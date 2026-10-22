import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BROWSER_VIEW, type BrowserBounds, type BrowserSnapshot } from '../../shared/grid/browser.ts'
import {
  EMPTY_GRID,
  layoutOf,
  placeFramed,
  refreshPanel,
  removeElement,
  setMode,
  setPanelState,
  withLayout,
  type Grid,
} from '../../shared/grid/grid.ts'
import {
  createBrowserManager,
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
  destroyed: boolean
  reloads: number
  pageText: string | null
}

function createHarness() {
  const placed = placeFramed(EMPTY_GRID, {
    content: { kind: 'view', view: BROWSER_VIEW },
    state: { url: 'https://www.bloomberg.com/live' },
    rect: { x: 0, y: 0, w: 8, h: 6 },
    loop: 'f1',
  })
  let state: BrowserManagerState = {
    currentWorkspaceId: 'ws-1',
    workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }],
    grids: {
      'ws-1': { 1: placed.grid },
      'ws-2': { 1: EMPTY_GRID },
    },
  }
  const views: FakeView[] = []
  const attached = new Map<number, Set<ManagedBrowserView>>()
  const sent: { window: number; snapshot: BrowserSnapshot }[] = []
  const focused: { workspaceId: string; elementId: string }[] = []

  const windows = new Map<number, ManagedWindow>([
    [
      1,
      {
        number: 1,
        viewport: () => ({ width: 1400, height: 1000 }),
        attach: (view) => {
          let set = attached.get(1)
          if (!set) {
            set = new Set()
            attached.set(1, set)
          }
          set.add(view)
        },
        detach: (view) => {
          attached.get(1)?.delete(view)
        },
        sendState: (snapshot) => {
          sent.push({ window: 1, snapshot })
        },
      },
    ],
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
        destroyed: false,
        reloads: 0,
        pageText: 'Bloomberg Live TV stream',
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
        readPageText: async () => view.pageText,
        destroy() {
          view.destroyed = true
        },
      }
      views.push(view)
      return view
    },
    setPanelUrl: (workspaceId, panelId, url) => {
      const grid = state.grids[workspaceId]![1]!
      const updated = setPanelState(grid, panelId, ['url'], url).grid
      state = { ...state, grids: { ...state.grids, [workspaceId]: { ...state.grids[workspaceId], 1: updated } } }
    },
    focusElement: (workspaceId, elementId) => {
      focused.push({ workspaceId, elementId })
    },
  })

  const updateGrid = (workspaceId: string, nextGrid: Grid): void => {
    state = { ...state, grids: { ...state.grids, [workspaceId]: { ...state.grids[workspaceId], 1: nextGrid } } }
  }

  return {
    manager,
    placed,
    views,
    attached,
    sent,
    focused,
    getState: () => state,
    setState: (next: BrowserManagerState) => {
      state = next
    },
    updateGrid,
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
})
