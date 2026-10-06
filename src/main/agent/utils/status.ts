import type { Place } from '../../../shared/agent/asking'
import { statusOf, tilesOf, type LoopStatus } from '../../../shared/loops/loops'
import type { AppState } from '../../../shared/state'
import { workingOn } from './runs'

/**
 * What a loop is doing right now, read off the runs in flight and what is asked on its tiles. It is
 * never stored, so a restart cannot leave one working that is not.
 */
export function statusNow(state: AppState, workspaceId: string, loopId: string): LoopStatus {
  const tiles = tilesOf(state.grids[workspaceId] ?? {}, loopId).map((one) => one.element.id)
  const here = (ask: { place?: Place }): boolean =>
    ask.place?.workspaceId === workspaceId && tiles.includes(ask.place.on)
  return statusOf(workingOn(workspaceId, loopId), [...state.questions, ...state.secretRequests].some(here))
}
