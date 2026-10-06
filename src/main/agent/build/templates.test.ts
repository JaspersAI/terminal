import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { bundlePlugin } from '../../plugins/bundle.ts'
import { evaluatePlugin } from '../../plugins/plugin-eval.ts'

// The templates the builder copies are real plugins under docs/templates: each has to build the way
// the app builds one and evaluate to a definition whose id is its folder name, or the example the
// builder is told to follow is broken before it starts.

const ROOT = path.resolve(import.meta.dirname, '../../../../docs/templates')

const templates = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

test('there are templates for a feed, a feed with a table, a document producer, and a connection', () => {
  assert.deepEqual(templates, ['connection', 'document', 'feed', 'feed-table'])
})

for (const name of templates) {
  test(`the ${name} template builds and evaluates to a plugin named ${name}`, async () => {
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-template-'))
    try {
      const outfile = path.join(out, 'bundle.js')
      const code = await bundlePlugin(path.join(ROOT, name), outfile)
      assert.ok(fs.existsSync(outfile), 'the browser bundle is written')
      const plugin = evaluatePlugin(code, name)
      assert.equal(plugin.id, name)
      assert.ok(Object.keys(plugin.sources).length > 0, 'a template has at least one source')
    } finally {
      await fsp.rm(out, { recursive: true, force: true })
    }
  })
}

test('the feed-table template has a view that renders its source', async () => {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-template-'))
  try {
    const code = await bundlePlugin(path.join(ROOT, 'feed-table'), path.join(out, 'bundle.js'))
    const plugin = evaluatePlugin(code, 'feed-table')
    const view = plugin.views['table']
    assert.ok(view, 'a view named table')
    assert.equal(view.renders?.length, 1)
    assert.ok(fs.existsSync(path.join(out, 'bundle.css')), 'its CSS is written beside the bundle')
  } finally {
    await fsp.rm(out, { recursive: true, force: true })
  }
})

test("a plugin's code imports only its own files and its packages: an import from outside the folder fails the build", async () => {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-confine-'))
  try {
    const dir = path.join(out, 'plugin')
    await fsp.mkdir(path.join(dir, 'node_modules', 'inside'), { recursive: true })
    await fsp.writeFile(path.join(out, 'outside.json'), '{"leak":true}')
    await fsp.writeFile(path.join(dir, 'node_modules', 'inside', 'index.js'), 'module.exports = 1')
    await fsp.writeFile(path.join(dir, 'node_modules', 'inside', 'package.json'), '{"name":"inside","main":"index.js"}')
    await fsp.writeFile(path.join(dir, 'own.ts'), 'export const own = 1')
    await fsp.writeFile(
      path.join(dir, 'plugin.tsx'),
      `import { definePlugin } from '@jaspers-ai/sdk'\nimport inside from 'inside'\nimport { own } from './own'\nexport default definePlugin({ id: 'plugin', sources: {} })\nconsole.log(inside, own)\n`,
    )
    await bundlePlugin(dir, path.join(out, 'bundle.js'))
    await fsp.writeFile(
      path.join(dir, 'plugin.tsx'),
      `import { definePlugin } from '@jaspers-ai/sdk'\nimport data from '../outside.json'\nexport default definePlugin({ id: 'plugin', sources: {} })\nconsole.log(data)\n`,
    )
    await assert.rejects(bundlePlugin(dir, path.join(out, 'bundle.js')), /outside the plugin's folder/)
  } finally {
    await fsp.rm(out, { recursive: true, force: true })
  }
})
