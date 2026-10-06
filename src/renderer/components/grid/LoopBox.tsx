import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { askedIn } from '../../../shared/agent/asking'
import type { Exchange } from '../../../shared/agent/transcript'
import type { Loop } from '../../../shared/loops/loops'
import type { WaitingView } from '../../../shared/plugins/needs'
import { errorMessage } from '../../lib/errors'
import { useAppState } from '../../lib/state'
import { over, without, type LiveExchange } from '../composer/live'
import { QuestionField } from '../composer/QuestionField'
import { PAGE } from '../composer/request'
import { SecretField } from '../composer/SecretField'
import { Transcript } from '../composer/Transcript'
import { boxActivity, boxFresh, boxHeard, boxSent, boxSettled, type Activity } from './box'
import { Need } from './Need'
import { Progress } from './Progress'

interface Props {
  workspaceId: string
  elementId: string
  loop: Loop
  /** What the tile is, for the field's label: what its work is. */
  label: string
  /** What the user calls the loop: loop_3. */
  called: string
  /** Whether the conversation is shown under the line: only a deep research loop's is. */
  chat: boolean
  /** True while another element is maximized over the tile: nothing in the box can be read then. */
  covered: boolean
  /** True while the tile has no view in it yet: with nothing to make room for, what the box shows open is the tile. */
  fills: boolean
  /** A view in the tile that has nothing to show until its plugin is given a key or a sign-in, when there is one: it is asked for here. */
  need: WaitingView | null
  /** Sets that ask aside, which shows the view as it is. */
  onSkip: () => void
  /** Whether the box is open under its line. Folded by default: the label in the loop's bar opens it, or a run begun with no view in the tile yet. */
  expanded: boolean
  /** Opens or folds it. */
  onExpand: (expanded: boolean) => void
  /** Told how its requests stand, for the label in the loop's bar, whenever that changes. */
  onActivity: (activity: Activity | null) => void
}

/**
 * A loop's command line, in its tile: a box under the bar whose line goes to the loop's agent. It is
 * folded by default, the line and nothing else, and opens when the label in the loop's bar is pressed
 * (`barLabel`), which says meanwhile how its requests stand and what the run at work is doing, or by
 * itself as a run begins in a tile with no view yet, which the first view to land folds again
 * (`boxOpens`, in `ElementFrame`). Escape folds it too. Open, it sits above the loop's views and pushes
 * them down, never over them, and takes at most half the tile; in a tile with no view yet it fills the
 * tile.
 *
 * What it shows open depends on the loop. Only a deep research loop, whose answer is its
 * conversation, shows the conversation: what was sent, what the run is doing, and the reply, below
 * what was said before, which it reads from the loop's log a page at a time. Any other loop never shows
 * its conversation, which is kept all the same: open, its box shows the request at work, the steps its
 * run takes, and how the last one ended (`Progress`). A new request takes the place of what was over.
 *
 * It follows the runs on its tile by what main says of them (`box.ts`), not by having sent them, so a
 * run shows here in whichever window holds the tile, after the page is drawn again, and when the
 * global box handed it over. A message sent while one is being worked on waits its turn. Stop, the
 * square at the line's end while a run works, names the request it stops, so no other run is touched.
 * Escape stops a working run first, then folds the box, then gives the keyboard up.
 *
 * A question or a key the run asks for takes the line's place until it is answered: one thing to
 * type into at a time, and the keyboard goes with it if the box had it. What a view in the tile is
 * waiting on, a key its plugin declares or a sign-in, is asked for the same way (`Need`), behind what
 * a run asks, and Escape sets it aside as its cross does.
 *
 * The log is read only while no row of its own is up, and opening a conversation lets the rows that
 * are over go first, so an exchange is drawn from one or the other and never both.
 */
export function LoopBox({
  workspaceId,
  elementId,
  loop,
  label,
  called,
  chat,
  covered,
  fills,
  need,
  onSkip,
  expanded,
  onExpand,
  onActivity,
}: Props): ReactElement {
  const [draft, setDraft] = useState('')
  const [live, setLive] = useState<LiveExchange[]>([])
  // The rows as they stand, for what happens between draws: an event landing, a reply coming back.
  const now = useRef<LiveExchange[]>(live)
  const [earlier, setEarlier] = useState<Exchange[]>([])
  const [focused, setFocused] = useState(false)
  // This tile, as the place a run shows and asks: its workspace, and its element there.
  const place = useMemo(() => ({ workspaceId, on: elementId }), [workspaceId, elementId])
  const question = useAppState((s) => askedIn(s.questions, place))
  const secret = useAppState((s) => askedIn(s.secretRequests, place))
  const box = useRef<HTMLDivElement>(null)
  // Whether the log has exchanges ahead of the ones read, and whether a page of them is on its way.
  const ahead = useRef({ any: true, reading: false })

  const working = live.some((one) => one.working)
  const asked = question?.id ?? (secret ? `${secret.plugin}/${secret.key}` : (need?.name ?? null))
  const open = expanded
  const idle = live.length === 0
  // Whether a conversation in view is drawn from the rows: it keeps the ones that are over. Set once a
  // draw is committed, since the event listener reads it between draws.
  const inView = useRef(false)
  useLayoutEffect(() => {
    inView.current = chat && open
  }, [chat, open])
  // The square at the line's end stops while a run works and nothing is typed, and sends otherwise.
  const stopping = working && draft === ''

  const change = useCallback((to: (list: LiveExchange[]) => LiveExchange[]): void => {
    now.current = to(now.current)
    setLive(now.current)
  }, [])

  // How the requests stand, for the label in the bar.
  const activity = useMemo(() => boxActivity(live), [live])
  useEffect(() => onActivity(activity), [activity, onActivity])

  // What main says of the runs on this tile. One begun elsewhere joins as a request sent here does.
  useEffect(
    () =>
      window.app.agent.onEvent((event) =>
        change((list) => {
          const next = boxHeard(list, event, place)
          return event.kind === 'start' && next.length > list.length ? boxFresh(next, inView.current) : next
        }),
      ),
    [place, change],
  )

  // The runs already in flight on this tile: the window opened partway through one.
  useEffect(() => {
    let current = true
    void window.app.agent.running().then((runs) => {
      if (!current) return
      for (const run of runs) {
        const { workspaceId: runsOn } = run
        // Only a tile's run says where it is; `boxHeard` takes the ones that are here.
        if (runsOn !== undefined) {
          change((list) => boxHeard(list, { kind: 'start', label: '', ...run, workspaceId: runsOn }, place))
        }
      }
    })
    return () => {
      current = false
    }
  }, [place, change])

  // What was said before, read while a conversation is shown and open with no row of its own up.
  useEffect(() => {
    if (!chat || !open || !idle) return
    let current = true
    ahead.current = { any: true, reading: false }
    window.app.agent.history(PAGE, undefined, loop.id).then(
      (page) => {
        if (!current) return
        setEarlier(page)
        if (page.length < PAGE) ahead.current.any = false
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [chat, open, idle, loop.id])

  // Opened, a conversation is drawn from the log, which has what is over.
  useEffect(() => {
    if (chat && open) change((list) => (list.some((one) => one.working) ? list : without(list, over(list))))
  }, [chat, open, change])

  /** The page ahead of what is drawn, asked for as the reader nears its top. */
  const older = useCallback(() => {
    const head = earlier[0]?.id
    if (head === undefined || !ahead.current.any || ahead.current.reading) return
    ahead.current.reading = true
    window.app.agent.history(PAGE, head, loop.id).then(
      (page) => {
        ahead.current.reading = false
        if (page.length < PAGE) ahead.current.any = false
        // Onto the list it was read for, and no other: the log may have been read again since.
        if (page.length > 0) setEarlier((had) => (had[0]?.id === head ? [...page, ...had] : had))
      },
      () => {
        ahead.current.reading = false
      },
    )
  }, [earlier, loop.id])

  // The keyboard stays in the box when a question takes the line's place, and when the line comes
  // back: the draw that swapped them took the field it was in.
  useLayoutEffect(() => {
    if (focused && !box.current?.contains(document.activeElement)) box.current?.querySelector('input')?.focus()
    // Only as what is asked changes: `focused` is as it was before the swap, which is what is wanted.
  }, [asked])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const ask = crypto.randomUUID()
    change((list) => boxSent(boxFresh(list, chat && open), ask, workspaceId, text))
    // A request that began is ended by its run's events. What comes back here settles one that never did.
    window.app.agent.run(text, ask, elementId).then(
      (reply) => change((list) => boxSettled(list, ask, reply, null)),
      (err: unknown) => change((list) => boxSettled(list, ask, '', errorMessage(err))),
    )
  }

  /** Stops one request by the name it was sent under: its run, or its wait for a turn, and no other. */
  const stop = useCallback((ask: string): void => {
    const row = now.current.find((one) => one.ask === ask)
    if (row) void window.app.agent.stop(row.runId ?? undefined, row.ask)
  }, [])

  /** Stops the request sent last that is still working. Answers whether there was one. */
  function stopNewest(): boolean {
    const newest = [...now.current].reverse().find((one) => one.working)
    if (newest) stop(newest.ask)
    return newest !== undefined
  }

  function keyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    // A question or a key field a run put up here hears its own Escape.
    if (event.key !== 'Escape' || question !== null || secret !== null) return
    event.stopPropagation()
    if (need !== null) return onSkip()
    if (stopNewest()) return
    if (open) return onExpand(false)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  return (
    <div
      ref={box}
      id={`loop-box-${elementId}`}
      data-loop-box
      data-open={open}
      // It can hold the keyboard itself, so a press on what it shows keeps the keyboard in it.
      tabIndex={-1}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!box.current?.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
      onKeyDown={keyDown}
      // The command line is first in the box, at the top of the tile. Open in a tile with no view yet,
      // what it shows fills the tile under it.
      className={`m-1 flex flex-col border border-border bg-background outline-none select-text focus-within:border-foreground ${
        fills && open ? 'min-h-0 flex-1' : 'max-h-1/2 shrink-0'
      }`}
    >
      {secret !== null ? (
        <SecretField key={`${secret.plugin}/${secret.key}`} request={secret} />
      ) : question !== null ? (
        <QuestionField key={question.id} question={question} shown={!covered} />
      ) : need !== null ? (
        <Need key={need.name} waiting={need} on={elementId} onSkip={onSkip} />
      ) : (
        <form id={`loop-form-${elementId}`} onSubmit={submit} className="flex shrink-0 items-center gap-1 p-0.5">
          <input
            id={`loop-input-${elementId}`}
            name="loop-prompt"
            aria-label={`Message ${label}`}
            autoComplete="off"
            value={draft}
            placeholder={chat ? `Ask ${called} more…` : `Tell ${called} what to do…`}
            onChange={(event) => setDraft(event.target.value)}
            className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-xs outline-none"
          />
          <button
            type={stopping ? 'button' : 'submit'}
            aria-label={stopping ? 'Stop' : 'Send'}
            data-loop-stop={stopping ? '' : undefined}
            disabled={!stopping && draft.trim() === ''}
            onClick={
              stopping
                ? (event) => {
                    event.preventDefault()
                    stopNewest()
                  }
                : undefined
            }
            className="flex h-6 w-6 shrink-0 items-center justify-center bg-primary text-primary-foreground disabled:opacity-30"
          >
            {stopping ? (
              <span aria-hidden className="h-2 w-2 bg-current" />
            ) : (
              <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
                <path d="M5 9V1.5M1.5 5 5 1.5 8.5 5" />
              </svg>
            )}
          </button>
        </form>
      )}
      {chat && open && (live.length > 0 || earlier.length > 0) && (
        <Transcript
          named={false}
          earlier={earlier}
          onEarlier={older}
          live={live}
          onStop={stop}
          className="min-h-0 flex-1 border-t border-border px-2 py-1.5"
        />
      )}
      {!chat && open && live.length > 0 && <Progress live={live} onStop={stop} />}
    </div>
  )
}
