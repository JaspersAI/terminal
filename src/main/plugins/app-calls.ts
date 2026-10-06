import fs from 'node:fs'
import path from 'node:path'
// The extension is explicit because Node's test runner resolves this import at run time.
import { KEPT_MAX, type Kept } from '../../shared/plugins/apps.ts'

// The one call each `core/app` panel shows, kept so its page can be shown again without calling the
// tool: across a remount, and across a restart, which matters for a tool that starts something. In
// memory, and in a file per panel beside its workspace, so a workspace that is deleted takes them
// with it. A result too large to write is kept for this run only. Electron stays out of this file,
// which takes its folder as an argument, so a test drives it.

export interface KeptStore {
  get(workspaceId: string, panelId: string): Kept | undefined
  put(workspaceId: string, panelId: string, kept: Kept): void
  /** Drops what no panel in `panels` names, from memory and from disk. */
  keepOnly(workspaceId: string, panels: ReadonlySet<string>): void
}

/** A panel id becomes a file name, so it is held to what one of ours looks like. */
const PANEL_ID = /^[A-Za-z0-9_-]+$/

/** `folder` answers where one workspace's kept calls live. */
export function keptStore(folder: (workspaceId: string) => string): KeptStore {
  /** Workspace, then panel. Undefined means read and found nothing, so the disk is asked once. */
  const held = new Map<string, Map<string, Kept | undefined>>()
  const of = (workspaceId: string): Map<string, Kept | undefined> => {
    let panels = held.get(workspaceId)
    if (!panels) held.set(workspaceId, (panels = new Map()))
    return panels
  }
  const fileOf = (workspaceId: string, panelId: string): string => {
    if (!PANEL_ID.test(panelId)) throw new Error(`Unknown panel ${JSON.stringify(panelId)}.`)
    return path.join(folder(workspaceId), `${panelId}.json`)
  }

  return {
    get(workspaceId, panelId) {
      const file = fileOf(workspaceId, panelId)
      const panels = of(workspaceId)
      if (!panels.has(panelId)) panels.set(panelId, read(file))
      return panels.get(panelId)
    },

    put(workspaceId, panelId, kept) {
      const file = fileOf(workspaceId, panelId)
      of(workspaceId).set(panelId, kept)
      const json = JSON.stringify(kept)
      // Too large to write: and an older call left on disk would be read as this one after a restart.
      if (Buffer.byteLength(json) > KEPT_MAX) fs.rmSync(file, { force: true })
      else write(file, json)
    },

    keepOnly(workspaceId, panels) {
      const mine = held.get(workspaceId)
      for (const panelId of mine?.keys() ?? []) if (!panels.has(panelId)) mine!.delete(panelId)
      let names: string[]
      try {
        names = fs.readdirSync(folder(workspaceId))
      } catch {
        // No folder: this workspace never kept a call.
        return
      }
      for (const name of names) {
        if (name.endsWith('.json') && !panels.has(name.slice(0, -'.json'.length))) {
          fs.rmSync(path.join(folder(workspaceId), name), { force: true })
        }
      }
    },
  }
}

/** A file that is missing, unreadable, or not a kept call reads as nothing kept: the view calls again. */
function read(file: string): Kept | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isKept(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isKept(value: unknown): value is Kept {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { connection, tool, args, at } = value as Record<string, unknown>
  return (
    typeof connection === 'string' &&
    typeof tool === 'string' &&
    typeof args === 'object' &&
    args !== null &&
    !Array.isArray(args) &&
    typeof at === 'number' &&
    'result' in value
  )
}

/** Temp file then rename, so a crash mid-write cannot leave half a result. Mode 0600: it is what a server answered the user. */
function write(file: string, json: string): void {
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, json, { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (err) {
    console.warn(`apps: could not keep ${file}:`, err)
  }
}
