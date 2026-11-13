import { validateSyncedPluginBundle, type SyncedPluginBundle } from '../../shared/collab/collab.ts'

// Compiled browser view bundles received from shared rooms and workspace tabs. Held in memory so
// `viewhost.ts` can serve `jaspers-plugin://<id>/index.html`, `/bundle.js`, and `/bundle.css`
// inside the sandboxed view iframe without needing a local plugin installation or backend host.

const bundles = new Map<string, SyncedPluginBundle>()

export function keepSyncedBundle(raw: unknown): SyncedPluginBundle | null {
  const valid = validateSyncedPluginBundle(raw)
  if (!valid) return null
  bundles.set(valid.plugin, valid)
  return valid
}

export function getSyncedBundle(plugin: string): SyncedPluginBundle | null {
  return bundles.get(plugin) ?? null
}

export function clearSyncedBundles(): void {
  bundles.clear()
}
