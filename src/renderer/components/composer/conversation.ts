import { useEffect, useRef } from 'react'
import { rejoin } from '../../../shared/agent/transcript'
import { dispatch } from '../../lib/state'
import { PAGE, type ComposerRequest } from './request'

const ANSWER_MS = 15_000
const FADE_MS = 500

/**
 * The conversation so far, read from main while `when` holds and nothing is in flight: again when
 * `said` names something new in that chat, like a scheduled task's reply, and again as each message
 * of the welcome after setup lands, which `welcome` counts.
 */
export function useEarlier({
  request,
  workspaceId: _workspaceId,
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
  const shown = useRef<boolean>(false)
  useEffect(() => {
    if (!when || !idle) return
    let live = true
    window.app.agent.history(PAGE).then(
      (got) => {
        if (!live) return
        shown.current = true
        setEarlier((was) => rejoin(was, got))
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [when, idle, said, welcome])

  const head = earlier[0]?.id
  const reading = useRef(false)
  const first = useRef<number | undefined>(undefined)

  /** Reads the page ahead of the first exchange up and puts it above the rest, one read at a time. */
  return function more(): void {
    if (head === undefined || head === first.current || reading.current || !shown.current) return
    reading.current = true
    window.app.agent.history(PAGE, head).then(
      (older) => {
        reading.current = false
        if (older.length < PAGE) first.current = older[0]?.id ?? head
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
 * told to drop it.
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
