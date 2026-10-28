import { execFile, type ChildProcess } from 'node:child_process'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

// Around the MCP SDK's StdioClientTransport:
// 1. Concurrent close() calls share one shutdown promise. On a failed connect() the SDK triggers
//    `void this.close()` without awaiting before rethrowing, and StdioClientTransport.close() clears
//    `this._process` on its first line; without coalescing, a caller's `await client.close()` returns
//    at once while the previous child process is still shutting down.
// 2. On Windows, a stdio server started through a wrapper (`uv.exe` spawning `python.exe`, or `cmd.exe`
//    spawning `node.exe`) leaves its child tree running if force-killed with `child.kill()` alone.
//    When the process does not exit on stdin EOF and the transport falls back to `kill()`, `taskkill /t /f`
//    terminates the whole process tree before falling back to `child.kill()`.

export interface StdioGuardDeps {
  platform?: string
  killTree?: (pid: number) => Promise<void>
}

function defaultKillTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export function guardStdioTransport<T extends Transport>(transport: T, deps?: StdioGuardDeps): T {
  const platform = deps?.platform ?? process.platform
  const killTree = deps?.killTree ?? defaultKillTree
  let spawned: ChildProcess | undefined
  let closing: Promise<void> | undefined

  const start = transport.start.bind(transport)
  transport.start = async () => {
    await start()
    const child = (transport as { _process?: ChildProcess })._process
    spawned = child
    if (platform === 'win32' && child?.pid) {
      const pid = child.pid
      const kill = child.kill.bind(child)
      let killingTree: Promise<void> | undefined
      child.kill = (signal?: NodeJS.Signals | number): boolean => {
        killingTree ??= Promise.resolve(killTree(pid))
          .catch(() => undefined)
          .finally(() => {
            if (child.exitCode === null) {
              try {
                kill(signal)
              } catch {
                // Process already exited.
              }
            }
          })
        return true
      }
    }
  }

  const close = transport.close.bind(transport)
  transport.close = () =>
    (closing ??= close().finally(() => {
      spawned?.stdout?.destroy()
      spawned?.stderr?.destroy()
    }))

  return transport
}
