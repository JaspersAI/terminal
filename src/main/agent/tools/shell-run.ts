import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { commandEnv, SANDBOX_EXEC, shellCommand, type ProMode } from '../../../shared/app/pro-mode.ts'

export interface Outcome {
  code: number | null
  output: string
  timedOut: boolean
}

export interface RunDeps {
  platform?: string
  hasSandbox?: boolean
  env?: Record<string, string | undefined>
  home?: string
  spawn?: (
    file: string,
    args: string[],
    options: { cwd: string; detached: boolean; windowsHide: boolean; env: Record<string, string> },
  ) => ChildProcess
  killTree?: (pid: number) => void
}

/** Whether commands on this platform run under macOS's `sandbox-exec`. */
export function isSandboxed(platform = process.platform, hasSandbox = fs.existsSync(SANDBOX_EXEC)): boolean {
  return platform === 'darwin' && hasSandbox
}

function defaultSpawn(
  file: string,
  args: string[],
  options: { cwd: string; detached: boolean; windowsHide: boolean; env: Record<string, string> },
): ChildProcess {
  return nodeSpawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
}

function defaultKillTree(pid: number): void {
  execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => undefined)
}

/**
 * Runs `command` in `folder` under the platform's shell (and `sandbox-exec` on macOS when present),
 * killing its process group on POSIX or its process tree via `taskkill` on Windows when it times out
 * or `signal` aborts.
 *
 * `-c` on POSIX and `-NoProfile` on Windows: the user's PATH is already merged into this process at
 * startup (app/shell-path.ts), so a login profile would add nothing but side effects. The command is
 * given `commandEnv`'s allowlisted variables so nothing secret in the app's environment travels into it.
 */
export async function execute(
  command: string,
  folder: string,
  proMode: ProMode,
  seconds: number,
  signal?: AbortSignal,
  deps?: RunDeps,
): Promise<Outcome> {
  const platform = deps?.platform ?? process.platform
  const hasSandbox = deps?.hasSandbox ?? (platform === 'darwin' && fs.existsSync(SANDBOX_EXEC))
  const env = commandEnv(deps?.env ?? process.env)
  const home = deps?.home ?? os.homedir()
  try {
    return await spawnOnce(
      shellCommand({ platform, command, folder, home, env, hasSandbox }),
      folder,
      env,
      proMode,
      seconds,
      platform,
      signal,
      deps,
    )
  } catch (err) {
    if (platform === 'win32' && (err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return spawnOnce(
        shellCommand({ platform, command, folder, home, env, hasSandbox, useCmdFallback: true }),
        folder,
        env,
        proMode,
        seconds,
        platform,
        signal,
        deps,
      )
    }
    throw err
  }
}

function spawnOnce(
  spec: { file: string; args: string[] },
  folder: string,
  env: Record<string, string>,
  proMode: ProMode,
  seconds: number,
  platform: string,
  signal?: AbortSignal,
  deps?: RunDeps,
): Promise<Outcome> {
  const runSpawn = deps?.spawn ?? defaultSpawn
  const killTree = deps?.killTree ?? defaultKillTree
  return new Promise((resolve, reject) => {
    const child = runSpawn(spec.file, spec.args, {
      cwd: folder,
      detached: platform !== 'win32',
      windowsHide: true,
      env,
    })
    let output = ''
    let timedOut = false
    let settled = false
    let drainTimer: NodeJS.Timeout | null = null
    const keep = (chunk: Buffer): void => {
      // Twice the cap at most: enough for capOutput to say how much was cut without holding a runaway in memory.
      if (output.length < proMode.outputMax * 2) output += chunk.toString('utf8')
    }
    const finish = (outcome: Outcome): void => {
      if (settled) return
      settled = true
      done()
      resolve(outcome)
    }
    const stop = (): void => {
      if (platform === 'win32') {
        if (child.pid) killTree(child.pid)
        try {
          child.kill('SIGKILL')
        } catch {
          // Process already exited.
        }
      } else {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      // If a grandchild outside the group holds stdio open after kill, bound how long we wait for close.
      drainTimer ??= setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish({ code: null, output, timedOut })
      }, 250)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, seconds * 1000)
    const stopped = (): void => stop()
    signal?.addEventListener('abort', stopped, { once: true })
    const done = (): void => {
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      signal?.removeEventListener('abort', stopped)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      done()
      reject(err)
    })
    child.on('close', (code) => {
      finish({ code, output, timedOut })
    })
    if (signal?.aborted) stop()
  })
}
