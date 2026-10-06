import { useSyncExternalStore } from 'react'
import { statusOf, tilesOf, type LoopStatus } from '../../../shared/loops/loops'
import { useAppState } from '../../lib/state'
import { isWorking, NOTHING_WORKING, workingHeard, workingSeeded, type Working } from './working'

// What a piece of work is doing, for every tile of it to say the same: working while a run of its is
// in flight, asking while a question or a key ask waits on one of its tiles. One subscription to main's
// run events for the window, however many tiles read it, begun by the first; the rules are in
// `working.ts`. Nothing here is kept: a window that reloads asks main what is in flight and goes on.

let working: Working = NOTHING_WORKING
const listeners = new Set<() => void>()
/** The runs heard to end since this window began listening, which an older answer to "what is running" must not bring back. */
const ended = new Set<string>()
let hearing = false

function put(next: Working): void {
  if (next === working) return
  working = next
  for (const each of listeners) each()
}

function hear(): void {
  if (hearing) return
  hearing = true
  window.app.agent.onEvent((event) => {
    if (event.kind === 'done' || event.kind === 'failed' || event.kind === 'stopped') ended.add(event.runId)
    put(workingHeard(working, event))
  })
  void window.app.agent.running().then((runs) => {
    put(workingSeeded(working, runs, ended))
    // Only the answer that was on its way could be older than an end already heard.
    ended.clear()
  })
}

function subscribe(listener: () => void): () => void {
  hear()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What a piece of work is doing right now. The docked chat, which is no work's, is idle. */
export function useLoopStatus(workspaceId: string, loop: string | undefined): LoopStatus {
  const now = useSyncExternalStore(subscribe, () => working)
  const asking = useAppState((s) => {
    if (loop === undefined) return false
    const tiles = tilesOf(s.grids[workspaceId] ?? {}, loop).map((one) => one.element.id)
    return [...s.questions, ...s.secretRequests].some(
      (ask) => ask.place?.workspaceId === workspaceId && tiles.includes(ask.place.on),
    )
  })
  return loop === undefined ? 'idle' : statusOf(isWorking(now, workspaceId, loop), asking)
}
