import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { Action } from '../../../shared/state'
import { everyText, isFinished, shortLocal, taskStatus, type Task, type TaskStatus } from '../../../shared/tasks/tasks'
import { errorMessage } from '../../lib/errors'
import { currentWorkspace, dispatch, useAppState } from '../../lib/state'
import { BUTTON } from './Row'
import { Entry, PinnedEntry, Split } from './Split'
import { shownEntry, TASK_STATUS, taskLine } from './summary'

/** The entry above the tasks. Task ids are t<n>. */
const ABOUT = '+about'

/** Settings' Tasks pane: what tasks are, and the tasks of the workspace on screen, newest first. */
export function TasksPane(): ReactElement {
  const all = useAppState((s) => s.tasks)
  const workspace = useAppState(currentWorkspace)
  // Filtered here, not in the selector: a selector that builds a new array never settles.
  const tasks = useMemo(() => all.filter((t) => t.workspaceId === workspace.id), [all, workspace.id])
  return (
    <TaskList
      tasks={tasks}
      about={
        <>
          <p className="pr-8 text-sm text-muted-foreground">
            Work the app does at a time on {workspace.name}, once or on an interval: one tool call, or a request to the
            assistant, which speaks in the chat only when it has something to tell you. Each workspace has its own. Ask
            the assistant to schedule one.
          </p>
          <p className="mt-2 mb-6 text-sm text-muted-foreground">
            Closing the window keeps Jaspers running in the menu bar, and every workspace's tasks with it. Quit from the
            menu bar icon to stop them.
          </p>
          <OpenAtLogin />
        </>
      }
    />
  )
}

/** Whether Jaspers starts, hidden, when the user logs in. The OS keeps the setting; main reads it back. */
function OpenAtLogin(): ReactElement {
  const { openAtLogin, canOpenAtLogin } = useAppState((s) => s.background)
  const [failed, setFailed] = useState<string | null>(null)
  // One line, not a Row: a Row keeps a wide column for a text field, and this is one small toggle.
  return (
    <div className="flex items-center justify-between gap-6 border-y border-border py-3">
      <div className="min-w-0 text-sm">
        <span>Open at login</span>
        <div className={`mt-0.5 text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
          {failed ??
            (canOpenAtLogin
              ? 'Starts Jaspers hidden when you log in.'
              : 'Needs the packaged app, on macOS or Windows.')}
        </div>
      </div>
      <button
        type="button"
        aria-pressed={openAtLogin}
        disabled={!canOpenAtLogin}
        onClick={() => {
          setFailed(null)
          dispatch({ type: 'background.setOpenAtLogin', enabled: !openAtLogin }).catch((err: unknown) =>
            setFailed(errorMessage(err)),
          )
        }}
        className={`${BUTTON} disabled:opacity-50 disabled:hover:bg-transparent`}
      >
        {openAtLogin ? 'On' : 'Off'}
      </button>
    </div>
  )
}

const STATUS_COLOR: Record<TaskStatus, string> = {
  running: 'text-muted-foreground',
  paused: 'text-muted-foreground',
  scheduled: 'text-foreground',
  done: 'text-muted-foreground',
  failed: 'text-destructive',
}

interface ListProps {
  /** One workspace's. */
  tasks: Task[]
  /** What Settings says above the tasks; the core/tasks view leaves it out. */
  about?: ReactNode
}

/** The tasks, newest first, and the one picked beside them. Settings shows the list, and so does the core/tasks view. */
export function TaskList({ tasks, about }: ListProps): ReactElement {
  const [open, setOpen] = useState<string | null>(null)
  if (about === undefined && tasks.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No tasks on this workspace. Ask the assistant to schedule one.
      </p>
    )
  }

  const newest = [...tasks].reverse()
  const shown = shownEntry(open, [...(about === undefined ? [] : [ABOUT]), ...newest.map((task) => task.id)])
  const current = newest.find((task) => task.id === shown.id)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = Date.now()

  return (
    <Split
      label="Tasks"
      shown={shown.id}
      picked={shown.picked}
      onBack={() => setOpen(null)}
      list={
        <>
          {about !== undefined && (
            <PinnedEntry id={ABOUT} selected={shown.id === ABOUT} onSelect={() => setOpen(ABOUT)}>
              About tasks
            </PinnedEntry>
          )}
          {newest.length === 0 ? (
            <p className="px-4 py-2 text-sm text-muted-foreground">No tasks on this workspace.</p>
          ) : (
            <ul>
              {newest.map((task) => {
                const { status, when, alert } = taskLine(task, now, timeZone)
                return (
                  <Entry
                    key={task.id}
                    id={task.id}
                    selected={shown.id === task.id}
                    onSelect={() => setOpen(task.id)}
                    title={task.instructions}
                    line={
                      <>
                        <span className={alert ? 'text-destructive' : undefined}>{status}</span> · {when}
                      </>
                    }
                  />
                )
              })}
            </ul>
          )}
        </>
      }
      detail={current ? <TaskDetail task={current} now={now} timeZone={timeZone} /> : about}
    />
  )
}

/**
 * A task: its instructions whole, where it stands, a muted line saying when, its call, the three things
 * to do to it, and what its runs said. It dispatches actions itself, as a host component; the bridge
 * carries no such call.
 */
function TaskDetail({ task, now, timeZone }: { task: Task; now: number; timeZone: string }): ReactElement {
  const [failed, setFailed] = useState<string | null>(null)
  const status = taskStatus(task)
  const when = (at: number): string => shortLocal(at, now, timeZone)

  function act(action: Action): void {
    setFailed(null)
    dispatch(action).catch((err: unknown) => setFailed(errorMessage(err)))
  }

  const parts = [task.id, task.every === null ? `once at ${when(task.executeAt)}` : `every ${everyText(task.every)}`]
  if (task.model) parts.push(`on ${task.model}`)
  if (task.enabled && task.nextAt !== null) parts.push(`next ${when(task.nextAt)}`)
  if (task.lastRun) parts.push(`last ${when(task.lastRun.at)} ${task.lastRun.ok ? 'ok' : 'failed'}`)
  parts.push(`${task.runs} ${task.runs === 1 ? 'run' : 'runs'}`)
  const failure = task.lastRun && !task.lastRun.ok ? task.lastRun.result : ''
  // A request's answer is what the user comes back for; a tool call's is its own business.
  const answer = task.lastRun?.ok && !task.call ? task.lastRun.result : ''
  // Under `npm run dev` this window reloads on an edit and main does not, so a tree from an older main has none.
  const commands = task.commands ?? []

  return (
    <section aria-label={`Task ${task.id}`}>
      {/* Clear of the close cross in the corner. */}
      <h3 className="pr-8 text-base font-semibold break-words whitespace-pre-wrap">{task.instructions}</h3>
      <p className="mt-1 text-sm">
        <span className={STATUS_COLOR[status]}>{TASK_STATUS[status]}</span>
        <span className="text-muted-foreground"> · {parts.join(' · ')}</span>
      </p>
      {task.call && (
        <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
          {task.call.tool} {JSON.stringify(task.call.input)}
        </p>
      )}
      {/* What the user allowed it, whole: an allowance nobody can read back is not one they can stand behind. */}
      {commands.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-muted-foreground">
            Runs without asking, as you allowed. Remove the task to end it.
          </p>
          {commands.map((command) => (
            <pre
              key={command}
              className="mt-1 max-h-40 overflow-auto border border-border p-2 font-mono text-xs break-all whitespace-pre-wrap"
            >
              {command}
            </pre>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={task.running}
          onClick={() => act({ type: 'task.run', id: task.id })}
          className={`${BUTTON} disabled:opacity-50 disabled:hover:bg-transparent`}
        >
          Run now
        </button>
        {/* A task that will not run again has nothing to pause. */}
        {(!isFinished(task) || !task.enabled) && (
          <button
            type="button"
            onClick={() => act({ type: 'task.setEnabled', id: task.id, enabled: !task.enabled })}
            className={BUTTON}
          >
            {task.enabled ? 'Pause' : 'Resume'}
          </button>
        )}
        <button type="button" onClick={() => act({ type: 'task.remove', id: task.id })} className={BUTTON}>
          Remove
        </button>
      </div>
      {failed && <p className="mt-2 text-sm break-words text-destructive">{failed}</p>}
      {(failure || answer || task.history.length > 0) && (
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3">
          {failure && <p className="text-sm break-words whitespace-pre-wrap text-destructive">{failure}</p>}
          {answer && <p className="text-sm break-words whitespace-pre-wrap">{answer}</p>}
          {task.history.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground select-none">
                {task.history.length} earlier {task.history.length === 1 ? 'run' : 'runs'}
              </summary>
              <ul className="mt-1 flex flex-col gap-1">
                {task.history.map((run) => (
                  <li key={run.at} className="break-words">
                    <span className={run.ok ? 'text-muted-foreground' : 'text-destructive'}>
                      {when(run.at)} {run.ok ? 'ok' : 'failed'}
                    </span>
                    {run.result && <span className="text-muted-foreground"> · {run.result.split('\n')[0]}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  )
}
