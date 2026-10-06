import { useEffect, useRef, useState } from 'react'
import { rejoin } from '../../../shared/agent/transcript'
import { dispatch } from '../../lib/state'
import { PAGE, type ComposerRequest } from './request'

const ANSWER_MS = 15_000
const FADE_MS = 500

/** Keeps display timers separate from the request that produced the answer. */
export function useConversation({
  open,
  request,
  workspaceId,
  showNotice,
  noticeId,
  noticeInChat,
  blocked,
  welcome,
}: {
  open: boolean
  request: ComposerRequest
  workspaceId: string
  showNotice: boolean
  noticeId: string | null
  /** The notice is a task's reply this workspace's chat already holds, so the box shows the chat for it. */
  noticeInChat: boolean
  blocked: boolean
  /** How many messages of the welcome after setup this chat holds, while it is being said; null otherwise. */
  welcome: number | null
}) {
  const { shown, away, earlier, sequence, dismiss, setEarlier } = request
  // Every request on screen answered: what is up has landed. One working out of sight does not hold
  // it there: its box was dismissed from over it, and its own reply brings it back.
  const landed = shown.length > 0 && shown.every((one) => !one.working && one.answer !== null && one.error === null)
  const [closedSequence, setClosedSequence] = useState<number | null>(null)
  const [fadeSequence, setFadeSequence] = useState<number | null>(null)
  const [noticeFading, setNoticeFading] = useState(false)
  const historyClosed = closedSequence === sequence
  const fading = fadeSequence === sequence
  // The conversation, up with the composer: what was said, and under it whatever works out of sight.
  const browsing =
    open && !historyClosed && (earlier.length > 0 || away.length > 0) && shown.length === 0 && !showNotice && !blocked
  const conversation = useLeaving(browsing, FADE_MS)
  // The notice bringing the chat up, by id, while it does.
  const told = showNotice && noticeInChat ? noticeId : null

  function close(): void {
    dismiss()
    setClosedSequence(open ? sequence : null)
  }

  function closeHistory(): void {
    setClosedSequence(sequence)
  }

  /** The notice goes. One that brought the chat up takes the chat with it, which would stay up in its place otherwise. */
  function closeNotice(): void {
    if (noticeId === null) return
    dismissNotice(noticeId)
    if (told !== null && open) setClosedSequence(sequence)
  }

  // The conversation so far, asked of main whenever the composer comes up with nothing in flight.
  const more = useEarlier({ request, workspaceId, when: open || told !== null, said: told, welcome })
  useEffect(() => {
    if (!open) setClosedSequence(null)
  }, [open])
  // Something new in the chat opens it again, if it was closed.
  useEffect(() => {
    if (told !== null) setClosedSequence(null)
  }, [told])
  useEffect(() => {
    if (welcome !== null) setClosedSequence(null)
  }, [welcome])

  // A notice goes the way an answer does: it sits, fades, and is gone, and main forgets it then.
  useEffect(() => {
    if (!showNotice || noticeId === null) return
    setNoticeFading(false)
    const fade = setTimeout(() => setNoticeFading(true), ANSWER_MS)
    const drop = setTimeout(() => dismissNotice(noticeId), ANSWER_MS + FADE_MS)
    return () => {
      clearTimeout(fade)
      clearTimeout(drop)
    }
  }, [showNotice, noticeId])

  // An answer clears itself: wait, fade, then drop the text. The wait runs from the moment the
  // answer lands and nothing pauses it, not even a pointer resting on the box — the box comes to
  // rest where the pointer usually already is, so holding it there held every answer forever.
  // It has landed once its run is over, not before: what a run has written so far is there while it
  // still works, a line said before a tool call, and waiting on that took the box, its trail and its
  // Stop from under a run that went on for longer than the wait. With several requests up, the wait
  // starts when the last of them is over: the box stays while anything in it works.
  useEffect(() => {
    if (!landed) return
    const timer = setTimeout(() => setFadeSequence(sequence), ANSWER_MS)
    return () => clearTimeout(timer)
  }, [landed, sequence])
  // Once they have sat, they join the conversation above them. With the composer up the box is
  // wanted, so that happens where it stands; away, the box fades out first.
  useEffect(() => {
    if (!fading || !landed) return
    const retire = (): void => {
      // As main would hand each back: an answer that cites nothing carries no list, and it keeps what
      // its run did, so the trail does not go when the reply joins the conversation.
      const said = shown.map(({ question, answer, citations, steps }) => ({
        question,
        answer: answer ?? '',
        ...(citations.length > 0 ? { citations } : {}),
        ...(steps.length > 0 ? { steps } : {}),
      }))
      setEarlier((was) => [...was, ...said])
      dismiss()
      setFadeSequence(null)
    }
    if (open) return retire()
    const timer = setTimeout(retire, FADE_MS)
    return () => clearTimeout(timer)
  }, [fading, open, landed, shown])

  return { browsing, conversation, historyClosed, fading, noticeFading, close, closeHistory, closeNotice, more }
}

/**
 * The conversation so far, read from main while `when` holds and nothing is in flight: again when the
 * workspace changes under it, since the chat is the workspace's, and again when `said` names
 * something new in that chat, like a scheduled task's reply, and again as each message of the welcome
 * after setup lands, which `welcome` counts. The overlay reads it while it is up; the docked chat,
 * which is always up, reads it whenever it is idle.
 *
 * What it reads is the end of the chat, a page of it, and it goes under whatever the reader has gone
 * back through. The rest is a page further up each time the function it returns is called, which the
 * transcript does as the reader nears the top.
 */
export function useEarlier({
  request,
  workspaceId,
  when,
  said = null,
  welcome = null,
}: {
  request: ComposerRequest
  workspaceId: string
  when: boolean
  said?: string | null
  welcome?: number | null
}): () => void {
  const { earlier, setEarlier } = request
  const idle = request.shown.length === 0
  // The workspace whose chat is up, once it has been read: until then what is up is the one before it.
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (!when || !idle) return
    let live = true
    window.app.agent.history(PAGE).then(
      (got) => {
        if (!live) return
        shown.current = workspaceId
        // Under the pages the reader went back through: a reply landing at the end takes none away.
        setEarlier((was) => rejoin(was, got))
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [when, idle, workspaceId, said, welcome])

  const head = earlier[0]?.id
  const reading = useRef(false)
  // The exchange nothing is filed ahead of, known once a page has come back short.
  const first = useRef<number | undefined>(undefined)

  /** Reads the page ahead of the first exchange up and puts it above the rest, one read at a time. */
  return function more(): void {
    // One read off a thread has no id: there is no log to read further into. And what is up has to be
    // this workspace's chat, not the one before it, still on screen until this one's is read.
    if (head === undefined || head === first.current || reading.current) return
    if (shown.current !== workspaceId) return
    reading.current = true
    window.app.agent.history(PAGE, head).then(
      (older) => {
        reading.current = false
        if (older.length < PAGE) first.current = older[0]?.id ?? head
        // Onto the list it was read for, and no other: the chat may have been read again since.
        if (older.length > 0) setEarlier((was) => (was[0]?.id === head ? [...older, ...was] : was))
      },
      () => {
        reading.current = false
      },
    )
  }
}

/**
 * A notice's life where nothing fades it: it sits as long as it does in the answer box, then main is
 * told to drop it, so one shown in the docked chat goes the way one shown over the composer does.
 */
export function useNoticeTimer(noticeId: string | null): void {
  useEffect(() => {
    if (noticeId === null) return
    const drop = setTimeout(() => dismissNotice(noticeId), ANSWER_MS + FADE_MS)
    return () => clearTimeout(drop)
  }, [noticeId])
}

/** Main drops the notice and the next one, if any, takes its place by push. */
function dismissNotice(id: string): void {
  void dispatch({ type: 'notice.dismiss', id }).catch(() => undefined)
}

/** Whether something that fades out is still on screen: while `on`, and for `ms` after, leaving then. */
function useLeaving(on: boolean, ms: number): { mounted: boolean; leaving: boolean } {
  const [lingering, setLingering] = useState(false)
  useEffect(() => {
    if (on) return setLingering(true)
    const timer = setTimeout(() => setLingering(false), ms)
    return () => clearTimeout(timer)
  }, [on, ms])
  return { mounted: on || lingering, leaving: !on && lingering }
}
