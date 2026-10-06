import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { usePublish, usePublishText } from '@jaspers-ai/sdk'
import { dispatch, useAppState } from '../lib/state'
import type { ViewProps } from './index'

// Everything the app has told you, kept. A notice is what is said now and is gone in fifteen
// seconds; this is the record of it, so something that arrived overnight is here in the morning.
// Whatever raised it is its source: a plugin's id, a task, or the app.

interface Item {
  id: number
  at: number
  source: string
  text: string
  read: boolean
}

export function Inbox({ panel }: ViewProps): ReactElement {
  const unread = useAppState((s) => s.unread)
  const [items, setItems] = useState<Item[] | null>(null)

  // Re-read when the count moves, which is what happens when something new arrives or is read.
  const load = useCallback((): void => {
    window.app.inbox
      .list(200)
      .then(setItems)
      .catch(() => setItems([]))
  }, [])
  useEffect(load, [load, unread])

  usePublish(panel, { unread, count: items?.length ?? 0 })
  usePublishText(
    panel,
    items && items.length > 0 ? items.map((one) => `${when(one.at)} ${one.source}: ${one.text}`).join('\n') : null,
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs">
          {unread > 0 ? `${unread} unread` : items === null ? '' : items.length === 0 ? 'Nothing yet' : 'All read'}
        </span>
        {unread > 0 && (
          <button
            type="button"
            onClick={() => void dispatch({ type: 'inbox.read', ids: [] })}
            className="ml-auto border border-border px-2 py-0.5 text-xs hover:bg-muted"
          >
            Mark all read
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items === null ? (
          <p className="p-3 text-xs text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">
            Nothing has been said yet. A task that finds something, or a plugin that has news, lands here.
          </p>
        ) : (
          <ul>
            {items.map((one) => (
              <li key={one.id} className="border-b border-border/60">
                <button
                  type="button"
                  onClick={() => one.read || void dispatch({ type: 'inbox.read', ids: [one.id] })}
                  className={`block w-full px-3 py-2 text-left hover:bg-muted ${one.read ? '' : 'bg-muted/40'}`}
                >
                  <span className="flex items-baseline gap-2">
                    {/* A square rather than a dot: the house style has no round corners. */}
                    <span
                      aria-hidden
                      className={`mt-1 h-1.5 w-1.5 shrink-0 ${one.read ? 'bg-transparent' : 'bg-foreground'}`}
                    />
                    <span className="min-w-0 flex-1 text-xs break-words">{one.text}</span>
                  </span>
                  <span className="mt-0.5 block pl-3.5 text-[11px] text-muted-foreground">
                    {one.source} · {when(one.at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** The clock alone for today, the date as well for anything older. */
function when(at: number): string {
  const date = new Date(at)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return date.toLocaleString(
    undefined,
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  )
}
