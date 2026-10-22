import { ipcMain, session, WebContentsView, type BrowserWindow, type Session } from 'electron'
import { BROWSER_PARTITION, browserUserAgent, isBrowserUrl } from '../../shared/grid/browser'
import { PANEL_TEXT_MAX, panelOf } from '../../shared/grid/grid'
import { publishChecked, publishTextChecked, setPanelStateChecked } from '../actions'
import { getState, subscribe } from '../state'
import {
  createBrowserManager,
  type BrowserManager,
  type BrowserViewEvents,
  type ManagedBrowserView,
  type ManagedWindow,
} from './browser-manager'
import { findElement, focus } from './grid'
import { windowNumberOf, windowOf } from './windows'

// Electron's native `WebContentsView` backing for `core/browser` panels. Each tab runs in the
// persistent `persist:browser` session partition with sandboxed, context-isolated preferences and a
// clean Chrome User-Agent so user sign-ins persist across restarts without triggering bot blocks.

/** Only media playback and fullscreen are granted to browsed pages; camera, mic, geolocation, and device APIs are denied. */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'mediaKeySystem'])

const THEATER_SCRIPT = (theater: boolean): string => `
(() => {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const id = '__jaspers-theater-mode';
  let style = document.getElementById(id);
  if (${theater ? 'true' : 'false'}) {
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      style.textContent = \`
        video { max-width: 100% !important; }
        [class*="live-player"], [class*="video-player"], [data-component*="video"], #player-theater-container, #full-bleed-container {
          width: 100% !important;
          max-width: 100% !important;
          background: #000 !important;
        }
      \`;
      (document.head || document.documentElement).appendChild(style);
    }
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && !flexy.hasAttribute('theater')) {
      const btn = document.querySelector('.ytp-size-button');
      if (btn instanceof HTMLElement) btn.click();
      else flexy.setAttribute('theater', '');
    }
  } else {
    if (style) style.remove();
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && flexy.hasAttribute('theater')) {
      const btn = document.querySelector('.ytp-size-button');
      if (btn instanceof HTMLElement) btn.click();
      else flexy.removeAttribute('theater');
    }
  }
})()
`

const nativeViews = new WeakMap<ManagedBrowserView, WebContentsView>()
const watchedWindows = new WeakSet<BrowserWindow>()
let configuredSession: Session | null = null
let activeManager: BrowserManager | null = null

function browserSession(): Session {
  if (configuredSession) return configuredSession
  const partition = session.fromPartition(BROWSER_PARTITION)
  const cleanUa = browserUserAgent(partition.getUserAgent())
  if (cleanUa) partition.setUserAgent(cleanUa)
  partition.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  partition.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission))
  configuredSession = partition
  return partition
}

function createNativeView(events: BrowserViewEvents): ManagedBrowserView {
  const part = browserSession()
  const raw = new WebContentsView({
    webPreferences: {
      session: part,
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
  const cleanUa = browserUserAgent(webContents.getUserAgent())
  if (cleanUa) webContents.setUserAgent(cleanUa)

  webContents.on('will-attach-webview', (event) => event.preventDefault())
  webContents.on('will-navigate', (event) => {
    if (!isBrowserUrl(event.url)) event.preventDefault()
  })
  webContents.on('will-redirect', (event) => {
    if (!isBrowserUrl(event.url)) event.preventDefault()
  })
  // Additional browser windows open as switchable tabs inside the same browser panel rather than new windows or tiles.
  webContents.setWindowOpenHandler(({ url }) => {
    if (isBrowserUrl(url)) {
      setImmediate(() => events.onOpenWindow?.(url))
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
    setTheaterMode: (theater, url) => {
      if (webContents.isDestroyed()) return
      if (/youtube\.com|youtu\.be/i.test(url)) {
        void part.cookies
          .set({
            url: 'https://www.youtube.com',
            domain: '.youtube.com',
            name: 'wide',
            value: theater ? '1' : '0',
            path: '/',
          })
          .catch(() => undefined)
      }
      void webContents.executeJavaScript(THEATER_SCRIPT(theater), false).catch(() => undefined)
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
    publishPanel: (workspaceId, panelId, snapshot) => {
      try {
        const panel = panelOf(findElement(workspaceId, panelId).grid, panelId)
        const nextOutput = {
          url: snapshot.url,
          title: snapshot.title,
          loading: snapshot.loading,
          canGoBack: snapshot.canGoBack,
          canGoForward: snapshot.canGoForward,
          theater: snapshot.theater ?? false,
          tabCount: snapshot.tabCount ?? 1,
          error: snapshot.error,
        }
        if (JSON.stringify(panel.output) !== JSON.stringify(nextOutput)) {
          publishChecked(workspaceId, panelId, nextOutput)
        }
        if (panel.text !== snapshot.text) {
          publishTextChecked(workspaceId, panelId, snapshot.text)
        }
      } catch {
        // Panel was removed concurrently.
      }
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
