import type { ConnectionForm } from './connection-plugin.ts'
import { isPluginId } from './id.ts'
import type { InstallRequest, PreparedInstall } from './install.ts'
import { isHandle } from '../hub/hub.ts'
import type { PreparedSkill } from '../skills/skill-install.ts'

// The assistant starting an install: a plugin, skills, or a connection, from a link it was given or
// an item on Jaspers Hub. It goes through the same staging the Settings panes use, and what is staged is
// put in front of the user as a question before anything of it is moved into place, built, or run.
// What the question says, and how its answer is read, is here; main only stages, asks, and confirms.
//
// The answer is read the strict way the shell's is: the one Install choice installs, and anything
// else — Cancel, a closed question, a stopped run, nobody there — cancels.

export const INSTALL = 'Install'
export const ADD_CONNECTION = 'Add connection'
export const CANCEL = 'Cancel'

/** True only when the user picked the choice that goes ahead. */
export function approvedInstall(answer: string | null, yes: string = INSTALL): boolean {
  return answer === yes
}

/**
 * The plugin the model named, as a request the install takes: an item on Jaspers Hub by its
 * handle/name, or a link as typed (a GitHub repo, an archive, an item's page on Hub), for the
 * install's own parser to accept or refuse.
 */
export function pluginRequest(value: unknown): InstallRequest {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text)
    throw new Error(
      'source is the plugin to install: a GitHub repo, an https link to its archive, or a Jaspers Hub item as handle/name.',
    )
  const [handle, name, ...rest] = text.split('/')
  if (handle && name && rest.length === 0 && isHandle(handle) && isPluginId(name)) return { kind: 'hub', handle, name }
  return { kind: 'url', text }
}

/** What the user is asked before a staged plugin is installed, and the details shown beside it. */
export function pluginQuestion(prepared: PreparedInstall): { text: string; code: string } {
  const replaces = prepared.replaces ? ` It replaces the installed ${prepared.replaces.version}.` : ''
  return {
    text: `Install the plugin ${prepared.id} ${prepared.version}? Nothing of it runs until you say Install.${replaces}`,
    code: [
      `plugin   ${prepared.id}`,
      `version  ${prepared.version}`,
      `from     ${prepared.source}`,
      `sha256   ${prepared.sha256}`,
      ...(prepared.description ? ['', prepared.description] : []),
    ].join('\n'),
  }
}

/** An explicit selection from the model; an empty list means only an explicit all: true. */
export function skillNames(input: Record<string, unknown>): string[] {
  if (input.all === true && input.names === undefined) return []
  if (
    input.all !== undefined ||
    !Array.isArray(input.names) ||
    input.names.length === 0 ||
    !input.names.every((name): name is string => typeof name === 'string' && name.trim() !== '')
  ) {
    throw new Error('Give a non-empty names list or all: true to install skills, never both.')
  }
  return input.names.map((name) => name.trim())
}

/**
 * The staged skills to install: the ones named, or, with no names, every one that can be. Throws, in
 * words for the model, when a name is not in the source or none can be installed.
 */
export function chooseSkills(skills: readonly PreparedSkill[], names: readonly string[]): PreparedSkill[] {
  const installable = skills.filter((skill) => skill.error === null)
  if (names.length === 0) {
    if (installable.length === 0) {
      const why = skills.map((skill) => `${skill.name}: ${skill.error}`).join('; ')
      throw new Error(
        skills.length === 0 ? 'The source has no skill in it.' : `No skill in it can be installed. ${why}`,
      )
    }
    return installable
  }
  return names.map((name) => {
    const skill = skills.find((one) => one.name === name)
    if (!skill) throw new Error(`The source has no skill ${name}. It has ${skills.map((s) => s.name).join(', ')}.`)
    if (skill.error !== null) throw new Error(`${name} cannot be installed: ${skill.error}`)
    return skill
  })
}

/** What the user is asked before staged skills are installed: each by name, with its SKILL.md to read. */
export function skillsQuestion(source: string, chosen: readonly PreparedSkill[]): { text: string; code: string } {
  const names = chosen.map((skill) => skill.name)
  const scripts = chosen.some((skill) => skill.scripts)
    ? ' It includes scripts, which Jaspers lists for the assistant to read and never runs.'
    : ''
  const text = `Install the skill${names.length === 1 ? '' : 's'} ${names.join(', ')} from ${source}?${scripts}`
  const code = chosen
    .map((skill) => {
      const replaces = skill.replaces ? ` (replaces ${skill.replaces.version ?? 'the installed one'})` : ''
      return [`── ${skill.name}${replaces}: ${skill.files} file${skill.files === 1 ? '' : 's'}`, skill.preview].join(
        '\n',
      )
    })
    .join('\n\n')
  return { text, code }
}

/**
 * A connection's form from what the model sent: an http URL or a stdio command, and how it signs in.
 * Checked afterwards by the same `checkForm` the Settings pane uses.
 */
export function connectionForm(input: Record<string, unknown>): ConnectionForm {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')
  const command = text('command')
  const transport = command && !text('url') ? 'stdio' : 'http'
  const auth = input['auth'] === 'bearer' ? 'bearer' : input['auth'] === 'oauth' ? 'oauth' : 'none'
  const tools = Array.isArray(input['tools'])
    ? input['tools'].filter((tool): tool is string => typeof tool === 'string' && tool.trim() !== '')
    : []
  return {
    id: text('name'),
    transport,
    url: transport === 'http' ? text('url') : '',
    command: transport === 'stdio' ? command : '',
    auth,
    keyLabel: auth === 'bearer' ? text('keyLabel') || 'API key' : '',
    envName: auth === 'bearer' && transport === 'stdio' ? text('envName') : '',
    tools,
  }
}

/** What the user is asked before a connection is added. A stdio command runs on their computer, so it is shown whole. */
export function connectionQuestion(form: ConnectionForm): { text: string; code: string } {
  const where =
    form.transport === 'stdio'
      ? 'It starts this command on your computer whenever it connects.'
      : 'It connects to this address.'
  const signIn =
    form.auth === 'bearer'
      ? `It signs in with a ${form.keyLabel}, which you type into the secure field, never into the chat.`
      : form.auth === 'oauth'
        ? 'It signs in through your browser.'
        : 'It needs no sign-in.'
  return {
    text: `Add the connection ${form.id}? ${where} ${signIn}`,
    code: [
      form.transport === 'stdio' ? `command  ${form.command}` : `url      ${form.url}`,
      ...(form.auth === 'bearer' && form.envName ? [`key env  ${form.envName}`] : []),
      `tools    ${form.tools.length > 0 ? form.tools.join(', ') : 'all of them'}`,
    ].join('\n'),
  }
}
