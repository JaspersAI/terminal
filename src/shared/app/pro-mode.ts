// Pro mode: whether the assistant may run commands in the user's own shell, and under what limits.
// Off unless the user turns it on in Settings, and there is no way for the assistant to turn it on:
// nothing here is reachable from a tool. Keep this file free of Node and DOM imports — it is the
// rule for what the setting means, which main enforces and the renderer only shows.
//
// This is a trust switch, not a sandbox. A command runs as the user, through their login shell, with
// everything on their PATH. The limits below keep an approved command from running away; they do not
// make an unapproved one safe, which is why every command is approved by hand.

/**
 * How a command is approved: every time, once per exact command in a conversation, or once for the
 * whole conversation. The last is the widest thing the setting can say, and what a workflow of
 * twenty different commands needs to be one answer rather than twenty.
 */
export type ApprovalMode = 'always' | 'once' | 'session'

export interface ProMode {
  enabled: boolean
  /** Whether a command that only reads runs without asking. Off: every command is approved by hand. */
  allowReadOnly: boolean
  /** How long a command may run before it is killed. */
  timeoutSeconds: number
  /** How much of a command's output the assistant is given. What is over it is cut, and said to be cut. */
  outputMax: number
  approval: ApprovalMode
}

/** Long enough for a download or a pass over a file; a script that wants more asks for it, up to the setting. */
export const TIMEOUT_DEFAULT = 120
export const TIMEOUT_MIN = 1
export const TIMEOUT_MAX = 600
export const OUTPUT_DEFAULT = 100_000
export const OUTPUT_MIN = 1_000
export const OUTPUT_MAX = 1_000_000

/** The most a call may be, in characters: a whole script, not a line. It is put in front of the user to approve. */
export const COMMAND_MAX = 10_000

/** Off, two minutes, 100 KB, and every command approved by hand. */
export const PRO_MODE_OFF: ProMode = {
  enabled: false,
  allowReadOnly: false,
  timeoutSeconds: TIMEOUT_DEFAULT,
  outputMax: OUTPUT_DEFAULT,
  approval: 'always',
}

/**
 * The setting as it is stored or as it arrives from the renderer, read the careful way: anything
 * missing or malformed falls back to the safe value rather than becoming a permissive one, and the
 * numbers are held inside their range. Enabled has to be exactly true.
 */
export function readProMode(raw: unknown): ProMode {
  const value = isRecord(raw) ? raw : {}
  return {
    enabled: value['enabled'] === true,
    allowReadOnly: value['allowReadOnly'] === true,
    timeoutSeconds: clamp(value['timeoutSeconds'], TIMEOUT_MIN, TIMEOUT_MAX, TIMEOUT_DEFAULT),
    outputMax: clamp(value['outputMax'], OUTPUT_MIN, OUTPUT_MAX, OUTPUT_DEFAULT),
    approval: value['approval'] === 'once' || value['approval'] === 'session' ? value['approval'] : 'always',
  }
}

/** What the user said about a command they were asked to approve. Anything else is a refusal. */
export type Approval = 'once' | 'conversation' | 'session' | 'task' | 'denied'

export const ALLOW_ONCE = 'Allow once'
export const ALLOW_CONVERSATION = 'Allow in this conversation'
export const ALLOW_SESSION = 'Allow every command in this conversation'
export const DENY = 'Deny'
/** The one allowance that outlives the app's run: it is kept with the task, and goes when the task does. */
export const ALLOW_TASK = 'Allow for this task'

/** How many commands a task may be allowed. A run's shell work belongs in one script, so this is small. */
export const TASK_COMMANDS_MAX = 5

/**
 * The answer as an approval. Only an allowance offered by the setting is an allowance: a closed
 * question, a timeout, a stopped run, and anything the user typed themselves all mean no. Each wider
 * answer is on offer only while the setting says so, so an answer carried over from before it
 * changed cannot widen anything.
 */
export function readApproval(answer: string | null, mode: ApprovalMode): Approval {
  if (answer === ALLOW_ONCE) return 'once'
  if (answer === ALLOW_CONVERSATION && mode === 'once') return 'conversation'
  if (answer === ALLOW_SESSION && mode === 'session') return 'session'
  return 'denied'
}

/**
 * What the user is offered: the exact command for the conversation when the setting asks once per
 * command, every command in the conversation when it asks once per conversation. Allowing once and
 * refusing are always there.
 */
export function approvalChoices(mode: ApprovalMode): string[] {
  if (mode === 'once') return [ALLOW_ONCE, ALLOW_CONVERSATION, DENY]
  if (mode === 'session') return [ALLOW_ONCE, ALLOW_SESSION, DENY]
  return [ALLOW_ONCE, DENY]
}

/**
 * A scheduled task's command is asked about at the moment it is needed: while the task is being made,
 * when the assistant names what its runs will run, and at a run that reaches for one nobody allowed.
 * `scheduling` has no once on offer, since there is no run yet for once to mean anything.
 */
export type TaskApprovalAt = 'scheduling' | 'run'

export function taskApprovalChoices(at: TaskApprovalAt): string[] {
  return at === 'run' ? [ALLOW_ONCE, ALLOW_TASK, DENY] : [ALLOW_TASK, DENY]
}

/**
 * The answer about a task's command, read as strictly as any other: a question nobody answered,
 * which is what a run in the night gets, is a refusal. The conversation's allowances are not on
 * offer here and are not answers: a task's run is not a conversation the user is in.
 */
export function readTaskApproval(answer: string | null, at: TaskApprovalAt): Approval {
  if (answer === ALLOW_TASK) return 'task'
  if (answer === ALLOW_ONCE && at === 'run') return 'once'
  return 'denied'
}

/** A command as it is remembered once allowed for a conversation: the text as it would run, nothing normalized away. */
export function approvalKey(conversation: string, command: string): string {
  return `${conversation}\u0000${command}`
}

/**
 * How long this call may run: what it asked for, held inside the setting, and the setting itself when
 * it asked for nothing or for nonsense. A call can ask for longer than the default and never for
 * longer than the user allowed — the setting is the ceiling, not a suggestion.
 */
export function commandTimeout(requested: unknown, configured: number): number {
  const asked = typeof requested === 'string' ? Number(requested) : requested
  if (typeof asked !== 'number' || !Number.isFinite(asked)) return configured
  return Math.min(Math.max(Math.round(asked), TIMEOUT_MIN), configured)
}

/**
 * What a command is given of the app's environment: the few variables a program needs to find its
 * way, and nothing else. The app's own process holds whatever it was launched with, a provider key
 * among it when one came from the environment, and none of that is a command's business.
 */
export const ENV_KEPT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'] as const

/** That environment, from the app's, with a terminal that claims nothing so a program does not draw. */
export function commandEnv(from: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { TERM: 'dumb' }
  for (const key of ENV_KEPT) {
    const value = from[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  return env
}

/** Output with what is over the cap cut, and a line saying so, so the model never reads a cut as the end. */
export function capOutput(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.length - max
  return `${text.slice(0, max)}\n… ${cut === 1 ? '1 more character was' : `${cut} more characters were`} cut.`
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.round(number), min), max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// What a command may touch, and which commands need no asking. Both are rules rather than
// heuristics: the sandbox profile is what the OS enforces, and the read-only list is a closed set of
// programs in a command with nothing but arguments — no pipe, no redirection, no second command.

/** Programs that only read. `git` is here for its read-only subcommands alone, checked below. */
export const READ_ONLY_PROGRAMS = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'file',
  'stat',
  'du',
  'df',
  'pwd',
  'echo',
  'which',
  'whoami',
  'date',
  'diff',
  'sort',
  'uniq',
  'cut',
  'basename',
  'dirname',
  'sw_vers',
  'uname',
  'git',
] as const

/** The `git` subcommands that only read. Anything else under git asks, `git push` most of all. */
export const READ_ONLY_GIT = ['status', 'log', 'diff', 'show', 'blame', 'describe', 'ls-files', 'rev-parse'] as const

/** What turns one command into something else: another command, a file written, a program's output eaten. */
const SHELL_SYNTAX = /[|&;<>`$(){}\[\]\n\r*?~]|\\\\/

/**
 * Whether a command plainly only reads, and so needs no asking when the user has allowed that. The
 * test is deliberately narrow: one program from the list, arguments that are not options that write,
 * and no shell syntax anywhere, so `cat x | sh` and `find . -delete` are not read-only however they
 * are spelled. Everything else is asked about, which is the safe answer for anything unclear.
 */
export function isReadOnlyCommand(command: string): boolean {
  const line = command.trim()
  if (!line || SHELL_SYNTAX.test(line)) return false
  const words = line.split(/\s+/)
  const [program, ...rest] = words as [string, ...string[]]
  if (!(READ_ONLY_PROGRAMS as readonly string[]).includes(program)) return false
  // The subcommand has to be the first word after git: an option before it takes a value
  // (`git -C repo diff`), and reading past one is how a list like this gets fooled.
  if (program === 'git' && !(READ_ONLY_GIT as readonly string[]).includes(rest[0] ?? '')) return false
  // find runs other programs and deletes; tail -f never ends. Neither is a read to run unasked.
  if (program === 'find' && rest.some((word) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(word))) {
    return false
  }
  if ((program === 'tail' || program === 'head') && rest.includes('-f')) return false
  return true
}

/**
 * The user's folders a command may read but not write: Desktop and Downloads, where a file the user
 * means for it to work on usually is. A script copies what it needs into the shell folder and writes
 * there; nothing of these folders can be changed or deleted from a command.
 */
export function readOnlyFolders(home: string): string[] {
  const base = home.replace(/\/+$/, '')
  return [`${base}/Desktop`, `${base}/Downloads`]
}

/**
 * The macOS sandbox profile a command runs under: it may read and write inside the app's shell
 * folder and the system's temporary folder, read `readable` (the user's Desktop and Downloads), read
 * the system itself and the folders on PATH so a program and its libraries can be found, and nothing
 * else. The rest of the user's files are not readable, and none of them writable.
 *
 * Written as deny-what-matters over an otherwise permissive profile: a profile that denies
 * everything by default has to name every mach service a program might want, and a program that
 * cannot start is indistinguishable from a command that failed.
 */
export function sandboxProfile(folder: string, onPath: string[], readable: string[] = []): string {
  const system = ['/usr', '/bin', '/sbin', '/opt', '/etc', '/var', '/private', '/System', '/Library', '/Applications']
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${subpaths([folder, '/private/var/folders', '/private/tmp', '/dev'])})`,
    '(deny file-read* (subpath "/Users"))',
    `(allow file-read* ${subpaths([folder, ...readable, ...system, ...onPath.filter((entry) => entry.startsWith('/Users'))])})`,
  ]
  return lines.join('\n')
}

/** Paths as a sandbox profile's subpath list, quoted, in order, with the duplicates dropped. */
function subpaths(paths: string[]): string {
  return [...new Set(paths)].map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')
}
