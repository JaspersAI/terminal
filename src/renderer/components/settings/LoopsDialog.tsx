import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { CHANGE_TEXT, loopLog, type LogEntry } from '../../../shared/loops/closed'
import { loopName } from '../../../shared/loops/loops'
import { shortLocal } from '../../../shared/tasks/tasks'
import { errorMessage } from '../../lib/errors'
import { currentWorkspace, dispatch, useAppState } from '../../lib/state'
import { BUTTON } from './Row'

interface Props {
  onClose: () => void
}

/**
 * View loops, opened from Settings: every loop of the workspace on screen, open and closed, the one
 * changed last first, with when it was made, closed, and reopened. A loop closed on the canvas is kept
 * here with its views and its conversation, and Reopen puts it back where it was; an open one can be
 * closed from here as from its tile, and either can be deleted for good. It stands over the workspace,
 * so a loop reopened is seen coming back behind it. Escape, the cross, or a press on the backdrop
 * closes it.
 */
export function LoopsDialog({ onClose }: Props): ReactElement {
  const workspace = useAppState(currentWorkspace)
  const open = useAppState((s) => s.loops[workspace.id])
  const closed = useAppState((s) => s.closedLoops[workspace.id])
  const log = useMemo(() => loopLog(open ?? [], closed ?? []), [open, closed])
  const [failed, setFailed] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = Date.now()

  // Focus starts inside, so keys land here and not on the workspace underneath.
  useEffect(() => dialog.current?.focus(), [])

  // Escape is heard in the capture phase and goes no further, as for Settings: the answer box and a
  // tile's box close on Escape too, and this is on top of both.
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
          aria-label="Close loops"
          onClick={onClose}
          className="absolute top-2 right-2 z-10 flex h-8 w-8 items-center justify-center bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-3 w-3 stroke-current stroke-[1.25]">
            <path d="M1 1 9 9M9 1 1 9" />
          </svg>
        </button>
        <div className="shrink-0 px-6 pt-5 pb-4">
          <h2 id="loops-title" className="text-base font-semibold">
            Loops
          </h2>
          <p className="mt-1 pr-8 text-sm text-muted-foreground">
            Every loop in {workspace.name}, the one changed last first. A loop closed on the canvas is kept here with
            its views and its conversation: reopen it to carry on where it stopped.
          </p>
          {failed && <p className="mt-2 text-sm text-destructive">{failed}</p>}
        </div>
        {log.length === 0 ? (
          <p className="border-t border-border px-6 py-5 text-sm text-muted-foreground">
            No loops in this workspace yet. Ask the assistant for one.
          </p>
        ) : (
          <ol id="loop-log" className="min-h-0 overflow-y-auto border-t border-border px-6">
            {log.map((entry) => (
              <LogRow
                key={entry.loop.id}
                entry={entry}
                when={(at) => shortLocal(at, now, timeZone)}
                onClose={() => act({ type: 'loop.close', workspaceId: workspace.id, loop: entry.loop.id })}
                onReopen={() => act({ type: 'loop.reopen', workspaceId: workspace.id, loop: entry.loop.id })}
                onDelete={() => act({ type: 'loop.delete', workspaceId: workspace.id, loop: entry.loop.id })}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

interface RowProps {
  entry: LogEntry
  when: (at: number) => string
  onClose: () => void
  onReopen: () => void
  onDelete: () => void
}

/** One loop: its name and what it is, whether it is open, its changes, newest first, and what can be done with it. */
function LogRow({ entry, when, onClose, onReopen, onDelete }: RowProps): ReactElement {
  const [confirming, setConfirming] = useState(false)
  const { loop, open, changes } = entry
  const [last, ...earlier] = changes
  return (
    <li
      data-loop={loop.id}
      data-open={open}
      className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border py-3 last:border-b-0"
    >
      <div className="min-w-0 flex-1 text-sm">
        <p className="truncate">
          <span className="font-medium">{loopName(loop.id)}</span>
          <span className={open ? 'text-foreground' : 'text-muted-foreground'}> · {open ? 'Open' : 'Closed'}</span>
        </p>
        <p className="truncate text-muted-foreground">{loop.desc}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {CHANGE_TEXT[last!.change]} {when(last!.at)}
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
            <span className="text-xs text-muted-foreground">Delete it and its conversation?</span>
            <button type="button" data-delete-now onClick={onDelete} className={`${BUTTON} text-destructive`}>
              Delete
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={BUTTON}>
              Keep
            </button>
          </>
        ) : (
          <>
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
