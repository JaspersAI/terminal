import { createContext, useContext } from 'react'
import type { RunResult } from './datasets'
import type { QueryResult } from './query'

// The one surface a view talks to the app through. A built-in view gets the host's own bridge over
// the tree; a plugin view in an iframe will get one over postMessage that answers the same calls,
// so the hooks below it never learn which they have. React only here: no Electron, no window.app.

/** A view's own panel: which panel, in which workspace. Every write names it. */
export interface PanelRef {
  id: string
  workspaceId: string
}

export interface Bridge {
  /** One read of a store path, like `workspaces/<id>/panels/p3/state/text`. */
  get(path: string): Promise<unknown>
  /** Calls `listener` at once with the value there now, and again after every change. Returns an unsubscribe. */
  subscribe(path: string, listener: (value: unknown) => void): () => void
  /** Writes one value inside the panel's state. Main checks the result against the view's schema. */
  setState(panel: PanelRef, path: string[], value: unknown): Promise<void>
  /** What the view is showing now, for the orchestrator to read. */
  publish(panel: PanelRef, output: Record<string, unknown>): Promise<void>
  /** The whole of what the view shows as text, like a transcript, for a model to read at length; null for none. */
  publishText(panel: PanelRef, text: string | null): Promise<void>
  /** Runs a source by registry id. Rows land in main as a dataset; anything else comes back as text. */
  runSource(source: string, args: unknown, options?: RunOptions): Promise<RunResult>
  /** The rows a run produced, while its dataset is still good. */
  datasetRows(datasetId: string): Promise<Record<string, unknown>[]>
  /**
   * Reads the store with SQL, where the host offers it. Only the app's own views have it: the store
   * holds everything every source ever answered, including from another plugin's keyed connection,
   * so it is not a plugin's to read across, and the relay to an iframe does not carry this.
   */
  query?(sql: string, limit?: number): Promise<QueryResult>
  /** Opens an https link in the browser. A sandboxed frame cannot open one itself. */
  openLink(url: string): Promise<void>
  /** Puts text on the system clipboard. A sandboxed frame has no clipboard of its own. */
  copyText(text: string): Promise<void>
}

/** How a source is run: fresh skips a dataset still good for the arguments and fetches again. */
export interface RunOptions {
  fresh?: boolean
}

const BridgeContext = createContext<Bridge | null>(null)

export const BridgeProvider = BridgeContext.Provider

export function useBridge(): Bridge {
  const bridge = useContext(BridgeContext)
  if (!bridge) throw new Error('A view has to be mounted inside a BridgeProvider.')
  return bridge
}

/** The panel a view is mounted in. The hooks read it, so a refresh of the panel reaches every source run under it. */
const PanelContext = createContext<PanelRef | null>(null)

export const PanelProvider = PanelContext.Provider

/** The panel the view is in, or null outside a view. */
export function usePanel(): PanelRef | null {
  return useContext(PanelContext)
}
