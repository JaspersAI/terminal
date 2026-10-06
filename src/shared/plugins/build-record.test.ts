import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineConnection, definePlugin, defineSource } from '@jaspers-ai/sdk/define'
import { z } from 'zod'
import {
  describeEnvelope,
  EMPTY_ENVELOPE,
  envelopeFromInput,
  envelopeOf,
  readBuildRecord,
  widened,
  type Envelope,
} from './build-record.ts'
import { validatePluginDefinition } from './plugins.ts'

const plugin = validatePluginDefinition(
  definePlugin({
    id: 'fred',
    capabilities: ['files'],
    frames: ['https://www.tradingview-widget.com'],
    secrets: { apikey: { label: 'FRED API key' }, token: { label: 'Server token' } },
    connections: {
      server: defineConnection({
        url: 'https://example.com/mcp',
        auth: 'bearer',
        headers: { Authorization: 'Bearer ${secret:token}' },
      }),
      local: defineConnection({ command: ['node', 'server.ts'] }),
    },
    sources: {
      series: defineSource({
        description: 'A series',
        input: z.object({ id: z.string() }),
        hosts: ['api.stlouisfed.org', 'fred.stlouisfed.org'],
        run: async () => [],
      }),
      releases: defineSource({
        description: 'Releases',
        input: z.object({}),
        hosts: ['api.stlouisfed.org'],
        run: async () => [],
      }),
      search: defineSource({ mcp: 'server', tool: 'search' }),
    },
  }),
  'fred',
)

test('the envelope of a definition is what it declares, sorted and deduplicated', () => {
  assert.deepEqual(envelopeOf(plugin, ['pdf-lib', 'zod-to-json-schema']), {
    hosts: ['api.stlouisfed.org', 'fred.stlouisfed.org'],
    capabilities: ['files'],
    secrets: ['apikey', 'token'],
    connections: ['local: node server.ts', 'server: https://example.com/mcp'],
    packages: ['pdf-lib', 'zod-to-json-schema'],
    frames: ['https://www.tradingview-widget.com'],
  })
})

test('what is wider is named field by field, and nothing is wider than itself', () => {
  const approved = envelopeOf(plugin, ['pdf-lib'])
  assert.deepEqual(widened(approved, approved), [])
  assert.deepEqual(widened(EMPTY_ENVELOPE, approved), [])
  const more: Envelope = {
    hosts: [...approved.hosts, 'api.example.com'],
    capabilities: ['files', 'llm'],
    secrets: [...approved.secrets, 'other'],
    connections: [...approved.connections, 'extra: https://x.test/mcp'],
    packages: ['pdf-lib', 'left-pad'],
    frames: [...approved.frames, 'https://evil.test'],
  }
  assert.deepEqual(widened(more, approved), [
    'host api.example.com',
    'capability llm',
    'secret other',
    'connection extra: https://x.test/mcp',
    'package left-pad',
    'frame https://evil.test',
  ])
})

test('a record is read only when whole', () => {
  const record = {
    purpose: 'FRED series',
    request: 'chart the 10 year',
    at: '2026-09-30T18:00:00.000Z',
    approved: EMPTY_ENVELOPE,
  }
  assert.deepEqual(readBuildRecord(record), record)
  assert.equal(readBuildRecord({ ...record, approved: { hosts: 'x' } }), null)
  assert.equal(readBuildRecord({ purpose: 'x' }), null)
  assert.equal(readBuildRecord(null), null)
})

test('an envelope read from tool input is strings only, trimmed, deduplicated, and sorted', () => {
  assert.deepEqual(
    envelopeFromInput({
      hosts: [' b.test', 'a.test', 'a.test'],
      capabilities: ['files'],
      secrets: { apikey: 'FRED API key' },
      connections: ['server: https://x.test'],
      packages: ['pdf-lib@^1.17.1', 'left-pad'],
    }),
    {
      envelope: {
        hosts: ['a.test', 'b.test'],
        capabilities: ['files'],
        secrets: ['apikey'],
        connections: ['server: https://x.test'],
        packages: ['left-pad', 'pdf-lib'],
        frames: [],
      },
      packageSpecs: ['left-pad', 'pdf-lib@^1.17.1'],
    },
  )
  assert.deepEqual(envelopeFromInput({}), { envelope: EMPTY_ENVELOPE, packageSpecs: [] })
  assert.throws(() => envelopeFromInput({ hosts: [7] }), /hosts is a list of host names/)
  assert.throws(() => envelopeFromInput({ capabilities: ['network'] }), /capabilities are llm, tools, files/)
  assert.throws(() => envelopeFromInput({ secrets: ['apikey'] }), /secrets is an object/)
  assert.throws(() => envelopeFromInput({ connections: ['local: node server.ts'] }), /https:\/\/ address/)
  assert.throws(() => envelopeFromInput({ connections: ['server: http://x.test/mcp'] }), /https:\/\/ address/)
  assert.throws(() => envelopeFromInput({ connections: ['https://x.test/mcp'] }), /name: https/)
})

test('an envelope is described a line a field, with none where empty', () => {
  assert.equal(
    describeEnvelope(envelopeOf(plugin, [])),
    [
      'Reaches:       api.stlouisfed.org, fred.stlouisfed.org',
      'Capabilities:  files',
      'Keys asked:    apikey, token',
      'Connections:   local: node server.ts; server: https://example.com/mcp',
      'Packages:      none',
      'Frames:        https://www.tradingview-widget.com',
    ].join('\n'),
  )
})
