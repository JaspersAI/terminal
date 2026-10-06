import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import { endedAs, type Exchange } from '../../../shared/agent/transcript'
import type { Loop } from '../../../shared/loops/loops'
import { loopName } from '../../../shared/loops/loops'
import { menuOf } from '../../../shared/loops/menu'
import { useAppState } from '../../lib/state'
import { PAGE } from '../composer/request'
import { send } from './send'
import { useLoopStatus } from './status'

interface Props {
  workspaceId: string
  elementId: string
  loop: Loop
  /** The button that opens it: a press there is the button's to answer, not a press outside. */
  opener: RefObject<HTMLButtonElement | null>
  /** True on a minimized tile, which is as tall as its bar: the menu hangs below it, as tall as it needs. */
  hangs: boolean
  onClose: () => void
}

/**
 * A tile's menu, under its bar. First what may be done, so it is reached however long the rest is:
 * what the loop is doing stopped, the loop closed, which keeps it for View loops in Settings to
 * reopen, and the loop deleted for good, which asks once here rather than in a dialog. Then what the loop was
 * told of, with each connection and what it is doing, and the work's timeline, newest first, each
 * request with the steps its run took and how it ended. It is drawn inside its
 * tile, like the tile's box, so it works in every window. It closes on Escape, on a press outside it,
 * when the window loses the keyboard, and with its tile.
 */
export function LoopMenu({ workspaceId, elementId, loop, opener, hangs, onClose }: Props): ReactElement | null {
  // The slices the rule reads, each as the tree holds it, so the menu is rebuilt only when one changes.
  const loops = useAppState((s) => s.loops[workspaceId])
  const plugins = useAppState((s) => s.plugins)
  const connections = useAppState((s) => s.connections)
  const menu = useMemo(
    () => menuOf({ loops: { [workspaceId]: loops ?? [] }, plugins, connections }, workspaceId, loop.id),
    [workspaceId, loop.id, loops, plugins, connections],
  )
  const [timeline, setTimeline] = useState<Exchange[]>([])
  /** The oldest exchange read, while there may be more before it. */
  const [earlier, setEarlier] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const reading = useRef(0)
  const status = useLoopStatus(workspaceId, loop.id)

  /** Reads a page of the work's log, as its box reads it (every key the app holds masked), newest first. */
  const read = useCallback(
    (before?: number) => {
      const request = ++reading.current
      window.app.agent.history(PAGE, before, loop.id).then(
        (page) => {
          if (request !== reading.current) return
          const newestFirst = [...page].reverse()
          setTimeline((had) => (before === undefined ? newestFirst : [...had, ...newestFirst]))
          setEarlier(page.length === PAGE ? (page[0]?.id ?? null) : null)
        },
        // The work went while this was open: there is nothing to read, and the menu goes with its tile.
        () => {
          if (request === reading.current) setEarlier(null)
        },
      )
    },
    [workspaceId, loop.id],
  )

  useEffect(() => {
    read()
    return () => {
      reading.current++
    }
  }, [read])

  // The menu holds the keyboard while it is open, so Escape reaches it: on opening, and again when
  // the button that was pressed goes (Delete becoming its question, or Keep taking that back).
  useEffect(() => {
    root.current?.focus()
  }, [confirming])

  /** Stops what the work is doing: every run of its in flight, and no other. */
  const stop = useCallback(() => {
    void window.app.agent.running().then((runs) => {
      for (const run of runs) {
        if (run.loop === loop.id && run.workspaceId === workspaceId) void window.app.agent.stop(run.runId)
      }
    })
  }, [workspaceId, loop.id])

  useEffect(() => {
    const pressed = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (root.current?.contains(target) || opener.current?.contains(target)) return
      onClose()
    }
    // In the capture phase: a press on a tile's bar is stopped before it reaches the document.
    document.addEventListener('pointerdown', pressed, true)
    // A press inside a view's own frame never reaches this document; the window losing the keyboard does.
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', pressed, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, opener])

  if (!menu) return null
  const item = 'px-2 py-1 text-left hover:bg-muted'

  return (
    <div
      ref={root}
      id={`loop-menu-${elementId}`}
      role="dialog"
      aria-label={`More for ${loopName(loop.id)}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onClose()
      }}
      // Above the edges that resize and the bar's buttons, and inside the tile: it scrolls when the tile is short.
      className={`absolute top-6 right-0 z-30 flex w-72 max-w-full flex-col overflow-y-auto border border-border bg-background text-xs outline-none select-text ${
        hangs ? 'max-h-80' : 'max-h-[calc(100%-1.5rem)]'
      }`}
    >
      <div className="flex shrink-0 flex-col border-b border-border py-1">
        {status === 'working' && (
          <button type="button" data-stop onClick={stop} className={item}>
            Stop what it is doing
          </button>
        )}
        <button
          type="button"
          data-close
          onClick={() => send({ type: 'loop.close', workspaceId, loop: loop.id })}
          className={item}
        >
          Close this loop
        </button>
        {confirming ? (
          <div data-confirm className="px-2 py-1">
            <p>Delete it for good, with its conversation? Closing keeps it in View loops, in Settings.</p>
            <div className="mt-1 flex gap-1">
              <button
                type="button"
                data-delete-now
                onClick={() => send({ type: 'loop.delete', workspaceId, loop: loop.id })}
                className="border border-destructive px-2 py-0.5 text-destructive"
              >
                Delete
              </button>
              <button
                type="button"
                data-keep
                onClick={() => setConfirming(false)}
                className="border border-border px-2 py-0.5"
              >
                Keep
              </button>
            </div>
          </div>
        ) : (
          <button type="button" data-delete onClick={() => setConfirming(true)} className={`${item} text-destructive`}>
            Delete this loop
          </button>
        )}
      </div>
      <section className="border-b border-border p-2">
        <h3 className="mb-1 text-muted-foreground">Told of</h3>
        {menu.plugins.length === 0 ? (
          <p>No plugins</p>
        ) : (
          <ul>
            {menu.plugins.map((plugin) => (
              <li key={plugin.id} data-plugin={plugin.id} className="mb-1 last:mb-0">
                <p className="truncate">
                  {plugin.id}
                  {plugin.installed ? '' : ' · not installed'}
                </p>
                {plugin.connections.map((one) => (
                  <p key={one.id} data-connection={one.id} className="truncate pl-2 text-muted-foreground">
                    {one.id} · {one.status}
                    {one.error ? ` · ${one.error}` : ''}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="p-2">
        <h3 className="mb-1 text-muted-foreground">Timeline</h3>
        {timeline.length === 0 ? (
          <p>Nothing has been said yet</p>
        ) : (
          <ol>
            {timeline.map((one, at) => (
              <Entry key={one.id ?? `at-${at}`} exchange={one} />
            ))}
          </ol>
        )}
        {earlier !== null && (
          <button
            type="button"
            data-earlier
            onClick={() => read(earlier)}
            className="mt-1 text-muted-foreground underline"
          >
            Earlier
          </button>
        )}
      </section>
    </div>
  )
}

/** One request in the timeline: what was asked, the steps its run took, and how it ended. */
function Entry({ exchange }: { exchange: Exchange }): ReactElement {
  const ended = endedAs(exchange)
  const how =
    ended === 'failed'
      ? `Failed: ${exchange.error ?? ''}`
      : ended === 'stopped'
        ? 'Stopped'
        : (exchange.answer.trim().split('\n')[0] ?? '')
  return (
    <li data-exchange data-ended={ended} className="mb-2 last:mb-0">
      <p className="truncate">{exchange.question}</p>
      {exchange.steps && exchange.steps.length > 0 && (
        <p className="truncate text-muted-foreground">{exchange.steps.join(' · ')}</p>
      )}
      <p className={`truncate ${ended === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{how}</p>
    </li>
  )
}
