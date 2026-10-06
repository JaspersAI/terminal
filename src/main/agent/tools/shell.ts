import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  approvalChoices,
  approvalKey,
  capOutput,
  COMMAND_MAX,
  commandEnv,
  commandTimeout,
  isReadOnlyCommand,
  readApproval,
  readOnlyFolders,
  readTaskApproval,
  sandboxProfile,
  taskApprovalChoices,
  type Approval,
  type ProMode,
} from '../../../shared/app/pro-mode'
import { askUser } from '../../actions'
import { jaspersHome } from '../../home'
import { getState } from '../../state'
import { allowTaskCommand, taskAllows } from '../../tasks/tasks'
import { askedBy } from '../utils/runs'
import type { Tool, ToolContext } from './types'

// Running a command on the user's computer, which is what pro mode turns on. Nothing here is
// reachable while it is off: the tool is left out of the catalog, so the model is never told it
// exists, and the tool refuses as well, in case a stale catalog reaches a call.
//
// Every command is approved by hand before it runs, in the field a question uses, and the answer is
// read the strict way: anything but an allowance the setting offers is a refusal, so a closed
// question, a stopped run, and a timeout all mean no. An allowance for a conversation covers that
// exact command string and nothing else — no prefix, no glob. The wider allowance, every command in
// the conversation, exists because a twenty-step workflow of different commands is otherwise twenty
// questions; it is on offer only while the setting asks for it, and both kinds go when the
// conversation does, at /new, and neither is ever reachable from an unattended run.
//
// A scheduled task's run is not a conversation, so it has an allowance of its own: a script the user
// allowed that task, to the letter, kept with the task. It is asked for at the moment it is needed —
// while the task is made, when the assistant names what its runs will run, or at a run that reaches
// for a script nobody allowed, where the question waits like any other and nobody answering is a no.
//
// A call is a script, not a line: it goes to the shell as one string, so `cd`, `&&`, `set -e`, a
// heredoc, and several lines all work, and a workflow is one thing the user reads and approves once
// rather than twenty things they wave through.
//
// A command is confined by the OS, not by reading what it says: macOS's sandbox-exec runs it under a
// profile that may read and write only inside the app's shell folder, read the user's Desktop and
// Downloads, read the system and the folders on PATH so a program can be found, and nothing else.
// Desktop and Downloads are where a file the user wants worked on usually is, so a script may read
// them, and copy from them into the folder; it can change nothing there. The rest of the user's files
// are not readable, so an approved command that turns out to do more than it said writes only inside
// the folder and reads only what those two hold. Without
// sandbox-exec nothing runs at all: an unconfined command is not what the user agreed to.

/** Commands allowed for the rest of a conversation, by `approvalKey`. Never persisted: a restart forgets them. */
const allowed = new Set<string>()

/** Conversations where the user allowed every command. Never persisted, and never more than this app's run. */
const allowedSessions = new Set<string>()

/** A conversation is over: `/new`, or a thread replaced. Both kinds of allowance go with it. */
export function forgetApprovals(conversation: string): void {
  for (const key of allowed) {
    if (key.startsWith(`${conversation}\u0000`)) allowed.delete(key)
  }
  allowedSessions.delete(conversation)
}

export function shellTools(context?: ToolContext): Tool[] {
  return getState().proMode.enabled && context ? [runShell] : []
}

const runShell: Tool = {
  name: 'run_shell',
  description:
    "Runs a shell script on the user's own computer and answers with what it printed. A workflow over files — make folders, download with curl into them, pull sections out with grep, awk, sed, or python3, diff two files, write results back — is exactly what this is for, and the whole workflow belongs in one call: pass a multi-line script, with cd, &&, set -e, and heredocs as you would type them. It runs inside Jaspers's own folder, ~/Jaspers/shell, which is the only place it can write. It can also read the user's ~/Desktop and ~/Downloads, so a file they saved or downloaded there is read in place, or copied into the folder to work on; it cannot change or delete anything in them, and the rest of the user's files are not readable. When the user asks for shell work, do it here: do not answer from a source instead, and do not offer to build a plugin for it. A plain data question that a source, a query, or a plugin already answers still goes there, not to a command. The user approves the script before it runs, and a refusal is final: do not ask again, and do not try another wording of the same thing. Say what you are about to run and why before you call it. In a scheduled task's run, a script the user allowed that task runs without asking and any other asks them then, when they may not be there: when you schedule work that needs a command, give the exact script in schedule_task's commands, so they are asked now, and have the run pass it unchanged. Files it leaves in the folder are the user's to open from Settings > Pro mode.",
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: `The script, exactly as it would be typed in a terminal, up to ${COMMAND_MAX.toLocaleString('en-US')} characters. One script of several lines is better than several calls: it runs in one shell, so cd holds, && and set -e hold, and the user approves it once. Start it with set -e when a later step depends on an earlier one. It runs in Jaspers's shell folder, the only place it can write; ~/Desktop and ~/Downloads can be read as well.`,
      },
      timeoutSeconds: {
        type: 'integer',
        minimum: 1,
        description:
          "How long it may run before it is killed. Only for work that plainly takes longer, like a download or a pass over a large file; the user's setting is the ceiling and a larger number is held to it.",
      },
    },
    required: ['command'],
  },
  async run(input, context) {
    const proMode = getState().proMode
    if (!proMode.enabled) {
      throw new Error(
        'Pro mode is off, so nothing can be run on this computer. Tell the user it is in Settings > Pro mode, and that turning it on is theirs to do.',
      )
    }
    if (process.platform !== 'darwin' || !fs.existsSync(SANDBOX)) {
      throw new Error("Commands run only where macOS can confine them to Jaspers's folder, and this computer cannot.")
    }
    const command = asCommand(input.command)
    const folder = await shellFolder()
    const task = context.task
    const conversation = context.conversationId
    const key = approvalKey(conversation, command)
    const seconds = commandTimeout(input.timeoutSeconds, proMode.timeoutSeconds)
    // A command that plainly only reads needs no asking, when the user has allowed that much.
    const readOnly = proMode.allowReadOnly && isReadOnlyCommand(command)
    const approval: Approval = readOnly
      ? 'once'
      : task !== undefined
        ? taskAllows(task, command)
          ? 'task'
          : readTaskApproval(
              await askUser(askAtRun(task, folder, seconds), taskApprovalChoices('run'), context.signal, command),
              'run',
            )
        : allowed.has(key)
          ? 'conversation'
          : allowedSessions.has(conversation)
            ? 'session'
            : readApproval(
                await askUser(
                  ask(folder, seconds),
                  approvalChoices(proMode.approval),
                  context.signal,
                  command,
                  askedBy(context.runId),
                ),
                proMode.approval,
              )
    if (approval === 'denied') {
      await log({ command, folder, answer: 'denied' })
      throw new Error(
        `The user did not approve \`${command}\`. Leave it; say what you wanted to run and ask what they would rather do.`,
      )
    }
    if (approval === 'conversation') allowed.add(key)
    if (approval === 'session') allowedSessions.add(conversation)
    if (approval === 'task' && task !== undefined) allowTaskCommand(task, command)
    const started = Date.now()
    const result = await execute(command, folder, proMode, seconds, context.signal)
    const ms = Date.now() - started
    await log({ command, folder, answer: readOnly ? 'read-only' : approval, timeout: seconds, code: result.code, ms })
    const head = result.timedOut
      ? `It was still running after ${seconds}s and was stopped. Anything it had written is in the folder; a longer timeoutSeconds is the way to ask for more, up to the user's setting.`
      : `Exit code ${result.code}, ${(ms / 1000).toFixed(1)}s.`
    const output = capOutput(result.output.trim(), proMode.outputMax)
    return output ? `${head}\n\n${output}` : `${head}\n\nIt printed nothing.`
  },
}

/**
 * The scripts a task being made or changed will run, put in front of the user now, while they are
 * there to read them: each is allowed for the task or the task is not made. Answers with the scripts
 * as they are kept. A run then passes one to the letter and is not asked.
 */
export async function approveForTask(commands: string[], context: ToolContext): Promise<string[]> {
  if (commands.length === 0) return []
  const proMode = getState().proMode
  if (!proMode.enabled) {
    throw new Error(
      'Pro mode is off, so a task cannot run anything on this computer. Tell the user it is in Settings > Pro mode, and that turning it on is theirs to do.',
    )
  }
  if (process.platform !== 'darwin' || !fs.existsSync(SANDBOX)) {
    throw new Error("Commands run only where macOS can confine them to Jaspers's folder, and this computer cannot.")
  }
  const folder = await shellFolder()
  const scripts = [...new Set(commands.map(asCommand))]
  for (const command of scripts) {
    const approval = readTaskApproval(
      await askUser(
        askForTask(folder, proMode.timeoutSeconds),
        taskApprovalChoices('scheduling'),
        context.signal,
        command,
        askedBy(context.runId),
      ),
      'scheduling',
    )
    await log({ command, folder, answer: approval === 'task' ? 'task, when scheduled' : 'denied, when scheduled' })
    if (approval !== 'task') {
      throw new Error(
        `The user did not allow the task \`${command}\`, so nothing was scheduled or changed. Leave it; say what the task would have run and ask what they would rather do.`,
      )
    }
  }
  return scripts
}

/** macOS's sandbox: what confines a command. Deprecated by Apple and still what confines a command. */
const SANDBOX = '/usr/bin/sandbox-exec'

/**
 * What the user is asked. The script itself goes beside the question rather than in it, so the field
 * shows it as it would be typed — every line, monospaced — and nothing about it is shortened: what is
 * being approved is the text, and text nobody can read is not something to approve.
 */
function ask(folder: string, seconds: number): string {
  return `Run this on your computer? It can write only inside ${folder}, read that and your Desktop and Downloads, and is stopped after ${seconds}s.`
}

/** What the user is asked while a task is made: the same script, allowed for every run of it rather than for now. */
function askForTask(folder: string, seconds: number): string {
  return `Let the scheduled task run this on your computer at each of its runs, without asking again? It can write only inside ${folder}, read that and your Desktop and Downloads, and is stopped after ${seconds}s.`
}

/** What the user is asked when a task's run reaches for a script nobody allowed it. */
function askAtRun(task: string, folder: string, seconds: number): string {
  return `Scheduled task ${task} wants to run this on your computer. It can write only inside ${folder}, read that and your Desktop and Downloads, and is stopped after ${seconds}s.`
}

function asCommand(value: unknown): string {
  const command = typeof value === 'string' ? value.trim() : ''
  if (!command) throw new Error('command is the script to run, as it would be typed in a terminal.')
  if (command.length > COMMAND_MAX) {
    throw new Error(
      `That script is ${command.length.toLocaleString('en-US')} characters; ${COMMAND_MAX.toLocaleString('en-US')} is the most the user can be asked to read at once. Split the work into steps.`,
    )
  }
  return command
}

/** Where every command runs: the app's own shell folder, made if it is not there. Nothing else is offered. */
async function shellFolder(): Promise<string> {
  const folder = path.join(jaspersHome(), 'shell')
  await fsp.mkdir(folder, { recursive: true })
  return folder
}

interface Outcome {
  code: number | null
  output: string
  timedOut: boolean
}

/**
 * The command, under the sandbox profile and in its own process group, so a timeout or the user's
 * Stop kills whatever it started and not only the shell. Output is collected as one stream, the way a terminal shows it, and the
 * cap is applied to what is kept rather than to what is read.
 *
 * `-c`, not `-lc`: the user's PATH is already merged into this process at startup (app/shell-path.ts),
 * so a login shell would add nothing but their profile's side effects — what it prints, what it
 * exports, and how long it takes. The command is given `commandEnv`'s few variables rather than
 * whatever this process was launched with, so nothing in the app's environment travels into it.
 */
function execute(
  command: string,
  folder: string,
  proMode: ProMode,
  seconds: number,
  signal?: AbortSignal,
): Promise<Outcome> {
  const shell = process.env['SHELL'] || '/bin/sh'
  return new Promise((resolve, reject) => {
    const env = commandEnv(process.env)
    const profile = sandboxProfile(
      folder,
      (env['PATH'] ?? '').split(':').filter(Boolean),
      readOnlyFolders(os.homedir()),
    )
    const child = spawn(SANDBOX, ['-p', profile, shell, '-c', command], {
      cwd: folder,
      detached: true,
      windowsHide: true,
      env,
    })
    let output = ''
    let timedOut = false
    const keep = (chunk: Buffer): void => {
      // Twice the cap at most: enough for capOutput to say how much was cut without holding a runaway in memory.
      if (output.length < proMode.outputMax * 2) output += chunk.toString('utf8')
    }
    const stop = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, seconds * 1000)
    const stopped = (): void => stop()
    signal?.addEventListener('abort', stopped, { once: true })
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stopped)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (err) => {
      done()
      reject(err)
    })
    child.on('close', (code) => {
      done()
      resolve({ code, output, timedOut })
    })
  })
}

/** Every attempt, in one line of JSON: when, what, where, what the user said, and how it went. Never the output. */
async function log(entry: {
  command: string
  folder: string
  answer: string
  /** How long it was allowed to run, so the line says what the limit was as well as what happened. */
  timeout?: number
  code?: number | null
  ms?: number
}): Promise<void> {
  try {
    const file = path.join(jaspersHome(), 'data', 'shell.jsonl')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch (err) {
    // The log is a record, not a gate: failing to write it must not decide whether a command runs.
    console.warn('[shell] could not write the log:', err)
  }
}
