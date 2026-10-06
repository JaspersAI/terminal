import { sameValue } from '../../shared/data/hash'
import { parsePath, readPath, type StorePath } from '../../shared/paths'
import type { Bridge, RunOptions } from '@jaspers-ai/sdk'
import type { RunResult } from '../../shared/data/datasets'
import { errorMessage } from './errors'
import { dispatch, get, subscribe } from './state'

// The bridge a built-in view gets: reads are the tree the renderer already mirrors, writes are
// dispatches to main. Nothing here validates: main does, against the view's schema, wherever the
// write came from. A plugin view in an iframe will reach this same object through a relay.

export const hostBridge: Bridge = {
  async get(path) {
    return read(parsePath(path))
  },

  subscribe(path, listener) {
    const parsed = parsePath(path)
    let last = read(parsed)
    listener(last)
    return subscribe(() => {
      const next = read(parsed)
      // Every push replaces the whole tree, so most of them say nothing about this path; and it
      // arrives deserialized, so an object here is never the reference it was: compare by value, or
      // every listener on an object path hears every push.
      if (sameValue(next, last)) return
      last = next
      listener(next)
    })
  },

  async setState(panel, path, value) {
    await dispatch({ type: 'panel.setState', workspaceId: panel.workspaceId, panelId: panel.id, path, value })
  },

  async publish(panel, output) {
    await dispatch({ type: 'panel.publish', workspaceId: panel.workspaceId, panelId: panel.id, output })
  },

  async publishText(panel, text) {
    await dispatch({ type: 'panel.publishText', workspaceId: panel.workspaceId, panelId: panel.id, text })
  },

  // A built-in view is always on the workspace on screen.
  async runSource(source, args, options) {
    return runSourceIn(get().currentWorkspaceId, source, args, options)
  },

  async datasetRows(datasetId) {
    return unwrap(window.app.sources.rows(datasetId))
  },

  // Only here. The relay a plugin's iframe talks to does not carry this method.
  async query(sql, limit) {
    return unwrap(window.app.store.query(sql, limit))
  },

  async openLink(url) {
    // Main opens https only and says so otherwise.
    return unwrap(window.app.openExternal(url))
  },

  async copyText(text) {
    return unwrap(window.app.copyText(text))
  },
}

/** A source run for a view on a given workspace. The relay names its frame's workspace, whatever the frame says. */
export async function runSourceIn(
  workspaceId: string,
  source: string,
  args: unknown,
  options?: RunOptions,
): Promise<RunResult> {
  return unwrap(window.app.sources.run(source, args, { fresh: options?.fresh === true, workspaceId }))
}

/** Main's message, without the IPC wrapper around it, since a view shows it to the user. */
async function unwrap<T>(call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (err) {
    throw new Error(errorMessage(err))
  }
}

/**
 * A path without a workspace means the one on screen. A subscription outlives the panel it reads
 * by a moment when an element closes, so a path that no longer resolves reads as undefined here
 * rather than throwing at whoever is listening.
 */
function read(path: StorePath): unknown {
  try {
    return readPath(get(), get().currentWorkspaceId, path)
  } catch {
    return undefined
  }
}
