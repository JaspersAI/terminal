import type { SyncedBundle } from '../../shared/collab/parts.ts'

// A plugin's compiled views as a teammate's shared room sent them, for a plugin this terminal does
// not have. Held in memory, under the share that brought them, so `viewhost.ts` can serve
// `jaspers-plugin://<id>/` to the sandboxed frame of a replica's tile. They are a teammate's code:
// the frame is all they run in, and everything a replica's view asks for is answered by the room's
// owner, never by this terminal (main/collab/). A plugin installed here is never stood in for.

const bundles = new Map<string, { shareId: string; bundle: SyncedBundle }>()

export function keepSyncedBundle(shareId: string, bundle: SyncedBundle): void {
  bundles.set(bundle.plugin, { shareId, bundle })
}

export function getSyncedBundle(plugin: string): SyncedBundle | null {
  return bundles.get(plugin)?.bundle ?? null
}

/** Forgets what one share brought. The plugins it was the only source of. */
export function dropSyncedBundles(shareId: string): string[] {
  const dropped: string[] = []
  for (const [plugin, kept] of bundles) {
    if (kept.shareId !== shareId) continue
    bundles.delete(plugin)
    dropped.push(plugin)
  }
  return dropped
}
