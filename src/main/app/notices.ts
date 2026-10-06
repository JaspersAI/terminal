import { randomUUID } from 'node:crypto'
import { update } from '../state'
import type { Notice } from '../../shared/state'
import { notify, unreadCount } from '../data/store'

// Notices: one line the user is told, like "Credit Analyst finished". Whoever says one, it is
// written down in the store, which is the inbox, and handed to whoever listens for them: the system's
// notifications while the window is not in front, and Eye. Something that arrived at three in the
// morning is still in the inbox.
//
// A task's or the app's own is also said now, in the answer box (`addNotice`): those ride the tree so
// the composer can show them, are capped so a loop cannot pile them up, and fade after a few seconds.
// A plugin's is not (`fileNotice`): the box is the user's conversation with the assistant, and what a
// plugin has to say about its work shows in the views of the work that runs it.

const NOTICES_MAX = 5
const TEXT_MAX = 300

const listeners = new Set<(notice: Notice) => void>()

/** Hears every notice as it is told, whether or not it is said in the answer box. */
export function onNotice(listener: (notice: Notice) => void): void {
  listeners.add(listener)
}

/**
 * Says a line in the answer box, and keeps it. `chat` is the workspace whose conversation already
 * holds what the notice says, when one does. Such a notice stands for the chat, so it takes the place
 * of one before it for the same chat: the chat holds both, and one box shows them.
 */
export function addNotice(plugin: string, raw: string, chat?: string): void {
  const notice = noticeOf(plugin, raw, chat)
  if (!notice) return
  update((state) => ({
    ...state,
    notices: [...state.notices.filter((n) => chat === undefined || n.chat !== chat), notice].slice(-NOTICES_MAX),
  }))
  tell(notice)
}

/** Keeps a line a plugin has for the user, without saying it in the answer box. */
export function fileNotice(plugin: string, raw: string): void {
  const notice = noticeOf(plugin, raw)
  if (notice) tell(notice)
}

/** A line as a notice: one line of it, cut to what a notice may be. Nothing for an empty one. */
function noticeOf(plugin: string, raw: string, chat?: string): Notice | null {
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)
  if (!text) return null
  return { id: randomUUID(), plugin, text, at: Date.now(), ...(chat ? { chat } : {}) }
}

/** Writes a notice down in the inbox and hands it to whoever listens. */
function tell(notice: Notice): void {
  // The inbox keeps it; the unread count follows from what the store says.
  void notify(notice.at, notice.plugin, notice.text).then((unread) => {
    if (unread !== null) setUnread(unread)
  })
  for (const listener of listeners) listener(notice)
}

/** The unread count the inbox view shows. Read from the store, never counted here. */
export function setUnread(unread: number): void {
  update((state) => (state.unread === unread ? state : { ...state, unread }))
}

/** Reads the count back at startup, so it is right before anything new arrives. */
export function startInbox(): void {
  void unreadCount().then(setUnread)
}

export function dismissNotice(id: string): void {
  update((state) =>
    state.notices.some((n) => n.id === id) ? { ...state, notices: state.notices.filter((n) => n.id !== id) } : state,
  )
}
