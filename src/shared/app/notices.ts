import type { Notice } from '../state.ts'

/** How many notices the answer box holds at once. */
export const NOTICES_MAX = 5

/**
 * The notices on screen once `notice` is said. A notice standing for a chat takes the place of one
 * before it for the same chat: the chat holds both, and one box shows them. The same line said again
 * by the same speaker takes the place of the one still up, so a button pressed five times that is
 * refused five times leaves one line to dismiss, not five.
 */
export function withNotice(notices: Notice[], notice: Notice): Notice[] {
  const kept = notices.filter(
    (n) =>
      !(notice.chat !== undefined && n.chat === notice.chat) &&
      !(n.plugin === notice.plugin && n.text === notice.text && n.chat === notice.chat),
  )
  return [...kept, notice].slice(-NOTICES_MAX)
}
