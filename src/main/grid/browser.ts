import { ipcMain, session, WebContentsView, type BrowserWindow, type Session } from 'electron'
import { BROWSER_PARTITION, isBrowserUrl } from '../../shared/grid/browser'
import { PANEL_TEXT_MAX } from '../../shared/grid/grid'
import { setPanelStateChecked } from '../actions'
import { getState, subscribe } from '../state'
import {
  createBrowserManager,
  type BrowserManager,
  type BrowserViewEvents,
  type ManagedBrowserView,
  type ManagedWindow,
} from './browser-manager'
import { focus } from './grid'
import { windowNumberOf, windowOf } from './windows'

// Electron's native `WebContentsView` backing for `core/browser` panels. Each view runs in the
// persistent `persist:browser` session partition with sandboxed, context-isolated preferences so
// user sign-ins persist across restarts while web pages have no access to Node or Terminal's state.

/** Only media playback and fullscreen are granted to browsed pages; camera, mic, geolocation, and device APIs are denied. */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'mediaKeySystem'])

const nativeViews = new WeakMap<ManagedBrowserView, WebContentsView>()
const watchedWindows = new WeakSet<BrowserWindow>()
let configuredSession: Session | null = null
let activeManager: BrowserManager | null = null

function browserSession(): Session {
  if (configuredSession) return configuredSession
  const partition = session.fromPartition(BROWSER_PARTITION)
  partition.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  partition.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission))
  configuredSession = partition
  return partition
}

function createNativeView(events: BrowserViewEvents): ManagedBrowserView {
  const raw = new WebContentsView({
    webPreferences: {
      session: browserSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
    },
  })
  raw.setVisible(false)
  const { webContents } = raw

  webContents.on('will-attach-webview', (event) => event.preventDefault())
  webContents.on('will-navigate', (event) => {
    if (!isBrowserUrl(event.url)) event.preventDefault()
  })
  webContents.on('will-redirect', (event) => {
    if (!isBrowserUrl(event.url)) event.preventDefault()
  })
  // Popups and auth flows stay inside this view's persistent partition rather than spawning new windows.
  webContents.setWindowOpenHandler(({ url }) => {
    if (isBrowserUrl(url)) {
      setImmediate(() => {
        if (!webContents.isDestroyed()) void webContents.loadURL(url).catch(() => undefined)
      })
    }
    return { action: 'deny' }
  })

  webContents.on('did-start-loading', () => events.onDidStartLoading())
  webContents.on('did-stop-loading', () => events.onDidStopLoading())
  webContents.on('did-navigate', (_event, url) => events.onDidNavigate(url))
  webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) events.onDidNavigate(url)
  })
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    events.onDidFailLoad(errorCode, errorDescription, isMainFrame)
  })
  webContents.on('page-title-updated', (_event, title) => events.onPageTitleUpdated(title))
  webContents.on('focus', () => events.onFocus())

  const managed: ManagedBrowserView = {
    loadURL: (url) => (webContents.isDestroyed() ? Promise.resolve() : webContents.loadURL(url)),
    reload: () => {
      if (!webContents.isDestroyed()) webContents.reload()
    },
    canGoBack: () => !webContents.isDestroyed() && webContents.navigationHistory.canGoBack(),
    canGoForward: () => !webContents.isDestroyed() && webContents.navigationHistory.canGoForward(),
    goBack: () => {
      if (!webContents.isDestroyed() && webContents.navigationHistory.canGoBack()) {
        webContents.navigationHistory.goBack()
      }
    },
    goForward: () => {
      if (!webContents.isDestroyed() && webContents.navigationHistory.canGoForward()) {
        webContents.navigationHistory.goForward()
      }
    },
    getURL: () => (webContents.isDestroyed() ? '' : webContents.getURL()),
    getTitle: () => (webContents.isDestroyed() ? '' : webContents.getTitle()),
    isLoading: () => !webContents.isDestroyed() && webContents.isLoading(),
    setBounds: (bounds) => {
      if (!webContents.isDestroyed()) raw.setBounds(bounds)
    },
    setVisible: (visible) => {
      if (!webContents.isDestroyed()) raw.setVisible(visible)
    },
    readPageText: async () => {
      if (webContents.isDestroyed()) return null
      try {
        const text: unknown = await webContents.executeJavaScript(
          'typeof document !== "undefined" && document.body ? document.body.innerText : ""',
          false,
        )
        return typeof text === 'string' && text.trim() !== '' ? text.trim().slice(0, PANEL_TEXT_MAX) : null
      } catch {
        return null
      }
    },
    destroy: () => {
      raw.setVisible(false)
      if (!webContents.isDestroyed()) webContents.close()
    },
  }

  nativeViews.set(managed, raw)
  return managed
}

function wrapWindow(number: number, win: BrowserWindow): ManagedWindow {
  if (!watchedWindows.has(win)) {
    watchedWindows.add(win)
    win.on('resize', () => manager().sweep())
    win.once('closed', () => manager().windowClosed(number))
  }
  return {
    number,
    viewport: () => {
      if (win.isDestroyed()) return null
      const [width = 0, height = 0] = win.getContentSize()
      return { width, height }
    },
    attach: (view) => {
      const raw = nativeViews.get(view)
      if (!raw || win.isDestroyed()) return
      if (!win.contentView.children.includes(raw)) win.contentView.addChildView(raw)
    },
    detach: (view) => {
      const raw = nativeViews.get(view)
      if (!raw || win.isDestroyed()) return
      if (win.contentView.children.includes(raw)) win.contentView.removeChildView(raw)
    },
    sendState: (snapshot) => {
      if (!win.isDestroyed()) win.webContents.send('browser:state', snapshot)
    },
  }
}

function manager(): BrowserManager {
  activeManager ??= createBrowserManager({
    getState,
    getWindow: (n) => {
      const win = windowOf(n)
      return win ? wrapWindow(n, win) : null
    },
    createView: createNativeView,
    setPanelUrl: (workspaceId, panelId, url) => {
      setPanelStateChecked(workspaceId, panelId, ['url'], url)
    },
    focusElement: (workspaceId, elementId) => {
      focus(workspaceId, elementId)
    },
  })
  return activeManager
}

/** Keeps native browser views in sync with workspace switches, panel state updates, and removed tiles. */
export function startBrowsers(): void {
  manager().sweep(getState())
  subscribe((next) => manager().sweep(next))
}

export function registerBrowserIpc(): void {
  ipcMain.handle('browser:sync', (event, workspaceId: unknown, panelId: unknown, bounds: unknown, visible: unknown) =>
    manager().sync(windowNumberOf(event.sender), workspaceId, panelId, bounds, visible),
  )
  ipcMain.handle('browser:navigate', (event, workspaceId: unknown, panelId: unknown, action: unknown, url: unknown) =>
    manager().navigate(windowNumberOf(event.sender), workspaceId, panelId, action, url),
  )
  ipcMain.handle('browser:detach', (event, workspaceId: unknown, panelId: unknown) => {
    manager().detach(windowNumberOf(event.sender), workspaceId, panelId)
  })
}

export function closeAllBrowsers(): void {
  activeManager?.closeAll()
}
