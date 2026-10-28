import { frameOf, NO_LOOPS, notOwn, withActivity, withPlugin, type Loops } from '../../shared/loops/loops'
import { closedLoop, closedWithout } from '../../shared/loops/closed'
import type { Grid } from '../../shared/grid/grid'
import type { ToolContext } from '../agent/tools/types'
import { getGrids } from '../grid/grid'
import { getState, update, type MainState } from '../state'

// A tab's rooms in the tree. A record is made, closed, and reopened where its frame is, in
// `placeChecked`, `createLoop`, `removeChecked`, and `reopenLoop` (actions.ts), in the same change
// as the grid's, so a tile and its room are never apart; `deleteLoop` is the one way a record goes.

export function loopsOf(workspaceId: string): Loops {
  return getState().loops[workspaceId] ?? NO_LOOPS
}

/** Finds which tab currently holds a room (open or closed), if any. */
export function findRoomTab(state: MainState, loopId: string): string | undefined {
  for (const [tabId, loops] of Object.entries(state.loops)) {
    if (loops.list.some((one) => one.id === loopId) || closedLoop(loops, loopId) !== undefined) {
      return tabId
    }
  }
  return undefined
}

/** Updates a room's lastActiveAt timestamp when an exchange runs or a view in it is changed. */
export function touchLoop(workspaceId: string, loopId: string, at = Date.now()): void {
  update((state) => {
    const tabId = state.loops[workspaceId]?.list.some((r) => r.id === loopId)
      ? workspaceId
      : (findRoomTab(state, loopId) ?? workspaceId)
    return withLoops(state, tabId, withActivity(state.loops[tabId] ?? NO_LOOPS, loopId, at))
  })
}

/** The tree with a workspace's loops replaced. */
export function withLoops(state: MainState, workspaceId: string, loops: Loops): MainState {
  return state.loops[workspaceId] === loops ? state : { ...state, loops: { ...state.loops, [workspaceId]: loops } }
}

/**
 * The tree with the loops that no tile on the workspace's grids belongs to any more closed: kept,
 * with their frames as `before` (the grids ahead of the change) had them, so they can be reopened.
 */
export function tidied(state: MainState, workspaceId: string, before: Record<number, Grid>): MainState {
  const loops = state.loops[workspaceId] ?? NO_LOOPS
  return withLoops(state, workspaceId, closedWithout(loops, before, state.grids[workspaceId] ?? {}, Date.now()))
}

/** Refuses a change to a tile that is not the run's own, when the run is a loop's agent's. The global assistant's is refused nothing here. */
export function ownTile(context: ToolContext, id: string): void {
  if (context.loop === undefined) return
  const why = notOwn(getGrids(context.workspaceId), loopsOf(context.workspaceId).list, context.loop, id)
  if (why) throw new Error(why)
}

/** Refuses a loop's agent the removal of its work's own tile, the frame its views are in, which would end the work under it. */
export function notOwnFrame(context: ToolContext, elementId: string): void {
  if (context.loop === undefined) return
  if (frameOf(getGrids(context.workspaceId), context.loop)?.element.id === elementId) {
    throw new Error(
      `${elementId} is this work's own tile, and removing it would end the work itself. Leave it; the user closes it when they are done.`,
    )
  }
}

/** A loop's agent was told of a plugin: it is kept on the record, so later runs are told of it from the start. */
export function usePlugin(workspaceId: string, loopId: string, plugin: string): void {
  update((state) => withLoops(state, workspaceId, withPlugin(state.loops[workspaceId] ?? NO_LOOPS, loopId, plugin)))
}
