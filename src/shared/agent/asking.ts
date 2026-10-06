// What the app is asking the user, and where. A question or a key ask is asked in a place: a tile's
// box, or the global box, named by no place. The user reads one at a time in a place, so each place
// shows the one that has waited longest there and the rest wait behind it.

import type { Question } from '../state'

/**
 * A tile, as the place something is asked: its workspace, and its element's id there. An element's
 * id is unique in its workspace and no further, so the id alone names a tile in every workspace.
 */
export interface Place {
  workspaceId: string
  on: string
}

/** Whether two places are the same tile, or both the global box. */
export function samePlace(a: Place | undefined, b: Place | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.workspaceId === b.workspaceId && a.on === b.on
}

/** The questions on screen: of those waiting, in the order asked, the first in each place. */
export function onScreen(waiting: Question[]): Question[] {
  const heads: Question[] = []
  for (const one of waiting) {
    if (!heads.some((head) => samePlace(head.place, one.place))) heads.push(one)
  }
  return heads
}

/** What a place is asking, of the asks on screen: the global box's when no place is named. */
export function askedIn<T extends { place?: Place }>(asks: readonly T[], place?: Place): T | null {
  return asks.find((one) => samePlace(one.place, place)) ?? null
}
