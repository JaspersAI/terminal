// Coordinates `WebContentsView` tabs per `core/browser` panel across workspaces and windows. Kept
// free of Electron imports so the tab lifecycle, bounds clipping, visibility, navigation, theater
// mode defaults, and sweep rules run directly under Node's test runner.

import {
  BROWSER_VIEW,
  browserEmulationOverrideForUrl,
  browserStanding,
  browserUserAgent,
  browserUserAgentForUrl,
  clipBounds,
  DEFAULT_BROWSER_BOUNDS,
  DEFAULT_BROWSER_URL,
  isBlankBrowserPopupUrl,
  isBotChallengeText,
  isBotChallengeUrl,
  isBrowserUrl,
  isVideoPageUrl,
  normalizeBounds,
  normalizeBrowserUrl,
  readBrowserState,
  scaleBounds,
  shouldShowBrowser,
  unwrapBotChallengeUrl,
  type BrowserAction,
  type BrowserBounds,
  type BrowserEmulationOverride,
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
  onZoom?(direction: 'in' | 'out' | 'reset'): void
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
  setBackgrounded?(backgrounded: boolean): void
  setTheaterMode?(theater: boolean, url: string): void
  setZoomFactor?(zoom: number): void
  clearBotCookies?(url?: string): Promise<void> | void
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
  zoomElement?(workspaceId: string, elementId: string, direction: 'in' | 'out' | 'reset'): void
  publishPanel?(workspaceId: string, panelId: string, snapshot: BrowserSnapshot): void
  /** How long a backgrounded tab or inactive-workspace browser view waits before discarding its native view. */
  idleSuspendMs?: number
  /** Delays after a load or in-page navigation at which page text is re-read to capture async client-side hydration. */
  hydrationDelaysMs?: readonly number[]
  /** How long `syncPanelText` waits for an active main-frame load to finish. */
  settleTimeoutMs?: number
  /** Post-load window during which `syncPanelText` polls for async auth/subscriber DOM hydration. */
  hydrationWindowMs?: number
  /** Poll interval within `hydrationWindowMs` when waiting for DOM text hydration to stabilize. */
  hydrationPollMs?: number
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
  syncPanelText(rawWorkspaceId: unknown, rawPanelId: unknown, signal?: AbortSignal): Promise<string | null>
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
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  text: string | null
  loadSeq: number
  loadedAt: number | null
  initialLoadText: string | null
  challengeRetriedUrl: string | null
  hydrationTimers: ReturnType<typeof setTimeout>[]
  loadWaiters: Set<() => void>
  backgrounded: boolean
  suspended: boolean
  suspendTimer: ReturnType<typeof setTimeout> | null
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
  /** The last `panel.state` reference seen on sync/sweep, so an explicit `set` to the same `state.url` after an in-page navigation still loads `state.url`. */
  stateRef: Record<string, unknown> | null
  suppressStateLoad: boolean
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
/** Background tabs and inactive-workspace browser views discard their native WebContentsView after 5 minutes idle. */
export const DEFAULT_IDLE_SUSPEND_MS = 5 * 60_000
export const DEFAULT_HYDRATION_DELAYS_MS: readonly number[] = [350, 1_000, 2_200]
export const DEFAULT_SETTLE_TIMEOUT_MS = 4_000
export const DEFAULT_HYDRATION_WINDOW_MS = 1_500
export const DEFAULT_HYDRATION_POLL_MS = 250
const SUBSTANTIAL_HYDRATION_CHARS = 2_000

const entryKey = (workspaceId: string, panelId: string): string => `${workspaceId}\n${panelId}`

export function createBrowserManager(deps: BrowserManagerDeps): BrowserManager {
  const entries = new Map<string, Entry>()
  const idleSuspendMs = deps.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS
  const hydrationDelaysMs = deps.hydrationDelaysMs ?? DEFAULT_HYDRATION_DELAYS_MS
  const settleTimeoutMs = deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  const hydrationWindowMs = deps.hydrationWindowMs ?? DEFAULT_HYDRATION_WINDOW_MS
  const hydrationPollMs = Math.max(10, deps.hydrationPollMs ?? DEFAULT_HYDRATION_POLL_MS)

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
    if (tab.suspended) {
      return {
        id: tab.id,
        url: tab.url || fallbackUrl,
        title: tab.title,
        loading: false,
        canGoBack: tab.canGoBack,
        canGoForward: tab.canGoForward,
        theater: tab.theater,
        error: tab.error,
      }
    }
    const liveUrl = tab.view.getURL()
    const onChallenge = isBotChallengeUrl(liveUrl)
    const committedUrl = isBrowserUrl(liveUrl)
      ? (unwrapBotChallengeUrl(liveUrl, tab.url || fallbackUrl) ?? liveUrl)
      : ''
    const url = tab.loading || tab.error !== null ? tab.url || fallbackUrl : committedUrl || tab.url || fallbackUrl
    const liveTitle = tab.view.getTitle()
    const title =
      tab.loading || tab.error !== null || onChallenge || isBotChallengeText('', liveTitle)
        ? tab.title
        : liveTitle || tab.title
    const canGoBack = tab.view.canGoBack()
    const canGoForward = tab.view.canGoForward()
    tab.canGoBack = canGoBack
    tab.canGoForward = canGoForward
    return {
      id: tab.id,
      url,
      title,
      loading: tab.loading || tab.view.isLoading(),
      canGoBack,
      canGoForward,
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

  function clearSuspendTimer(tab: TabEntry): void {
    if (tab.suspendTimer !== null) {
      clearTimeout(tab.suspendTimer)
      tab.suspendTimer = null
    }
  }

  function clearHydrationTimers(tab: TabEntry): void {
    if (tab.hydrationTimers.length === 0) return
    for (const timer of tab.hydrationTimers) clearTimeout(timer)
    tab.hydrationTimers = []
  }

  function notifyLoadWaiters(tab: TabEntry): void {
    if (tab.loadWaiters.size === 0) return
    const waiters = [...tab.loadWaiters]
    tab.loadWaiters.clear()
    for (const wake of waiters) wake()
  }

  function detachFromWindow(entry: Entry): void {
    for (const tab of entry.tabs) {
      if (!tab.suspended) tab.view.setVisible(false)
    }
    if (entry.attachedWindow !== null && entry.attachedView !== null) {
      deps.getWindow(entry.attachedWindow)?.detach(entry.attachedView)
      entry.attachedWindow = null
      entry.attachedView = null
    }
  }

  function destroyTab(entry: Entry, tab: TabEntry): void {
    if (tab.destroyed) return
    tab.destroyed = true
    clearSuspendTimer(tab)
    clearHydrationTimers(tab)
    notifyLoadWaiters(tab)
    if (!tab.suspended) {
      tab.view.setVisible(false)
      if (entry.attachedView === tab.view && entry.attachedWindow !== null) {
        deps.getWindow(entry.attachedWindow)?.detach(tab.view)
        entry.attachedWindow = null
        entry.attachedView = null
      }
      tab.view.destroy()
    }
  }

  function destroyEntry(entry: Entry): void {
    if (entry.destroyed) return
    entry.destroyed = true
    entries.delete(entry.key)
    detachFromWindow(entry)
    for (const tab of entry.tabs) destroyTab(entry, tab)
  }

  function canSuspendTab(entry: Entry, tab: TabEntry): boolean {
    if (entry.destroyed || tab.destroyed || tab.suspended || !tab.backgrounded) return false
    const url = tab.url || entry.stateUrl
    if (!url) return false
    if (tab.openerTabId !== null && !isBrowserUrl(tab.url)) return false
    if (entry.tabs.some((other) => !other.destroyed && other.openerTabId === tab.id)) return false
    return true
  }

  function suspendTab(entry: Entry, tab: TabEntry): void {
    clearSuspendTimer(tab)
    clearHydrationTimers(tab)
    if (!canSuspendTab(entry, tab)) return
    const liveUrl = tab.view.getURL()
    if (isBrowserUrl(liveUrl)) {
      tab.url = unwrapBotChallengeUrl(liveUrl, tab.url || entry.stateUrl) ?? liveUrl
    }
    const liveTitle = tab.view.getTitle()
    if (liveTitle && !isBotChallengeUrl(liveUrl) && !isBotChallengeText('', liveTitle)) {
      tab.title = liveTitle
    }
    tab.canGoBack = tab.view.canGoBack()
    tab.canGoForward = tab.view.canGoForward()
    tab.loading = false
    notifyLoadWaiters(tab)
    tab.view.setVisible(false)
    if (entry.attachedView === tab.view && entry.attachedWindow !== null) {
      deps.getWindow(entry.attachedWindow)?.detach(tab.view)
      entry.attachedWindow = null
      entry.attachedView = null
    }
    tab.suspended = true
    tab.view.destroy()
  }

  function wakeTab(entry: Entry, tab: TabEntry): void {
    clearSuspendTimer(tab)
    if (!tab.suspended || tab.destroyed || entry.destroyed) return
    tab.suspended = false
    tab.backgrounded = false
    const savedTitle = tab.title
    const savedText = tab.text
    const targetUrl = tab.url || entry.stateUrl
    tab.view = bindTabView(entry, tab, deps.createView)
    if (targetUrl) {
      loadTabAddress(entry, tab, targetUrl, { preserveTitle: savedTitle, preserveText: savedText })
    }
  }

  function setTabBackgrounded(entry: Entry, tab: TabEntry, backgrounded: boolean): void {
    if (tab.destroyed || entry.destroyed) return
    if (!backgrounded) {
      clearSuspendTimer(tab)
      if (tab.suspended) {
        wakeTab(entry, tab)
        return
      }
      if (tab.backgrounded) {
        tab.backgrounded = false
        tab.view.setBackgrounded?.(false)
      }
      return
    }
    if (!tab.backgrounded) {
      tab.backgrounded = true
      if (!tab.suspended) tab.view.setBackgrounded?.(true)
    }
    if (!tab.suspended && tab.suspendTimer === null && idleSuspendMs > 0 && canSuspendTab(entry, tab)) {
      tab.suspendTimer = setTimeout(() => {
        tab.suspendTimer = null
        suspendTab(entry, tab)
      }, idleSuspendMs)
      tab.suspendTimer.unref?.()
    }
  }

  async function readTabTextNow(entry: Entry, tab: TabEntry): Promise<string | null> {
    if (tab.destroyed || tab.suspended || entry.destroyed || tab.loading || tab.error !== null) return tab.text
    const loadId = tab.loadSeq
    const currentView = tab.view
    try {
      const text = await currentView.readPageText()
      if (
        tab.destroyed ||
        tab.suspended ||
        tab.view !== currentView ||
        entry.destroyed ||
        tab.loadSeq !== loadId ||
        tab.error !== null
      ) {
        return tab.text
      }
      const liveUrl = currentView.getURL()
      const liveTitle = currentView.getTitle() || tab.title
      if (
        text !== null &&
        (isBotChallengeUrl(liveUrl) || isBotChallengeText(text, liveTitle)) &&
        tab.text !== null &&
        !isBotChallengeText(tab.text)
      ) {
        return tab.text
      }
      if (tab.initialLoadText === null && text !== null) {
        tab.initialLoadText = text
      }
      if (tab.text !== text) {
        tab.text = text
        pushSnapshot(entry)
      }
      return tab.text
    } catch {
      return tab.text
    }
  }

  function readTabText(entry: Entry, tab: TabEntry): void {
    void readTabTextNow(entry, tab)
  }

  function scheduleHydrationReads(entry: Entry, tab: TabEntry): void {
    clearHydrationTimers(tab)
    if (hydrationDelaysMs.length === 0) return
    const loadId = tab.loadSeq
    for (const delay of hydrationDelaysMs) {
      if (delay <= 0) continue
      const timer = setTimeout(() => {
        tab.hydrationTimers = tab.hydrationTimers.filter((one) => one !== timer)
        if (
          tab.destroyed ||
          tab.suspended ||
          entry.destroyed ||
          tab.loading ||
          tab.error !== null ||
          tab.loadSeq !== loadId ||
          activeTab(entry) !== tab
        ) {
          return
        }
        readTabText(entry, tab)
      }, delay)
      timer.unref?.()
      tab.hydrationTimers.push(timer)
    }
  }

  function positionEntry(entry: Entry, state: BrowserManagerState): void {
    if (entry.destroyed || entry.tabs.length === 0) return
    const active = activeTab(entry)
    const standing = browserStanding(state.grids[entry.workspaceId], entry.panelId)
    const onCurrentWorkspace = state.currentWorkspaceId === entry.workspaceId
    const foregroundInGrid = onCurrentWorkspace && Boolean(standing?.visibleInGrid)

    for (const tab of entry.tabs) {
      if (tab !== active) {
        if (!tab.suspended) tab.view.setVisible(false)
        setTabBackgrounded(entry, tab, true)
      }
    }
    if (!standing) {
      setTabBackgrounded(entry, active, true)
      if (!active.suspended) {
        const fallback =
          entry.bounds && entry.bounds.width > 0 && entry.bounds.height > 0 ? entry.bounds : DEFAULT_BROWSER_BOUNDS
        active.view.setBounds(fallback)
      }
      detachFromWindow(entry)
      return
    }
    const hasUrl = Boolean(active.url || entry.stateUrl)
    const activeForeground = foregroundInGrid && hasUrl && active.error === null
    if (activeForeground && active.suspended) {
      wakeTab(entry, active)
      return
    }
    setTabBackgrounded(entry, active, !activeForeground)
    if (active.suspended) {
      detachFromWindow(entry)
      return
    }
    active.view.setZoomFactor?.(standing.zoom)
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
    const fallbackBounds =
      clipped && clipped.width > 0 && clipped.height > 0
        ? clipped
        : entry.bounds && entry.bounds.width > 0 && entry.bounds.height > 0
          ? entry.bounds
          : viewport && viewport.width > 0 && viewport.height > 0
            ? { x: 0, y: 0, width: viewport.width, height: viewport.height }
            : DEFAULT_BROWSER_BOUNDS
    const show = shouldShowBrowser({
      onCurrentWorkspace,
      visibleInGrid: standing.visibleInGrid,
      rendererVisible: onBoundsWindow && entry.rendererVisible,
      bounds: clipped,
      hasUrl,
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
      active.view.setBounds(fallbackBounds)
      detachFromWindow(entry)
    }
  }

  function bindTabView(
    entry: Entry,
    tab: TabEntry,
    customCreateView: (events: BrowserViewEvents) => ManagedBrowserView = deps.createView,
  ): ManagedBrowserView {
    let view!: ManagedBrowserView
    const isCurrent = (): boolean =>
      Boolean(tab && !tab.destroyed && !tab.suspended && !entry.destroyed && tab.view === view)
    view = customCreateView({
      onDidStartLoading() {
        if (!isCurrent()) return
        clearHydrationTimers(tab)
        tab.loading = true
        tab.loadedAt = null
        tab.initialLoadText = null
        pushSnapshot(entry)
      },
      onDidStopLoading() {
        if (!isCurrent()) return
        if (tab.error !== null) {
          tab.loading = false
          notifyLoadWaiters(tab)
          pushSnapshot(entry)
          return
        }
        const liveUrl = tab.view.getURL()
        if (isBotChallengeUrl(liveUrl)) {
          const retryTarget = unwrapBotChallengeUrl(liveUrl, tab.url || entry.stateUrl) || tab.url || entry.stateUrl
          if (retryTarget) tab.url = retryTarget
          if (retryTarget && tab.challengeRetriedUrl !== retryTarget) {
            tab.challengeRetriedUrl = retryTarget
            loadTabAddress(entry, tab, retryTarget, {
              preserveTitle: tab.title,
              preserveText: tab.text,
              keepChallengeRetry: true,
              clearBotCookies: true,
            })
            return
          }
        } else if (isBrowserUrl(liveUrl)) {
          tab.url = liveUrl
          tab.challengeRetriedUrl = null
        }
        tab.loading = false
        tab.loadedAt = Date.now()
        notifyLoadWaiters(tab)
        const liveTitle = tab.view.getTitle()
        if (liveTitle && !isBotChallengeUrl(liveUrl) && !isBotChallengeText('', liveTitle)) {
          tab.title = liveTitle
        }
        if (isVideoPageUrl(tab.url)) tab.theater = true
        tab.view.setTheaterMode?.(tab.theater, tab.url)
        positionEntry(entry, deps.getState())
        pushSnapshot(entry)
        if (activeTab(entry) === tab) {
          readTabText(entry, tab)
          scheduleHydrationReads(entry, tab)
        }
      },
      onDidNavigate(url) {
        if (!isCurrent()) return
        if (isBotChallengeUrl(url)) {
          const unwrapped = unwrapBotChallengeUrl(url, tab.url || entry.stateUrl)
          if (unwrapped) {
            tab.url = unwrapped
            tab.error = null
            if (isVideoPageUrl(unwrapped)) tab.theater = true
            tab.view.setTheaterMode?.(tab.theater, unwrapped)
          }
          if (!tab.loading && !tab.view.isLoading() && unwrapped && tab.challengeRetriedUrl !== unwrapped) {
            tab.challengeRetriedUrl = unwrapped
            loadTabAddress(entry, tab, unwrapped, {
              preserveTitle: tab.title,
              preserveText: tab.text,
              keepChallengeRetry: true,
              clearBotCookies: true,
            })
            return
          }
          positionEntry(entry, deps.getState())
          pushSnapshot(entry)
          return
        }
        const normalized = normalizeBrowserUrl(url)
        if (normalized) {
          tab.url = normalized
          tab.challengeRetriedUrl = null
          tab.error = null
          if (isVideoPageUrl(normalized)) tab.theater = true
          tab.view.setTheaterMode?.(tab.theater, normalized)
        }
        const liveTitle = tab.view.getTitle()
        if (liveTitle && !isBotChallengeText('', liveTitle)) tab.title = liveTitle
        positionEntry(entry, deps.getState())
        pushSnapshot(entry)
        if (!tab.loading && !tab.view.isLoading() && tab.error === null && activeTab(entry) === tab) {
          tab.loadSeq++
          tab.loadedAt = Date.now()
          tab.initialLoadText = null
          readTabText(entry, tab)
          scheduleHydrationReads(entry, tab)
        }
      },
      onDidFailLoad(errorCode, errorDescription, isMainFrame) {
        if (!isCurrent() || !isMainFrame || errorCode === ERR_ABORTED) return
        clearHydrationTimers(tab)
        tab.loading = false
        tab.loadedAt = null
        tab.error = errorDescription || `Load failed (${errorCode}).`
        notifyLoadWaiters(tab)
        positionEntry(entry, deps.getState())
        pushSnapshot(entry)
      },
      onPageTitleUpdated(title) {
        if (!isCurrent()) return
        if (isBotChallengeUrl(tab.view.getURL()) || isBotChallengeText('', title)) return
        tab.title = title
        pushSnapshot(entry)
      },
      onFocus() {
        if (!isCurrent()) return
        const standing = browserStanding(deps.getState().grids[entry.workspaceId], entry.panelId)
        if (standing && !standing.focused) deps.focusElement(entry.workspaceId, standing.element.id)
      },
      onZoom(direction) {
        if (!isCurrent()) return
        const standing = browserStanding(deps.getState().grids[entry.workspaceId], entry.panelId)
        if (standing && standing.focused && standing.visibleInGrid) {
          deps.zoomElement?.(entry.workspaceId, (standing.frame ?? standing.element).id, direction)
        }
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
        if (!isCurrent()) return
        closeTabById(entry, tab.id, true)
      },
    })
    return view
  }

  function createTab(
    entry: Entry,
    initialUrl: string,
    customCreateView: (events: BrowserViewEvents) => ManagedBrowserView = deps.createView,
    openerTabId: string | null = null,
  ): TabEntry {
    const id = `t${++entry.nextTabSeq}`
    const tab: TabEntry = {
      id,
      openerTabId,
      view: null as unknown as ManagedBrowserView,
      url: initialUrl,
      title: '',
      loading: false,
      theater: isVideoPageUrl(initialUrl),
      canGoBack: false,
      canGoForward: false,
      error: null,
      text: null,
      loadSeq: 0,
      loadedAt: null,
      initialLoadText: null,
      challengeRetriedUrl: null,
      hydrationTimers: [],
      loadWaiters: new Set(),
      backgrounded: false,
      suspended: false,
      suspendTimer: null,
      destroyed: false,
    }
    tab.view = bindTabView(entry, tab, customCreateView)
    return tab
  }

  function updatePanelUrl(entry: Entry, target: string): void {
    entry.stateUrl = target
    entry.suppressStateLoad = true
    try {
      deps.setPanelUrl(entry.workspaceId, entry.panelId, target)
    } finally {
      entry.suppressStateLoad = false
    }
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
      updatePanelUrl(entry, DEFAULT_BROWSER_URL)
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
      stateRef: null,
      suppressStateLoad: false,
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

  function loadTabAddress(
    entry: Entry,
    tab: TabEntry,
    url: string,
    options?: {
      preserveTitle?: string
      preserveText?: string | null
      keepChallengeRetry?: boolean
      clearBotCookies?: boolean
    },
  ): void {
    clearSuspendTimer(tab)
    clearHydrationTimers(tab)
    if (tab.suspended) {
      tab.suspended = false
      tab.backgrounded = false
      tab.view = bindTabView(entry, tab, deps.createView)
    }
    const targetUrl = unwrapBotChallengeUrl(url, tab.url || entry.stateUrl) || url
    if (!options?.keepChallengeRetry) {
      tab.challengeRetriedUrl = null
    }
    const loadId = ++tab.loadSeq
    tab.url = targetUrl
    tab.title = options?.preserveTitle ?? ''
    tab.text = options?.preserveText ?? null
    tab.loadedAt = null
    tab.initialLoadText = null
    tab.error = null
    tab.loading = true
    tab.theater = isVideoPageUrl(targetUrl)
    tab.view.setTheaterMode?.(tab.theater, targetUrl)
    positionEntry(entry, deps.getState())
    pushSnapshot(entry)
    const currentView = tab.view
    const startLoad = async (): Promise<void> => {
      if (options?.clearBotCookies) {
        try {
          await currentView.clearBotCookies?.(targetUrl)
        } catch {
          // Ignore cookie cleanup failures before load.
        }
        if (tab.destroyed || tab.suspended || tab.view !== currentView || entry.destroyed || tab.loadSeq !== loadId) {
          return
        }
      }
      await currentView.loadURL(targetUrl)
    }
    void startLoad().catch((err: unknown) => {
      if (
        tab.destroyed ||
        tab.suspended ||
        tab.view !== currentView ||
        entry.destroyed ||
        tab.loadSeq !== loadId ||
        isAbortedLoad(err)
      )
        return
      tab.loading = false
      tab.loadedAt = null
      tab.error = err instanceof Error ? err.message : String(err)
      notifyLoadWaiters(tab)
      positionEntry(entry, deps.getState())
      pushSnapshot(entry)
    })
  }

  function reloadTab(entry: Entry, tab: TabEntry): void {
    tab.challengeRetriedUrl = null
    if (tab.suspended) {
      wakeTab(entry, tab)
      return
    }
    const targetUrl = unwrapBotChallengeUrl(tab.url || entry.stateUrl, entry.stateUrl) || tab.url || entry.stateUrl
    const liveUrl = tab.view.getURL()
    if (isBotChallengeUrl(liveUrl) && targetUrl) {
      loadTabAddress(entry, tab, targetUrl, {
        preserveTitle: tab.title,
        preserveText: tab.text,
        clearBotCookies: true,
      })
      return
    }
    if ((tab.error !== null || !isBrowserUrl(liveUrl) || liveUrl !== targetUrl) && targetUrl) {
      loadTabAddress(entry, tab, targetUrl, { preserveTitle: tab.title, preserveText: tab.text })
      return
    }
    clearHydrationTimers(tab)
    tab.loadSeq++
    tab.loadedAt = null
    tab.initialLoadText = null
    tab.error = null
    tab.loading = true
    positionEntry(entry, deps.getState())
    tab.view.reload()
    pushSnapshot(entry)
  }

  function applyPanelState(entry: Entry, panel: Panel, stateUrl: string): void {
    if (entry.suppressStateLoad) {
      entry.stateRef = panel.state
      return
    }
    const active = activeTab(entry)
    const explicitStateWrite = entry.stateRef !== null && panel.state !== entry.stateRef
    entry.stateRef = panel.state
    if (stateUrl !== entry.stateUrl || explicitStateWrite) {
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
        updatePanelUrl(entry, target)
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
          const wasSuspended = found.suspended
          if (wasSuspended) {
            wakeTab(entry, found)
          } else {
            positionEntry(entry, deps.getState())
            pushSnapshot(entry)
            if (found.text === null && !found.loading && found.error === null) {
              readTabText(entry, found)
            }
          }
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
        if (!active.suspended) {
          active.view.setTheaterMode?.(active.theater, active.url || entry.stateUrl)
        }
        pushSnapshot(entry)
        return snapshotOf(entry)
      }

      if (action === 'reload') {
        reloadTab(entry, active)
        return snapshotOf(entry)
      }

      if (active.suspended) {
        wakeTab(entry, active)
        return snapshotOf(entry)
      }

      active.error = null
      if (action === 'back' && active.view.canGoBack()) active.view.goBack()
      else if (action === 'forward' && active.view.canGoForward()) active.view.goForward()
      positionEntry(entry, deps.getState())
      pushSnapshot(entry)
      return snapshotOf(entry)
    },

    async syncPanelText(rawWorkspaceId, rawPanelId, signal) {
      const state = deps.getState()
      if (typeof rawWorkspaceId !== 'string' || typeof rawPanelId !== 'string' || rawPanelId === '') return null
      const standing = browserStanding(state.grids[rawWorkspaceId], rawPanelId)
      const grid = standing ? state.grids[rawWorkspaceId]?.[standing.window] : undefined
      if (!standing || !grid) return null
      let panel: Panel
      try {
        panel = panelOf(grid, rawPanelId)
      } catch {
        return null
      }
      if (panel.content.kind !== 'view' || panel.content.view !== BROWSER_VIEW) return null
      const entry = entries.get(entryKey(rawWorkspaceId, panel.id))
      if (!entry || entry.destroyed) return panel.text ?? null
      const stateUrl = readBrowserState(panel.state).url
      if (stateUrl) applyPanelState(entry, panel, stateUrl)

      let tab = activeTab(entry)
      if (tab.destroyed || tab.suspended || entry.destroyed || signal?.aborted) return tab.text

      if ((tab.loading || tab.view.isLoading()) && settleTimeoutMs > 0) {
        await waitForTabLoad(tab, settleTimeoutMs, signal)
      }
      tab = activeTab(entry)
      if (
        tab.destroyed ||
        tab.suspended ||
        entry.destroyed ||
        tab.loading ||
        tab.view.isLoading() ||
        tab.error !== null ||
        signal?.aborted
      ) {
        return tab.text
      }

      const firstText = await readTabTextNow(entry, tab)
      const baselineText = tab.initialLoadText ?? firstText

      if (hydrationWindowMs > 0 && tab.loadedAt !== null) {
        const deadline = tab.loadedAt + hydrationWindowMs
        let lastText = firstText
        let changedFromBaseline = firstText !== null && baselineText !== null && firstText !== baselineText
        while (
          !signal?.aborted &&
          !tab.destroyed &&
          !tab.suspended &&
          !entry.destroyed &&
          !tab.loading &&
          !tab.view.isLoading() &&
          tab.error === null &&
          activeTab(entry) === tab
        ) {
          const now = Date.now()
          if (now >= deadline) break
          await sleepOrAbort(Math.min(hydrationPollMs, deadline - now), signal)
          if (
            signal?.aborted ||
            tab.destroyed ||
            tab.suspended ||
            entry.destroyed ||
            tab.loading ||
            tab.view.isLoading() ||
            tab.error !== null ||
            activeTab(entry) !== tab
          ) {
            break
          }
          const nextText = await readTabTextNow(entry, tab)
          if (nextText !== lastText) {
            changedFromBaseline = true
            lastText = nextText
            if (Date.now() >= deadline && !signal?.aborted) {
              await sleepOrAbort(hydrationPollMs, signal)
              if (
                !signal?.aborted &&
                !tab.destroyed &&
                !tab.suspended &&
                !entry.destroyed &&
                !tab.loading &&
                tab.error === null &&
                activeTab(entry) === tab
              ) {
                lastText = await readTabTextNow(entry, tab)
              }
              break
            }
          } else if (
            changedFromBaseline &&
            nextText !== null &&
            nextText.length >= SUBSTANTIAL_HYDRATION_CHARS &&
            nextText.length >= (baselineText?.length ?? 0) * 1.5
          ) {
            break
          }
        }
      }

      return tab.text
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

export interface BrowserLoadTarget {
  isLoadingMainFrame(): boolean
}

export interface BrowserLoadTracker {
  isLoading(): boolean
  onDidStartNavigation(isMainFrame: boolean, isSameDocument: boolean): void
  onDidStartLoading(): void
  onDidFinishFrameLoad(isMainFrame: boolean): void
  onDidStopLoading(): void
  onDidFailLoad(isMainFrame: boolean): void
}

/**
 * Tracks main-frame page loads and ignores subframe (ad/tracker iframe) load activity so recurring
 * third-party iframe reloads do not trigger page-load state churn, theater script re-injection, or
 * full-DOM `innerText` extraction.
 */
export function createBrowserLoadTracker(
  target: BrowserLoadTarget,
  events: { onDidStartLoading(): void; onDidStopLoading(): void },
): BrowserLoadTracker {
  let mainFrameLoading = false

  return {
    isLoading: () => mainFrameLoading || target.isLoadingMainFrame(),
    onDidStartNavigation(isMainFrame, isSameDocument) {
      if (!isMainFrame || isSameDocument) return
      if (!mainFrameLoading) {
        mainFrameLoading = true
        events.onDidStartLoading()
      }
    },
    onDidStartLoading() {
      if (!mainFrameLoading && target.isLoadingMainFrame()) {
        mainFrameLoading = true
        events.onDidStartLoading()
      }
    },
    onDidFinishFrameLoad(isMainFrame) {
      if (isMainFrame && mainFrameLoading && !target.isLoadingMainFrame()) {
        mainFrameLoading = false
        events.onDidStopLoading()
      }
    },
    onDidStopLoading() {
      if (mainFrameLoading) {
        mainFrameLoading = false
        events.onDidStopLoading()
      }
    },
    onDidFailLoad(isMainFrame) {
      if (isMainFrame && mainFrameLoading && !target.isLoadingMainFrame()) {
        mainFrameLoading = false
      }
    },
  }
}

export interface BrowserUserAgentTarget {
  getURL(): string
  getUserAgent(): string
  setUserAgent(userAgent: string): void
  setCdpUserAgentOverride?(userAgent: string): void
  setEmulationOverride?(override: BrowserEmulationOverride): void
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
  options?: { chromeVersion?: string; arch?: string },
): BrowserUserAgentSync {
  const cleanUa = browserUserAgent(baseUserAgent)
  let cdpOverrideUa: string | null = null
  let lastEmulationUa: string | null = null
  let inFlightMainFrameUrl: string | undefined

  const resolveUa = (url: string): string => browserUserAgentForUrl(url, cleanUa || baseUserAgent, platform)
  const syncEmulation = (url: string): void => {
    if (!target.setEmulationOverride) return
    const override = browserEmulationOverrideForUrl(url, cleanUa || baseUserAgent, {
      chromeVersion: options?.chromeVersion,
      platform,
      arch: options?.arch,
    })
    if (lastEmulationUa === override.userAgent) return
    lastEmulationUa = override.userAgent
    target.setEmulationOverride(override)
  }

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
      syncEmulation(url)
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
      syncEmulation(url)
    },
    onDidNavigate(url) {
      inFlightMainFrameUrl = undefined
      if (!isBrowserUrl(url)) return
      const targetUa = resolveUa(url)
      if (targetUa && target.getUserAgent() !== targetUa) {
        target.setUserAgent(targetUa)
      }
      syncEmulation(url)
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
      syncEmulation(committedUrl)
    },
    onDebuggerDetach() {
      cdpOverrideUa = null
      lastEmulationUa = null
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

function waitForTabLoad(tab: TabEntry, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (!tab.loading && !tab.view.isLoading()) return Promise.resolve()
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      tab.loadWaiters.delete(finish)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    tab.loadWaiters.add(finish)
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', finish, { once: true })
  })
}

function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    signal?.addEventListener('abort', finish, { once: true })
  })
}
