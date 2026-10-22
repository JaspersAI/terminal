// Coordinates one `WebContentsView` per `core/browser` panel across workspaces and windows. Kept
// free of Electron imports so the lifecycle, bounds clipping, visibility, navigation, and sweep rules
// run directly under Node's test runner.

import {
  BROWSER_VIEW,
  browserStanding,
  clipBounds,
  isBrowserUrl,
  normalizeBounds,
  normalizeBrowserUrl,
  readBrowserState,
  shouldShowBrowser,
  type BrowserAction,
  type BrowserBounds,
  type BrowserSnapshot,
  type BrowserStanding,
} from '../../shared/grid/browser.ts'
import { panelOf, type Grid, type Panel } from '../../shared/grid/grid.ts'

export interface BrowserViewEvents {
  onDidStartLoading(): void
  onDidStopLoading(): void
  onDidNavigate(url: string): void
  onDidFailLoad(errorCode: number, errorDescription: string, isMainFrame: boolean): void
  onPageTitleUpdated(title: string): void
  onFocus(): void
}

export interface ManagedBrowserView {
  loadURL(url: string): Promise<void>
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  setBounds(bounds: BrowserBounds): void
  setVisible(visible: boolean): void
  readPageText(): Promise<string | null>
  destroy(): void
}

export interface ManagedWindow {
  number: number
  viewport(): { width: number; height: number } | null
  attach(view: ManagedBrowserView): void
  detach(view: ManagedBrowserView): void
  sendState(snapshot: BrowserSnapshot): void
}

export interface BrowserManagerState {
  currentWorkspaceId: string
  workspaces: { id: string }[]
  grids: Record<string, Record<number, Grid>>
}

export interface BrowserManagerDeps {
  getState(): BrowserManagerState
  getWindow(windowNumber: number): ManagedWindow | null
  createView(events: BrowserViewEvents): ManagedBrowserView
  setPanelUrl(workspaceId: string, panelId: string, url: string): void
  focusElement(workspaceId: string, elementId: string): void
}

export interface BrowserManager {
  sync(
    callerWindow: number | null,
    rawWorkspaceId: unknown,
    rawPanelId: unknown,
    rawBounds: unknown,
    rawVisible: unknown,
  ): Promise<BrowserSnapshot>
  navigate(
    callerWindow: number | null,
    rawWorkspaceId: unknown,
    rawPanelId: unknown,
    rawAction: unknown,
    rawUrl?: unknown,
  ): Promise<BrowserSnapshot>
  detach(callerWindow: number | null, rawWorkspaceId: unknown, rawPanelId: unknown): void
  sweep(state?: BrowserManagerState): void
  windowClosed(windowNumber: number): void
  closeAll(): void
}

interface Entry {
  key: string
  workspaceId: string
  panelId: string
  view: ManagedBrowserView
  /** The last `panel.state.url` applied from the state tree, so in-page clicks are not overwritten on sync. */
  stateUrl: string
  url: string
  title: string
  loading: boolean
  error: string | null
  text: string | null
  refreshedAt: number | null
  bounds: BrowserBounds | null
  rendererVisible: boolean
  attachedWindow: number | null
  loadSeq: number
  destroyed: boolean
}

const ACTIONS = new Set<BrowserAction>(['load', 'back', 'forward', 'reload'])
/** Chromium's `ERR_ABORTED`, fired when a redirect or a new navigation supersedes one in flight. */
const ERR_ABORTED = -3

const entryKey = (workspaceId: string, panelId: string): string => `${workspaceId}\n${panelId}`

export function createBrowserManager(deps: BrowserManagerDeps): BrowserManager {
  const entries = new Map<string, Entry>()

  function emptySnapshot(workspaceId: string, panelId: string): BrowserSnapshot {
    return {
      workspaceId,
      panelId,
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
      text: null,
    }
  }

  function snapshotOf(entry: Entry): BrowserSnapshot {
    const liveUrl = entry.view.getURL()
    const committedUrl = isBrowserUrl(liveUrl) ? liveUrl : ''
    const url =
      entry.loading || entry.error !== null ? entry.url || entry.stateUrl : committedUrl || entry.url || entry.stateUrl
    const title = entry.loading || entry.error !== null ? entry.title : entry.view.getTitle() || entry.title
    return {
      workspaceId: entry.workspaceId,
      panelId: entry.panelId,
      url,
      title,
      loading: entry.loading || entry.view.isLoading(),
      canGoBack: entry.view.canGoBack(),
      canGoForward: entry.view.canGoForward(),
      error: entry.error,
      text: entry.text,
    }
  }

  function pushSnapshot(entry: Entry): void {
    if (entry.destroyed) return
    const state = deps.getState()
    if (state.currentWorkspaceId !== entry.workspaceId) return
    const standing = browserStanding(state.grids[entry.workspaceId], entry.panelId)
    const winNumber = standing?.window ?? entry.attachedWindow
    if (winNumber === null) return
    deps.getWindow(winNumber)?.sendState(snapshotOf(entry))
  }

  function detachFromWindow(entry: Entry): void {
    entry.view.setVisible(false)
    if (entry.attachedWindow !== null) {
      deps.getWindow(entry.attachedWindow)?.detach(entry.view)
      entry.attachedWindow = null
    }
  }

  function destroyEntry(entry: Entry): void {
    if (entry.destroyed) return
    entry.destroyed = true
    entries.delete(entry.key)
    detachFromWindow(entry)
    entry.view.destroy()
  }

  function positionEntry(entry: Entry, state: BrowserManagerState): void {
    if (entry.destroyed) return
    const standing = browserStanding(state.grids[entry.workspaceId], entry.panelId)
    if (!standing) {
      detachFromWindow(entry)
      return
    }
    if (entry.attachedWindow !== null && entry.attachedWindow !== standing.window) {
      deps.getWindow(entry.attachedWindow)?.detach(entry.view)
      entry.attachedWindow = null
    }
    const win = deps.getWindow(standing.window)
    const viewport = win?.viewport() ?? null
    const clipped = entry.bounds && viewport ? clipBounds(entry.bounds, viewport) : entry.bounds
    const show = shouldShowBrowser({
      onCurrentWorkspace: state.currentWorkspaceId === entry.workspaceId,
      visibleInGrid: standing.visibleInGrid,
      rendererVisible: entry.rendererVisible,
      bounds: clipped,
      hasUrl: Boolean(entry.url || entry.stateUrl),
      hasError: entry.error !== null,
    })
    if (show && win && clipped) {
      if (entry.attachedWindow !== win.number) {
        win.attach(entry.view)
        entry.attachedWindow = win.number
      }
      entry.view.setBounds(clipped)
      entry.view.setVisible(true)
    } else {
      detachFromWindow(entry)
    }
  }

  function ensureEntry(workspaceId: string, panel: Panel): Entry {
    const key = entryKey(workspaceId, panel.id)
    const existing = entries.get(key)
    if (existing) return existing
    let entry!: Entry
    const view = deps.createView({
      onDidStartLoading() {
        if (!entry || entry.destroyed) return
        entry.loading = true
        pushSnapshot(entry)
      },
      onDidStopLoading() {
        if (!entry || entry.destroyed) return
        entry.loading = false
        if (entry.error !== null) {
          pushSnapshot(entry)
          return
        }
        const liveUrl = entry.view.getURL()
        if (isBrowserUrl(liveUrl)) entry.url = liveUrl
        const liveTitle = entry.view.getTitle()
        if (liveTitle) entry.title = liveTitle
        pushSnapshot(entry)
        const loadId = entry.loadSeq
        void entry.view
          .readPageText()
          .then((text) => {
            if (entry.destroyed || entry.loadSeq !== loadId || entry.error !== null || entry.text === text) return
            entry.text = text
            pushSnapshot(entry)
          })
          .catch(() => undefined)
      },
      onDidNavigate(url) {
        if (!entry || entry.destroyed) return
        const normalized = normalizeBrowserUrl(url)
        if (normalized) {
          entry.url = normalized
          entry.error = null
        }
        const liveTitle = entry.view.getTitle()
        if (liveTitle) entry.title = liveTitle
        positionEntry(entry, deps.getState())
        pushSnapshot(entry)
      },
      onDidFailLoad(errorCode, errorDescription, isMainFrame) {
        if (!entry || entry.destroyed || !isMainFrame || errorCode === ERR_ABORTED) return
        entry.loading = false
        entry.error = errorDescription || `Load failed (${errorCode}).`
        positionEntry(entry, deps.getState())
        pushSnapshot(entry)
      },
      onPageTitleUpdated(title) {
        if (!entry || entry.destroyed) return
        entry.title = title
        pushSnapshot(entry)
      },
      onFocus() {
        if (!entry || entry.destroyed) return
        const standing = browserStanding(deps.getState().grids[entry.workspaceId], entry.panelId)
        if (standing && !standing.focused) deps.focusElement(entry.workspaceId, standing.element.id)
      },
    })
    entry = {
      key,
      workspaceId,
      panelId: panel.id,
      view,
      stateUrl: '',
      url: '',
      title: '',
      loading: false,
      error: null,
      text: null,
      refreshedAt: panel.refreshedAt,
      bounds: null,
      rendererVisible: false,
      attachedWindow: null,
      loadSeq: 0,
      destroyed: false,
    }
    entries.set(key, entry)
    return entry
  }

  function loadAddress(entry: Entry, url: string): void {
    const loadId = ++entry.loadSeq
    entry.url = url
    entry.title = ''
    entry.text = null
    entry.error = null
    entry.loading = true
    positionEntry(entry, deps.getState())
    pushSnapshot(entry)
    void entry.view.loadURL(url).catch((err: unknown) => {
      if (entry.destroyed || entry.loadSeq !== loadId || isAbortedLoad(err)) return
      entry.loading = false
      entry.error = err instanceof Error ? err.message : String(err)
      positionEntry(entry, deps.getState())
      pushSnapshot(entry)
    })
  }

  function reloadEntry(entry: Entry): void {
    const targetUrl = entry.url || entry.stateUrl
    const liveUrl = entry.view.getURL()
    if ((entry.error !== null || !isBrowserUrl(liveUrl) || liveUrl !== targetUrl) && targetUrl) {
      loadAddress(entry, targetUrl)
      return
    }
    entry.error = null
    entry.loading = true
    positionEntry(entry, deps.getState())
    entry.view.reload()
    pushSnapshot(entry)
  }

  function applyPanelState(entry: Entry, panel: Panel, stateUrl: string): void {
    if (stateUrl !== entry.stateUrl) {
      entry.stateUrl = stateUrl
      entry.refreshedAt = panel.refreshedAt
      loadAddress(entry, stateUrl)
      return
    }
    if (panel.refreshedAt !== null && panel.refreshedAt !== entry.refreshedAt) {
      entry.refreshedAt = panel.refreshedAt
      reloadEntry(entry)
    }
  }

  function resolveBrowserPanel(
    callerWindow: number | null,
    rawWorkspaceId: unknown,
    rawPanelId: unknown,
  ): { state: BrowserManagerState; workspaceId: string; panel: Panel; standing: BrowserStanding } {
    const state = deps.getState()
    if (typeof rawWorkspaceId !== 'string' || !state.workspaces.some((w) => w.id === rawWorkspaceId)) {
      throw new Error('Unknown workspace.')
    }
    if (typeof rawPanelId !== 'string' || rawPanelId === '') {
      throw new Error('A panel id is required.')
    }
    const standing = browserStanding(state.grids[rawWorkspaceId], rawPanelId)
    const grid = standing ? state.grids[rawWorkspaceId]?.[standing.window] : undefined
    if (!standing || !grid) throw new Error(`No panel ${rawPanelId}.`)
    const panel = panelOf(grid, rawPanelId)
    if (panel.content.kind !== 'view' || panel.content.view !== BROWSER_VIEW) {
      throw new Error(`${rawPanelId} does not show a browser view.`)
    }
    if (callerWindow !== standing.window) {
      throw new Error('This panel is not in this window.')
    }
    return { state, workspaceId: rawWorkspaceId, panel, standing }
  }

  return {
    async sync(callerWindow, rawWorkspaceId, rawPanelId, rawBounds, rawVisible) {
      const { state, workspaceId, panel } = resolveBrowserPanel(callerWindow, rawWorkspaceId, rawPanelId)
      const bounds = normalizeBounds(rawBounds)
      if (!bounds) throw new Error('Bounds must be { x, y, width, height }.')
      const rendererVisible = rawVisible === true
      const stateUrl = readBrowserState(panel.state).url
      const key = entryKey(workspaceId, panel.id)

      if (!stateUrl) {
        const existing = entries.get(key)
        if (existing) destroyEntry(existing)
        return emptySnapshot(workspaceId, panel.id)
      }

      const entry = ensureEntry(workspaceId, panel)
      entry.bounds = bounds
      entry.rendererVisible = rendererVisible
      applyPanelState(entry, panel, stateUrl)
      positionEntry(entry, state)
      return snapshotOf(entry)
    },

    async navigate(callerWindow, rawWorkspaceId, rawPanelId, rawAction, rawUrl) {
      const { workspaceId, panel } = resolveBrowserPanel(callerWindow, rawWorkspaceId, rawPanelId)
      if (typeof rawAction !== 'string' || !ACTIONS.has(rawAction as BrowserAction)) {
        throw new Error('Unknown browser action.')
      }
      const action = rawAction as BrowserAction
      const key = entryKey(workspaceId, panel.id)

      if (action === 'load') {
        const normalized = normalizeBrowserUrl(rawUrl)
        if (normalized === null) throw new Error('Enter an https:// or http:// address.')
        if (normalized === '') {
          const existing = entries.get(key)
          if (existing) destroyEntry(existing)
          deps.setPanelUrl(workspaceId, panel.id, '')
          return emptySnapshot(workspaceId, panel.id)
        }
        const entry = ensureEntry(workspaceId, panel)
        entry.stateUrl = normalized
        deps.setPanelUrl(workspaceId, panel.id, normalized)
        loadAddress(entry, normalized)
        return snapshotOf(entry)
      }

      const entry = entries.get(key)
      if (!entry) {
        const stateUrl = readBrowserState(panel.state).url
        if (!stateUrl) return emptySnapshot(workspaceId, panel.id)
        const created = ensureEntry(workspaceId, panel)
        created.stateUrl = stateUrl
        loadAddress(created, stateUrl)
        return snapshotOf(created)
      }

      if (action === 'reload') {
        reloadEntry(entry)
        return snapshotOf(entry)
      }

      entry.error = null
      if (action === 'back' && entry.view.canGoBack()) entry.view.goBack()
      else if (action === 'forward' && entry.view.canGoForward()) entry.view.goForward()
      positionEntry(entry, deps.getState())
      pushSnapshot(entry)
      return snapshotOf(entry)
    },

    detach(callerWindow, rawWorkspaceId, rawPanelId) {
      if (callerWindow === null || typeof rawWorkspaceId !== 'string' || typeof rawPanelId !== 'string') return
      const entry = entries.get(entryKey(rawWorkspaceId, rawPanelId))
      if (entry && (entry.attachedWindow === null || entry.attachedWindow === callerWindow)) {
        entry.rendererVisible = false
        detachFromWindow(entry)
      }
      this.sweep()
    },

    sweep(state = deps.getState()) {
      const livePanels = new Map<string, Panel>()
      for (const { id: workspaceId } of state.workspaces) {
        for (const grid of Object.values(state.grids[workspaceId] ?? {})) {
          for (const panel of grid.panels) {
            if (panel.content.kind === 'view' && panel.content.view === BROWSER_VIEW) {
              livePanels.set(entryKey(workspaceId, panel.id), panel)
            }
          }
        }
      }
      for (const [key, entry] of entries) {
        const panel = livePanels.get(key)
        if (!panel) {
          destroyEntry(entry)
          continue
        }
        const stateUrl = readBrowserState(panel.state).url
        if (!stateUrl) {
          destroyEntry(entry)
          continue
        }
        applyPanelState(entry, panel, stateUrl)
        positionEntry(entry, state)
      }
    },

    windowClosed(windowNumber) {
      for (const entry of entries.values()) {
        if (entry.attachedWindow === windowNumber) {
          entry.attachedWindow = null
          entry.rendererVisible = false
        }
      }
    },

    closeAll() {
      for (const entry of [...entries.values()]) destroyEntry(entry)
    },
  }
}

function isAbortedLoad(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const record = err as { errno?: unknown; code?: unknown; message?: unknown }
  return (
    record.errno === ERR_ABORTED ||
    record.code === 'ERR_ABORTED' ||
    (typeof record.message === 'string' && record.message.includes('ERR_ABORTED'))
  )
}
