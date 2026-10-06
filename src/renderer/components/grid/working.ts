// Which pieces of work have a run in flight, as a window knows it from what main says of runs. Pure,
// so it is read in a test; the store that feeds it and the hook that reads it are in `status.ts`.
//
// A loop's status is never stored: main reads it off the runs in flight, and so does a window, from
// the same events its tiles' boxes follow. A run for a piece of work says so as it begins, and every
// run says when it ends.

// The extension is explicit because Node's test runner resolves this import at run time.
import type { AgentEvent, AgentOrigin } from '../../../shared/agent/agent.ts'

/** The runs in flight that are a loop's, by run: which work each is on. */
export type Working = ReadonlyMap<string, { workspaceId: string; loop: string }>

export const NOTHING_WORKING: Working = new Map()

/** The runs after something main said of one. The same map comes back when nothing changed. */
export function workingHeard(working: Working, event: AgentEvent): Working {
  if (event.kind === 'start') {
    if (event.loop === undefined || working.has(event.runId)) return working
    return new Map(working).set(event.runId, { workspaceId: event.workspaceId, loop: event.loop })
  }
  if (event.kind !== 'done' && event.kind !== 'failed' && event.kind !== 'stopped') return working
  if (!working.has(event.runId)) return working
  const next = new Map(working)
  next.delete(event.runId)
  return next
}

/** A run in flight, as main answers a window that asks what is running. */
export interface InFlight {
  runId: string
  origin: AgentOrigin
  workspaceId?: string
  loop?: string
}

/**
 * The runs with the ones main says are in flight, for a window that opened partway through. One this
 * window has heard end since it asked is left out: the answer is older than that event.
 */
export function workingSeeded(working: Working, runs: readonly InFlight[], ended: ReadonlySet<string>): Working {
  let next = working
  for (const { runId, origin, workspaceId, loop } of runs) {
    if (workspaceId === undefined || loop === undefined || ended.has(runId)) continue
    next = workingHeard(next, { kind: 'start', runId, origin, workspaceId, label: '', loop })
  }
  return next
}

/** Whether a piece of work has a run in flight. */
export function isWorking(working: Working, workspaceId: string, loop: string): boolean {
  for (const one of working.values()) if (one.workspaceId === workspaceId && one.loop === loop) return true
  return false
}
