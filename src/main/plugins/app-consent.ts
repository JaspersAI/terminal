import { addressOf, isAllowed } from '../../shared/plugins/apps'
import { getConnection } from './connections'
import { getState, update } from '../state'

// Which connections may show their server's own pages. A page is the server's code, so the first
// one a connection would show waits for the user's yes, asked by the view that would show it. The
// yes is recorded against where the connection points, as its plugin declared it: a connection
// edited to another server asks again. Apart from apps.ts so that actions.ts can reach it without
// reaching back into everything apps.ts reaches.

/** Whether the user said this connection may show pages, and it still points where it did then. */
export function appsAllowed(id: string): boolean {
  const entry = getConnection(id)
  return entry !== undefined && isAllowed(getState().allowedApps, id, entry.spec)
}

/** The user's yes for one connection. */
export function allowApps(id: string): void {
  const entry = getConnection(id)
  if (!entry) throw new Error(`Unknown connection ${id}.`)
  const address = addressOf(entry.spec)
  update((state) =>
    state.allowedApps[id] === address ? state : { ...state, allowedApps: { ...state.allowedApps, [id]: address } },
  )
}
