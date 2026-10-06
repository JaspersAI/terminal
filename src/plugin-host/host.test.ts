import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluatePlugin } from '../main/plugins/plugin-eval.ts'
import { createRpc, type Rpc, type RpcPort } from '../shared/rpc.ts'
import { createHost } from './host.ts'

// The host driven the way main drives it: over a wire, with a plugin's CJS build as a string. The
// main end of the wire stands in for main's capability handlers.

function pair(): [RpcPort, RpcPort] {
  const heard: [Set<(data: unknown) => void>, Set<(data: unknown) => void>] = [new Set(), new Set()]
  const end = (mine: 0 | 1): RpcPort => ({
    postMessage: (message) => {
      const copy = structuredClone(message)
      setImmediate(() => {
        for (const listener of heard[mine === 0 ? 1 : 0]) listener(copy)
      })
    },
    onMessage: (listener) => {
      heard[mine].add(listener)
      return () => heard[mine].delete(listener)
    },
  })
  return [end(0), end(1)]
}

function start(): { main: Rpc; exits: number[] } {
  const [a, b] = pair()
  const exits: number[] = []
  createHost(createRpc(b), { evaluate: evaluatePlugin, exit: (code) => void exits.push(code) })
  return { main: createRpc(a), exits }
}

const PLUGIN = `
const { definePlugin, defineSource } = require('@jaspers-ai/sdk')
const { z } = require('zod')
module.exports = definePlugin({
  id: 'hello',
  capabilities: ['files'],
  async start(ctx) {
    ctx.live.set('greeting', { text: await ctx.files.read('hello.txt') })
    ctx.files.watch('inbox', (paths) => ctx.notify('changed ' + paths.join(',')))
  },
  sources: {
    echo: defineSource({ description: 'Echo', input: z.object({ text: z.string() }), run: async (args) => ({ echoed: args.text }) }),
    peek: defineSource({ description: 'Peek', input: z.object({}), hosts: ['example.com'], run: async (_args, ctx) => ctx.fetch('https://evil.test/x') }),
  },
})
`

/** Main's side of the capabilities start uses: one file, and watches that start. */
function serve(main: Rpc): { watchId: () => number } {
  let watchId = 0
  main.handle('files.read', async (params) => {
    assert.equal((params as { path: string }).path, 'hello.txt')
    return 'hi'
  })
  main.handle('files.watch', async (params) => {
    watchId = (params as { watchId: number }).watchId
    return null
  })
  return { watchId: () => watchId }
}

test('init evaluates the build and runs start, which reaches main through its capabilities', async () => {
  const { main } = start()
  serve(main)
  const live = new Promise((resolve) => main.onNotification('live.set', resolve))
  assert.deepEqual(await main.request('init', { id: 'hello', code: PLUGIN, capabilities: ['files'] }), {
    sources: ['echo', 'peek'],
  })
  assert.deepEqual(await live, { key: 'greeting', value: { text: 'hi' } })
})

test('a change main reports reaches the watch that start set up', async () => {
  const { main } = start()
  const { watchId } = serve(main)
  const notice = new Promise((resolve) => main.onNotification('notify', resolve))
  await main.request('init', { id: 'hello', code: PLUGIN, capabilities: ['files'] })
  main.notify('files.changed', { watchId: watchId(), paths: ['inbox/a.md'] })
  assert.deepEqual(await notice, { text: 'changed inbox/a.md' })
})

test('a source runs with its arguments, and its fetch reaches only its own hosts', async () => {
  const { main } = start()
  serve(main)
  await main.request('init', { id: 'hello', code: PLUGIN, capabilities: ['files'] })
  assert.deepEqual(await main.request('source.run', { name: 'echo', args: { text: 'yo' } }), { echoed: 'yo' })
  await assert.rejects(main.request('source.run', { name: 'peek', args: {} }), /host not allowed: evil\.test/)
  await assert.rejects(main.request('source.run', { name: 'nope', args: {} }), /no function source named nope/)
})

test('a capability main did not grant fails where the plugin uses it', async () => {
  const { main } = start()
  serve(main)
  await assert.rejects(
    main.request('init', { id: 'hello', code: PLUGIN, capabilities: [] }),
    /declare "files" in capabilities/,
  )
})

const READER = `
const { definePlugin, defineSource } = require('@jaspers-ai/sdk')
const { z } = require('zod')
module.exports = definePlugin({
  id: 'reader',
  capabilities: ['state'],
  sources: {
    look: defineSource({ description: 'Look', input: z.object({ path: z.string() }), run: async (args, ctx) => ctx.state.get(args.path) }),
  },
})
`

test('state reads the tree by path from main, once main granted it', async () => {
  const { main } = start()
  main.handle('state.get', async (params) => ({ read: (params as { path: string }).path }))
  await main.request('init', { id: 'reader', code: READER, capabilities: ['state'] })
  assert.deepEqual(await main.request('source.run', { name: 'look', args: { path: 'panels/e1/output' } }), {
    read: 'panels/e1/output',
  })

  const refused = start()
  refused.main.handle('state.get', async () => 'never')
  await refused.main.request('init', { id: 'reader', code: READER, capabilities: [] })
  await assert.rejects(
    refused.main.request('source.run', { name: 'look', args: { path: 'panels' } }),
    /declare "state" in capabilities/,
  )
})

const WHERE = `
const { definePlugin, defineSource } = require('@jaspers-ai/sdk')
const { z } = require('zod')
module.exports = definePlugin({
  id: 'where',
  capabilities: ['state'],
  async start(ctx) {
    if (ctx.workspace !== null) throw new Error('start has no caller, so no workspace')
  },
  sources: {
    here: defineSource({ description: 'Here', input: z.object({}), run: async (_args, ctx) => ({ workspace: ctx.workspace, read: await ctx.state.get('workspace') }) }),
  },
})
`

test('a source run knows the workspace that called it, and reads that workspace when a path names none', async () => {
  const { main } = start()
  main.handle('state.get', async (params) => params)
  await main.request('init', { id: 'where', code: WHERE, capabilities: ['state'] })
  assert.deepEqual(await main.request('source.run', { name: 'here', args: {}, workspaceId: 'ws-2' }), {
    workspace: 'ws-2',
    read: { path: 'workspace', workspaceId: 'ws-2' },
  })
  // Nobody said where the call came from: the workspace on screen, as before.
  assert.deepEqual(await main.request('source.run', { name: 'here', args: {} }), {
    workspace: null,
    read: { path: 'workspace' },
  })
})

test('a build for another plugin is refused, and so is a second init', async () => {
  const { main } = start()
  serve(main)
  await assert.rejects(
    main.request('init', { id: 'goodbye', code: PLUGIN, capabilities: ['files'] }),
    /has to match its folder name goodbye/,
  )
  await main.request('init', { id: 'hello', code: PLUGIN, capabilities: ['files'] })
  await assert.rejects(
    main.request('init', { id: 'hello', code: PLUGIN, capabilities: ['files'] }),
    /already runs a plugin/,
  )
})

test('shutdown answers, then leaves', async () => {
  const { main, exits } = start()
  await main.request('shutdown', { reason: 'plugin reloaded' })
  assert.deepEqual(exits, [])
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(exits, [0])
})

const JOBS = `
const { definePlugin, defineSource } = require('@jaspers-ai/sdk')
const { z } = require('zod')
module.exports = definePlugin({
  id: 'worker',
  sources: {
    work: defineSource({
      description: 'Start work',
      input: z.object({ key: z.string() }),
      run: async (args, ctx) => {
        ctx.jobs.start(args.key, (signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            ctx.live.set('stopped/' + args.key, { reason: signal.reason.message })
            resolve()
          })
        }))
        return ctx.jobs.running()
      },
    }),
    stop: defineSource({ description: 'Stop work', input: z.object({ key: z.string() }), run: async (args, ctx) => { ctx.jobs.abort(args.key, 'the user stopped it'); return 'ok' } }),
  },
})
`

test('a job runs in the background, main hears what is running, and a key runs once at a time', async () => {
  const { main } = start()
  const changes: unknown[] = []
  main.onNotification('jobs.changed', (params) => void changes.push(params))
  await main.request('init', { id: 'worker', code: JOBS, capabilities: [] })
  assert.deepEqual(await main.request('source.run', { name: 'work', args: { key: 'r1/credit' } }), ['r1/credit'])
  await assert.rejects(
    main.request('source.run', { name: 'work', args: { key: 'r1/credit' } }),
    /r1\/credit is already running/,
  )
  const stopped = new Promise((resolve) => main.onNotification('live.set', resolve))
  await main.request('source.run', { name: 'stop', args: { key: 'r1/credit' } })
  assert.deepEqual(await stopped, { key: 'stopped/r1/credit', value: { reason: 'the user stopped it' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(changes, [{ running: ['r1/credit'] }, { running: [] }])
})

test('shutdown aborts every job with its reason and answers once they have settled', async () => {
  const { main } = start()
  const heard: unknown[] = []
  main.onNotification('live.set', (params) => void heard.push(params))
  await main.request('init', { id: 'worker', code: JOBS, capabilities: [] })
  await main.request('source.run', { name: 'work', args: { key: 'a' } })
  await main.request('source.run', { name: 'work', args: { key: 'b' } })
  await main.request('shutdown', { reason: 'plugin reloaded' })
  assert.deepEqual(heard, [
    { key: 'stopped/a', value: { reason: 'plugin reloaded' } },
    { key: 'stopped/b', value: { reason: 'plugin reloaded' } },
  ])
})

test('plugin code has timers and the other web built-ins, and no Node', async () => {
  const code = `
const { definePlugin, defineSource } = require('@jaspers-ai/sdk')
const { z } = require('zod')
module.exports = definePlugin({
  id: 'clock',
  sources: {
    tick: defineSource({
      description: 'Wait a moment',
      input: z.object({}),
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return [typeof AbortController, typeof URL, typeof TextEncoder, typeof structuredClone, typeof process, typeof require('zod')]
      },
    }),
  },
})
`
  const { main } = start()
  await main.request('init', { id: 'clock', code, capabilities: [] })
  assert.deepEqual(await main.request('source.run', { name: 'tick', args: {} }), [
    'function',
    'function',
    'function',
    'function',
    'undefined',
    'object',
  ])
})

const SKILLED = `
const { definePlugin, defineSource, runSkillTool, skillsPrompt, skillTools } = require('@jaspers-ai/sdk')
const { z } = require('zod')
module.exports = definePlugin({
  id: 'skilled',
  capabilities: ['skills'],
  sources: {
    brief: defineSource({
      description: 'Brief',
      input: z.object({}),
      run: async (_args, ctx) => {
        const skills = await ctx.skills.catalog({ names: ['dcf'] })
        const loaded = await runSkillTool(ctx.skills, { id: 'c1', name: 'activate_skill', input: { name: 'dcf', arguments: 'AAPL' } }, [])
        const part = await ctx.skills.read('dcf', 'references/a.md', { offset: 2 })
        return { prompt: skillsPrompt(skills), tools: skillTools(skills.map((s) => s.name)).map((t) => t.name), loaded, part }
      },
    }),
  },
})
`

const UNSKILLED = `
const { definePlugin, defineSource } = require('@jaspers-ai/sdk')
const { z } = require('zod')
module.exports = definePlugin({
  id: 'unskilled',
  sources: { peek: defineSource({ description: 'Peek', input: z.object({}), run: async (_args, ctx) => ctx.skills.catalog() }) },
})
`

test('a plugin that declares skills loads them through main, with the SDK helpers in its host', async () => {
  const { main } = start()
  const asked: unknown[] = []
  const content = '<skill_content name="dcf">\nB\n</skill_content>'
  main.handle('skills.catalog', async (params) => {
    asked.push(['catalog', params])
    return [{ name: 'dcf', description: 'Builds a DCF.', plugin: null, argumentHint: null, compatibility: null }]
  })
  main.handle('skills.activate', async (params) => {
    asked.push(['activate', params])
    return content
  })
  main.handle('skills.read', async (params) => {
    asked.push(['read', params])
    return { text: 'hi', from: 2, to: 4, length: 4, next: null }
  })
  await main.request('init', { id: 'skilled', code: SKILLED, capabilities: ['skills'] })
  const result = (await main.request('source.run', { name: 'brief', args: {} })) as {
    prompt: string
    tools: string[]
    loaded: unknown
    part: unknown
  }
  assert.match(result.prompt, /<name>dcf<\/name>/)
  assert.deepEqual(result.tools, ['activate_skill', 'read_skill_file'])
  assert.deepEqual(result.loaded, { callId: 'c1', output: content, isError: false })
  assert.deepEqual(result.part, { text: 'hi', from: 2, to: 4, length: 4, next: null })
  assert.deepEqual(asked, [
    ['catalog', { names: ['dcf'] }],
    ['activate', { name: 'dcf', arguments: 'AAPL' }],
    ['read', { name: 'dcf', path: 'references/a.md', offset: 2 }],
  ])
})

test('ctx.skills is refused to a plugin that did not declare it', async () => {
  const { main } = start()
  await main.request('init', { id: 'unskilled', code: UNSKILLED, capabilities: [] })
  await assert.rejects(main.request('source.run', { name: 'peek', args: {} }), /declare "skills" in capabilities/)
})

const KEYED = `
const { definePlugin, defineSource } = require('@jaspers-ai/sdk')
const { z } = require('zod')
module.exports = definePlugin({
  id: 'keyed',
  secrets: { apikey: { label: 'A key' } },
  sources: {
    quote: defineSource({
      description: 'Quote',
      input: z.object({}),
      hosts: ['api.invalid'],
      run: async (_args, ctx) => ctx.fetch('https://api.invalid/q?key=\${secret:apikey}'),
    }),
  },
})
`

test("a source's fetch carries the plugin's secrets main sent, and fails naming set_secret when one is not set", async () => {
  const { main } = start()
  await main.request('init', { id: 'keyed', code: KEYED, capabilities: [] })
  await assert.rejects(
    main.request('source.run', { name: 'quote', args: {}, secrets: {} }),
    /keyed needs its apikey: the user adds it with set_secret \{ plugin: "keyed", key: "apikey" \}/,
  )
  // With the key the reference is filled and the request goes out: to a host that does not resolve,
  // so what comes back is the network's refusal rather than the missing key's.
  await assert.rejects(
    main.request('source.run', { name: 'quote', args: {}, secrets: { apikey: 'k' } }),
    (err: Error) => {
      assert.doesNotMatch(err.message, /needs its apikey/)
      return true
    },
  )
})
