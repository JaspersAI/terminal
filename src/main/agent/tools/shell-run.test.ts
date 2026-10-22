import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { PRO_MODE_OFF, type ProMode } from '../../../shared/app/pro-mode.ts'
import { execute, isSandboxed } from './shell-run.ts'

const ON: ProMode = { ...PRO_MODE_OFF, enabled: true }

test('isSandboxed is true only on macOS when sandbox-exec is present', () => {
  assert.equal(isSandboxed('darwin', true), true)
  assert.equal(isSandboxed('darwin', false), false)
  assert.equal(isSandboxed('linux', true), false)
  assert.equal(isSandboxed('win32', true), false)
})

test('execute runs a multi-line script in the shell folder with sanitized env and closed stdin', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jaspers-shell-run-'))
  try {
    const result = await execute(
      'pwd\nprintf "term=%s secret=%s\\n" "$TERM" "${OPENAI_API_KEY:-none}"\ncat',
      folder,
      ON,
      5,
      undefined,
      {
        platform: 'linux',
        hasSandbox: false,
        env: { ...process.env, OPENAI_API_KEY: 'sk-should-not-leak' },
      },
    )
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0)
    assert.match(result.output, new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(result.output, /term=dumb secret=none/)
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test('execute kills the whole process group on timeout or abort, even if a background child holds pipes open', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jaspers-shell-timeout-'))
  try {
    const timed = await execute('sleep 30 &\necho started\nsleep 30', folder, ON, 1, undefined, {
      platform: 'linux',
      hasSandbox: false,
    })
    assert.equal(timed.timedOut, true)
    assert.match(timed.output, /started/)

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const aborted = await execute('sleep 30 &\nsleep 30', folder, ON, 10, controller.signal, {
      platform: 'linux',
      hasSandbox: false,
    })
    assert.equal(aborted.timedOut, false)
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test('execute on Windows invokes PowerShell, falls back to ComSpec on ENOENT, and kills the process tree via killTree on timeout', async () => {
  const calls: { file: string; args: string[]; env: Record<string, string>; detached: boolean }[] = []
  const killed: number[] = []

  const fakeSpawn = (
    file: string,
    args: string[],
    options: { cwd: string; detached: boolean; windowsHide: boolean; env: Record<string, string> },
  ): ChildProcess => {
    calls.push({ file, args, env: options.env, detached: options.detached })
    const emitter = new EventEmitter() as ChildProcess & {
      stdout: PassThrough
      stderr: PassThrough
      pid: number
      kill: () => boolean
    }
    emitter.stdout = new PassThrough()
    emitter.stderr = new PassThrough()
    emitter.pid = 4242
    emitter.kill = () => {
      emitter.emit('close', 1)
      return true
    }
    queueMicrotask(() => {
      if (file === 'powershell.exe' && calls.length === 1) {
        const err = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })
        emitter.emit('error', err)
        return
      }
      if (args.includes('hang')) return
      emitter.stdout.write('Server: dns.google\r\n')
      emitter.emit('close', 0)
    })
    return emitter
  }

  const fallback = await execute('nslookup api.bls.gov', 'C:\\Users\\alice\\Jaspers\\shell', ON, 5, undefined, {
    platform: 'win32',
    hasSandbox: false,
    env: {
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      ANTHROPIC_API_KEY: 'sk-secret',
    },
    spawn: fakeSpawn,
    killTree: (pid) => killed.push(pid),
  })
  assert.equal(fallback.code, 0)
  assert.equal(fallback.timedOut, false)
  assert.match(fallback.output, /Server: dns\.google/)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.file, 'powershell.exe')
  assert.equal(calls[0]!.detached, false)
  assert.equal(calls[1]!.file, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(calls[1]!.args, ['/d', '/s', '/c', 'nslookup api.bls.gov'])
  assert.equal(calls[1]!.env['SystemRoot'], 'C:\\Windows')
  assert.equal(calls[1]!.env['PATH'], 'C:\\Windows\\System32')
  assert.equal(calls[1]!.env['ANTHROPIC_API_KEY'], undefined)

  const timedOut = await execute('hang', 'C:\\Users\\alice\\Jaspers\\shell', ON, 1, undefined, {
    platform: 'win32',
    hasSandbox: false,
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    spawn: fakeSpawn,
    killTree: (pid) => killed.push(pid),
  })
  assert.equal(timedOut.timedOut, true)
  assert.deepEqual(killed, [4242])
})
