import { harvest, remember, type Citation } from '../../shared/agent/citations'

// The sources a workspace's replies may cite: whatever its source runs brought under `citations`,
// whoever asked for the run. The orchestrator's own calls count, and so do a view's, since a view may
// publish `[^id]` beside a quote in its panel text for the model to cite. They are held here beside
// the datasets rather than in the state tree: every push sends the whole tree to every window, and
// the renderer needs only the few a reply on screen points at, which travel with that reply.

const known = new Map<string, Map<string, Citation>>()

/** Keeps what one run's structured value brought, for the workspace the run was for. */
export function keepCitations(workspaceId: string | null, value: unknown): void {
  if (workspaceId === null) return
  const found = harvest(value)
  if (found.length === 0) return
  let held = known.get(workspaceId)
  if (!held) known.set(workspaceId, (held = new Map()))
  remember(held, found)
}

const NONE: ReadonlyMap<string, Citation> = new Map()

/** What a reply on this workspace may cite, by id. */
export function citationsFor(workspaceId: string): ReadonlyMap<string, Citation> {
  return known.get(workspaceId) ?? NONE
}
