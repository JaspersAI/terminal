// Coordinates `WebContentsView` tabs per `core/browser` panel across workspaces and windows. Kept
// free of Electron imports so the tab lifecycle, bounds clipping, visibility, navigation, theater
// mode defaults, and sweep rules run directly under Node's test runner.

import {
  BROWSER_VIEW,
  browserStanding,
  browserUserAgent,
  browserUserAgentForUrl,
  clipBounds,
  DEFAULT_BROWSER_URL,
  isBlankBrowserPopupUrl,
  isBrowserUrl,
  isVideoPageUrl,
  normalizeBounds,
  normalizeBrowserUrl,
  readBrowserState,
  scaleBounds,
  shouldShowBrowser,
  type BrowserAction,
  type BrowserBounds,
  type BrowserSnapshot,
  type BrowserStanding,
  type BrowserTab,
} from '../../shared/grid/browser.ts'
import { panelOf, type Grid, type Panel } from '../../shared/grid/grid.ts'

export interface BrowserViewEvents {
  onDidStartLoading(): void
  onDidStopLoading(): void
  onDidNavigate(url: string): void
  onDidFailLoad(errorCode: number, errorDescription: string, isMainFrame: boolean): void
  onPageTitleUpdated(title: string): void
  onFocus(): void
  onOpenWindow?(url: string, createView?: (events: BrowserViewEvents) => ManagedBrowserView): ManagedBrowserView | null
  onClose?(): void
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
  setTheaterMode?(theater: boolean, url: string): void
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
  publishPanel?(workspaceId: string, panelId: string, snapshot: BrowserSnapshot): void
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

interface TabEntry {
  id: string
  openerTabId: string | null
  view: ManagedBrowserView
  url: string
  title: string
  loading: boolean
  theater: boolean
  error: string | null
  text: string | null
  loadSeq: number
  destroyed: boolean
}

interface Entry {
  key: string
  workspaceId: string
  panelId: string
  tabs: TabEntry[]
  activeTabId: string
  nextTabSeq: number
  /** The last `panel.state.url` applied from the state tree, so in-page clicks are not overwritten on sync. */
  stateUrl: string
  refreshedAt: number | null
  bounds: BrowserBounds | null
  boundsWindow: number | null
  viewport: { width: number; height: number } | null
  rendererVisible: boolean
  attachedWindow: number | null
  attachedView: ManagedBrowserView | null
  destroyed: boolean
}

const ACTIONS = new Set<BrowserAction>([
  'load',
  'back',
  'forward',
  'reload',
  'new-tab',
  'select-tab',
  'close-tab',
  'toggle-theater',
])
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
      theater: false,
      tabCount: 0,
      activeTabId: '',
      tabs: [],
      error: null,
      text: null,
    }
  }

  function activeTab(entry: Entry): TabEntry {
    return entry.tabs.find((one) => one.id === entry.activeTabId) ?? entry.tabs[0]!
  }

  function tabSnapshot(tab: TabEntry, fallbackUrl = ''): BrowserTab {
    const liveUrl = tab.view.getURL()
    const committedUrl = isBrowserUrl(liveUrl) ? liveUrl : ''
    const url = tab.loading || tab.error !== null ? tab.url || fallbackUrl : committedUrl || tab.url || fallbackUrl
    const title = tab.loading || tab.error !== null ? tab.title : tab.view.getTitle() || tab.title
    return {
      id: tab.id,
      url,
      title,
      loading: tab.loading || tab.view.isLoading(),
      canGoBack: tab.view.canGoBack(),
      canGoForward: tab.view.canGoForward(),
      theater: tab.theater,
      error: tab.error,
    }
  }

  function snapshotOf(entry: Entry): BrowserSnapshot {
    const active = activeTab(entry)
    const activeSnap = tabSnapshot(active, entry.stateUrl)
    const tabs = entry.tabs.map((tab) => (tab.id === active.id ? activeSnap : tabSnapshot(tab)))
    return {
      workspaceId: entry.workspaceId,
      panelId: entry.panelId,
      url: activeSnap.url,
      title: activeSnap.title,
      loading: activeSnap.loading,
      canGoBack: activeSnap.canGoBack,
      canGoForward: activeSnap.canGoForward,
      theater: activeSnap.theater,
      tabCount: tabs.length,
      activeTabId: active.id,
      tabs,
      error: activeSnap.error,
      text: active.text,
    }
  }

  function pushSnapshot(entry: Entry): void {
    if (entry.destroyed) return
    const snap = snapshotOf(entry)
    deps.publishPanel?.(entry.workspaceId, entry.panelId, snap)
    const state = deps.getState()
    if (state.currentWorkspaceId !== entry.workspaceId) return
    const standing = browserStanding(state.grids[entry.workspaceId], entry.panelId)
    const winNumber = standing?.window ?? entry.attachedWindow
    if (winNumber === null) return
    deps.getWindow(winNumber)?.sendState(snap)
  }

  function detachFromWindow(entry: Entry): void {
    for (const tab of entry.tabs) tab.view.setVisible(false)
    if (entry.attachedWindow !== null && entry.attachedView !== null) {
      deps.getWindow(entry.attachedWindow)?.detach(entry.attachedView)
      entry.attachedWindow = null
      entry.attachedView = null
    }
  }

  function destroyTab(entry: Entry, tab: TabEntry): void {
    if (tab.destroyed) return
    tab.destroyed = true
    tab.view.setVisible(false)
    if (entry.attachedView === tab.view && entry.attachedWindow !== null) {
      deps.getWindow(entry.attachedWindow)?.detach(tab.view)
      entry.attachedWindow = null
      entry.attachedView = null
    }
    tab.view.destroy()
  }

  function destroyEntry(entry: Entry): void {
    if (entry.destroyed) return
    entry.destroyed = true
    entries.delete(entry.key)
    detachFromWindow(entry)
    for (const tab of entry.tabs) destroyTab(entry, tab)
  }

  function positionEntry(entry: Entry, state: BrowserManagerState): void {
    if (entry.destroyed || entry.tabs.length === 0) return
    const active = activeTab(entry)
    for (const tab of entry.tabs) {
      if (tab !== active) tab.view.setVisible(false)
    }
    const standing = browserStanding(state.grids[entry.workspaceId], entry.panelId)
    if (!standing) {
      detachFromWindow(entry)
      return
    }
    if (
      entry.attachedView !== null &&
      entry.attachedWindow !== null &&
      (entry.attachedView !== active.view || entry.attachedWindow !== standing.window)
    ) {
      deps.getWindow(entry.attachedWindow)?.detach(entry.attachedView)
      entry.attachedWindow = null
      entry.attachedView = null
    }
    const win = deps.getWindow(standing.window)
    const viewport = win?.viewport() ?? null
    const onBoundsWindow = entry.boundsWindow === standing.window
    const scaled = onBoundsWindow && entry.bounds ? scaleBounds(entry.bounds, entry.viewport, viewport) : null
    const clipped = scaled && viewport ? clipBounds(scaled, viewport) : scaled
    const show = shouldShowBrowser({
      onCurrentWorkspace: state.currentWorkspaceId === entry.workspaceId,
      visibleInGrid: standing.visibleInGrid,
      rendererVisible: onBoundsWindow && entry.rendererVisible,
      bounds: clipped,
      hasUrl: Boolean(active.url || entry.stateUrl),
      hasError: active.error !== null,
    })
    if (show && win && clipped) {
      if (entry.attachedWindow !== win.number || entry.attachedView !== active.view) {
        win.attach(active.view)
        entry.attachedWindow = win.number
        entry.attachedView = active.view
      }
      active.view.setBounds(clipped)
      active.view.setVisible(true)
    } else {
      detachFromWindow(entry)
    }
  }

  function createTab(
    entry: Entry,
    initialUrl: string,
    customCreateView: (events: BrowserViewEvents) => ManagedBrowserView = deps.createView,
    openerTabId: string | null = null,
  ): TabEntry {
    const id = `t${++entry.nextTabSeq}`
    let tab!: TabEntry
    const view = customCreateView({
      onDidStartLoading() {
        if (!tab || tab.destroyed || entry.destroyed) return
        tab.loading = true
        pushSnapshot(entry)
      },
      onDidStopLoading() {
        if (!tab || tab.destroyed || entry.destroyed) return
        tab.loading = false
        if (tab.error !== null) {
          pushSnapshot(entry)
          return
        }
        const liveUrl = tab.view.getURL()
        if (isBrowserUrl(liveUrl)) tab.url = liveUrl
        const liveTitle = tab.view.getTitle()
        if (liveTitle) tab.title = liveTitle
        if (isVideoPageUrl(tab.url)) tab.theater = true
        tab.view.setTheaterMode?.(tab.theater, tab.url)
        pushSnapshot(entry)
        const loadId = tab.loadSeq
        void tab.view
          .readPageText()
          .then((text) => {
            if (tab.destroyed || entry.destroyed || tab.loadSeq !== loadId || tab.error !== null || tab.text === text)
              return
            tab.text = text
            pushSnapshot(entry)
          })
          .catch(() => undefined)
      },
      onDidNavigate(url) {
        if (!tab || tab.destroyed || entry.destroyed) return
        const normalized = normalizeBrowserUrl(url)
        if (normalized) {
          tab.url = normalized
          tab.error = null
          if (isVideoPageUrl(normalized)) tab.theater = true
          tab.view.setTheaterMode?.(tab.theater, normalized)
        }
        const liveTitle = tab.view.getTitle()
        if (liveTitle) tab.title = liveTitle
        positionEntry(entry, deps.getState())
        pushSnapshot(entry)
      },
      onDidFailLoad(errorCode, errorDescription, isMainFrame) {
        if (!tab || tab.destroyed || entry.destroyed || !isMainFrame || errorCode === ERR_ABORTED) return
        tab.loading = false
        tab.error = errorDescription || `Load failed (${errorCode}).`
        positionEntry(entry, deps.getState())
        pushSnapshot(entry)
      },
      onPageTitleUpdated(title) {
        if (!tab || tab.destroyed || entry.destroyed) return
        tab.title = title
        pushSnapshot(entry)
      },
      onFocus() {
        if (!tab || tab.destroyed || entry.destroyed) return
        const standing = browserStanding(deps.getState().grids[entry.workspaceId], entry.panelId)
        if (standing && !standing.focused) deps.focusElement(entry.workspaceId, standing.element.id)
      },
      onOpenWindow(url, createChildView) {
        if (entry.destroyed) return null
        if (createChildView) {
          const normalized = normalizeBrowserUrl(url) ?? ''
          if (!normalized && !isBlankBrowserPopupUrl(url)) return null
          const opened = createTab(entry, normalized, createChildView, tab.id)
          opened.loading = Boolean(normalized)
          entry.tabs.push(opened)
          entry.activeTabId = opened.id
          positionEntry(entry, deps.getState())
          pushSnapshot(entry)
          return opened.view
        }
        const normalized = normalizeBrowserUrl(url)
        if (!normalized) return null
        const opened = createTab(entry, normalized, deps.createView, tab.id)
        entry.tabs.push(opened)
        entry.activeTabId = opened.id
        loadTabAddress(entry, opened, normalized)
        return opened.view
      },
      onClose() {
        if (!tab || tab.destroyed || entry.destroyed) return
        closeTabById(entry, tab.id, true)
      },
    })
    tab = {
      id,
      openerTabId,
      view,
      url: initialUrl,
      title: '',
      loading: false,
      theater: isVideoPageUrl(initialUrl),
      error: null,
      text: null,
      loadSeq: 0,
      destroyed: false,
    }
    return tab
  }

  function closeTabById(entry: Entry, targetId: string, replaceSingleTab: boolean): void {
    const index = entry.tabs.findIndex((one) => one.id === targetId)
    if (index < 0) return
    if (entry.tabs.length <= 1) {
      if (replaceSingleTab) {
        const [removed] = entry.tabs.splice(index, 1)
        if (removed) destroyTab(entry, removed)
        const replacement = createTab(entry, DEFAULT_BROWSER_URL)
        entry.tabs.push(replacement)
        entry.activeTabId = replacement.id
      }
      entry.stateUrl = DEFAULT_BROWSER_URL
      deps.setPanelUrl(entry.workspaceId, entry.panelId, DEFAULT_BROWSER_URL)
      loadTabAddress(entry, entry.tabs[0]!, DEFAULT_BROWSER_URL)
      return
    }
    const [removed] = entry.tabs.splice(index, 1)
    if (removed) destroyTab(entry, removed)
    if (entry.activeTabId === targetId) {
      const opener = removed?.openerTabId ? entry.tabs.find((one) => one.id === removed.openerTabId) : undefined
      const nextTab = opener ?? entry.tabs[Math.min(index, entry.tabs.length - 1)]!
      entry.activeTabId = nextTab.id
    }
    positionEntry(entry, deps.getState())
    pushSnapshot(entry)
  }

  function ensureEntry(workspaceId: string, panel: Panel): Entry {
    const key = entryKey(workspaceId, panel.id)
    const existing = entries.get(key)
    if (existing) return existing
    const entry: Entry = {
      key,
      workspaceId,
      panelId: panel.id,
      tabs: [],
      activeTabId: '',
      nextTabSeq: 0,
      stateUrl: '',
      refreshedAt: panel.refreshedAt,
      bounds: null,
      boundsWindow: null,
      viewport: null,
      rendererVisible: false,
      attachedWindow: null,
      attachedView: null,
      destroyed: false,
    }
    const first = createTab(entry, '')
    entry.tabs.push(first)
    entry.activeTabId = first.id
    entries.set(key, entry)
    return entry
  }

  function loadTabAddress(entry: Entry, tab: TabEntry, url: string): void {
    const loadId = ++tab.loadSeq
    tab.url = url
    tab.title = ''
    tab.text = null
    tab.error = null
    tab.loading = true
    tab.theater = isVideoPageUrl(url)
    tab.view.setTheaterMode?.(tab.theater, url)
    positionEntry(entry, deps.getState())
    pushSnapshot(entry)
    void tab.view.loadURL(url).catch((err: unknown) => {
      if (tab.destroyed || entry.destroyed || tab.loadSeq !== loadId || isAbortedLoad(err)) return
      tab.loading = false
      tab.error = err instanceof Error ? err.message : String(err)
      positionEntry(entry, deps.getState())
      pushSnapshot(entry)
    })
  }

  function reloadTab(entry: Entry, tab: TabEntry): void {
    const targetUrl = tab.url || entry.stateUrl
    const liveUrl = tab.view.getURL()
    if ((tab.error !== null || !isBrowserUrl(liveUrl) || liveUrl !== targetUrl) && targetUrl) {
      loadTabAddress(entry, tab, targetUrl)
      return
    }
    tab.error = null
    tab.loading = true
    positionEntry(entry, deps.getState())
    tab.view.reload()
    pushSnapshot(entry)
  }

  function applyPanelState(entry: Entry, panel: Panel, stateUrl: string): void {
    const active = activeTab(entry)
    if (stateUrl !== entry.stateUrl) {
      entry.stateUrl = stateUrl
      entry.refreshedAt = panel.refreshedAt
      loadTabAddress(entry, active, stateUrl)
      return
    }
    if (panel.refreshedAt !== null && panel.refreshedAt !== entry.refreshedAt) {
      entry.refreshedAt = panel.refreshedAt
      reloadTab(entry, active)
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
      entry.boundsWindow = callerWindow
      entry.viewport = callerWindow !== null ? (deps.getWindow(callerWindow)?.viewport() ?? null) : null
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

      if (action === 'load') {
        const normalized = normalizeBrowserUrl(rawUrl)
        if (normalized === null) throw new Error('Enter an https:// or http:// address.')
        const target = normalized || DEFAULT_BROWSER_URL
        const entry = ensureEntry(workspaceId, panel)
        entry.stateUrl = target
        deps.setPanelUrl(workspaceId, panel.id, target)
        loadTabAddress(entry, activeTab(entry), target)
        return snapshotOf(entry)
      }

      const entry = ensureEntry(workspaceId, panel)
      if (!entry.stateUrl) {
        const stateUrl = readBrowserState(panel.state).url
        entry.stateUrl = stateUrl
        loadTabAddress(entry, activeTab(entry), stateUrl)
      }

      if (action === 'new-tab') {
        const target = (typeof rawUrl === 'string' ? normalizeBrowserUrl(rawUrl) : null) || DEFAULT_BROWSER_URL
        const opened = createTab(entry, target)
        entry.tabs.push(opened)
        entry.activeTabId = opened.id
        loadTabAddress(entry, opened, target)
        return snapshotOf(entry)
      }

      if (action === 'select-tab') {
        const targetId = typeof rawUrl === 'string' ? rawUrl : ''
        const found = entry.tabs.find((one) => one.id === targetId)
        if (found) {
          entry.activeTabId = found.id
          positionEntry(entry, deps.getState())
          pushSnapshot(entry)
        }
        return snapshotOf(entry)
      }

      if (action === 'close-tab') {
        const targetId = typeof rawUrl === 'string' && rawUrl ? rawUrl : entry.activeTabId
        closeTabById(entry, targetId, false)
        return snapshotOf(entry)
      }

      const active = activeTab(entry)
      if (action === 'toggle-theater') {
        active.theater = !active.theater
        active.view.setTheaterMode?.(active.theater, active.url || entry.stateUrl)
        pushSnapshot(entry)
        return snapshotOf(entry)
      }

      if (action === 'reload') {
        reloadTab(entry, active)
        return snapshotOf(entry)
      }

      active.error = null
      if (action === 'back' && active.view.canGoBack()) active.view.goBack()
      else if (action === 'forward' && active.view.canGoForward()) active.view.goForward()
      positionEntry(entry, deps.getState())
      pushSnapshot(entry)
      return snapshotOf(entry)
    },

    detach(callerWindow, rawWorkspaceId, rawPanelId) {
      if (callerWindow === null || typeof rawWorkspaceId !== 'string' || typeof rawPanelId !== 'string') return
      const entry = entries.get(entryKey(rawWorkspaceId, rawPanelId))
      if (
        entry &&
        (entry.boundsWindow === callerWindow ||
          entry.attachedWindow === callerWindow ||
          (entry.boundsWindow === null && entry.attachedWindow === null))
      ) {
        if (entry.boundsWindow === callerWindow || entry.boundsWindow === null) entry.rendererVisible = false
        if (entry.attachedWindow === callerWindow || entry.attachedWindow === null) detachFromWindow(entry)
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
          entry.attachedView = null
        }
        if (entry.boundsWindow === windowNumber) {
          entry.boundsWindow = null
          entry.viewport = null
          entry.rendererVisible = false
        }
      }
    },

    closeAll() {
      for (const entry of [...entries.values()]) destroyEntry(entry)
    },
  }
}

export interface BrowserUserAgentTarget {
  getURL(): string
  getUserAgent(): string
  setUserAgent(userAgent: string): void
  setCdpUserAgentOverride?(userAgent: string): void
}

export interface BrowserUserAgentSync {
  inFlightUrl(): string | undefined
  onDidStartNavigation(url: string, isMainFrame: boolean, isSameDocument: boolean): void
  onWillRedirect(url: string, isMainFrame: boolean): void
  onDidNavigate(url: string): void
  onDidFailLoad(isMainFrame: boolean): void
  onDebuggerDetach(): void
}

export function createBrowserUserAgentSync(
  target: BrowserUserAgentTarget,
  baseUserAgent: string,
  platform = 'darwin',
): BrowserUserAgentSync {
  const cleanUa = browserUserAgent(baseUserAgent)
  let cdpOverrideUa: string | null = null
  let inFlightMainFrameUrl: string | undefined

  const resolveUa = (url: string): string => browserUserAgentForUrl(url, cleanUa || baseUserAgent, platform)

  return {
    inFlightUrl: () => inFlightMainFrameUrl,
    onDidStartNavigation(url, isMainFrame, isSameDocument) {
      if (!isMainFrame || isSameDocument || !isBrowserUrl(url)) return
      inFlightMainFrameUrl = url
      const targetUa = resolveUa(url)
      if (targetUa && target.getUserAgent() !== targetUa) {
        target.setUserAgent(targetUa)
      }
      if (cdpOverrideUa !== null) {
        cdpOverrideUa = null
        target.setCdpUserAgentOverride?.('')
      }
    },
    onWillRedirect(url, isMainFrame) {
      if (!isMainFrame || !isBrowserUrl(url)) return
      inFlightMainFrameUrl = url
      const targetUa = resolveUa(url)
      if (!targetUa) return
      const effectiveUa = cdpOverrideUa ?? target.getUserAgent()
      if (effectiveUa === targetUa) return
      const nextOverride = target.getUserAgent() === targetUa ? '' : targetUa
      cdpOverrideUa = nextOverride || null
      target.setCdpUserAgentOverride?.(nextOverride)
    },
    onDidNavigate(url) {
      inFlightMainFrameUrl = undefined
      if (!isBrowserUrl(url)) return
      const targetUa = resolveUa(url)
      if (targetUa && target.getUserAgent() !== targetUa) {
        target.setUserAgent(targetUa)
      }
    },
    onDidFailLoad(isMainFrame) {
      if (!isMainFrame) return
      inFlightMainFrameUrl = undefined
      const committedUrl = target.getURL()
      if (!isBrowserUrl(committedUrl)) return
      const targetUa = resolveUa(committedUrl)
      if (targetUa && target.getUserAgent() !== targetUa) {
        target.setUserAgent(targetUa)
      }
      if (cdpOverrideUa !== null) {
        cdpOverrideUa = null
        target.setCdpUserAgentOverride?.('')
      }
    },
    onDebuggerDetach() {
      cdpOverrideUa = null
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
