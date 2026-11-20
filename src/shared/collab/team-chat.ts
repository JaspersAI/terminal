// Built-in human-to-human team chat (`core/team-chat`): pure rules for reading, stamping, and
// summarizing direct teammate chat messages in shared rooms without triggering any AI agent.
// Pure: no Node or DOM imports.

import { asEmail, cleanPersonName, personName } from './collab.ts'

export const TEAM_CHAT_VIEW = 'core/team-chat'
export const TEAM_CHAT_PLUGIN_ID = 'team-chat'
export const TEAM_CHAT_PLUGIN_TITLE = 'Team Chat'
export const TEAM_CHAT_PLUGIN_DESCRIPTION =
  'Direct human-to-human chat rooms with teammates, without AI agent triggers.'
export const TEAM_CHAT_MESSAGE_MAX = 8_000
export const TEAM_CHAT_MESSAGES_MAX = 500

const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const CLOCK_SKEW_MAX_MS = 5 * 60_000

export interface TeamChatMessage {
  id: string
  senderEmail: string
  senderFirstName?: string
  senderLastName?: string
  text: string
  at: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isValidTeamChatMessageId(id: string): boolean {
  return MESSAGE_ID_RE.test(id)
}

export function readTeamChatMessage(raw: unknown, expectedId?: string): TeamChatMessage | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!MESSAGE_ID_RE.test(id)) return null
  if (expectedId !== undefined && id !== expectedId) return null
  const rawEmail = typeof raw.senderEmail === 'string' ? raw.senderEmail.trim() : ''
  const senderEmail = asEmail(rawEmail) ?? (rawEmail.length > 0 && rawEmail.length <= 254 ? rawEmail : null)
  if (!senderEmail) return null
  const rawText = typeof raw.text === 'string' ? raw.text : ''
  const text = rawText.replace(/\r\n/g, '\n').trim()
  if (!text || text.length > TEAM_CHAT_MESSAGE_MAX) return null
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at >= 0 ? raw.at : null
  if (at === null) return null
  const firstName = cleanPersonName(raw.senderFirstName)
  const lastName = cleanPersonName(raw.senderLastName)
  return {
    id,
    senderEmail,
    ...(firstName ? { senderFirstName: firstName } : {}),
    ...(lastName ? { senderLastName: lastName } : {}),
    text,
    at,
  }
}

/** Reads `state.messages` (or a whole `panel.state`) into chronologically ordered messages. */
export function readTeamChatMessages(raw: unknown): TeamChatMessage[] {
  const map = isRecord(raw) && isRecord(raw.messages) && !('senderEmail' in raw) ? raw.messages : raw
  if (!isRecord(map)) return []
  const parsed: TeamChatMessage[] = []
  for (const [key, value] of Object.entries(map)) {
    const msg = readTeamChatMessage(value, key)
    if (msg) parsed.push(msg)
  }
  parsed.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  return parsed.length > TEAM_CHAT_MESSAGES_MAX ? parsed.slice(-TEAM_CHAT_MESSAGES_MAX) : parsed
}

/**
 * Validates and stamps a teammate's incoming `set` command on a `core/team-chat` tile:
 * only appending a new message under `['messages', id]` is allowed, and the sender's email and
 * name come from the authenticated `WireCommand`, never from untrusted client JSON.
 */
export function stampIncomingTeamChatMessage(
  path: readonly string[],
  value: unknown,
  existingState: Record<string, unknown>,
  sender: { email: string; firstName?: string; lastName?: string },
  now: number,
): TeamChatMessage | null {
  if (path.length !== 2 || path[0] !== 'messages') return null
  const id = path[1] ?? ''
  if (!MESSAGE_ID_RE.test(id)) return null
  const existingMap = isRecord(existingState.messages) ? existingState.messages : {}
  if (Object.hasOwn(existingMap, id)) return null
  if (!isRecord(value)) return null
  const rawText = typeof value.text === 'string' ? value.text : ''
  const text = rawText.replace(/\r\n/g, '\n').trim()
  if (!text || text.length > TEAM_CHAT_MESSAGE_MAX) return null
  const senderEmail = asEmail(sender.email) ?? sender.email.trim()
  if (!senderEmail) return null
  const clientAt = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : null
  const at = clientAt !== null && Math.abs(clientAt - now) <= CLOCK_SKEW_MAX_MS ? clientAt : now
  const firstName = cleanPersonName(sender.firstName)
  const lastName = cleanPersonName(sender.lastName)
  return {
    id,
    senderEmail,
    ...(firstName ? { senderFirstName: firstName } : {}),
    ...(lastName ? { senderLastName: lastName } : {}),
    text,
    at,
  }
}

export function formatTeamChatTranscript(messages: readonly TeamChatMessage[]): string | null {
  if (messages.length === 0) return null
  return messages
    .map(
      (msg) =>
        `${personName({ email: msg.senderEmail, firstName: msg.senderFirstName, lastName: msg.senderLastName })}: ${msg.text}`,
    )
    .join('\n\n')
}

export function summarizeTeamChat(_state: unknown, output: unknown): string {
  const count = isRecord(output) && typeof output.messageCount === 'number' ? output.messageCount : 0
  if (count <= 0) return 'no messages yet'
  return count === 1 ? '1 message' : `${count} messages`
}
