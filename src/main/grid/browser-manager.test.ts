import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BROWSER_VIEW,
  googleAuthUserAgent,
  readBrowserState,
  type BrowserBounds,
  type BrowserSnapshot,
} from '../../shared/grid/browser.ts'
import type { BrowserInteraction, BrowserInteractionOutcome } from '../../shared/grid/browser-interact.ts'
import {
  EMPTY_GRID,
  layoutOf,
  moveAcross,
  panelOf,
  placeFramed,
  refreshPanel,
  removeElement,
  replacePanelState,
  setMode,
  setPanelState,
  setZoom,
  withLayout,
  type Grid,
} from '../../shared/grid/grid.ts'
import { closedWithout, reopenAcrossTabs, reopened } from '../../shared/loops/closed.ts'
import type { Loops } from '../../shared/loops/loops.ts'
import {
  createBrowserLoadTracker,
  createBrowserManager,
  createBrowserUserAgentSync,
  type BrowserManagerState,
  type BrowserViewEvents,
  type ManagedBrowserView,
  type ManagedWindow,
} from './browser-manager.ts'

interface FakeView extends ManagedBrowserView {
  events: BrowserViewEvents
  history: string[]
  index: number
  title: string
  loading: boolean
  bounds: BrowserBounds | null
  visible: boolean
  backgrounded: boolean
  theater: boolean
  zoomFactor: number
  destroyed: boolean
  reloads: number
  pageText: string | null
  readPageTextCalls: number
  interactions: BrowserInteraction[]
  onInteract?: (
    interaction: BrowserInteraction,
    view: FakeView,
  ) => Promise<BrowserInteractionOutcome> | BrowserInteractionOutcome
}

function createHarness(
  options: {
    idleSuspendMs?: number
    hydrationDelaysMs?: readonly number[]
    settleTimeoutMs?: number
    hydrationWindowMs?: number
    hydrationPollMs?: number
    postActionDelayMs?: number
    initialState?: BrowserManagerState
  } = {},
) {
  const placed = placeFramed(EMPTY_GRID, {
    content: { kind: 'view', view: BROWSER_VIEW },
    state: { url: 'https://www.bloomberg.com/live' },
    rect: { x: 0, y: 0, w: 8, h: 6 },
    loop: 'f1',
  })
  let state: BrowserManagerState = options.initialState ?? {
    currentWorkspaceId: 'ws-1',
    workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }],
    grids: {
      'ws-1': { 1: placed.grid },
      'ws-2': { 1: EMPTY_GRID },
    },
  }
  const views: FakeView[] = []
  const attached = new Map<number, Set<ManagedBrowserView>>()
  const viewports = new Map<number, { width: number; height: number }>([
    [1, { width: 1400, height: 1000 }],
    [2, { width: 1200, height: 900 }],
  ])
  const sent: { window: number; snapshot: BrowserSnapshot }[] = []
  const published: { workspaceId: string; panelId: string; snapshot: BrowserSnapshot }[] = []
  const focused: { workspaceId: string; elementId: string }[] = []
  const zoomed: { workspaceId: string; elementId: string; direction: 'in' | 'out' | 'reset' }[] = []

  const makeWindow = (n: number): ManagedWindow => ({
    number: n,
    viewport: () => viewports.get(n) ?? null,
    attach: (view) => {
      let set = attached.get(n)
      if (!set) {
        set = new Set()
        attached.set(n, set)
      }
      set.add(view)
    },
    detach: (view) => {
      attached.get(n)?.delete(view)
    },
    sendState: (snapshot) => {
      sent.push({ window: n, snapshot })
    },
  })

  const windows = new Map<number, ManagedWindow>([
    [1, makeWindow(1)],
    [2, makeWindow(2)],
  ])

  const manager = createBrowserManager({
    getState: () => state,
    getWindow: (n) => windows.get(n) ?? null,
    createView: (events) => {
      const view: FakeView = {
        events,
        history: [],
        index: -1,
        title: '',
        loading: false,
        bounds: null,
        visible: false,
        backgrounded: false,
        theater: false,
        zoomFactor: 1,
        destroyed: false,
        reloads: 0,
        pageText: 'Bloomberg Live TV stream',
        readPageTextCalls: 0,
        interactions: [],
        async interact(interaction: BrowserInteraction) {
          view.interactions.push(interaction)
          if (view.onInteract) return view.onInteract(interaction, view)
          return { detail: `Executed ${interaction.action}.` }
        },
        async loadURL(url: string) {
          view.history = [...view.history.slice(0, view.index + 1), url]
          view.index = view.history.length - 1
          view.loading = true
          events.onDidStartLoading()
          events.onDidNavigate(url)
          view.loading = false
          events.onDidStopLoading()
        },
        reload() {
          view.reloads++
          view.loading = true
          events.onDidStartLoading()
          view.loading = false
          events.onDidStopLoading()
        },
        canGoBack: () => view.index > 0,
        canGoForward: () => view.index >= 0 && view.index < view.history.length - 1,
        goBack() {
          if (view.index > 0) {
            view.index--
            events.onDidNavigate(view.history[view.index]!)
          }
        },
        goForward() {
          if (view.index < view.history.length - 1) {
            view.index++
            events.onDidNavigate(view.history[view.index]!)
          }
        },
        getURL: () => (view.index >= 0 ? (view.history[view.index] ?? '') : ''),
        getTitle: () => view.title,
        isLoading: () => view.loading,
        setBounds(bounds) {
          view.bounds = bounds
        },
        setVisible(visible) {
          view.visible = visible
        },
        setBackgrounded(backgrounded) {
          view.backgrounded = backgrounded
        },
        setTheaterMode(theater) {
          view.theater = theater
        },
        setZoomFactor(zoom) {
          view.zoomFactor = zoom
        },
        readPageText: async () => {
          view.readPageTextCalls++
          return view.pageText
        },
        destroy() {
          view.destroyed = true
        },
      }
      views.push(view)
      return view
    },
    idleSuspendMs: options.idleSuspendMs,
    hydrationDelaysMs: options.hydrationDelaysMs,
    settleTimeoutMs: options.settleTimeoutMs,
    hydrationWindowMs: options.hydrationWindowMs,
    hydrationPollMs: options.hydrationPollMs,
    postActionDelayMs: options.postActionDelayMs ?? 0,
    publishPanel: (workspaceId, panelId, snapshot) => {
      published.push({ workspaceId, panelId, snapshot })
    },
    setPanelUrl: (workspaceId, panelId, url) => {
      for (const [winKey, grid] of Object.entries(state.grids[workspaceId] ?? {})) {
        if (!grid.panels.some((p) => p.id === panelId || p.elementId === panelId)) continue
        const updated = setPanelState(grid, panelId, ['url'], url).grid
        state = {
          ...state,
          grids: { ...state.grids, [workspaceId]: { ...state.grids[workspaceId], [Number(winKey)]: updated } },
        }
        manager.sweep(state)
        return
      }
    },
    setPanelState: (workspaceId, panelId, nextState) => {
      for (const [winKey, grid] of Object.entries(state.grids[workspaceId] ?? {})) {
        if (!grid.panels.some((p) => p.id === panelId || p.elementId === panelId)) continue
        const updated = replacePanelState(grid, panelId, { ...nextState }).grid
        if (updated === grid) return
        const write = (): void => {
          state = {
            ...state,
            grids: { ...state.grids, [workspaceId]: { ...state.grids[workspaceId], [Number(winKey)]: updated } },
          }
        }
        // Inside `dispatchGrid`, as in main's state.ts:update, a write made while subscribers are being
        // told of a change lands after them, with the grid it computed now. Elsewhere it lands at once.
        if (notifying) pending.push(write)
        else {
          write()
          manager.sweep(state)
        }
        return
      }
    },
    focusElement: (workspaceId, elementId) => {
      focused.push({ workspaceId, elementId })
    },
    zoomElement: (workspaceId, elementId, direction) => {
      zoomed.push({ workspaceId, elementId, direction })
    },
  })

  const updateGrid = (workspaceId: string, nextGrid: Grid): void => {
    state = { ...state, grids: { ...state.grids, [workspaceId]: { ...state.grids[workspaceId], 1: nextGrid } } }
  }

  // Main's state.ts:update: subscribers (the sweep) hear of one change at a time, and a write a
  // subscriber makes meanwhile is queued and applied after them.
  let notifying = false
  const pending: (() => void)[] = []
  const dispatchGrid = (workspaceId: string, nextGrid: Grid): void => {
    notifying = true
    try {
      let step: (() => void) | undefined = () => updateGrid(workspaceId, nextGrid)
      for (let steps = 0; step; steps++) {
        if (steps === 100) throw new Error('The sweep kept writing panel state: a write loop.')
        step()
        manager.sweep(state)
        step = pending.shift()
      }
    } finally {
      pending.length = 0
      notifying = false
    }
  }

  return {
    manager,
    placed,
    views,
    attached,
    windows,
    viewports,
    sent,
    published,
    focused,
    zoomed,
    getState: () => state,
    setState: (next: BrowserManagerState) => {
      state = next
    },
    updateGrid,
    dispatchGrid,
  }
}

test('sync attaches a WebContentsView, loads panel state.url, clips bounds, and publishes page text', async () => {
  const { manager, placed, views, attached } = createHarness()
  const snap = await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  assert.equal(views.length, 1)
  const view = views[0]!
  assert.equal(attached.get(1)?.has(view), true)
  assert.equal(view.visible, true)
  assert.deepEqual(view.bounds, { x: 16, y: 60, width: 680, height: 420 })
  assert.equal(snap.url, 'https://www.bloomberg.com/live')
  assert.equal(snap.loading, false)
})

test('in-page user navigation is preserved across state syncs while assistant state.url updates or refresh_element reload', async () => {
  const { manager, placed, views, getState, updateGrid } = createHarness()
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  const view = views[0]!

  // User clicks a sign-in link inside the WebContentsView.
  view.history.push('https://login.bloomberg.com/auth')
  view.index = 1
  view.events.onDidNavigate('https://login.bloomberg.com/auth')

  // A subsequent bounds sync or state sweep does not reset the user's in-page navigation back to state.url.
  const afterSync = await manager.sync(1, 'ws-1', placed.panel.id, { x: 20, y: 60, width: 700, height: 420 }, true)
  assert.equal(afterSync.url, 'https://login.bloomberg.com/auth')
  assert.deepEqual(view.history, ['https://www.bloomberg.com/live', 'https://login.bloomberg.com/auth'])

  // Navigating back and forward works through the manager.
  const backSnap = await manager.navigate(1, 'ws-1', placed.panel.id, 'back')
  assert.equal(backSnap.url, 'https://www.bloomberg.com/live')
  assert.equal(backSnap.canGoForward, true)
  const forwardSnap = await manager.navigate(1, 'ws-1', placed.panel.id, 'forward')
  assert.equal(forwardSnap.url, 'https://login.bloomberg.com/auth')

  // Assistant changes panel.state.url: sweep loads the new address.
  updateGrid('ws-1', setPanelState(getState().grids['ws-1']![1]!, placed.panel.id, ['url'], 'https://www.sec.gov').grid)
  manager.sweep()
  assert.equal(view.getURL(), 'https://www.sec.gov/')

  // Assistant calls refresh_element: sweep reloads the view once.
  updateGrid('ws-1', refreshPanel(getState().grids['ws-1']![1]!, placed.panel.id, 12345).grid)
  manager.sweep()
  assert.equal(view.reloads, 1)
  manager.sweep()
  assert.equal(view.reloads, 1)
})

test('hides the native view when occluded in the renderer, minimized, switched to another workspace, or failed, and destroys on panel removal', async () => {
  const { manager, placed, views, attached, getState, setState, updateGrid } = createHarness()
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  const view = views[0]!
  assert.equal(view.visible, true)

  // Renderer reports an overlay (such as Settings or the floating composer) covering the tile.
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, false)
  assert.equal(view.visible, false)
  assert.equal(attached.get(1)?.has(view), false)

  // Overlay closes.
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  assert.equal(view.visible, true)

  // Switching to Workspace 2 hides the view without destroying it.
  setState({ ...getState(), currentWorkspaceId: 'ws-2' })
  manager.sweep()
  assert.equal(view.visible, false)
  assert.equal(view.destroyed, false)

  // Switching back to Workspace 1 restores visibility.
  setState({ ...getState(), currentWorkspaceId: 'ws-1' })
  manager.sweep()
  assert.equal(view.visible, true)

  // Minimizing the loop frame hides the view.
  const minWindow = setMode(layoutOf(getState().grids['ws-1']![1]!), placed.frame.id, 'minimized').grid
  updateGrid('ws-1', withLayout(getState().grids['ws-1']![1]!, undefined, minWindow))
  manager.sweep()
  assert.equal(view.visible, false)

  // Removing the frame destroys the native WebContentsView so audio/video stops immediately.
  const removedWindow = removeElement(layoutOf(getState().grids['ws-1']![1]!), placed.frame.id).grid
  updateGrid('ws-1', withLayout(getState().grids['ws-1']![1]!, undefined, removedWindow))
  manager.sweep()
  assert.equal(view.destroyed, true)
})

test('focusing an unfocused browser view focuses its grid element, and invalid IPC inputs are rejected', async () => {
  const { manager, placed, views, focused, getState, updateGrid } = createHarness()
  // Add a second loop so the first loop is not focused.
  const second = placeFramed(getState().grids['ws-1']![1]!, {
    content: { kind: 'view', view: 'core/table' },
    loop: 'f2',
  })
  updateGrid('ws-1', second.grid)

  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  views[0]!.events.onFocus()
  assert.deepEqual(focused, [{ workspaceId: 'ws-1', elementId: placed.element.id }])

  await assert.rejects(
    manager.navigate(1, 'ws-1', placed.panel.id, 'load', 'javascript:alert(1)'),
    /https:\/\/ or http:\/\/ address/,
  )
  await assert.rejects(
    manager.sync(2, 'ws-1', placed.panel.id, { x: 0, y: 0, width: 100, height: 100 }, true),
    /not in this window/,
  )
  await assert.rejects(
    manager.sync(null, 'ws-1', placed.panel.id, { x: 0, y: 0, width: 100, height: 100 }, true),
    /not in this window/,
  )
})

test('navigate load does not double-load on synchronous sweep, ignores ERR_ABORTED, and reload retries a failed URL', async () => {
  const { manager, placed, views } = createHarness()
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  const view = views[0]!
  assert.equal(view.history.length, 1)

  // Navigating to a new URL via navigate('load') with synchronous sweep inside setPanelUrl loads once.
  const loaded = await manager.navigate(1, 'ws-1', placed.panel.id, 'load', 'https://example.com/news')
  assert.equal(loaded.workspaceId, 'ws-1')
  assert.deepEqual(view.history, ['https://www.bloomberg.com/live', 'https://example.com/news'])

  // Simulate a failed navigation to a new URL: title and URL reflect the failed target, and reload retries it.
  let failNext = true
  const origLoad = view.loadURL.bind(view)
  view.loadURL = async (url: string) => {
    if (failNext) {
      failNext = false
      view.events.onDidStartLoading()
      view.events.onDidFailLoad(-105, 'ERR_NAME_NOT_RESOLVED', true)
      view.events.onDidStopLoading()
      return
    }
    return origLoad(url)
  }
  const failed = await manager.navigate(1, 'ws-1', placed.panel.id, 'load', 'https://unreached.example.com/live')
  assert.equal(failed.url, 'https://unreached.example.com/live')
  assert.equal(failed.error, 'ERR_NAME_NOT_RESOLVED')
  assert.equal(view.visible, false)

  // Clicking Try again (navigate 'reload') retries loading the failed target URL instead of reloading the old page.
  const retried = await manager.navigate(1, 'ws-1', placed.panel.id, 'reload')
  assert.equal(retried.url, 'https://unreached.example.com/live')
  assert.equal(retried.error, null)
  assert.equal(view.visible, true)
})

test('popups and new-tab actions open switchable tabs inside the same panel, and video pages default to theater mode', async () => {
  const { manager, placed, views, attached } = createHarness()
  const initial = await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  assert.equal(initial.tabs?.length, 1)
  assert.equal(initial.theater, true)
  assert.equal(views[0]!.theater, true)

  // A popup/window.open from inside the first tab opens a second tab and switches to it.
  views[0]!.events.onOpenWindow?.('https://www.youtube.com/watch?v=live123')
  assert.equal(views.length, 2)
  assert.equal(views[0]!.visible, false)
  assert.equal(attached.get(1)?.has(views[0]!), false)
  assert.equal(views[1]!.visible, true)
  assert.equal(attached.get(1)?.has(views[1]!), true)
  assert.equal(views[1]!.getURL(), 'https://www.youtube.com/watch?v=live123')
  assert.equal(views[1]!.theater, true)

  // Toggling theater mode on the active tab flips its theater state.
  const toggled = await manager.navigate(1, 'ws-1', placed.panel.id, 'toggle-theater')
  assert.equal(toggled.theater, false)
  assert.equal(views[1]!.theater, false)

  // Switching back to the first tab detaches tab 2 and re-attaches tab 1.
  const firstTabId = initial.tabs![0]!.id
  const switched = await manager.navigate(1, 'ws-1', placed.panel.id, 'select-tab', firstTabId)
  assert.equal(switched.activeTabId, firstTabId)
  assert.equal(switched.url, 'https://www.bloomberg.com/live')
  assert.equal(views[0]!.visible, true)
  assert.equal(views[1]!.visible, false)

  // Closing the second tab destroys its view and leaves the first tab active.
  const secondTabId = switched.tabs![1]!.id
  const afterClose = await manager.navigate(1, 'ws-1', placed.panel.id, 'close-tab', secondTabId)
  assert.equal(afterClose.tabs?.length, 1)
  assert.equal(views[1]!.destroyed, true)
  assert.equal(views[0]!.visible, true)
})

test('adopts OAuth popup child WebContents into a switchable tab without reloading and returns to the opener tab on window.close', async () => {
  const { manager, placed, views, attached, sent } = createHarness()
  const initial = await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  const opener = views[0]!
  const openerTabId = initial.tabs![0]!.id

  // Open a second regular tab first, then switch back to the first tab so opener is t1 while [t1, t2] exist.
  await manager.navigate(1, 'ws-1', placed.panel.id, 'new-tab', 'https://example.com/other')
  await manager.navigate(1, 'ws-1', placed.panel.id, 'select-tab', openerTabId)

  // Page in t1 opens an about:blank OAuth popup via window.open('', 'gsi') and then navigates it to accounts.google.com.
  let adoptedEvents!: BrowserViewEvents
  let adoptedLoadCalls = 0
  const adoptedView: ManagedBrowserView = {
    loadURL: async () => {
      adoptedLoadCalls++
    },
    reload: () => {},
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => {},
    goForward: () => {},
    getURL: () => 'https://accounts.google.com/v3/signin/identifier',
    getTitle: () => 'Sign in - Google Accounts',
    isLoading: () => false,
    setBounds: () => {},
    setVisible: () => {},
    readPageText: async () => 'Sign in with your Google Account',
    destroy: () => {},
  }
  const returned = opener.events.onOpenWindow?.('about:blank', (childEvents) => {
    adoptedEvents = childEvents
    return adoptedView
  })
  assert.equal(returned, adoptedView)
  // Adopting a child WebContents must not call loadURL again (Chromium already drives the popup navigation).
  assert.equal(adoptedLoadCalls, 0)
  assert.equal(attached.get(1)?.has(adoptedView), true)
  assert.equal(opener.visible, false)

  adoptedEvents.onDidStartLoading()
  adoptedEvents.onDidNavigate('https://accounts.google.com/v3/signin/identifier')
  adoptedEvents.onDidStopLoading()
  assert.equal(sent.at(-1)?.snapshot.url, 'https://accounts.google.com/v3/signin/identifier')
  assert.equal(sent.at(-1)?.snapshot.tabs?.length, 3)

  // Popup completes sign-in, posts credentials to window.opener, and calls window.close(): returns to t1 (the opener), not t2.
  adoptedEvents.onClose?.()
  assert.equal(sent.at(-1)?.snapshot.tabs?.length, 2)
  assert.equal(sent.at(-1)?.snapshot.activeTabId, openerTabId)
  assert.equal(sent.at(-1)?.snapshot.url, 'https://www.bloomberg.com/live')
  assert.equal(opener.visible, true)
  assert.equal(attached.get(1)?.has(opener), true)
  assert.equal(attached.get(1)?.has(adoptedView), false)
})

test('keeps the browser view attached during window resize and across cross-window tile moves without stale detach races', async () => {
  const { manager, placed, views, attached, viewports, getState, setState } = createHarness()
  // Browser tile is on the right half of a 1400x1000 window.
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 700, y: 100, width: 680, height: 800 }, true)
  const view = views[0]!
  assert.equal(view.visible, true)
  assert.equal(attached.get(1)?.has(view), true)

  // Shrinking Window 1 to 650x500 before the renderer's ResizeObserver sync arrives scales the view instead of clipping to 0 and detaching.
  viewports.set(1, { width: 650, height: 500 })
  manager.sweep()
  assert.equal(view.visible, true)
  assert.equal(attached.get(1)?.has(view), true)
  assert.ok(view.bounds && view.bounds.width > 0 && view.bounds.height > 0)

  // Moving the loop frame from Window 1 to Window 2 detaches from Window 1, waits for Window 2's sync, and ignores late detach from Window 1.
  const moved = moveAcross(getState().grids['ws-1']![1]!, EMPTY_GRID, placed.frame.id, {
    rect: { x: 0, y: 0, w: 8, h: 6 },
  })
  setState({
    ...getState(),
    grids: { ...getState().grids, 'ws-1': { 1: moved.source, 2: moved.target } },
  })
  manager.sweep()
  assert.equal(attached.get(1)?.has(view), false)
  assert.equal(attached.get(2)?.has(view) ?? false, false)

  // Window 2 mounts and syncs its bounds, then Window 1's unmount cleanup fires a late detach(1, ...): view stays visible in Window 2.
  await manager.sync(2, 'ws-1', placed.panel.id, { x: 20, y: 60, width: 560, height: 400 }, true)
  assert.equal(attached.get(2)?.has(view), true)
  assert.equal(view.visible, true)

  manager.detach(1, 'ws-1', placed.panel.id)
  assert.equal(attached.get(2)?.has(view), true)
  assert.equal(view.visible, true)
  assert.equal(view.destroyed, false)
})

test('synchronizes WebContents User-Agent for Google auth hosts and uses CDP override during redirects without aborting', () => {
  const rawUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) jaspers-terminal/0.11.1 Chrome/136.0.0.0 Electron/44.3.0 Safari/537.36'
  const cleanUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
  const googleAuthUa = googleAuthUserAgent(rawUa)

  let committedUrl = 'https://www.linkedin.com/login'
  let currentUa = cleanUa
  const setUserAgentCalls: string[] = []
  const cdpOverrides: string[] = []

  const sync = createBrowserUserAgentSync(
    {
      getURL: () => committedUrl,
      getUserAgent: () => currentUa,
      setUserAgent: (ua) => {
        currentUa = ua
        setUserAgentCalls.push(ua)
      },
      setCdpUserAgentOverride: (ua) => {
        cdpOverrides.push(ua)
      },
    },
    rawUa,
  )

  // Direct navigation to accounts.google.com sets Electron's unmodified UA via setUserAgent before the request leaves.
  sync.onDidStartNavigation('https://accounts.google.com/v3/signin/identifier', true, false)
  assert.equal(sync.inFlightUrl(), 'https://accounts.google.com/v3/signin/identifier')
  assert.equal(currentUa, googleAuthUa)
  assert.deepEqual(setUserAgentCalls, [googleAuthUa])
  assert.deepEqual(cdpOverrides, [])

  committedUrl = 'https://accounts.google.com/v3/signin/identifier'
  sync.onDidNavigate(committedUrl)
  assert.equal(sync.inFlightUrl(), undefined)

  // Post-auth 302 redirect off accounts.google.com to myaccount.google.com uses CDP override (not setUserAgent) during redirect.
  setUserAgentCalls.length = 0
  sync.onWillRedirect('https://myaccount.google.com/?pli=1', true)
  assert.equal(sync.inFlightUrl(), 'https://myaccount.google.com/?pli=1')
  assert.deepEqual(setUserAgentCalls, [])
  assert.deepEqual(cdpOverrides, [cleanUa])

  // Once the redirect commits, setUserAgent is updated to the clean Chrome UA.
  committedUrl = 'https://myaccount.google.com/?pli=1'
  sync.onDidNavigate(committedUrl)
  assert.equal(currentUa, cleanUa)
  assert.deepEqual(setUserAgentCalls, [cleanUa])

  // Next direct navigation clears the standing CDP override.
  setUserAgentCalls.length = 0
  cdpOverrides.length = 0
  sync.onDidStartNavigation('https://mail.google.com/mail/u/0/', true, false)
  assert.deepEqual(setUserAgentCalls, [])
  assert.deepEqual(cdpOverrides, [''])

  // Redirect from mail.google.com into accounts.google.com applies Electron's UA via CDP without calling setUserAgent mid-redirect.
  cdpOverrides.length = 0
  sync.onWillRedirect('https://accounts.google.com/ServiceLogin', true)
  assert.deepEqual(setUserAgentCalls, [])
  assert.deepEqual(cdpOverrides, [googleAuthUa])

  // If that redirected navigation fails, the committed page's clean Chrome UA is restored.
  cdpOverrides.length = 0
  sync.onDidFailLoad(true)
  assert.equal(sync.inFlightUrl(), undefined)
  assert.equal(currentUa, cleanUa)
  assert.deepEqual(cdpOverrides, [''])
})

test('applies tile zoom factor to WebContentsView while keeping bounds unscaled, and forwards browser zoom gestures', async () => {
  const { manager, placed, views, zoomed, getState, updateGrid } = createHarness()
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  const view = views[0]!
  assert.equal(view.zoomFactor, 1)
  assert.deepEqual(view.bounds, { x: 16, y: 60, width: 680, height: 420 })

  const zoomedWindow = setZoom(layoutOf(getState().grids['ws-1']![1]!), placed.frame.id, 0.8).grid
  updateGrid('ws-1', withLayout(getState().grids['ws-1']![1]!, undefined, zoomedWindow))
  manager.sweep()
  assert.equal(view.zoomFactor, 0.8)
  assert.deepEqual(view.bounds, { x: 16, y: 60, width: 680, height: 420 })

  // If Chromium resets per-origin zoom as a page finishes loading, onDidStopLoading restores the tile's zoom.
  view.zoomFactor = 1
  view.events.onDidStopLoading()
  assert.equal(view.zoomFactor, 0.8)

  view.events.onZoom?.('out')
  assert.deepEqual(zoomed, [{ workspaceId: 'ws-1', elementId: placed.frame.id, direction: 'out' }])

  // Focusing another loop prevents unfocused browser views from zooming.
  const second = placeFramed(getState().grids['ws-1']![1]!, {
    content: { kind: 'view', view: 'core/table' },
    loop: 'f2',
  })
  updateGrid('ws-1', second.grid)
  view.events.onZoom?.('in')
  assert.equal(zoomed.length, 1)
})

test('createBrowserLoadTracker tracks main-frame loads and ignores subframe ad/tracker reloads', () => {
  let mainFrameLoading = false
  let starts = 0
  let stops = 0
  const tracker = createBrowserLoadTracker(
    { isLoadingMainFrame: () => mainFrameLoading },
    {
      onDidStartLoading: () => {
        starts++
      },
      onDidStopLoading: () => {
        stops++
      },
    },
  )

  assert.equal(tracker.isLoading(), false)

  // Main-frame navigation starts loading.
  mainFrameLoading = true
  tracker.onDidStartNavigation(true, false)
  tracker.onDidStartLoading()
  assert.equal(tracker.isLoading(), true)
  assert.equal(starts, 1)
  assert.equal(stops, 0)

  // Main frame finishes while a slow ad subframe is still loading.
  mainFrameLoading = false
  tracker.onDidFinishFrameLoad(true)
  assert.equal(tracker.isLoading(), false)
  assert.equal(stops, 1)

  // When the slow subframe later stops, onDidStopLoading does not fire a second time.
  tracker.onDidStopLoading()
  assert.equal(stops, 1)

  // Subframe ad reloads on an already-loaded page do not trigger main-frame start/stop events.
  tracker.onDidStartNavigation(false, false)
  tracker.onDidStartLoading()
  assert.equal(tracker.isLoading(), false)
  assert.equal(starts, 1)
  tracker.onDidFinishFrameLoad(false)
  tracker.onDidStopLoading()
  assert.equal(stops, 1)

  // Same-document (hash/pushState) navigation does not start a full-page load.
  tracker.onDidStartNavigation(true, true)
  assert.equal(tracker.isLoading(), false)
  assert.equal(starts, 1)
})

test('backgrounds inactive tabs and workspaces, suspends idle background WebContentsViews to free memory, and wakes them on selection', async () => {
  const { manager, placed, views, attached, getState, setState } = createHarness({ idleSuspendMs: 25 })
  const initial = await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  const firstTabId = initial.tabs![0]!.id
  const tab1View = views[0]!
  tab1View.title = 'Bloomberg Live TV'
  tab1View.events.onPageTitleUpdated('Bloomberg Live TV')
  assert.equal(tab1View.backgrounded, false)

  // Temporary overlay occlusion (e.g. menu or feedback popover) hides the view visually without backgrounding/pausing it.
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, false)
  assert.equal(tab1View.visible, false)
  assert.equal(tab1View.backgrounded, false)
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  assert.equal(tab1View.visible, true)

  // Opening a second tab backgrounds Tab 1 immediately, then suspends Tab 1's WebContentsView after idleSuspendMs.
  const opened = await manager.navigate(1, 'ws-1', placed.panel.id, 'new-tab', 'https://www.bloomberg.com/')
  const secondTabId = opened.activeTabId!
  const tab2View = views[1]!
  assert.equal(tab1View.backgrounded, true)
  assert.equal(tab2View.backgrounded, false)
  assert.equal(tab1View.destroyed, false)

  // Wait for the idle suspension timer to discard Tab 1's background WebContentsView.
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal(tab1View.destroyed, true)
  assert.equal(tab2View.destroyed, false)

  // Tab 1 remains in the tab bar with its URL, title, and theater state intact while suspended.
  const whileSuspended = await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  const suspendedMeta = whileSuspended.tabs?.find((t) => t.id === firstTabId)
  assert.ok(suspendedMeta)
  assert.equal(suspendedMeta.url, 'https://www.bloomberg.com/live')
  assert.equal(suspendedMeta.title, 'Bloomberg Live TV')
  assert.equal(suspendedMeta.theater, true)

  // Selecting Tab 1 wakes it with a fresh WebContentsView and reloads its address.
  const reselected = await manager.navigate(1, 'ws-1', placed.panel.id, 'select-tab', firstTabId)
  assert.equal(views.length, 3)
  const wokenTab1View = views[2]!
  assert.equal(reselected.activeTabId, firstTabId)
  assert.equal(wokenTab1View.getURL(), 'https://www.bloomberg.com/live')
  assert.equal(wokenTab1View.visible, true)
  assert.equal(wokenTab1View.backgrounded, false)
  assert.equal(attached.get(1)?.has(wokenTab1View), true)
  assert.equal(tab2View.backgrounded, true)

  // Switching to Workspace 2 backgrounds all tabs in Workspace 1 and suspends them after idleSuspendMs.
  setState({ ...getState(), currentWorkspaceId: 'ws-2' })
  manager.sweep()
  assert.equal(wokenTab1View.backgrounded, true)
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal(wokenTab1View.destroyed, true)
  assert.equal(tab2View.destroyed, true)

  // Switching back to Workspace 1 wakes only the active tab (Tab 1), leaving inactive Tab 2 suspended until selected.
  setState({ ...getState(), currentWorkspaceId: 'ws-1' })
  manager.sweep()
  assert.equal(views.length, 4)
  const wsWokenView = views[3]!
  assert.equal(wsWokenView.getURL(), 'https://www.bloomberg.com/live')
  assert.equal(wsWokenView.visible, true)
  assert.equal(wsWokenView.backgrounded, false)

  await manager.navigate(1, 'ws-1', placed.panel.id, 'select-tab', secondTabId)
  assert.equal(views.length, 5)
  assert.equal(views[4]!.getURL(), 'https://www.bloomberg.com/')
  manager.closeAll()
})

test('re-reads page text after async client-side hydration, settles syncPanelText across load and hydration, and navigates when state.url is set again after in-page click', async () => {
  const { manager, placed, views, published, getState, updateGrid } = createHarness({
    hydrationDelaysMs: [30, 80],
    settleTimeoutMs: 500,
    hydrationWindowMs: 120,
    hydrationPollMs: 25,
  })
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  const view = views[0]!

  // Simulate an article navigation where initial SSR HTML only has a short preview at did-stop-loading,
  // and client-side subscriber hydration injects the full 14k-character article 40ms later.
  const ssrPreview = 'Top two free paragraphs before subscriber cookie hydration (1,303 chars).'
  const fullSubscriberArticle = `${ssrPreview}\n\n${'Full subscriber article body paragraph. '.repeat(350)}`
  view.loadURL = async (url: string) => {
    view.history = [...view.history.slice(0, view.index + 1), url]
    view.index = view.history.length - 1
    view.loading = true
    view.pageText = ssrPreview
    view.events.onDidStartLoading()
    view.events.onDidNavigate(url)
    await new Promise((resolve) => setTimeout(resolve, 15))
    view.loading = false
    view.events.onDidStopLoading()
    setTimeout(() => {
      view.pageText = fullSubscriberArticle
    }, 35)
  }

  const articleUrl = 'https://www.bloomberg.com/news/articles/2026-11-04/debt-limit-tariffs-top-list'
  updateGrid('ws-1', setPanelState(getState().grids['ws-1']![1]!, placed.panel.id, ['url'], articleUrl).grid)
  manager.sweep()

  // Immediately calling syncPanelText (as set/get do) waits for both the load and the post-load subscriber hydration.
  const settledText = await manager.syncPanelText('ws-1', placed.element.id)
  assert.equal(settledText, fullSubscriberArticle)
  assert.equal(published.at(-1)?.snapshot.text, fullSubscriberArticle)

  // User clicks an in-page link to another page while panel.state.url still holds articleUrl.
  view.history.push('https://www.bloomberg.com/markets')
  view.index = view.history.length - 1
  view.pageText = 'Bloomberg Markets front page'
  view.events.onDidNavigate('https://www.bloomberg.com/markets')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(published.at(-1)?.snapshot.text, 'Bloomberg Markets front page')

  // Assistant explicitly writes state.url back to articleUrl: even though state.url already equaled articleUrl,
  // the explicit setPanelState write navigates the browser back to articleUrl.
  updateGrid('ws-1', setPanelState(getState().grids['ws-1']![1]!, placed.panel.id, ['url'], articleUrl).grid)
  manager.sweep()
  assert.equal(view.getURL(), articleUrl)
  const rehydratedText = await manager.syncPanelText('ws-1', placed.panel.id)
  assert.equal(rehydratedText, fullSubscriberArticle)

  // Passive navigation without syncPanelText also updates panel.text once hydrationDelaysMs fire.
  const passiveUrl = 'https://www.bloomberg.com/news/articles/2026-11-04/passive-hydration-story'
  updateGrid('ws-1', setPanelState(getState().grids['ws-1']![1]!, placed.panel.id, ['url'], passiveUrl).grid)
  manager.sweep()
  await new Promise((resolve) => setTimeout(resolve, 110))
  assert.equal(published.at(-1)?.snapshot.url, passiveUrl)
  assert.equal(published.at(-1)?.snapshot.text, fullSubscriberArticle)

  manager.closeAll()
})

test('recovers from Bloomberg tosv2.html bot-challenge redirects, preserves unwrapped URL and prior page text, and keeps non-zero bounds on background views', async () => {
  const { manager, placed, views, published, getState, setState, updateGrid } = createHarness({
    idleSuspendMs: 25,
    hydrationDelaysMs: [],
    hydrationWindowMs: 0,
  })
  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  const view = views[0]!

  const marketsUrl = 'https://www.bloomberg.com/markets'
  const challengeUrl = 'https://www.bloomberg.com/tosv2.html?vid=&uuid=abc-123&url=L21hcmtldHM='

  view.pageText = 'Bloomberg Markets live headlines and indices'
  await manager.navigate(1, 'ws-1', placed.panel.id, 'load', marketsUrl)
  assert.equal(published.at(-1)?.snapshot.url, marketsUrl)
  assert.equal(published.at(-1)?.snapshot.text, 'Bloomberg Markets live headlines and indices')

  // Simulate Bloomberg redirecting a refresh to tosv2.html once due to a stale PerimeterX cookie, then succeeding on automatic retry via loadURL.
  let redirectedOnce = false
  let cookiesCleared = false
  let cookiesClearedBeforeLoad = false
  view.clearBotCookies = async () => {
    await new Promise((resolve) => setTimeout(resolve, 15))
    cookiesCleared = true
  }
  const origLoad = view.loadURL.bind(view)
  const origReload = view.reload.bind(view)
  view.reload = () => {
    if (!redirectedOnce) {
      redirectedOnce = true
      view.history = [...view.history.slice(0, view.index + 1), challengeUrl]
      view.index = view.history.length - 1
      view.title = 'Bloomberg - Are you a robot?'
      view.pageText =
        "We've detected unusual activity from your computer network. To continue, please click the box below to let us know you're not a robot."
      view.loading = true
      view.events.onDidStartLoading()
      view.events.onDidNavigate(challengeUrl)
      setTimeout(() => {
        view.loading = false
        view.events.onDidStopLoading()
      }, 10)
      return
    }
    origReload()
  }
  view.loadURL = async (url: string) => {
    cookiesClearedBeforeLoad = cookiesCleared
    view.title = 'Bloomberg Markets'
    view.pageText = 'Bloomberg Markets refreshed headlines'
    return origLoad(url)
  }

  updateGrid('ws-1', refreshPanel(getState().grids['ws-1']![1]!, placed.panel.id, 1001).grid)
  manager.sweep()
  const settledAfterChallengeRetry = await manager.syncPanelText('ws-1', placed.panel.id)

  assert.equal(cookiesClearedBeforeLoad, true)
  assert.equal(settledAfterChallengeRetry, 'Bloomberg Markets refreshed headlines')
  assert.equal(view.getURL(), marketsUrl)
  assert.equal(published.at(-1)?.snapshot.url, marketsUrl)
  assert.equal(published.at(-1)?.snapshot.text, 'Bloomberg Markets refreshed headlines')

  // If Bloomberg still lands on tosv2.html after retry, the tab keeps marketsUrl as its address, preserves prior article text, and reload awaits clearBotCookies before loading marketsUrl instead of tosv2.html.
  let forceChallenge = true
  const sendChallenge = (): void => {
    view.history = [...view.history.slice(0, view.index + 1), challengeUrl]
    view.index = view.history.length - 1
    view.title = 'Bloomberg - Are you a robot?'
    view.pageText =
      "We've detected unusual activity from your computer network. To continue, please click the box below to let us know you're not a robot."
    view.loading = true
    view.events.onDidStartLoading()
    view.events.onDidNavigate(challengeUrl)
    view.loading = false
    view.events.onDidStopLoading()
  }
  view.reload = () => {
    if (forceChallenge) {
      sendChallenge()
      return
    }
    origReload()
  }
  view.loadURL = async (url: string) => {
    if (forceChallenge) {
      sendChallenge()
      return
    }
    cookiesClearedBeforeLoad = cookiesCleared
    view.title = 'Bloomberg Markets'
    view.pageText = 'Bloomberg Markets recovered after manual reload'
    return origLoad(url)
  }

  updateGrid('ws-1', refreshPanel(getState().grids['ws-1']![1]!, placed.panel.id, 1002).grid)
  manager.sweep()
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(published.at(-1)?.snapshot.url, marketsUrl)
  assert.equal(published.at(-1)?.snapshot.text, 'Bloomberg Markets refreshed headlines')

  cookiesCleared = false
  cookiesClearedBeforeLoad = false
  forceChallenge = false
  const afterReload = await manager.navigate(1, 'ws-1', placed.panel.id, 'reload')
  await manager.syncPanelText('ws-1', placed.panel.id)
  assert.equal(cookiesClearedBeforeLoad, true)
  assert.equal(afterReload.url, marketsUrl)
  assert.equal(view.getURL(), marketsUrl)

  // Suspending on an inactive workspace and waking via background refresh_element still sets non-zero bounds on the woken view.
  setState({ ...getState(), currentWorkspaceId: 'ws-2' })
  manager.sweep()
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.equal(view.destroyed, true)

  updateGrid('ws-1', refreshPanel(getState().grids['ws-1']![1]!, placed.panel.id, 1003).grid)
  manager.sweep()
  const bgWokenView = views.at(-1)!
  assert.notEqual(bgWokenView, view)
  assert.ok(bgWokenView.bounds && bgWokenView.bounds.width > 0 && bgWokenView.bounds.height > 0)

  manager.closeAll()
})

test('attaches browser views with their clipped bounds and visible state already set so window attach hooks observe live geometry', async () => {
  const { manager, placed, views, windows } = createHarness()
  const observedOnAttach: { visible: boolean; bounds: BrowserBounds | null }[] = []
  const win1 = windows.get(1)!
  const origAttach = win1.attach.bind(win1)
  win1.attach = (view) => {
    const fake = view as FakeView
    observedOnAttach.push({
      visible: fake.visible,
      bounds: fake.bounds ? { ...fake.bounds } : null,
    })
    origAttach(view)
  }

  await manager.sync(1, 'ws-1', placed.panel.id, { x: 16, y: 60, width: 680, height: 420 }, true)
  assert.deepEqual(observedOnAttach[0], {
    visible: true,
    bounds: { x: 16, y: 60, width: 680, height: 420 },
  })

  // Opening a popup tab attaches the new view with its clipped bounds and visible=true already applied.
  views[0]!.events.onOpenWindow?.('https://www.bloomberg.com/markets')
  assert.deepEqual(observedOnAttach[1], {
    visible: true,
    bounds: { x: 16, y: 60, width: 680, height: 420 },
  })

  manager.closeAll()
})

test('interact drives navigate, click, type, press, scroll, tabs, history, and wakes suspended browser views while refreshing published page text', async () => {
  const { manager, placed, views, published, getState, setState } = createHarness({
    idleSuspendMs: 15,
    hydrationDelaysMs: [],
    hydrationWindowMs: 0,
    postActionDelayMs: 0,
  })

  // Interact works even before renderer IPC sync has run on the panel.
  const nav = await manager.interact('ws-1', placed.panel.id, {
    action: 'navigate',
    url: 'https://example.com/follow?account=acme',
  })
  assert.equal(nav.snapshot.url, 'https://example.com/follow?account=acme')
  assert.equal(views.length, 1)
  const v1 = views[0]!
  v1.pageText = 'Follow @acme?\n\nControls:\n- [c1] button "Follow" (in dialog)'

  // Clicking a modal confirmation button updates DOM text in place without a URL change and publishes the new text.
  v1.onInteract = (interaction, view) => {
    if (interaction.action === 'click') {
      view.pageText = 'Following @acme\n\nControls:\n- [c1] button "Following"'
      return { detail: 'Clicked button "Follow".', x: 640, y: 402, role: 'button', label: 'Follow' }
    }
    return { detail: `Ran ${interaction.action}.` }
  }
  const clicked = await manager.interact('ws-1', placed.panel.id, { action: 'click', text: 'Follow' })
  assert.equal(clicked.detail, 'Clicked button "Follow".')
  assert.match(clicked.snapshot.text ?? '', /Following @acme/)
  assert.match(published.at(-1)?.snapshot.text ?? '', /Following @acme/)

  // Clicking a link that opens a popup tab switches to the new tab and notes it in detail.
  v1.onInteract = () => {
    v1.events.onOpenWindow?.('https://example.com/acme/lists')
    views.at(-1)!.pageText = 'Lists by @acme'
    return { detail: 'Clicked link "View Lists".' }
  }
  const popupClick = await manager.interact('ws-1', placed.panel.id, { action: 'click', text: 'View Lists' })
  assert.equal(popupClick.snapshot.tabCount, 2)
  assert.equal(popupClick.snapshot.activeTabId, 't2')
  assert.match(popupClick.detail, /Opened tab t2\.$/)
  assert.equal(popupClick.snapshot.text, 'Lists by @acme')

  // Switch back to t1 and close t2.
  const switched = await manager.interact('ws-1', placed.panel.id, { action: 'select_tab', tabId: 't1' })
  assert.equal(switched.snapshot.activeTabId, 't1')
  const closed = await manager.interact('ws-1', placed.panel.id, { action: 'close_tab', tabId: 't2' })
  assert.equal(closed.snapshot.tabCount, 1)
  assert.equal(closed.snapshot.activeTabId, 't1')

  // Navigate to a second page, then go back and forward.
  await manager.interact('ws-1', placed.panel.id, { action: 'navigate', url: 'https://example.com/home' })
  const back = await manager.interact('ws-1', placed.panel.id, { action: 'back' })
  assert.equal(back.snapshot.url, 'https://example.com/follow?account=acme')
  const fwd = await manager.interact('ws-1', placed.panel.id, { action: 'forward' })
  assert.equal(fwd.snapshot.url, 'https://example.com/home')

  // Suspend the browser on an inactive workspace, then interact: it wakes automatically and executes the action.
  setState({ ...getState(), currentWorkspaceId: 'ws-2' })
  manager.sweep()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(v1.destroyed, true)

  const scrolled = await manager.interact('ws-1', placed.panel.id, {
    action: 'scroll',
    direction: 'down',
    pixels: 600,
  })
  assert.equal(scrolled.action, 'scroll')
  const woken = views.at(-1)!
  assert.notEqual(woken, v1)
  assert.equal(woken.interactions.at(-1)?.action, 'scroll')

  manager.closeAll()
})

test('persists multi-tab browser state across app restarts, wakes restored background tabs on demand, and preserves extra tabs on state.url updates', async () => {
  const firstRun = createHarness({
    hydrationDelaysMs: [],
    hydrationWindowMs: 0,
    postActionDelayMs: 0,
  })
  const { manager, placed, views, getState } = firstRun
  const panelId = placed.panel.id

  await manager.interact('ws-1', panelId, { action: 'navigate', url: 'https://x.com/home' })
  views[0]!.title = 'Home / X'
  views[0]!.events.onPageTitleUpdated('Home / X')

  await manager.interact('ws-1', panelId, {
    action: 'new_tab',
    url: 'https://www.linkedin.com/search/results/content/?keywords=AI',
  })
  views[1]!.title = 'Search | LinkedIn'
  views[1]!.events.onPageTitleUpdated('Search | LinkedIn')

  await manager.interact('ws-1', panelId, { action: 'new_tab', url: 'https://www.bloomberg.com/' })
  views[2]!.title = 'Bloomberg - Business News'
  views[2]!.events.onPageTitleUpdated('Bloomberg - Business News')

  // Open a fourth tab at x.com/home and simulate typing/submitting a search that navigates in-page to f=live.
  await manager.interact('ws-1', panelId, { action: 'new_tab', url: 'https://x.com/home' })
  const t4View = views[3]!
  t4View.history.push('https://x.com/search?q=Rogo%20OR%20Hebbia&f=live')
  t4View.index = t4View.history.length - 1
  t4View.title = 'Rogo OR Hebbia - Search / X'
  t4View.pageText = 'Live tweets about Rogo and Hebbia'
  t4View.events.onDidNavigate('https://x.com/search?q=Rogo%20OR%20Hebbia&f=live')

  // Switch active focus back to t1 before restart, just like a periodic scan task does.
  const beforeQuit = await manager.interact('ws-1', panelId, { action: 'select_tab', tabId: 't1' })
  assert.equal(beforeQuit.snapshot.tabCount, 4)
  assert.equal(beforeQuit.snapshot.activeTabId, 't1')

  const savedPanel = panelOf(getState().grids['ws-1']![1]!, panelId)
  assert.deepEqual(savedPanel.state, {
    url: 'https://x.com/home',
    activeTabId: 't1',
    tabs: [
      { id: 't1', url: 'https://x.com/home', title: 'Home / X' },
      { id: 't2', url: 'https://www.linkedin.com/search/results/content/?keywords=AI', title: 'Search | LinkedIn' },
      { id: 't3', url: 'https://www.bloomberg.com/', title: 'Bloomberg - Business News' },
      { id: 't4', url: 'https://x.com/search?q=Rogo%20OR%20Hebbia&f=live', title: 'Rogo OR Hebbia - Search / X' },
    ],
  })

  // Simulate app restart by serializing workspace state to JSON and starting a fresh BrowserManager.
  const persistedState = JSON.parse(JSON.stringify(getState())) as BrowserManagerState
  manager.closeAll()

  const restarted = createHarness({
    hydrationDelaysMs: [],
    hydrationWindowMs: 0,
    postActionDelayMs: 0,
    initialState: persistedState,
  })
  const restoredSnap = await restarted.manager.sync(1, 'ws-1', panelId, { x: 16, y: 60, width: 680, height: 420 }, true)

  // Only the active tab allocates a WebContentsView at startup; all 4 tabs and their titles are restored immediately.
  assert.equal(restarted.views.length, 1)
  assert.equal(restoredSnap.tabCount, 4)
  assert.equal(restoredSnap.activeTabId, 't1')
  assert.equal(restoredSnap.url, 'https://x.com/home')
  assert.deepEqual(
    restoredSnap.tabs?.map((t) => ({ id: t.id, url: t.url, title: t.title })),
    [
      { id: 't1', url: 'https://x.com/home', title: 'Home / X' },
      { id: 't2', url: 'https://www.linkedin.com/search/results/content/?keywords=AI', title: 'Search | LinkedIn' },
      { id: 't3', url: 'https://www.bloomberg.com/', title: 'Bloomberg - Business News' },
      { id: 't4', url: 'https://x.com/search?q=Rogo%20OR%20Hebbia&f=live', title: 'Rogo OR Hebbia - Search / X' },
    ],
  )
  assert.equal(restarted.published.at(-1)?.snapshot.tabCount, 4)

  // Selecting suspended background tab t4 wakes it on demand at its persisted search URL.
  const switchedToT4 = await restarted.manager.interact('ws-1', panelId, { action: 'select_tab', tabId: 't4' })
  assert.equal(restarted.views.length, 2)
  assert.equal(switchedToT4.snapshot.activeTabId, 't4')
  assert.equal(switchedToT4.snapshot.url, 'https://x.com/search?q=Rogo%20OR%20Hebbia&f=live')
  assert.equal(restarted.views[1]!.getURL(), 'https://x.com/search?q=Rogo%20OR%20Hebbia&f=live')

  // Assistant writes state.url while multiple tabs are open: navigates the active tab (t4) without dropping t1..t3.
  const gridBeforeSet = restarted.getState().grids['ws-1']![1]!
  restarted.updateGrid('ws-1', setPanelState(gridBeforeSet, panelId, ['url'], 'https://www.sec.gov').grid)
  restarted.manager.sweep()
  assert.equal(restarted.views[1]!.getURL(), 'https://www.sec.gov/')
  const afterSetSnap = await restarted.manager.sync(1, 'ws-1', panelId, { x: 16, y: 60, width: 680, height: 420 }, true)
  assert.equal(afterSetSnap.tabCount, 4)
  assert.equal(afterSetSnap.activeTabId, 't4')
  assert.equal(afterSetSnap.tabs?.[3]?.url, 'https://www.sec.gov/')
  assert.equal(afterSetSnap.tabs?.[0]?.url, 'https://x.com/home')

  restarted.manager.closeAll()
})

test('preserves multi-tab state across room close, reopen, cross-tab move, non-contiguous tab ids, and collapse back to one tab', async () => {
  const { manager, placed, views, getState, setState } = createHarness({
    hydrationDelaysMs: [],
    hydrationWindowMs: 0,
    postActionDelayMs: 0,
  })
  const panelId = placed.panel.id
  let loopsByTab: Record<string, Loops> = {
    'ws-1': {
      seq: 1,
      list: [{ id: 'f1', desc: 'Monitor', brief: '', plugins: [], skills: [], createdAt: 1000 }],
    },
    'ws-2': { seq: 0, list: [] },
  }

  await manager.sync(1, 'ws-1', panelId, { x: 16, y: 60, width: 680, height: 420 }, true)
  await manager.navigate(1, 'ws-1', panelId, 'new-tab', 'https://example.com/two')
  await manager.navigate(1, 'ws-1', panelId, 'new-tab', 'https://example.com/three')
  await manager.navigate(1, 'ws-1', panelId, 'new-tab', 'https://example.com/four')

  // Close t2 so open tabs have non-contiguous ids [t1, t3, t4], and toggle theater off on t1.
  await manager.navigate(1, 'ws-1', panelId, 'close-tab', 't2')
  await manager.navigate(1, 'ws-1', panelId, 'select-tab', 't1')
  await manager.navigate(1, 'ws-1', panelId, 'toggle-theater')

  // Ephemeral OAuth popup at about:blank -> accounts.google.com does not get persisted into state.tabs.
  let popupEvents!: BrowserViewEvents
  const popupView: ManagedBrowserView = {
    loadURL: async () => {},
    reload: () => {},
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => {},
    goForward: () => {},
    getURL: () => 'https://accounts.google.com/v3/signin/identifier',
    getTitle: () => 'Sign in - Google Accounts',
    isLoading: () => false,
    setBounds: () => {},
    setVisible: () => {},
    readPageText: async () => 'Sign in',
    destroy: () => {},
  }
  views[0]!.events.onOpenWindow?.('about:blank', (ev) => {
    popupEvents = ev
    return popupView
  })
  popupEvents.onDidNavigate('https://accounts.google.com/v3/signin/identifier')
  const stateDuringOAuth = panelOf(getState().grids['ws-1']![1]!, panelId).state
  assert.deepEqual(
    (stateDuringOAuth['tabs'] as { id: string }[]).map((t) => t.id),
    ['t1', 't3', 't4'],
  )
  popupEvents.onClose?.()

  // Close the room on ws-1 (destroying all live views), then reopen it onto ws-2 via reopenAcrossTabs.
  const beforeClose = getState().grids['ws-1']!
  const afterCloseWin = withLayout(
    beforeClose[1]!,
    undefined,
    removeElement(layoutOf(beforeClose[1]!), placed.frame.id).grid,
  )
  const afterCloseGrids = { 1: afterCloseWin }
  loopsByTab = {
    ...loopsByTab,
    'ws-1': closedWithout(loopsByTab['ws-1']!, beforeClose, afterCloseGrids, 2000),
  }
  setState({
    ...getState(),
    grids: { ...getState().grids, 'ws-1': afterCloseGrids },
  })
  manager.sweep()
  assert.equal(
    views.every((v) => v.destroyed),
    true,
  )

  const movedAcross = reopenAcrossTabs(getState().grids, loopsByTab, 'ws-2', 'f1', 1, 3000)
  loopsByTab = movedAcross.loops
  setState({
    ...getState(),
    currentWorkspaceId: 'ws-2',
    grids: movedAcross.grids,
  })
  manager.sweep()

  const reopenedSnap = await manager.sync(1, 'ws-2', panelId, { x: 16, y: 60, width: 680, height: 420 }, true)
  assert.equal(reopenedSnap.tabCount, 3)
  assert.equal(reopenedSnap.activeTabId, 't1')
  assert.equal(reopenedSnap.theater, false)
  assert.deepEqual(
    reopenedSnap.tabs?.map((t) => [t.id, t.url]),
    [
      ['t1', 'https://www.bloomberg.com/live'],
      ['t3', 'https://example.com/three'],
      ['t4', 'https://example.com/four'],
    ],
  )

  // Opening another tab after restoring [t1, t3, t4] mints t5 without colliding with t4.
  const withFifth = await manager.navigate(1, 'ws-2', panelId, 'new-tab', 'https://example.com/five')
  assert.equal(withFifth.activeTabId, 't5')
  assert.deepEqual(
    withFifth.tabs?.map((t) => t.id),
    ['t1', 't3', 't4', 't5'],
  )

  // Also verify same-tab reopened() and collapsing back to a single default t1 tab removes state.tabs.
  await manager.navigate(1, 'ws-2', panelId, 'close-tab', 't3')
  await manager.navigate(1, 'ws-2', panelId, 'close-tab', 't4')
  await manager.navigate(1, 'ws-2', panelId, 'close-tab', 't5')
  await manager.navigate(1, 'ws-2', panelId, 'toggle-theater')
  const collapsedState = panelOf(getState().grids['ws-2']![1]!, panelId).state
  assert.deepEqual(collapsedState, { url: 'https://www.bloomberg.com/live' })

  // Same-tab close and reopened() helper also works cleanly.
  const ws2Before = getState().grids['ws-2']!
  const ws2ClosedWin = withLayout(
    ws2Before[1]!,
    undefined,
    removeElement(layoutOf(ws2Before[1]!), movedAcross.frame.id).grid,
  )
  const ws2Closed = closedWithout(loopsByTab['ws-2']!, ws2Before, { 1: ws2ClosedWin }, 4000)
  const ws2Reopened = reopened({ 1: ws2ClosedWin }, ws2Closed, 'f1', 1, 5000)
  assert.deepEqual(panelOf(ws2Reopened.grids[1]!, panelId).state, { url: 'https://www.bloomberg.com/live' })

  manager.closeAll()
})

test('a state.url write navigates the active tab and is kept, not overwritten by the page still showing, while other tabs stay', async () => {
  const { manager, placed, views, getState, dispatchGrid } = createHarness({
    hydrationDelaysMs: [],
    hydrationWindowMs: 0,
    postActionDelayMs: 0,
  })
  const panelId = placed.panel.id
  const panelState = () => getState().grids['ws-1']![1]!.panels.find((p) => p.id === panelId)!.state

  // One tab, settled on its page: the assistant sets state.url.
  await manager.sync(1, 'ws-1', panelId, { x: 16, y: 60, width: 680, height: 420 }, true)
  assert.equal(views[0]!.getURL(), 'https://www.bloomberg.com/live')
  dispatchGrid('ws-1', setPanelState(getState().grids['ws-1']![1]!, panelId, ['url'], 'https://www.sec.gov').grid)
  assert.equal(views[0]!.getURL(), 'https://www.sec.gov/')
  assert.equal(readBrowserState(panelState()).url, 'https://www.sec.gov/')
  assert.equal(panelState()['tabs'], undefined)

  // Two tabs, the second active and settled: the write navigates it and keeps the first.
  await manager.navigate(1, 'ws-1', panelId, 'new-tab', 'https://www.bloomberg.com/')
  assert.equal(views[1]!.getURL(), 'https://www.bloomberg.com/')
  dispatchGrid('ws-1', setPanelState(getState().grids['ws-1']![1]!, panelId, ['url'], 'https://x.com/home').grid)
  assert.equal(views[1]!.getURL(), 'https://x.com/home')
  assert.equal(views[0]!.getURL(), 'https://www.sec.gov/')
  const persisted = readBrowserState(panelState())
  assert.equal(persisted.url, 'https://x.com/home')
  assert.equal(persisted.activeTabId, 't2')
  assert.deepEqual(
    persisted.tabs?.map((t) => [t.id, t.url]),
    [
      ['t1', 'https://www.sec.gov/'],
      ['t2', 'https://x.com/home'],
    ],
  )

  // The address another tab already shows is still the active tab's to load.
  dispatchGrid('ws-1', setPanelState(getState().grids['ws-1']![1]!, panelId, ['url'], 'https://www.sec.gov/').grid)
  assert.equal(views[1]!.getURL(), 'https://www.sec.gov/')
  assert.deepEqual(
    readBrowserState(panelState()).tabs?.map((t) => [t.id, t.url]),
    [
      ['t1', 'https://www.sec.gov/'],
      ['t2', 'https://www.sec.gov/'],
    ],
  )
})
