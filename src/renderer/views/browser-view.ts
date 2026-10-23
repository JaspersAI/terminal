import {
  DEFAULT_BROWSER_URL,
  isVideoPageUrl,
  normalizeBrowserUrl,
  shortAddress,
  type BrowserBounds,
  type BrowserOutput,
  type BrowserSnapshot,
} from '../../shared/grid/browser.ts'

/** Short label for a browser tab: its page title, its host/path, or `'New tab'`. */
export function tabLabel(tab: { title: string; url: string }): string {
  const title = tab.title.trim()
  if (title) return title
  const normalized = normalizeBrowserUrl(tab.url)
  return normalized ? shortAddress(normalized) : 'New tab'
}

/** True when two non-empty rectangles overlap in client coordinates. */
export function rectsOverlap(a: BrowserBounds, b: BrowserBounds): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * Whether the browser's viewport anchor is unobstructed in the renderer DOM: not inside an `inert`
 * subtree, not under an open modal, with positive dimensions, and not overlapped by a dropdown menu
 * or dialog popover. Grid drags and resizes keep the browser visible so video playback stays stable.
 */
export function viewportVisible(options: {
  bounds: BrowserBounds
  inert: boolean
  modalOpen: boolean
  dragging?: boolean
  overlays: readonly BrowserBounds[]
}): boolean {
  const { bounds, inert, modalOpen, overlays } = options
  if (inert || modalOpen || bounds.width <= 0 || bounds.height <= 0) return false
  return !overlays.some((overlay) => rectsOverlap(bounds, overlay))
}

/** The address shown in the bar and reported as output: the live page URL first, then normalized panel state or default. */
export function displayAddress(stateUrl: string, snapshot: BrowserSnapshot): string {
  if (snapshot.url) return snapshot.url
  const normalized = normalizeBrowserUrl(stateUrl)
  if (normalized) return normalized
  const trimmed = stateUrl.trim()
  return trimmed || DEFAULT_BROWSER_URL
}

/** What a `core/browser` panel publishes to the tree for the assistant and grid map. */
export function publishedOutput(stateUrl: string, snapshot: BrowserSnapshot): BrowserOutput {
  const url = displayAddress(stateUrl, snapshot)
  return {
    url,
    title: snapshot.title,
    loading: snapshot.loading,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    theater: snapshot.theater ?? isVideoPageUrl(url),
    tabCount: snapshot.tabs?.length || snapshot.tabCount || 1,
    error: snapshot.error,
  }
}

/** True when two browser snapshots carry identical state and tab metadata, so bounds-only syncs skip re-renders. */
export function sameBrowserSnapshot(a: BrowserSnapshot, b: BrowserSnapshot): boolean {
  if (
    a.workspaceId !== b.workspaceId ||
    a.panelId !== b.panelId ||
    a.url !== b.url ||
    a.title !== b.title ||
    a.loading !== b.loading ||
    a.canGoBack !== b.canGoBack ||
    a.canGoForward !== b.canGoForward ||
    (a.theater ?? false) !== (b.theater ?? false) ||
    (a.tabCount ?? 1) !== (b.tabCount ?? 1) ||
    (a.activeTabId ?? '') !== (b.activeTabId ?? '') ||
    a.error !== b.error ||
    a.text !== b.text
  ) {
    return false
  }
  const aTabs = a.tabs ?? []
  const bTabs = b.tabs ?? []
  if (aTabs.length !== bTabs.length) return false
  for (let i = 0; i < aTabs.length; i++) {
    const x = aTabs[i]!
    const y = bTabs[i]!
    if (
      x.id !== y.id ||
      x.url !== y.url ||
      x.title !== y.title ||
      x.loading !== y.loading ||
      x.canGoBack !== y.canGoBack ||
      x.canGoForward !== y.canGoForward ||
      x.theater !== y.theater ||
      x.error !== y.error
    ) {
      return false
    }
  }
  return true
}
