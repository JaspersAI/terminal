import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { checkConnection, connectOptions } from '../../shared/plugins/connections.ts'
import { guardStdioTransport } from './stdio.ts'

test('a stdio server that finishes cold-start work before answering initialize connects under connectOptions', async () => {
  const script = `
    import readline from 'node:readline';
    setTimeout(() => {
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: msg.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'research', version: '0.1.0' },
            },
          }) + '\\n');
        }
      });
    }, 100);
  `
  const connection = checkConnection(
    { kind: 'connection', command: ['uv', 'run', '--script', 'edgar/server.py'] },
    'agents/research',
  )
  const transport = guardStdioTransport(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--input-type=module', '-e', script],
      stderr: 'pipe',
    }),
  )
  const client = new Client({ name: 'test-client', version: '0.1.0' })
  try {
    await client.connect(transport, connectOptions(connection))
    assert.equal(client.getServerVersion()?.name, 'research')
  } finally {
    await client.close()
  }
})

test('concurrent close calls share the in-flight shutdown so awaiting client.close after a connect timeout waits for the child to exit', async () => {
  // Simulates a server that hangs during initialize (e.g. uv still installing packages) and ignores stdin EOF briefly.
  const script = `
    process.stdin.resume();
    process.stdin.on('end', () => setTimeout(() => process.exit(0), 120));
  `
  const transport = guardStdioTransport(
    new StdioClientTransport({
      command: process.execPath,
      args: ['-e', script],
      stderr: 'pipe',
    }),
  )
  const client = new Client({ name: 'test-client', version: '0.1.0' })
  let childExited = false
  const origStart = transport.start.bind(transport)
  transport.start = async () => {
    await origStart()
    const child = (transport as unknown as { _process?: ChildProcess })._process
    child?.once('close', () => {
      childExited = true
    })
  }

  await assert.rejects(() => client.connect(transport, { timeout: 50 }), /MCP error -32001: Request timed out/)
  // Client.connect calls `void this.close()` without awaiting before rethrowing; a subsequent
  // `await client.close()` must still wait until the child process has exited.
  await client.close()
  assert.equal(childExited, true)
})

function makeFakeTransport(pid: number, events: string[]) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(signal?: NodeJS.Signals | number): boolean {
      events.push(`child.kill:${String(signal)}`)
      child.exitCode = 1
      child.emit('close', 1)
      return true
    },
  })
  const transport: Transport & { _process?: ChildProcess } = {
    _process: undefined,
    async start(): Promise<void> {
      transport._process = child as unknown as ChildProcess
    },
    async send(): Promise<void> {},
    async close(): Promise<void> {
      const proc = transport._process
      transport._process = undefined
      if (!proc) return
      const closePromise = new Promise<void>((resolve) => proc.once('close', () => resolve()))
      proc.stdin?.end()
      if (proc.exitCode === null) {
        proc.kill('SIGTERM')
        await closePromise
      }
    },
  }
  return { child, transport }
}

test('on Windows, force-killing a stdio transport that ignores stdin EOF kills its process tree via killTree before fallback kill', async () => {
  const events: string[] = []
  const { child, transport } = makeFakeTransport(53212, events)
  const guarded = guardStdioTransport(transport, {
    platform: 'win32',
    killTree: async (pid) => {
      events.push(`killTree:${pid}`)
      child.exitCode = 1
      child.emit('close', 1)
    },
  })

  await guarded.start()
  await guarded.close()
  assert.deepEqual(events, ['killTree:53212'])
})

test('on Windows, if killTree fails while the stdio child is still running, fallback child.kill terminates it', async () => {
  const events: string[] = []
  const { transport } = makeFakeTransport(9999, events)
  const guarded = guardStdioTransport(transport, {
    platform: 'win32',
    killTree: async (pid) => {
      events.push(`killTree:${pid}`)
      throw new Error('taskkill failed')
    },
  })

  await guarded.start()
  await guarded.close()
  assert.deepEqual(events, ['killTree:9999', 'child.kill:SIGTERM'])
})
