import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  approvalChoices,
  approvalKey,
  askCommand,
  askTaskAtRunCommand,
  askTaskCommand,
  capOutput,
  COMMAND_MAX,
  commandParameterDescription,
  commandTimeout,
  isReadOnlyCommand,
  readApproval,
  readTaskApproval,
  runShellDescription,
  taskApprovalChoices,
  type Approval,
} from '../../../shared/app/pro-mode'
import { askUser } from '../../actions'
import { jaspersHome } from '../../home'
import { getState } from '../../state'
import { allowTaskCommand, taskAllows } from '../../tasks/tasks'
import { TASK_PRO_MODE_OFF } from '../../../shared/tasks/tasks'
import { askedBy } from '../utils/runs'
import { execute, isSandboxed } from './shell-run'
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
// On macOS, sandbox-exec runs a command under a profile that may read and write only inside the
// app's shell folder, read the user's Desktop and Downloads, read the system and the folders on
// PATH so a program can be found, and nothing else. On Linux and Windows, where sandbox-exec is not
// available, the command runs with the app's shell folder as its working directory and a sanitized
// environment (`commandEnv`).

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
  description: runShellDescription(process.platform, isSandboxed()),
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: commandParameterDescription(process.platform, isSandboxed()),
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
    const command = asCommand(input.command)
    const folder = await shellFolder()
    const confined = isSandboxed()
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
              await askUser(
                askTaskAtRunCommand(task, folder, seconds, confined),
                taskApprovalChoices('run'),
                context.signal,
                command,
              ),
              'run',
            )
        : allowed.has(key)
          ? 'conversation'
          : allowedSessions.has(conversation)
            ? 'session'
            : readApproval(
                await askUser(
                  askCommand(folder, seconds, confined),
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
    if (!getState().proMode.enabled) {
      throw new Error(
        'Pro mode is off, so nothing can be run on this computer. Tell the user it is in Settings > Pro mode, and that turning it on is theirs to do.',
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
    throw new Error(TASK_PRO_MODE_OFF)
  }
  const folder = await shellFolder()
  const confined = isSandboxed()
  const scripts = [...new Set(commands.map(asCommand))]
  for (const command of scripts) {
    if (!getState().proMode.enabled) {
      throw new Error(TASK_PRO_MODE_OFF)
    }
    const approval = readTaskApproval(
      await askUser(
        askTaskCommand(folder, proMode.timeoutSeconds, confined),
        taskApprovalChoices('scheduling'),
        context.signal,
        command,
        askedBy(context.runId),
      ),
      'scheduling',
    )
    if (!getState().proMode.enabled) {
      throw new Error(TASK_PRO_MODE_OFF)
    }
    await log({ command, folder, answer: approval === 'task' ? 'task, when scheduled' : 'denied, when scheduled' })
    if (!getState().proMode.enabled) {
      throw new Error(TASK_PRO_MODE_OFF)
    }
    if (approval !== 'task') {
      throw new Error(
        `The user did not allow the task \`${command}\`, so nothing was scheduled or changed. Leave it; say what the task would have run and ask what they would rather do.`,
      )
    }
  }
  return scripts
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
