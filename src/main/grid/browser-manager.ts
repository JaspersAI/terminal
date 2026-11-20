// Coordinates `WebContentsView` tabs per `core/browser` panel across workspaces and windows. Kept
// free of Electron imports so the tab lifecycle, bounds clipping, visibility, navigation, theater
// mode defaults, and sweep rules run directly under Node's test runner.

import {
  BROWSER_VIEW,
  browserEmulationOverrideForUrl,
  browserStanding,
  browserUserAgentForUrl,
  clipBounds,
  DEFAULT_BROWSER_BOUNDS,
  DEFAULT_BROWSER_URL,
  isBlankBrowserPopupUrl,
  isBotChallengeText,
  isBotChallengeUrl,
  isBrowserUrl,
  isGoogleAuthUrl,
  isVideoPageUrl,
  nextBrowserTabSeq,
  normalizeBounds,
  normalizeBrowserUrl,
  persistedBrowserState,
  readBrowserPersistedTabs,
  readBrowserState,
  sameBrowserPersistedTabs,
  sameBrowserState,
  scaleBounds,
  shouldShowBrowser,
  unwrapBotChallengeUrl,
  type BrowserAction,
  type BrowserBounds,
  type BrowserEmulationOverride,
  type BrowserSnapshot,
  type BrowserStanding,
  type BrowserState,
  type BrowserTab,
} from '../../shared/grid/browser.ts'
import type {
  BrowserInteraction,
  BrowserInteractionAction,
  BrowserInteractionOutcome,
} from '../../shared/grid/browser-interact.ts'
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
  interact?(interaction: BrowserInteraction, signal?: AbortSignal): Promise<BrowserInteractionOutcome>
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
  setPanelState?(workspaceId: string, panelId: string, state: BrowserState, options?: { touch?: boolean }): void
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
  /** Short settle delay after synthetic click, key, or scroll input so async UI updates commit. */
  postActionDelayMs?: number
}

export interface BrowserInteractionResult {
  action: BrowserInteractionAction
  detail: string
  snapshot: BrowserSnapshot
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
  interact(
    rawWorkspaceId: unknown,
    rawPanelId: unknown,
    interaction: BrowserInteraction,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult>
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
  persistedUrl: string
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
  /** The last normalized `BrowserState` persisted or read from `panel.state`, used to distinguish `state.url` writes from `state.tabs` / `state.activeTabId` edits. */
  lastPersistedState: BrowserState | null
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
/** Background tabs and inactive-workspace browser views discard their native WebContentsView after 1 minute idle. */
export const DEFAULT_IDLE_SUSPEND_MS = 60_000
export const DEFAULT_HYDRATION_DELAYS_MS: readonly number[] = [350, 1_000, 2_200]
export const DEFAULT_SETTLE_TIMEOUT_MS = 4_000
export const DEFAULT_HYDRATION_WINDOW_MS = 1_500
export const DEFAULT_HYDRATION_POLL_MS = 250
export const DEFAULT_POST_ACTION_DELAY_MS = 150
const SUBSTANTIAL_HYDRATION_CHARS = 2_000

const entryKey = (workspaceId: string, panelId: string): string => `${workspaceId}\n${panelId}`

export function createBrowserManager(deps: BrowserManagerDeps): BrowserManager {
  const entries = new Map<string, Entry>()
  const idleSuspendMs = deps.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS
  const hydrationDelaysMs = deps.hydrationDelaysMs ?? DEFAULT_HYDRATION_DELAYS_MS
  const settleTimeoutMs = deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  const hydrationWindowMs = deps.hydrationWindowMs ?? DEFAULT_HYDRATION_WINDOW_MS
  const hydrationPollMs = Math.max(10, deps.hydrationPollMs ?? DEFAULT_HYDRATION_POLL_MS)
  const postActionDelayMs = Math.max(0, deps.postActionDelayMs ?? DEFAULT_POST_ACTION_DELAY_MS)

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
      const unwrapped = unwrapBotChallengeUrl(liveUrl, tab.url || entry.stateUrl) ?? liveUrl
      tab.url = unwrapped
      if (!isGoogleAuthUrl(unwrapped)) tab.persistedUrl = unwrapped
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
    const savedTheater = tab.theater
    const targetUrl = tab.url || entry.stateUrl
    tab.view = bindTabView(entry, tab, deps.createView)
    if (targetUrl) {
      loadTabAddress(entry, tab, targetUrl, {
        preserveTitle: savedTitle,
        preserveText: savedText,
        preserveTheater: savedTheater,
      })
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
      active.view.setBounds(clipped)
      active.view.setVisible(true)
      if (entry.attachedWindow !== win.number || entry.attachedView !== active.view) {
        win.attach(active.view)
        entry.attachedWindow = win.number
        entry.attachedView = active.view
      }
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
        const prevUrl = tab.url
        const liveUrl = tab.view.getURL()
        if (isBotChallengeUrl(liveUrl)) {
          const retryTarget = unwrapBotChallengeUrl(liveUrl, tab.url || entry.stateUrl) || tab.url || entry.stateUrl
          if (retryTarget) tab.url = retryTarget
          if (retryTarget && tab.challengeRetriedUrl !== retryTarget) {
            tab.challengeRetriedUrl = retryTarget
            loadTabAddress(entry, tab, retryTarget, {
              preserveTitle: tab.title,
              preserveText: tab.text,
              preserveTheater: tab.theater,
              keepChallengeRetry: true,
              clearBotCookies: true,
            })
            return
          }
        } else if (isBrowserUrl(liveUrl)) {
          tab.url = liveUrl
          if (!isGoogleAuthUrl(liveUrl)) tab.persistedUrl = liveUrl
          tab.challengeRetriedUrl = null
        }
        tab.loading = false
        tab.loadedAt = Date.now()
        notifyLoadWaiters(tab)
        const liveTitle = tab.view.getTitle()
        if (liveTitle && !isBotChallengeUrl(liveUrl) && !isBotChallengeText('', liveTitle)) {
          tab.title = liveTitle
        }
        if (tab.url !== prevUrl && isVideoPageUrl(tab.url)) tab.theater = true
        tab.view.setTheaterMode?.(tab.theater, tab.url)
        persistEntryState(entry, { touch: false })
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
            if (!isGoogleAuthUrl(unwrapped)) tab.persistedUrl = unwrapped
            tab.error = null
            if (isVideoPageUrl(unwrapped)) tab.theater = true
            tab.view.setTheaterMode?.(tab.theater, unwrapped)
          }
          if (!tab.loading && !tab.view.isLoading() && unwrapped && tab.challengeRetriedUrl !== unwrapped) {
            tab.challengeRetriedUrl = unwrapped
            loadTabAddress(entry, tab, unwrapped, {
              preserveTitle: tab.title,
              preserveText: tab.text,
              preserveTheater: tab.theater,
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
          const prevUrl = tab.url
          tab.url = normalized
          if (!isGoogleAuthUrl(normalized) || !tab.persistedUrl) {
            tab.persistedUrl = normalized
          }
          tab.challengeRetriedUrl = null
          tab.error = null
          if (normalized !== prevUrl && isVideoPageUrl(normalized)) tab.theater = true
          tab.view.setTheaterMode?.(tab.theater, normalized)
        }
        const liveTitle = tab.view.getTitle()
        if (liveTitle && !isBotChallengeText('', liveTitle)) tab.title = liveTitle
        persistEntryState(entry, { touch: false })
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
        persistEntryState(entry, { touch: false })
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
          if (normalized && !isGoogleAuthUrl(normalized)) {
            persistEntryState(entry, { touch: true })
          }
          positionEntry(entry, deps.getState())
          pushSnapshot(entry)
          return opened.view
        }
        const normalized = normalizeBrowserUrl(url)
        if (!normalized) return null
        const opened = createTab(entry, normalized, deps.createView, tab.id)
        entry.tabs.push(opened)
        entry.activeTabId = opened.id
        persistEntryState(entry, { touch: true })
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
    options?: {
      id?: string
      title?: string
      theater?: boolean
      suspended?: boolean
    },
  ): TabEntry {
    const id = options?.id ?? `t${++entry.nextTabSeq}`
    const suspended = options?.suspended === true
    const persistedUrl = initialUrl && !isGoogleAuthUrl(initialUrl) ? initialUrl : ''
    const tab: TabEntry = {
      id,
      openerTabId,
      view: null as unknown as ManagedBrowserView,
      url: initialUrl,
      persistedUrl,
      title: options?.title ?? '',
      loading: false,
      theater: options?.theater ?? isVideoPageUrl(initialUrl),
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
      backgrounded: suspended,
      suspended,
      suspendTimer: null,
      destroyed: false,
    }
    if (!suspended) {
      tab.view = bindTabView(entry, tab, customCreateView)
    }
    return tab
  }

  function currentPanelOf(entry: Entry): Panel | null {
    const grids = deps.getState().grids[entry.workspaceId]
    for (const grid of Object.values(grids ?? {})) {
      const found = grid.panels.find((p) => p.id === entry.panelId)
      if (found) return found
    }
    return null
  }

  function tabPersistedUrl(entry: Entry, tab: TabEntry): string {
    if (tab.openerTabId !== null) {
      const candidate = tab.persistedUrl || tab.url
      if (!isBrowserUrl(candidate) || isGoogleAuthUrl(candidate)) return ''
    }
    if (!tab.suspended && !tab.loading && tab.error === null) {
      const liveUrl = tab.view.getURL()
      if (isBrowserUrl(liveUrl) && !isBotChallengeUrl(liveUrl) && !isGoogleAuthUrl(liveUrl)) {
        return liveUrl
      }
    }
    return tab.persistedUrl || tab.url || (tab === activeTab(entry) ? entry.stateUrl : '')
  }

  function buildEntryBrowserState(entry: Entry): BrowserState | null {
    const tabs: { id: string; url: string; title?: string; theater?: boolean }[] = []
    for (const tab of entry.tabs) {
      if (tab.destroyed) continue
      const rawUrl = tabPersistedUrl(entry, tab)
      const url = unwrapBotChallengeUrl(rawUrl)
      if (!url) continue
      const liveTitle =
        !tab.suspended && !tab.loading && tab.error === null && !isBotChallengeUrl(tab.view.getURL())
          ? tab.view.getTitle() || tab.title
          : tab.title
      tabs.push({
        id: tab.id,
        url,
        ...(liveTitle ? { title: liveTitle } : {}),
        theater: tab.theater,
      })
    }
    if (tabs.length === 0) return null
    return persistedBrowserState(tabs, entry.activeTabId, entry.stateUrl || DEFAULT_BROWSER_URL)
  }

  function panelStateMatches(rawState: Record<string, unknown>, target: BrowserState): boolean {
    const parsed = readBrowserState(rawState)
    if (!sameBrowserState(parsed, target)) return false
    const hasRawTabs = Array.isArray(rawState['tabs']) || rawState['activeTabId'] !== undefined
    const hasTargetTabs = target.tabs !== undefined || target.activeTabId !== undefined
    if (hasRawTabs !== hasTargetTabs) return false
    const rawUrl = typeof rawState['url'] === 'string' ? normalizeBrowserUrl(rawState['url']) : null
    return rawUrl === target.url
  }

  function persistEntryState(entry: Entry, options?: { touch?: boolean }): void {
    if (entry.destroyed) return
    const nextState = buildEntryBrowserState(entry)
    if (!nextState) return
    entry.stateUrl = nextState.url
    entry.lastPersistedState = nextState
    const currentPanel = currentPanelOf(entry)
    if (currentPanel && panelStateMatches(currentPanel.state, nextState)) {
      entry.stateRef = currentPanel.state
      return
    }
    entry.suppressStateLoad = true
    try {
      if (deps.setPanelState) {
        deps.setPanelState(entry.workspaceId, entry.panelId, nextState, options)
      } else {
        deps.setPanelUrl(entry.workspaceId, entry.panelId, nextState.url)
      }
    } finally {
      entry.suppressStateLoad = false
    }
    const updatedPanel = currentPanelOf(entry)
    if (updatedPanel) entry.stateRef = updatedPanel.state
  }

  function closeTabById(entry: Entry, targetId: string, replaceSingleTab: boolean): void {
    const index = entry.tabs.findIndex((one) => one.id === targetId)
    if (index < 0) return
    if (entry.tabs.length <= 1) {
      if (replaceSingleTab) {
        const [removed] = entry.tabs.splice(index, 1)
        if (removed) destroyTab(entry, removed)
        const replacement = createTab(entry, DEFAULT_BROWSER_URL, deps.createView, null, { id: 't1' })
        entry.nextTabSeq = Math.max(entry.nextTabSeq, 1)
        entry.tabs.push(replacement)
        entry.activeTabId = replacement.id
      } else {
        const only = entry.tabs[0]!
        only.url = DEFAULT_BROWSER_URL
        only.persistedUrl = DEFAULT_BROWSER_URL
        only.title = ''
        only.theater = isVideoPageUrl(DEFAULT_BROWSER_URL)
      }
      persistEntryState(entry, { touch: true })
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
    persistEntryState(entry, { touch: true })
    positionEntry(entry, deps.getState())
    pushSnapshot(entry)
  }

  function ensureEntry(workspaceId: string, panel: Panel): Entry {
    const key = entryKey(workspaceId, panel.id)
    const existing = entries.get(key)
    if (existing) return existing
    const parsed = readBrowserState(panel.state)
    const entry: Entry = {
      key,
      workspaceId,
      panelId: panel.id,
      tabs: [],
      activeTabId: '',
      nextTabSeq: 0,
      stateUrl: '',
      stateRef: null,
      lastPersistedState: parsed,
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
    if (parsed.tabs && parsed.tabs.length > 0) {
      entry.nextTabSeq = nextBrowserTabSeq(parsed.tabs)
      const activeId =
        parsed.activeTabId && parsed.tabs.some((t) => t.id === parsed.activeTabId)
          ? parsed.activeTabId
          : parsed.tabs[0]!.id
      entry.activeTabId = activeId
      for (const saved of parsed.tabs) {
        const restored = createTab(entry, saved.url, deps.createView, null, {
          id: saved.id,
          title: saved.title ?? '',
          theater: saved.theater ?? isVideoPageUrl(saved.url),
          suspended: true,
        })
        entry.tabs.push(restored)
      }
    } else {
      const first = createTab(entry, parsed.url, deps.createView, null, { suspended: true })
      entry.tabs.push(first)
      entry.activeTabId = first.id
    }
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
      preserveTheater?: boolean
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
    if (!isGoogleAuthUrl(targetUrl) || !tab.persistedUrl) {
      tab.persistedUrl = targetUrl
    }
    tab.title = options?.preserveTitle ?? ''
    tab.text = options?.preserveText ?? null
    tab.loadedAt = null
    tab.initialLoadText = null
    tab.error = null
    tab.loading = true
    tab.theater = options?.preserveTheater ?? isVideoPageUrl(targetUrl)
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
        preserveTheater: tab.theater,
        clearBotCookies: true,
      })
      return
    }
    if ((tab.error !== null || !isBrowserUrl(liveUrl) || liveUrl !== targetUrl) && targetUrl) {
      loadTabAddress(entry, tab, targetUrl, {
        preserveTitle: tab.title,
        preserveText: tab.text,
        preserveTheater: tab.theater,
      })
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

  function reconcileEntryTabs(entry: Entry, nextState: BrowserState): void {
    const desiredTabs =
      nextState.tabs && nextState.tabs.length > 0
        ? nextState.tabs
        : [{ id: entry.tabs[0]?.id ?? 't1', url: nextState.url }]
    const desiredIds = new Set(desiredTabs.map((t) => t.id))
    for (const existing of entry.tabs) {
      if (!desiredIds.has(existing.id)) destroyTab(entry, existing)
    }
    entry.nextTabSeq = Math.max(entry.nextTabSeq, nextBrowserTabSeq(desiredTabs))
    const targetActiveId =
      nextState.activeTabId && desiredIds.has(nextState.activeTabId) ? nextState.activeTabId : desiredTabs[0]!.id
    const prevActiveId = entry.activeTabId
    entry.activeTabId = targetActiveId

    const nextTabs: TabEntry[] = []
    for (const desired of desiredTabs) {
      const existing = entry.tabs.find((t) => !t.destroyed && t.id === desired.id)
      const desiredTheater = desired.theater ?? isVideoPageUrl(desired.url)
      if (existing) {
        existing.theater = desiredTheater
        if (desired.title && !existing.title) existing.title = desired.title
        const currentUrl = tabPersistedUrl(entry, existing)
        if (desired.url !== currentUrl) {
          if (desired.id === targetActiveId || !existing.suspended) {
            loadTabAddress(entry, existing, desired.url, {
              preserveTitle: desired.title ?? '',
              preserveTheater: desiredTheater,
            })
          } else {
            existing.url = desired.url
            existing.persistedUrl = desired.url
            existing.title = desired.title ?? ''
          }
        } else if (!existing.suspended) {
          existing.view.setTheaterMode?.(existing.theater, existing.url || desired.url)
        }
        nextTabs.push(existing)
      } else {
        const isActive = desired.id === targetActiveId
        const created = createTab(entry, desired.url, deps.createView, null, {
          id: desired.id,
          title: desired.title ?? '',
          theater: desiredTheater,
          suspended: !isActive,
        })
        nextTabs.push(created)
        if (isActive) {
          loadTabAddress(entry, created, desired.url, {
            preserveTitle: desired.title ?? '',
            preserveTheater: desiredTheater,
          })
        }
      }
    }
    entry.tabs = nextTabs
    const active = activeTab(entry)
    if (active.suspended) {
      wakeTab(entry, active)
    } else if (prevActiveId !== targetActiveId) {
      positionEntry(entry, deps.getState())
      pushSnapshot(entry)
      if (active.text === null && !active.loading && active.error === null) {
        readTabText(entry, active)
      }
    }
  }

  function applyPanelState(entry: Entry, panel: Panel): void {
    const parsed = readBrowserState(panel.state)
    if (entry.suppressStateLoad) {
      entry.stateRef = panel.state
      entry.lastPersistedState = parsed
      return
    }
    if (entry.stateRef === null && entry.stateUrl === '') {
      entry.stateUrl = parsed.url
      entry.stateRef = panel.state
      entry.lastPersistedState = parsed
      entry.refreshedAt = panel.refreshedAt
      const active = activeTab(entry)
      loadTabAddress(entry, active, parsed.url, {
        preserveTitle: active.title,
        preserveTheater: active.theater,
      })
      return
    }
    const prevPersisted = entry.lastPersistedState
    const explicitStateWrite = entry.stateRef !== null && panel.state !== entry.stateRef
    entry.stateRef = panel.state

    if (explicitStateWrite) {
      const rawTabs = Array.isArray(panel.state['tabs']) ? readBrowserPersistedTabs(panel.state['tabs']) : undefined
      const rawActiveId =
        typeof panel.state['activeTabId'] === 'string' && panel.state['activeTabId'].trim() !== ''
          ? panel.state['activeTabId'].trim()
          : undefined
      const tabsEdited =
        !sameBrowserPersistedTabs(rawTabs, prevPersisted?.tabs) ||
        (rawActiveId ?? '') !== (prevPersisted?.activeTabId ?? '')

      if (tabsEdited) {
        entry.refreshedAt = panel.refreshedAt
        reconcileEntryTabs(entry, parsed)
        persistEntryState(entry, { touch: false })
        return
      }

      const rawUrl = unwrapBotChallengeUrl(panel.state['url'], DEFAULT_BROWSER_URL) || DEFAULT_BROWSER_URL
      entry.stateUrl = rawUrl
      entry.refreshedAt = panel.refreshedAt
      const active = activeTab(entry)
      active.url = rawUrl
      active.persistedUrl = isGoogleAuthUrl(rawUrl) ? active.persistedUrl || rawUrl : rawUrl
      active.title = ''
      active.theater = isVideoPageUrl(rawUrl)
      persistEntryState(entry, { touch: false })
      loadTabAddress(entry, active, rawUrl)
      return
    }

    if (parsed.url !== entry.stateUrl) {
      entry.stateUrl = parsed.url
      entry.lastPersistedState = parsed
      entry.refreshedAt = panel.refreshedAt
      loadTabAddress(entry, activeTab(entry), parsed.url)
      return
    }

    if (panel.refreshedAt !== null && panel.refreshedAt !== entry.refreshedAt) {
      entry.refreshedAt = panel.refreshedAt
      reloadTab(entry, activeTab(entry))
    }
  }

  function resolveBrowserPanel(
    callerWindow: number | null,
    rawWorkspaceId: unknown,
    rawPanelId: unknown,
    checkWindow = true,
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
    if (checkWindow && callerWindow !== standing.window) {
      throw new Error('This panel is not in this window.')
    }
    return { state, workspaceId: rawWorkspaceId, panel, standing }
  }

  async function settleTabAfterAction(entry: Entry, signal?: AbortSignal, pollForDomChange = false): Promise<void> {
    if (entry.destroyed || signal?.aborted) return
    let tab = activeTab(entry)
    if (tab.destroyed || tab.suspended) return
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
      return
    }
    const beforeText = tab.text
    const firstRead = await readTabTextNow(entry, tab)
    if (
      pollForDomChange &&
      postActionDelayMs > 0 &&
      firstRead === beforeText &&
      !signal?.aborted &&
      !tab.destroyed &&
      !tab.suspended &&
      !entry.destroyed
    ) {
      await sleepOrAbort(Math.min(250, postActionDelayMs * 2), signal)
      const latest = activeTab(entry)
      if (!signal?.aborted && !latest.destroyed && !latest.suspended && !entry.destroyed) {
        if ((latest.loading || latest.view.isLoading()) && settleTimeoutMs > 0) {
          await waitForTabLoad(latest, settleTimeoutMs, signal)
        }
        if (!latest.loading && !latest.view.isLoading() && latest.error === null) {
          await readTabTextNow(entry, latest)
        }
      }
    }
    const settledTab = activeTab(entry)
    if (!settledTab.destroyed && !settledTab.suspended && !entry.destroyed && settledTab.error === null) {
      scheduleHydrationReads(entry, settledTab)
    }
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
      applyPanelState(entry, panel)
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
        entry.stateRef ??= panel.state
        const active = activeTab(entry)
        active.url = target
        active.persistedUrl = isGoogleAuthUrl(target) ? active.persistedUrl || target : target
        active.title = ''
        active.theater = isVideoPageUrl(target)
        persistEntryState(entry, { touch: true })
        loadTabAddress(entry, active, target)
        return snapshotOf(entry)
      }

      const entry = ensureEntry(workspaceId, panel)
      if (!entry.stateUrl) {
        const parsedState = readBrowserState(panel.state)
        entry.stateUrl = parsedState.url
        entry.stateRef = panel.state
        entry.lastPersistedState = parsedState
        if (action !== 'new-tab' && action !== 'select-tab' && action !== 'close-tab') {
          const active = activeTab(entry)
          if (!active.url) active.url = parsedState.url
          loadTabAddress(entry, active, parsedState.url, {
            preserveTitle: active.title,
            preserveTheater: active.theater,
          })
        } else if (!activeTab(entry).url) {
          activeTab(entry).url = parsedState.url
          activeTab(entry).persistedUrl = parsedState.url
        }
      }

      if (action === 'new-tab') {
        const target = (typeof rawUrl === 'string' ? normalizeBrowserUrl(rawUrl) : null) || DEFAULT_BROWSER_URL
        const opened = createTab(entry, target)
        entry.tabs.push(opened)
        entry.activeTabId = opened.id
        persistEntryState(entry, { touch: true })
        loadTabAddress(entry, opened, target)
        return snapshotOf(entry)
      }

      if (action === 'select-tab') {
        const targetId = typeof rawUrl === 'string' ? rawUrl : ''
        const found = entry.tabs.find((one) => one.id === targetId)
        if (found) {
          entry.activeTabId = found.id
          persistEntryState(entry, { touch: true })
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
        const next = activeTab(entry)
        if (next.suspended) {
          wakeTab(entry, next)
        }
        return snapshotOf(entry)
      }

      const active = activeTab(entry)
      if (action === 'toggle-theater') {
        active.theater = !active.theater
        if (!active.suspended) {
          active.view.setTheaterMode?.(active.theater, active.url || entry.stateUrl)
        }
        persistEntryState(entry, { touch: true })
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

    async interact(rawWorkspaceId, rawPanelId, interaction, signal) {
      const { workspaceId, panel } = resolveBrowserPanel(null, rawWorkspaceId, rawPanelId, false)
      const entry = ensureEntry(workspaceId, panel)
      const parsedState = readBrowserState(panel.state)
      if (!entry.stateUrl && parsedState.url) {
        entry.stateUrl = parsedState.url
        entry.stateRef = panel.state
        entry.lastPersistedState = parsedState
        if (
          interaction.action !== 'navigate' &&
          interaction.action !== 'new_tab' &&
          interaction.action !== 'select_tab' &&
          interaction.action !== 'close_tab'
        ) {
          const active = activeTab(entry)
          if (!active.url) active.url = parsedState.url
          loadTabAddress(entry, active, parsedState.url, {
            preserveTitle: active.title,
            preserveTheater: active.theater,
          })
        } else if (!activeTab(entry).url) {
          activeTab(entry).url = parsedState.url
          activeTab(entry).persistedUrl = parsedState.url
        }
      } else if (parsedState.url) {
        applyPanelState(entry, panel)
      }

      const resetIdleTimer = (tab: TabEntry): void => {
        if (tab.backgrounded && tab.suspendTimer !== null) {
          clearSuspendTimer(tab)
          setTabBackgrounded(entry, tab, true)
        }
      }

      if (interaction.action === 'navigate') {
        const active = activeTab(entry)
        active.url = interaction.url
        active.persistedUrl = isGoogleAuthUrl(interaction.url)
          ? active.persistedUrl || interaction.url
          : interaction.url
        active.title = ''
        active.theater = isVideoPageUrl(interaction.url)
        persistEntryState(entry, { touch: true })
        loadTabAddress(entry, active, interaction.url)
        await this.syncPanelText(workspaceId, panel.id, signal)
        const snap = snapshotOf(entry)
        return { action: 'navigate', detail: `Navigated to ${snap.url}.`, snapshot: snap }
      }

      if (interaction.action === 'new_tab') {
        const opened = createTab(entry, interaction.url)
        entry.tabs.push(opened)
        entry.activeTabId = opened.id
        persistEntryState(entry, { touch: true })
        loadTabAddress(entry, opened, interaction.url)
        await this.syncPanelText(workspaceId, panel.id, signal)
        const snap = snapshotOf(entry)
        return { action: 'new_tab', detail: `Opened tab ${opened.id} at ${snap.url}.`, snapshot: snap }
      }

      if (interaction.action === 'select_tab') {
        const found = entry.tabs.find((one) => one.id === interaction.tabId)
        if (!found) {
          throw new Error(
            `No tab ${JSON.stringify(interaction.tabId)}. Open tabs: ${entry.tabs.map((t) => t.id).join(', ')}.`,
          )
        }
        entry.activeTabId = found.id
        persistEntryState(entry, { touch: true })
        if (found.suspended) {
          wakeTab(entry, found)
          await this.syncPanelText(workspaceId, panel.id, signal)
        } else {
          resetIdleTimer(found)
          positionEntry(entry, deps.getState())
          await settleTabAfterAction(entry, signal)
          pushSnapshot(entry)
        }
        const snap = snapshotOf(entry)
        return { action: 'select_tab', detail: `Switched to tab ${found.id} (${snap.url || 'blank'}).`, snapshot: snap }
      }

      if (interaction.action === 'close_tab') {
        const targetId = interaction.tabId ?? entry.activeTabId
        if (!entry.tabs.some((one) => one.id === targetId)) {
          throw new Error(`No tab ${JSON.stringify(targetId)}. Open tabs: ${entry.tabs.map((t) => t.id).join(', ')}.`)
        }
        closeTabById(entry, targetId, false)
        const next = activeTab(entry)
        if (next.suspended) {
          wakeTab(entry, next)
          await this.syncPanelText(workspaceId, panel.id, signal)
        } else {
          await settleTabAfterAction(entry, signal)
          pushSnapshot(entry)
        }
        const snap = snapshotOf(entry)
        return {
          action: 'close_tab',
          detail: `Closed tab ${targetId}; active tab is ${snap.activeTabId}.`,
          snapshot: snap,
        }
      }

      if (interaction.action === 'reload') {
        reloadTab(entry, activeTab(entry))
        await this.syncPanelText(workspaceId, panel.id, signal)
        const snap = snapshotOf(entry)
        return { action: 'reload', detail: `Reloaded ${snap.url}.`, snapshot: snap }
      }

      if (interaction.action === 'back' || interaction.action === 'forward') {
        const active = activeTab(entry)
        if (active.suspended) {
          wakeTab(entry, active)
          if (settleTimeoutMs > 0) await waitForTabLoad(active, settleTimeoutMs, signal)
        }
        resetIdleTimer(active)
        if (interaction.action === 'back') {
          if (!active.view.canGoBack()) throw new Error('Cannot go back in this browser tab.')
          active.error = null
          active.view.goBack()
        } else {
          if (!active.view.canGoForward()) throw new Error('Cannot go forward in this browser tab.')
          active.error = null
          active.view.goForward()
        }
        positionEntry(entry, deps.getState())
        if (postActionDelayMs > 0) await sleepOrAbort(postActionDelayMs, signal)
        await settleTabAfterAction(entry, signal)
        pushSnapshot(entry)
        const snap = snapshotOf(entry)
        return {
          action: interaction.action,
          detail: `Went ${interaction.action} to ${snap.url}.`,
          snapshot: snap,
        }
      }

      let tab = activeTab(entry)
      if (tab.suspended) {
        wakeTab(entry, tab)
      }
      resetIdleTimer(tab)
      if ((tab.loading || tab.view.isLoading()) && settleTimeoutMs > 0) {
        await waitForTabLoad(tab, settleTimeoutMs, signal)
      }
      tab = activeTab(entry)
      if (signal?.aborted) throw new Error('Browser action was stopped.')
      if (entry.destroyed || tab.destroyed) throw new Error('Browser view was closed.')
      if (tab.error !== null) throw new Error(`Browser page failed to load: ${tab.error}`)
      if (!tab.view.interact) throw new Error('Browser interaction is unavailable.')

      const tabsBefore = entry.tabs.length
      const activeBefore = entry.activeTabId
      const loadSeqBefore = tab.loadSeq
      const outcome = await tab.view.interact(interaction, signal)

      if (postActionDelayMs > 0) {
        await sleepOrAbort(postActionDelayMs, signal)
      }
      const current = activeTab(entry)
      if (!current.destroyed && !current.suspended && !entry.destroyed) {
        resetIdleTimer(current)
        if (current === tab && current.loadSeq === loadSeqBefore && !current.loading && !current.view.isLoading()) {
          current.loadSeq++
          current.loadedAt = Date.now()
        }
        const pollDomChange =
          interaction.action === 'click' ||
          interaction.action === 'press' ||
          (interaction.action === 'type' && interaction.submit)
        await settleTabAfterAction(entry, signal, pollDomChange)
      }
      pushSnapshot(entry)
      const snap = snapshotOf(entry)
      const openedNote =
        entry.tabs.length > tabsBefore && entry.activeTabId !== activeBefore ? ` Opened tab ${entry.activeTabId}.` : ''
      return {
        action: interaction.action,
        detail: `${outcome.detail}${openedNote}`,
        snapshot: snap,
      }
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
      if (stateUrl) applyPanelState(entry, panel)

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
        applyPanelState(entry, panel)
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
  options?: {
    chromeVersion?: string
    arch?: string
    systemVersion?: string
    arm64Translation?: boolean
  },
): BrowserUserAgentSync {
  let cdpOverrideUa: string | null = null
  let lastEmulationUa: string | null = null
  let inFlightMainFrameUrl: string | undefined

  const resolveUa = (url: string): string => browserUserAgentForUrl(url, baseUserAgent)
  const syncEmulation = (url: string): void => {
    if (!target.setEmulationOverride) return
    const override = browserEmulationOverrideForUrl(url, baseUserAgent, {
      chromeVersion: options?.chromeVersion,
      platform,
      arch: options?.arch,
      systemVersion: options?.systemVersion,
      arm64Translation: options?.arm64Translation,
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
