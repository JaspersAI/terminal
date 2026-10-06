import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { ADDED, THINKING } from '../../../shared/agent/agent'
import type { Citation } from '../../../shared/agent/citations'
import type { Exchange } from '../../../shared/agent/transcript'
import { useAppState } from '../../lib/state'
import type { LiveExchange } from './live'
import { MarkdownText } from './MarkdownText'

/** How near the top of what is drawn the reader comes before the exchanges ahead of it are asked for, in px. */
const NEAR_TOP = 240

interface Props {
  /** The conversation before the requests still on screen as they were sent, oldest first. A notice has none. */
  earlier?: Exchange[]
  /** Asks for the exchanges ahead of the first one here. Called whenever the reader is near the top of them. */
  onEarlier?: () => void
  /**
   * The requests this window sent that are still as it sent them, under the conversation: each its
   * question, its run's trail, and its reply as it is written. Any number of them may be working at
   * once.
   */
  live?: LiveExchange[]
  /** Stops the run of one of them. Offered beside its trail while it works. */
  onStop?: (ask: string) => void
  /** Who a notice is from, in small type over its text. A conversation has none. */
  label?: string
  /** A notice's text. */
  text?: string
  /**
   * Whether the last request carries the ids a driven run waits on. Only the global conversation's
   * does: an id names one thing, and a tile's box draws this too.
   */
  named?: boolean
  /** What the scroller is: the floating box caps its height, the docked chat fills what it is given. */
  className: string
}

const NONE: LiveExchange[] = []

/**
 * The conversation itself, whatever holds it: the exchanges so far, then what the user asked as a
 * bubble on the right in the interface face, so a voice user sees what was heard, and under it the
 * orchestrator's reply in the prose face a size up, its Markdown rendered (`MarkdownText`), or three
 * squares pulsing in turn while it works. A scheduled task's reply sits among them where it was said
 * (`TaskReply`), and so does a message of the welcome after setup, as prose alone. A reply that cites
 * its sources shows them as numbered marks with the list under it.
 * The floating answer box (`Answer`), the docked chat view (`views/Chat`), and a tile's box
 * (`LoopBox`), for the conversation of the work the tile belongs to, all show this, so a conversation
 * reads the same wherever it is.
 *
 * A request starts as it is sent, so several may be working at once: each is an exchange of its own
 * at the end (`LiveRow`), with its own trail and its own Stop, in the order `live.ts` keeps them: as
 * sent while they work, and one that ends under the ones that ended before it.
 *
 * It keeps its end in view: a run's steps as they land and its reply as it is written stay on screen,
 * however long the trail over them has grown. A reader who scrolls up has it from there, and it
 * follows again once they scroll back down to the end, or send a question.
 *
 * The whole conversation is there to scroll back through, a page at a time: what is handed in is its
 * end, and nearing the top of that asks for the page ahead of it (`onEarlier`), which joins above
 * without moving what is being read.
 */
export function Transcript({
  earlier = [],
  onEarlier,
  live = NONE,
  onStop,
  label,
  text,
  named = true,
  className,
}: Props): ReactElement {
  const scroller = useRef<HTMLDivElement>(null)
  // Whether the end is kept in view: until the reader scrolls up from it, and again once they are back.
  const follow = useRef(true)
  // The requests drawn last, by name: one not among them has just been sent.
  const drawn = useRef<string[]>([])
  // The exchange at the top of what was last drawn, and where the reader was in it: how far down, and
  // how far from the end.
  const top = useRef<number | undefined>(undefined)
  const at = useRef(0)
  const fromEnd = useRef(0)

  useLayoutEffect(() => {
    const asks = live.map((one) => one.ask)
    // A question just sent is where the reader is now, wherever they had read back to.
    if (asks.some((ask) => !drawn.current.includes(ask))) follow.current = true
    drawn.current = asks
    const el = scroller.current
    if (!el) return
    const was = top.current
    top.current = earlier[0]?.id
    if (follow.current) {
      el.scrollTop = el.scrollHeight
    } else if (was !== undefined && was !== top.current && earlier.some((one) => one.id === was)) {
      // A page joined above what the reader has in hand. The same distance from the end is the same
      // place, since nothing under it changed; left alone, the page would push it down out of view.
      el.scrollTop = el.scrollHeight - fromEnd.current
    }
    reached(el)
    // Every change to a request still on screen: a step landing over what its run has written, its
    // reply growing, or Stop coming and going, moves what is under it.
  }, [earlier, live, text])

  // What holds it may change its height under the same words: a question taking room above it, its
  // tile resized. Its end stays in view through that too, unless the reader has it.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /**
   * Where the reader is now, kept for the next move and for when a page joins above; and near the
   * top, the page ahead is asked for.
   */
  function reached(el: HTMLDivElement): void {
    at.current = el.scrollTop
    fromEnd.current = el.scrollHeight - el.scrollTop
    if (el.scrollTop < NEAR_TOP) onEarlier?.()
  }

  /**
   * The box moved. Up and off its end, the reader has it; back down to its end, it follows again. A
   * move up that leaves it at its end is the box itself, grown taller over the same words, and
   * changes nothing.
   */
  function moved(el: HTMLDivElement): void {
    const was = at.current
    reached(el)
    // Within a pixel of it: the heights are whole numbers and the place is not.
    const atEnd = fromEnd.current - el.clientHeight <= 1
    if (el.scrollTop < was && !atEnd) follow.current = false
    else if (el.scrollTop > was && atEnd) follow.current = true
  }

  /**
   * The wheel turned up with room above: the reader has it. Said here, before the move it makes says
   * so, since a line landing in between would take the box back to its end and the turn with it. A
   * pinch arrives as a wheel too, and scrolls nothing.
   */
  function letGo(event: ReactWheelEvent<HTMLDivElement>): void {
    if (event.deltaY < 0 && !event.ctrlKey && event.currentTarget.scrollTop > 0) follow.current = false
  }

  return (
    <div
      ref={scroller}
      onWheel={letGo}
      onScroll={(event: ReactUIEvent<HTMLDivElement>) => moved(event.currentTarget)}
      className={`overflow-y-auto ${className}`}
    >
      {earlier.map((exchange, index) => (
        // Its place in the log, which holds as pages join above; one not filed yet has only its place here.
        <EarlierExchange key={exchange.id ?? `unfiled-${index}`} exchange={exchange} />
      ))}
      {live.map((exchange, index) => (
        <LiveRow key={exchange.ask} exchange={exchange} last={named && index === live.length - 1} onStop={onStop} />
      ))}
      {label !== undefined && <p className="mb-1 text-xs text-muted-foreground">{label}</p>}
      {text !== undefined && (
        <div id="agent-reply" className="animate-appear font-prose text-prose">
          <MarkdownText source={text} />
        </div>
      )}
    </div>
  )
}

/**
 * One request still on screen as it was sent: the question, the trail of its run, and the reply as it
 * is written. Drawn again only when it changes, so a reply arriving a piece at a time redraws itself
 * and not the requests working beside it. The last one of the global conversation carries the ids a
 * driven run waits on (`#agent-question`, `#agent-thinking`, `#agent-reply`, `#agent-stop`); every one
 * carries `data-live`.
 */
const LiveRow = memo(function LiveRow({
  exchange,
  last,
  onStop,
}: {
  exchange: LiveExchange
  last: boolean
  onStop?: (ask: string) => void
}): ReactElement {
  const { ask, question, answer, citations, steps, thinking, working, error } = exchange
  const stop = onStop ? () => onStop(ask) : undefined
  return (
    <div data-live={working ? 'working' : 'over'} className="mb-5 last:mb-0">
      <Bubble id={last ? 'agent-question' : undefined} text={question} />
      {answer === null ? (
        <Trail steps={steps} thinking={thinking} error={error} working={working} last={last} onStop={stop} />
      ) : (
        <>
          {/* Until the run is over the trail works and Stop stays, whatever has been written under it. */}
          {(steps.length > 0 || working) && (
            <Trail steps={steps} thinking={thinking} error={null} working={working} last={last} onStop={stop} />
          )}
          <div id={last ? 'agent-reply' : undefined} data-reply className="animate-appear font-prose text-prose">
            <MarkdownText source={answer} citations={citations} />
          </div>
          {error && <p className="mt-1 text-sm break-words text-destructive">{error}</p>}
        </>
      )}
    </div>
  )
})

/**
 * One exchange already in the conversation. It reads as a finished request does: what its run did,
 * dimmed, above its reply, and for one that failed, why, where a reply would be. One filed before the
 * log kept a run's steps has only its words. Drawn once and kept: a reply arriving a piece at a time
 * under a long conversation redraws itself, not every exchange above it.
 */
const EarlierExchange = memo(function EarlierExchange({ exchange }: { exchange: Exchange }): ReactElement {
  return (
    <div data-earlier className="mb-5 last:mb-0">
      {exchange.task !== undefined ? (
        <TaskReply task={exchange.task} text={exchange.answer} citations={exchange.citations} />
      ) : exchange.welcome ? (
        // The assistant speaking unasked, with nothing over it.
        <div data-welcome className="font-prose text-prose">
          <MarkdownText source={exchange.answer} citations={exchange.citations} />
        </div>
      ) : (
        <>
          <Bubble text={exchange.question} />
          {exchange.steps && exchange.steps.length > 0 && (
            <Trail steps={exchange.steps} error={null} working={false} last={false} />
          )}
          {exchange.answer !== '' && (
            <div className="font-prose text-prose">
              <MarkdownText source={exchange.answer} citations={exchange.citations} />
            </div>
          )}
          {exchange.error && <p className="mt-1 text-sm break-words text-destructive">{exchange.error}</p>}
        </>
      )}
    </div>
  )
})

/**
 * What a scheduled task's run said, where it was said: no question over it, and a rule down its side
 * under the task it came from, so it reads as the assistant speaking unasked.
 */
function TaskReply({ task, text, citations }: { task: string; text: string; citations?: Citation[] }): ReactElement {
  // What the task does says more than its id, while the task is there to ask.
  const does = useAppState((s) => s.tasks.find((t) => t.id === task)?.instructions)
  return (
    <div data-task={task} className="border-l-2 border-border pl-3">
      <p className="mb-1 truncate text-xs text-muted-foreground">
        Task {task}
        {does ? ` · ${does}` : ''}
      </p>
      <div className="font-prose text-prose">
        <MarkdownText source={text} citations={citations} />
      </div>
    </div>
  )
}

/** What the user asked, on the right. */
function Bubble({ id, text }: { id?: string; text: string }): ReactElement {
  return (
    <div className="mb-3 flex justify-end">
      <p id={id} className="max-w-[85%] bg-muted px-3 py-1.5 text-sm whitespace-pre-wrap">
        {text}
      </p>
    </div>
  )
}

/**
 * What the run is doing, in the conversation itself: each step on a line, the newest with the
 * squares pulsing beside it while the run works, and Stop at the end. While its model is asked, the
 * last line is what the model is thinking (`data-thinking`), which is no step: it changes as the
 * model thinks and goes when the model says or does something. Once the run is over the trail stays
 * above the reply, dimmed, so a long run still shows what it did. An error takes the place of the
 * squares. `#agent-thinking` is the block of the last request sent while it works, which a driven run
 * waits on; a request sent before it and still working has no id, since an id names one thing.
 */
export function Trail({
  steps,
  thinking = null,
  error,
  working,
  last,
  onStop,
}: {
  steps: string[]
  /** What the run's model is thinking now, while the run waits on it. */
  thinking?: string | null
  error: string | null
  working: boolean
  last: boolean
  onStop?: () => void
}): ReactElement {
  // A run that has begun and said nothing yet is thinking too: its first round has not said so.
  const now = working ? (thinking ?? (steps.length === 0 && !error ? THINKING : null)) : null
  const lines = now === null ? steps : [...steps, now]
  return (
    <div
      id={working && last ? 'agent-thinking' : undefined}
      data-trail
      role={working ? 'status' : undefined}
      className={`mb-2 text-sm ${working ? '' : 'opacity-60'}`}
    >
      {lines.map((line, index) => {
        const newest = index === lines.length - 1
        const thought = newest && now !== null
        // What the user added while the run was at work is theirs, and reads as theirs among the steps.
        const added = !thought && line.startsWith(ADDED)
        return (
          <p
            key={index}
            data-added={added ? '' : undefined}
            data-thinking={thought ? '' : undefined}
            className={`flex min-h-[22px] items-center gap-2 ${added ? 'text-foreground' : 'text-muted-foreground'}`}
          >
            {/* A thought is not a step: it reads as one passing, apart from what was said and done. */}
            <span className={`min-w-0 break-words ${thought ? 'italic' : ''}`}>{line}</span>
            {working && newest && (
              <span aria-hidden className="flex shrink-0 gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 animate-dots bg-muted-foreground"
                    style={{ animationDelay: `${i * 160}ms` }}
                  />
                ))}
              </span>
            )}
          </p>
        )
      })}
      {error && <p className="mt-1 text-sm break-words text-destructive">{error}</p>}
      {working && onStop && (
        <button
          type="button"
          id={last ? 'agent-stop' : undefined}
          data-stop
          onClick={onStop}
          className="mt-1.5 border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Stop
        </button>
      )}
    </div>
  )
}
