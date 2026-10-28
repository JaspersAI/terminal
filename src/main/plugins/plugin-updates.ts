import type { StoredSource } from '../../shared/plugins/install.ts'
import { isNewerVersion } from '../../shared/plugins/semver.ts'

// Keeping installed plugins aware of newer versions at their sources (Jaspers Hub and GitHub
// releases). Third-party plugin code requires user confirmation before evaluation (CLAUDE.md), so a
// check records the available version in the tree for Settings > Plugins and alerts the user once per
// version rather than replacing code unasked. What this reaches comes in through `deps` (plugins.ts
// hands it the app's), which is what lets a test drive it.

export interface PluginUpdateEntry {
  id: string
  version: string
  source: StoredSource
}

export interface PluginUpdateDeps {
  installed(): PluginUpdateEntry[]
  hubVersion(handle: string, name: string): Promise<string | null>
  githubVersion(owner: string, repo: string): Promise<string | null>
  setAvailable(id: string, installedVersion: string, available: string | null): void
  notice(text: string): void
}

const notified = new Set<string>()

/** Checks every installed plugin's source for a newer version, recording what is waiting and alerting once per version. */
export async function checkPluginUpdates(deps: PluginUpdateDeps, told: Set<string> = notified): Promise<void> {
  const updates: { id: string; version: string; available: string }[] = []
  for (const entry of deps.installed()) {
    const { id, version, source } = entry
    let raw: string | null = null
    try {
      if (source.kind === 'hub') raw = await deps.hubVersion(source.handle, source.name)
      else if (source.kind === 'github') raw = await deps.githubVersion(source.owner, source.repo)
      else continue
    } catch {
      continue
    }
    const candidate = raw?.trim().replace(/^v/, '') ?? null
    const available = candidate !== null && isNewerVersion(candidate, version) ? candidate : null
    deps.setAvailable(id, version, available)
    if (available !== null) {
      const key = `${id}@${available}`
      if (!told.has(key)) {
        told.add(key)
        updates.push({ id, version, available })
      }
    }
  }
  if (updates.length === 1) {
    const [only] = updates
    deps.notice(
      `Plugin ${only!.id} ${only!.available} is available (installed: ${only!.version}). Update it in Settings > Plugins.`,
    )
  } else if (updates.length > 1) {
    const list = updates.map((u) => `${u.id} ${u.available}`).join(', ')
    deps.notice(`Plugin updates are available: ${list}. Update them in Settings > Plugins.`)
  }
}
