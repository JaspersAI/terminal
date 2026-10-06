// AGENT.md: what is always true, as opposed to a skill, which is how to do one kind of work and is
// loaded when a request calls for it. It goes in the fixed block of the system prompt, which is the
// part a provider can cache, so saying it costs nothing after the first round.

/** What one file may contribute. It is in every round of every request, so it is not a document. */
export const STANDING_MAX = 4000

export interface Standing {
  /** What applies everywhere. */
  app: string
  /** What applies on this workspace only. */
  workspace: string
}

/**
 * The two files as one block, or '' when there are none, which is the usual case. The workspace's
 * comes second, so where the two disagree the nearer one is read last.
 */
export function standingText(standing: Standing): string {
  const parts: string[] = []
  const app = clean(standing.app)
  const workspace = clean(standing.workspace)
  if (app) parts.push(`Standing instructions from the user:\n${app}`)
  if (workspace) parts.push(`Standing instructions for this workspace:\n${workspace}`)
  return parts.join('\n\n')
}

/** A file as it will be sent: trimmed, capped, and with the cap said out loud rather than silently. */
export function clean(text: string): string {
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  if (trimmed.length <= STANDING_MAX) return trimmed
  return `${trimmed.slice(0, STANDING_MAX)}\n[cut: AGENT.md is longer than ${STANDING_MAX} characters, and the rest is not being sent.]`
}
