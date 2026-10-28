import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { askedIn, type Place } from '../../../shared/agent/asking'
import { withAttachments } from '../../../shared/agent/attachments'
import type { Loop } from '../../../shared/loops/loops'
import type { WaitingView } from '../../../shared/plugins/needs'
import { errorMessage } from '../../lib/errors'
import { get, subscribe as subscribeState, useAppState } from '../../lib/state'
import { AttachButton, AttachmentChips, useAttachments, useFileDrop } from '../composer/Attachments'
import { over, type LiveExchange } from '../composer/live'
import { pasteLinks } from '../composer/paste'
import { QuestionField } from '../composer/QuestionField'
import { PAGE } from '../composer/request'
import { SecretField } from '../composer/SecretField'
import { Transcript } from '../composer/Transcript'
import {
  boxesHeard,
  boxesKept,
  boxesSeeded,
  shouldReadTileBox,
  tileBoxExpanded,
  tileBoxOf,
  tileBoxOlder,
  tileBoxRead,
  tileBoxSent,
  tileBoxSettled,
  withTileBox,
  type TileBox,
} from './box'
import { Need } from './Need'

let boxes: ReadonlyMap<string, TileBox> = new Map()
const listeners = new Set<() => void>()
/** The runs heard to end since this window began listening, which an older answer to "what is running" must not bring back. */
const ended = new Set<string>()
let hearing = false

function putBoxes(next: ReadonlyMap<string, TileBox>): void {
  if (next === boxes) return
  boxes = next
  for (const each of listeners) each()
}

function hear(): void {
  if (hearing) return
  hearing = true
  window.app.agent.onEvent((event) => {
    if (event.kind === 'done' || event.kind === 'failed' || event.kind === 'stopped') ended.add(event.runId)
    putBoxes(boxesHeard(boxes, event))
  })
  void window.app.agent.running().then((runs) => {
    putBoxes(boxesSeeded(boxes, runs, ended))
    ended.clear()
  })
  subscribeState(() => putBoxes(boxesKept(boxes, get().grids)))
}

function subscribeBoxes(listener: () => void): () => void {
  hear()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What this window keeps of a tile's box across workspace switches while the tile stays on a grid. */
export function useTileBox(place: Place): TileBox {
  return useSyncExternalStore(subscribeBoxes, () => tileBoxOf(boxes, place))
}

/** Updates one tile's box in this window. */
export function updateTileBox(place: Place, to: (box: TileBox) => TileBox): void {
  hear()
  putBoxes(withTileBox(boxes, place, to))
}

interface Props {
  workspaceId: string
  elementId: string
  loop: Loop
  /** What the tile is, for the field's label: what its work is. */
  label: string
  /** What the user calls the loop: loop_3. */
  called: string
  /** True for a deep research loop, whose field invites follow-up questions rather than view commands. */
  chat: boolean
  /** True while another element is maximized over the tile: nothing in the box can be read then. */
  covered: boolean
  /** True while the tile has no view in it yet: with nothing to make room for, what the box shows open is the tile. */
  fills: boolean
  /** A view in the tile that has nothing to show until its plugin is given a key or a sign-in, when there is one: it is asked for here. */
  need: WaitingView | null
  /** Sets that ask aside, which shows the view as it is. */
  onSkip: () => void
  zoom?: number
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
 * Open, the box shows the loop's conversation (`Transcript`): what was sent, what each run did, and
 * the reply, below what was said before, which it reads from the loop's log a page at a time. Its
 * state (`TileBox`) stays in the window across workspace switches so an open conversation neither
 * collapses nor disappears when switching away and back.
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
  zoom = 1,
}: Props): ReactElement {
  const attachments = useAttachments()
  const drop = useFileDrop(attachments.attach)
  // This tile, as the place a run shows and asks: its workspace, and its element there.
  const place = useMemo(() => ({ workspaceId, on: elementId }), [workspaceId, elementId])
  const tileBox = useTileBox(place)
  const { expanded: open, draft, live, earlier, more } = tileBox
  // The rows as they stand, for what happens between draws: stopping a request, reading the log.
  const now = useRef<LiveExchange[]>(live)
  now.current = live
  const [focused, setFocused] = useState(false)
  const question = useAppState((s) => askedIn(s.questions, place))
  const secret = useAppState((s) => askedIn(s.secretRequests, place))
  const box = useRef<HTMLDivElement>(null)
  const readingOlder = useRef(false)

  const working = live.some((one) => one.working)
  const asked = question?.id ?? (secret ? `${secret.plugin}/${secret.key}` : (need?.name ?? null))
  // The square at the line's end stops while a run works and nothing is typed, and sends otherwise.
  const stopping = working && draft === '' && attachments.files.length === 0
  const shouldRead = shouldReadTileBox(tileBox)

  // What was said before: read on mount with no finished row up, and when opened with unread exchanges.
  useEffect(() => {
    if (!shouldRead) return
    let current = true
    const done = over(now.current)
    readingOlder.current = false
    window.app.agent.history(PAGE, undefined, loop.id).then(
      (page) => {
        if (!current) return
        updateTileBox(place, (b) => tileBoxRead(b, page, done, PAGE))
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [shouldRead, place, loop.id])

  /** The page ahead of what is drawn, asked for as the reader nears its top. */
  const older = useCallback(() => {
    const head = earlier[0]?.id
    if (head === undefined || !more || readingOlder.current) return
    readingOlder.current = true
    window.app.agent.history(PAGE, head, loop.id).then(
      (page) => {
        readingOlder.current = false
        updateTileBox(place, (b) => tileBoxOlder(b, head, page, PAGE))
      },
      () => {
        readingOlder.current = false
      },
    )
  }, [earlier, more, place, loop.id])

  // The keyboard stays in the box when a question takes the line's place, and when the line comes
  // back: the draw that swapped them took the field it was in.
  useLayoutEffect(() => {
    if (focused && !box.current?.contains(document.activeElement)) box.current?.querySelector('input')?.focus()
    // Only as what is asked changes: `focused` is as it was before the swap, which is what is wanted.
  }, [asked])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (attachments.reading > 0) return
    const text = withAttachments(draft, attachments.files)
    if (!text) return
    attachments.clear()
    const ask = crypto.randomUUID()
    updateTileBox(place, (b) => tileBoxSent(b, place, ask, text))
    // A request that began is ended by its run's events. What comes back here settles one that never did.
    window.app.agent.run(text, ask, elementId).then(
      (reply) => updateTileBox(place, (b) => tileBoxSettled(b, ask, reply, null)),
      (err: unknown) => updateTileBox(place, (b) => tileBoxSettled(b, ask, '', errorMessage(err))),
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
    if (open) return updateTileBox(place, (b) => tileBoxExpanded(b, false))
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
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      // The command line is first in the box, at the top of the tile. Open in a tile with no view yet,
      // what it shows fills the tile under it.
      className={`m-1 flex flex-col border border-border bg-background outline-none select-text focus-within:border-foreground ${
        fills && open ? 'min-h-0 flex-1' : 'max-h-1/2 shrink-0'
      } ${drop.dropping ? 'outline-2 -outline-offset-2 outline-foreground outline-dashed' : ''}`}
    >
      {secret !== null ? (
        <SecretField key={`${secret.plugin}/${secret.key}`} request={secret} />
      ) : question !== null ? (
        <QuestionField key={question.id} question={question} shown={!covered} />
      ) : need !== null ? (
        <Need key={need.name} waiting={need} on={elementId} onSkip={onSkip} />
      ) : (
        <form id={`loop-form-${elementId}`} onSubmit={submit} className="flex shrink-0 flex-col p-0.5">
          <div className="flex items-center gap-1">
            <AttachButton compact onFiles={attachments.attach} />
            <input
              id={`loop-input-${elementId}`}
              name="loop-prompt"
              aria-label={`Message ${label}`}
              autoComplete="off"
              value={draft}
              placeholder={chat ? `Ask ${called} more…` : `Tell ${called} what to do…`}
              onChange={(event) =>
                updateTileBox(place, (b) => (b.draft === event.target.value ? b : { ...b, draft: event.target.value }))
              }
              onPaste={(event) => pasteLinks(event, attachments.attach)}
              className="min-w-0 flex-1 bg-transparent px-1 py-1 text-xs outline-none"
            />
            <button
              type={stopping ? 'button' : 'submit'}
              aria-label={stopping ? 'Stop' : 'Send'}
              data-loop-stop={stopping ? '' : undefined}
              disabled={
                !stopping && ((draft.trim() === '' && attachments.files.length === 0) || attachments.reading > 0)
              }
              onClick={
                stopping
                  ? (event) => {
                      event.preventDefault()
                      stopNewest()
                    }
                  : undefined
              }
              style={zoom !== 1 ? { width: `${1.5 * zoom}rem`, height: `${1.5 * zoom}rem` } : undefined}
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
          </div>
          <AttachmentChips attachments={attachments} className="px-1 pt-0.5 pb-0.5" />
        </form>
      )}
      {open && (live.length > 0 || earlier.length > 0) && (
        <Transcript
          named={false}
          earlier={earlier}
          onEarlier={older}
          live={live}
          onStop={stop}
          className="min-h-0 flex-1 border-t border-border px-2 py-1.5"
        />
      )}
    </div>
  )
}
