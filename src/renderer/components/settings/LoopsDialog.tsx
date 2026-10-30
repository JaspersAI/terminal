import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { TerminalSession } from '../../../shared/agent/history'
import type { Exchange } from '../../../shared/agent/transcript'
import { CHANGE_TEXT, globalRoomLog, searchRooms, type GlobalLogEntry } from '../../../shared/loops/closed'
import { loopTitle } from '../../../shared/loops/loops'
import { shortLocal } from '../../../shared/tasks/tasks'
import { errorMessage } from '../../lib/errors'
import { currentWorkspace, dispatch, useAppState } from '../../lib/state'
import { useRequest } from '../composer/request'
import { BUTTON } from './Row'

interface Props {
  onClose: () => void
}

/**
 * Rooms & Sessions log dialog, opened from the header bar ("Rooms") or Settings:
 * - "Rooms" view: every room across all tabs in the terminal, open and saved in memory, ordered
 *   chronologically by last activity, with keyword search, Jump to tab, Reopen, Close, and Delete.
 * - "Sessions" view: every Terminal Session from start to finish, with full scrollable conversation
 *   context and keyword search.
 */
export function LoopsDialog({ onClose }: Props): ReactElement {
  const workspace = useAppState(currentWorkspace)
  const workspaces = useAppState((s) => s.workspaces)
  const open = useAppState((s) => s.loops)
  const closed = useAppState((s) => s.closedLoops)
  const grids = useAppState((s) => s.grids)
  const request = useRequest()
  const allEntries = useMemo(() => globalRoomLog(workspaces, open, closed), [workspaces, open, closed])
  const [mode, setMode] = useState<'rooms' | 'sessions'>('rooms')
  const [query, setQuery] = useState('')
  const [exchangeText, setExchangeText] = useState<Record<string, string>>({})
  const [sessions, setSessions] = useState<TerminalSession[]>([])
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

  // Load saved Terminal Sessions from main whenever the dialog opens or switches to Sessions.
  useEffect(() => {
    let active = true
    window.app.agent
      .sessions()
      .then((list) => {
        if (active) setSessions(list)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [mode, request.earlier.length, request.shown.length])

  const mergedSessions = useMemo(() => {
    if (sessions.length > 0) return sessions
    if (request.earlier.length === 0 && request.shown.length === 0) return []
    const liveDone: Exchange[] = request.shown
      .filter((one) => !one.working && (one.answer || one.error))
      .map((one, idx) => ({
        id: idx + 1,
        question: one.question,
        answer: one.answer ?? '',
        steps: one.steps,
        ...(one.error ? { error: one.error } : {}),
      }))
    const allExchanges = [...request.earlier, ...liveDone]
    if (allExchanges.length === 0) return []
    const firstQ = allExchanges.find((e) => e.question.trim() && !e.welcome)?.question.trim()
    return [
      {
        id: 'session_1',
        title: firstQ ? firstQ.replace(/\s+/g, ' ').slice(0, 80) : 'Terminal session',
        startedAt: now,
        updatedAt: now,
        active: true,
        exchanges: allExchanges,
      },
    ]
  }, [sessions, request.earlier, request.shown, now])

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

  const filteredSessions = useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return mergedSessions
    const terms = trimmed.split(/\s+/).filter(Boolean)
    return mergedSessions.filter((s) => {
      const hay = [s.id, s.title, ...s.exchanges.map((ex) => `${ex.question}\n${ex.answer}\n${ex.error ?? ''}`)]
        .join('\n')
        .toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [mergedSessions, query])

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
          <div className="flex items-center justify-between gap-3 pr-8">
            <h2 id="loops-title" className="text-base font-semibold">
              {mode === 'rooms' ? 'Rooms' : 'Sessions'}
            </h2>
            <div role="group" aria-label="Log view" className="grid grid-cols-2 border border-border">
              <button
                type="button"
                id="loops-tab-rooms"
                data-log-tab="rooms"
                aria-pressed={mode === 'rooms'}
                onClick={() => setMode('rooms')}
                className={`flex h-6 w-20 items-center justify-center text-xs transition-colors ${
                  mode === 'rooms'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                Rooms
              </button>
              <button
                type="button"
                id="loops-tab-sessions"
                data-log-tab="sessions"
                aria-pressed={mode === 'sessions'}
                onClick={() => setMode('sessions')}
                className={`flex h-6 w-20 items-center justify-center border-l border-border text-xs transition-colors ${
                  mode === 'sessions'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                Sessions
              </button>
            </div>
          </div>
          <p className="mt-1 pr-8 text-sm text-muted-foreground">
            {mode === 'rooms'
              ? `Every room saved in memory across all tabs, ordered chronologically by last activity. Reopen a saved room onto ${workspace.name} to carry on where it stopped, or search by keyword.`
              : 'Every terminal session saved from start to finish, with its full conversation context.'}
          </p>
          <div className="mt-3">
            <input
              ref={searchInput}
              id="rooms-search-input"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                mode === 'rooms'
                  ? 'Search rooms by keyword, plugin, description, or conversation…'
                  : 'Search terminal sessions by keyword or conversation…'
              }
              aria-label={mode === 'rooms' ? 'Search rooms' : 'Search sessions'}
              className="w-full border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground"
            />
          </div>
          {failed && <p className="mt-2 text-sm text-destructive">{failed}</p>}
        </div>
        {mode === 'rooms' ? (
          allEntries.length === 0 ? (
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
          )
        ) : mergedSessions.length === 0 ? (
          <p className="border-t border-border px-6 py-5 text-sm text-muted-foreground">
            No terminal sessions recorded yet.
          </p>
        ) : filteredSessions.length === 0 ? (
          <p className="border-t border-border px-6 py-5 text-sm text-muted-foreground">
            No sessions match &ldquo;{query.trim()}&rdquo;.
          </p>
        ) : (
          <ol id="sessions-log" className="min-h-0 overflow-y-auto border-t border-border px-6">
            {filteredSessions.map((session, index) => (
              <SessionRow
                key={session.id}
                session={session}
                defaultExpanded={index === 0}
                when={(at) => shortLocal(at, now, timeZone)}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

interface SessionRowProps {
  session: TerminalSession
  defaultExpanded: boolean
  when: (at: number) => string
}

function SessionRow({ session, defaultExpanded, when }: SessionRowProps): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const label = session.id.replace(/^session_/, 'Session ')
  return (
    <li data-session={session.id} className="border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 text-sm">
          <p className="truncate">
            <span className="font-medium">{label}</span>
            <span className={session.active ? 'text-foreground' : 'text-muted-foreground'}>
              {' · '}
              {session.active ? 'Current session' : 'Saved session'}
            </span>
            <span className="text-xs text-muted-foreground">
              {' · '}
              {session.exchanges.length} {session.exchanges.length === 1 ? 'exchange' : 'exchanges'}
            </span>
          </p>
          <p className="truncate text-muted-foreground">{session.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Started {when(session.startedAt)} · Last active {when(session.updatedAt)}
          </p>
        </div>
        <button
          type="button"
          data-session-toggle={session.id}
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className={BUTTON}
        >
          {expanded ? 'Hide conversation' : 'View conversation'}
        </button>
      </div>
      {expanded && session.exchanges.length > 0 && (
        <div
          data-session-transcript={session.id}
          className="mt-2 max-h-60 space-y-2 overflow-y-auto border border-border bg-muted/20 p-2.5 text-xs"
        >
          {session.exchanges.map((ex, idx) => (
            <div key={ex.id ?? idx} className="space-y-1 border-b border-border/60 pb-2 last:border-b-0 last:pb-0">
              {ex.question && !ex.welcome && (
                <p className="font-medium text-foreground whitespace-pre-wrap break-words">You: {ex.question}</p>
              )}
              {ex.steps && ex.steps.length > 0 && (
                <p className="text-[11px] text-muted-foreground">{ex.steps.join(' · ')}</p>
              )}
              {(ex.answer || ex.error) && (
                <p className="text-muted-foreground whitespace-pre-wrap break-words">{ex.answer || ex.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </li>
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
          <span className="font-medium">{loopTitle(loop.id)}</span>
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
