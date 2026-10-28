import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { CHANGE_TEXT, globalRoomLog, searchRooms, type GlobalLogEntry } from '../../../shared/loops/closed'
import { loopName } from '../../../shared/loops/loops'
import { shortLocal } from '../../../shared/tasks/tasks'
import { errorMessage } from '../../lib/errors'
import { currentWorkspace, dispatch, useAppState } from '../../lib/state'
import { BUTTON } from './Row'

interface Props {
  onClose: () => void
}

/**
 * Rooms (global room directory & tile log), opened from the header bar or Settings: every room across
 * all tabs in the terminal, open and saved in memory, ordered chronologically by its most recent
 * activity first, with keyword search across descriptions, prompts, plugins, panel summaries, and
 * conversations. A closed room is kept in memory with its views and conversation, and Reopen brings it
 * onto the current tab; an open room can be jumped to or closed, and permanent deletion requires
 * explicit confirmation.
 */
export function LoopsDialog({ onClose }: Props): ReactElement {
  const workspace = useAppState(currentWorkspace)
  const workspaces = useAppState((s) => s.workspaces)
  const open = useAppState((s) => s.loops)
  const closed = useAppState((s) => s.closedLoops)
  const grids = useAppState((s) => s.grids)
  const allEntries = useMemo(() => globalRoomLog(workspaces, open, closed), [workspaces, open, closed])
  const [query, setQuery] = useState('')
  const [exchangeText, setExchangeText] = useState<Record<string, string>>({})
  const [failed, setFailed] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = Date.now()

  useEffect(() => {
    searchInput.current?.focus() ?? dialog.current?.focus()
  }, [])

  // Load recent exchange text per room so keyword search covers room conversations as well as metadata.
  useEffect(() => {
    let active = true
    const ids = allEntries.map((e) => e.loop.id)
    Promise.all(
      ids.map(async (id) => {
        try {
          const hist = await window.app.agent.history(10, undefined, id)
          return [id, hist.map((ex) => `${ex.question}\n${ex.answer}`).join('\n')] as const
        } catch {
          return [id, ''] as const
        }
      }),
    ).then((pairs) => {
      if (!active) return
      setExchangeText(Object.fromEntries(pairs))
    })
    return () => {
      active = false
    }
  }, [allEntries])

  const extraText = useMemo(() => {
    const map: Record<string, string> = { ...exchangeText }
    for (const entry of allEntries) {
      const tabGrids = grids[entry.workspaceId] ?? {}
      const panelLines: string[] = []
      for (const grid of Object.values(tabGrids)) {
        const roomElemIds = new Set(grid.elements.filter((e) => e.loop === entry.loop.id).map((e) => e.id))
        for (const p of grid.panels) {
          if (!roomElemIds.has(p.elementId)) continue
          if (p.summary) panelLines.push(p.summary)
          if (p.text) panelLines.push(p.text.slice(0, 2000))
        }
      }
      map[entry.loop.id] = [map[entry.loop.id] ?? '', ...panelLines].filter(Boolean).join('\n')
    }
    return map
  }, [allEntries, grids, exchangeText])

  const log = useMemo(() => searchRooms(allEntries, query, extraText), [allEntries, query, extraText])

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [])

  const act = (action: Parameters<typeof dispatch>[0]): void => {
    setFailed(null)
    dispatch(action).catch((err: unknown) => setFailed(errorMessage(err)))
  }

  return (
    <div
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
    >
      <div
        ref={dialog}
        id="loops-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="loops-title"
        tabIndex={-1}
        className="relative flex max-h-176 w-full max-w-2xl flex-col border border-border bg-background shadow-2xl outline-none"
      >
        <button
          type="button"
          aria-label="Close rooms"
          onClick={onClose}
          className="absolute top-2 right-2 z-10 flex h-8 w-8 items-center justify-center bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-3 w-3 stroke-current stroke-[1.25]">
            <path d="M1 1 9 9M9 1 1 9" />
          </svg>
        </button>
        <div className="shrink-0 px-6 pt-5 pb-4">
          <h2 id="loops-title" className="text-base font-semibold">
            Rooms
          </h2>
          <p className="mt-1 pr-8 text-sm text-muted-foreground">
            Every room saved in memory across all tabs, ordered chronologically by last activity. Reopen a saved room
            onto {workspace.name} to carry on where it stopped, or search by keyword.
          </p>
          <div className="mt-3">
            <input
              ref={searchInput}
              id="rooms-search-input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search rooms by keyword, plugin, description, or conversation…"
              aria-label="Search rooms"
              className="w-full border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground"
            />
          </div>
          {failed && <p className="mt-2 text-sm text-destructive">{failed}</p>}
        </div>
        {allEntries.length === 0 ? (
          <p className="border-t border-border px-6 py-5 text-sm text-muted-foreground">
            No rooms in memory yet. Ask Central to set one up.
          </p>
        ) : log.length === 0 ? (
          <p className="border-t border-border px-6 py-5 text-sm text-muted-foreground">
            No rooms match &ldquo;{query.trim()}&rdquo;.
          </p>
        ) : (
          <ol id="loop-log" className="min-h-0 overflow-y-auto border-t border-border px-6">
            {log.map((entry) => (
              <LogRow
                key={entry.loop.id}
                entry={entry}
                currentTabId={workspace.id}
                when={(at) => shortLocal(at, now, timeZone)}
                onJump={() => {
                  act({ type: 'tab.select', id: entry.workspaceId })
                  onClose()
                }}
                onClose={() => act({ type: 'room.close', workspaceId: entry.workspaceId, room: entry.loop.id })}
                onReopen={() => act({ type: 'room.reopen', workspaceId: workspace.id, room: entry.loop.id })}
                onDelete={() => act({ type: 'room.delete', workspaceId: entry.workspaceId, room: entry.loop.id })}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

interface RowProps {
  entry: GlobalLogEntry
  currentTabId: string
  when: (at: number) => string
  onJump: () => void
  onClose: () => void
  onReopen: () => void
  onDelete: () => void
}

/** One room in the global directory: its name, status/tab, description, activity history, and actions. */
function LogRow({ entry, currentTabId, when, onJump, onClose, onReopen, onDelete }: RowProps): ReactElement {
  const [confirming, setConfirming] = useState(false)
  const { loop, open, changes, workspaceId, workspaceName, lastActiveAt } = entry
  const [last, ...earlier] = changes
  return (
    <li
      data-loop={loop.id}
      data-room={loop.id}
      data-open={open}
      className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border py-3 last:border-b-0"
    >
      <div className="min-w-0 flex-1 text-sm">
        <p className="truncate">
          <span className="font-medium">{loopName(loop.id)}</span>
          <span className={open ? 'text-foreground' : 'text-muted-foreground'}>
            {' · '}
            {open ? `Open in ${workspaceName}` : 'Saved in memory'}
          </span>
          {loop.model && <span className="text-xs text-muted-foreground"> · {loop.model}</span>}
        </p>
        <p className="truncate text-muted-foreground">{loop.desc}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Last active {when(lastActiveAt)}
          {last && (
            <>
              {' · '}
              {CHANGE_TEXT[last.change]} {when(last.at)}
            </>
          )}
          {earlier.map((one, at) => (
            <span key={at}>
              {' · '}
              {CHANGE_TEXT[one.change]} {when(one.at)}
            </span>
          ))}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {confirming ? (
          <>
            <span className="text-xs text-muted-foreground">Permanently delete room and its conversation?</span>
            <button type="button" data-delete-now onClick={onDelete} className={`${BUTTON} text-destructive`}>
              Delete permanently
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={BUTTON}>
              Keep
            </button>
          </>
        ) : (
          <>
            {open && workspaceId !== currentTabId && (
              <button type="button" data-jump onClick={onJump} className={BUTTON}>
                Go to tab
              </button>
            )}
            {open ? (
              <button type="button" data-close onClick={onClose} className={BUTTON}>
                Close
              </button>
            ) : (
              <button type="button" data-reopen onClick={onReopen} className={BUTTON}>
                Reopen
              </button>
            )}
            <button type="button" data-delete onClick={() => setConfirming(true)} className={BUTTON}>
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  )
}
