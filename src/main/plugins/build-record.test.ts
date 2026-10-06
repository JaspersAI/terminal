import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { defineConnection, definePlugin, defineSource } from '@jaspers-ai/sdk/define'
import { z } from 'zod'
import { EMPTY_ENVELOPE } from '../../shared/plugins/build-record.ts'
import { validatePluginDefinition } from '../../shared/plugins/plugins.ts'
import { checkEnvelope, dependencyNames, readBuildRecordFile, writeBuildRecordFile } from './build-record.ts'

async function folder(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-build-record-'))
}

test('a record written is the record read, and a folder without one reads null', async () => {
  const dir = await folder()
  try {
    assert.equal(readBuildRecordFile(dir), null)
    const record = {
      purpose: 'FRED series',
      request: 'chart the 10 year',
      at: '2026-09-30T18:00:00.000Z',
      approved: { ...EMPTY_ENVELOPE, hosts: ['api.stlouisfed.org'] },
    }
    writeBuildRecordFile(dir, record)
    assert.deepEqual(readBuildRecordFile(dir), record)
    assert.ok(fs.existsSync(path.join(dir, '.jaspers-build.json')))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a damaged record reads null rather than throwing', async () => {
  const dir = await folder()
  try {
    await fsp.writeFile(path.join(dir, '.jaspers-build.json'), '{ not json')
    assert.equal(readBuildRecordFile(dir), null)
    await fsp.writeFile(path.join(dir, '.jaspers-build.json'), JSON.stringify({ purpose: 'x' }))
    assert.equal(readBuildRecordFile(dir), null)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("dependency names come from package.json's dependencies, sorted, or none", async () => {
  const dir = await folder()
  try {
    assert.deepEqual(dependencyNames(dir), [])
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { 'pdf-lib': '^1', b: '*' } }),
    )
    assert.deepEqual(dependencyNames(dir), ['b', 'pdf-lib'])
    await fsp.writeFile(path.join(dir, 'package.json'), '{ broken')
    assert.deepEqual(dependencyNames(dir), [])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a built plugin is held to its record: wider declarations and any stdio command fail the check', async () => {
  const dir = await folder()
  try {
    const record = {
      purpose: 'p',
      request: 'r',
      at: '2026-09-30T18:00:00.000Z',
      approved: {
        ...EMPTY_ENVELOPE,
        hosts: ['api.test'],
        packages: ['left-pad'],
        secrets: ['token'],
        connections: ['server: https://x.test/mcp'],
      },
    }
    writeBuildRecordFile(dir, record)
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'p', dependencies: { 'left-pad': '^1' } }),
    )
    const within = validatePluginDefinition(
      definePlugin({
        id: 'p',
        secrets: { token: { label: 'T' } },
        connections: { server: defineConnection({ url: 'https://x.test/mcp' }) },
        sources: {
          a: defineSource({ description: 'a', input: z.object({}), hosts: ['api.test'], run: async () => [] }),
        },
      }),
      'p',
    )
    assert.equal(checkEnvelope(within, dir), null)
    const wider = validatePluginDefinition(
      definePlugin({
        id: 'p',
        capabilities: ['files'],
        sources: {
          a: defineSource({
            description: 'a',
            input: z.object({}),
            hosts: ['api.test', 'other.test'],
            run: async () => [],
          }),
        },
      }),
      'p',
    )
    assert.match(
      checkEnvelope(wider, dir)!,
      /^p declares host other\.test, capability files, which the user did not approve/,
    )
    const stdio = validatePluginDefinition(
      definePlugin({ id: 'p', connections: { local: defineConnection({ command: ['node', 'server.ts'] }) } }),
      'p',
    )
    assert.match(checkEnvelope(stdio, dir)!, /reaches servers over https only; local runs a command/)
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'p', dependencies: { 'left-pad': '^1', evil: '*' } }),
    )
    assert.match(checkEnvelope(within, dir)!, /package evil/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a folder without a record is not checked', async () => {
  const dir = await folder()
  try {
    const plugin = validatePluginDefinition(
      definePlugin({ id: 'p', connections: { local: defineConnection({ command: ['node', 'server.ts'] }) } }),
      'p',
    )
    assert.equal(checkEnvelope(plugin, dir), null)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
