import {
  ipcMain,
  session,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
  type WebPreferences,
} from 'electron'
import { zoomKey } from '../../shared/app/eye-events'
import {
  BROWSER_PARTITION,
  browserRequestHeaders,
  browserUserAgent,
  browserUserAgentForUrl,
  isBlankBrowserPopupUrl,
  isBrowserUrl,
  type BrowserBounds,
} from '../../shared/grid/browser'
import { PANEL_TEXT_MAX, panelOf, stepZoom, tileZoom } from '../../shared/grid/grid'
import { publishChecked, publishTextChecked, setPanelStateChecked } from '../actions'
import { getState, subscribe } from '../state'
import {
  createBrowserLoadTracker,
  createBrowserManager,
  createBrowserUserAgentSync,
  type BrowserManager,
  type BrowserViewEvents,
  type ManagedBrowserView,
  type ManagedWindow,
} from './browser-manager'
import { changeZoom, findElement, focus } from './grid'
import { windowNumberOf, windowOf } from './windows'
import orbLogoDataUrl from '../../renderer/assets/jaspers-logo-black.png?inline'

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
  const w = window;
  if (${theater ? 'true' : 'false'}) {
    if (!style) {
      style = document.createElement('style');
      style.id = id;
      style.textContent = \`
        video {
          max-width: 100% !important;
          max-height: 100vh !important;
          object-fit: contain !important;
        }
        [class*="live-player"], [class*="video-player"], [data-component*="video"], #player-theater-container, #full-bleed-container {
          width: 100% !important;
          max-width: 100% !important;
          max-height: 100vh !important;
          min-height: 0 !important;
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
    if (!w.__jaspersTheaterResize) {
      w.__jaspersTheaterResize = () => {
        if (!document.getElementById(id)) return;
        const target =
          document.querySelector('#player-theater-container, #full-bleed-container, [class*="live-player"], [class*="video-player"], [data-component*="video"]') ||
          document.querySelector('video');
        if (target instanceof HTMLElement) {
          const rect = target.getBoundingClientRect();
          if (rect.height > 0 && (rect.top < -4 || rect.top > 4)) {
            window.scrollBy({ top: rect.top, behavior: 'instant' });
          }
        }
      };
      window.addEventListener('resize', w.__jaspersTheaterResize, { passive: true });
    }
  } else {
    if (style) style.remove();
    if (w.__jaspersTheaterResize) {
      window.removeEventListener('resize', w.__jaspersTheaterResize);
      delete w.__jaspersTheaterResize;
    }
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && flexy.hasAttribute('theater')) {
      const btn = document.querySelector('.ytp-size-button');
      if (btn instanceof HTMLElement) btn.click();
      else flexy.removeAttribute('theater');
    }
  }
})()
`

const BACKGROUND_MEDIA_SCRIPT = (backgrounded: boolean): string => `
(() => {
  if (typeof document === 'undefined') return;
  for (const el of document.querySelectorAll('video, audio')) {
    if (!(el instanceof HTMLMediaElement)) continue;
    const media = el;
    if (${backgrounded ? 'true' : 'false'}) {
      if (!media.paused) {
        media.__jaspersPaused = true;
        try { media.pause(); } catch {}
      }
    } else if (media.__jaspersPaused) {
      delete media.__jaspersPaused;
      try { void media.play()?.catch(() => {}); } catch {}
    }
  }
})()
`

const nativeViews = new WeakMap<ManagedBrowserView, WebContentsView>()
const watchedWindows = new WeakSet<BrowserWindow>()
const inFlightUrlsByWebContentsId = new Map<number, string>()
let configuredSession: Session | null = null
let activeManager: BrowserManager | null = null

interface OrbOverlayState {
  visible: boolean
  x: number
  y: number
  size: number
  phase: string
  logoSrc: string
}

interface OrbOverlayEntry {
  view: WebContentsView
  state: OrbOverlayState
  ready: boolean
  dragOrigin: { x: number; y: number } | null
}

const orbOverlays = new WeakMap<BrowserWindow, OrbOverlayEntry>()

function orbHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
    user-select: none;
    -webkit-user-select: none;
  }
  #orb {
    position: relative;
    width: 84px;
    height: 84px;
    border-radius: 9999px;
    overflow: hidden;
    cursor: pointer;
    background: #171717;
    box-sizing: border-box;
  }
  #orb.recording {
    box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.35);
  }
  #orb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
  }
  #gloss {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    pointer-events: none;
    background: radial-gradient(circle at 32% 26%, rgba(255,255,255,0.5), rgba(255,255,255,0.06) 42%, rgba(0,0,0,0) 70%);
    box-shadow: inset 0 -6px 10px rgba(255,255,255,0.14), inset 0 6px 10px rgba(255,255,255,0.2);
  }
</style>
</head>
<body>
  <div id="orb">
    <img id="logo" alt="" draggable="false" />
    <span id="gloss"></span>
  </div>
  <script>
    const orb = document.getElementById('orb');
    let drag = null;
    orb.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = { sx: e.screenX, sy: e.screenY, dragging: false };
      try { orb.setPointerCapture(e.pointerId); } catch {}
      console.log('__ORB__:' + JSON.stringify({ kind: 'down' }));
    });
    orb.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.screenX - drag.sx;
      const dy = e.screenY - drag.sy;
      if (!drag.dragging && Math.hypot(dx, dy) < 10) return;
      drag.dragging = true;
      console.log('__ORB__:' + JSON.stringify({ kind: 'move', dx, dy }));
    });
    const end = (e) => {
      if (!drag) return;
      const wasDragging = drag.dragging;
      drag = null;
      try { if (orb.hasPointerCapture(e.pointerId)) orb.releasePointerCapture(e.pointerId); } catch {}
      if (!wasDragging) console.log('__ORB__:' + JSON.stringify({ kind: 'click' }));
    };
    orb.addEventListener('pointerup', end);
    orb.addEventListener('pointercancel', () => { drag = null; });
    window.__updateOrb = (logoSrc, phase) => {
      const img = document.getElementById('logo');
      if (logoSrc && img.getAttribute('src') !== logoSrc) img.setAttribute('src', logoSrc);
      orb.className = phase === 'recording' ? 'recording' : '';
    };
  </script>
</body>
</html>`
}

function getOrCreateOrbOverlay(win: BrowserWindow): OrbOverlayEntry {
  let entry = orbOverlays.get(win)
  if (entry && !entry.view.webContents.isDestroyed()) return entry
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  entry = {
    view,
    state: { visible: false, x: 400, y: 500, size: 84, phase: 'idle', logoSrc: '' },
    ready: false,
    dragOrigin: null,
  }
  orbOverlays.set(win, entry)
  view.webContents.on('did-finish-load', () => {
    if (!entry) return
    entry.ready = true
    applyOrbVisuals(entry)
  })
  view.webContents.on('console-message', (event) => {
    const msg = event.message
    if (!msg.startsWith('__ORB__:')) return
    try {
      const payload = JSON.parse(msg.slice('__ORB__:'.length)) as {
        kind: 'down' | 'move' | 'click'
        dx?: number
        dy?: number
      }
      if (!entry || win.isDestroyed() || win.webContents.isDestroyed()) return
      if (payload.kind === 'down') {
        entry.dragOrigin = { x: entry.state.x, y: entry.state.y }
      } else if (payload.kind === 'move' && entry.dragOrigin) {
        const [winW = 1200, winH = 800] = win.getContentSize()
        const maxX = Math.max(16, winW - entry.state.size - 16)
        const maxY = Math.max(40, winH - entry.state.size - 32)
        const nextX = Math.max(16, Math.min(maxX, Math.round(entry.dragOrigin.x + (payload.dx ?? 0))))
        const nextY = Math.max(40, Math.min(maxY, Math.round(entry.dragOrigin.y + (payload.dy ?? 0))))
        entry.state.x = nextX
        entry.state.y = nextY
        entry.view.setBounds({ x: nextX, y: nextY, width: entry.state.size, height: entry.state.size })
        win.webContents.send('orb:pointer', { kind: 'move', x: nextX, y: nextY })
      } else if (payload.kind === 'click') {
        win.webContents.send('orb:pointer', { kind: 'click' })
      }
    } catch {
      // ignore malformed message
    }
  })
  void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(orbHtml())}`)
  win.once('closed', () => {
    if (!view.webContents.isDestroyed()) view.webContents.close()
  })
  return entry
}

function applyOrbVisuals(entry: OrbOverlayEntry): void {
  if (!entry.ready || entry.view.webContents.isDestroyed()) return
  const logoSrc = entry.state.logoSrc.startsWith('data:') ? entry.state.logoSrc : orbLogoDataUrl
  const { phase } = entry.state
  void entry.view.webContents
    .executeJavaScript(`window.__updateOrb && window.__updateOrb(${JSON.stringify(logoSrc)}, ${JSON.stringify(phase)})`)
    .catch(() => undefined)
}

function syncOrbInWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const entry = orbOverlays.get(win)
  if (!entry || entry.view.webContents.isDestroyed()) return
  const hasBrowserChildren = win.contentView.children.some((c) => c !== entry.view)
  if (entry.state.visible && hasBrowserChildren) {
    const children = win.contentView.children
    if (children[children.length - 1] !== entry.view) {
      win.contentView.addChildView(entry.view)
    }
    entry.view.setBounds({
      x: Math.round(entry.state.x),
      y: Math.round(entry.state.y),
      width: Math.round(entry.state.size),
      height: Math.round(entry.state.size),
    })
    entry.view.setVisible(true)
    applyOrbVisuals(entry)
  } else {
    entry.view.setVisible(false)
    if (win.contentView.children.includes(entry.view)) {
      win.contentView.removeChildView(entry.view)
    }
  }
}

function browserWebPreferences(part: Session): WebPreferences {
  return {
    session: part,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    backgroundThrottling: true,
    spellcheck: false,
  }
}

function browserSession(): Session {
  if (configuredSession) return configuredSession
  const partition = session.fromPartition(BROWSER_PARTITION)
  const rawUa = partition.getUserAgent()
  const cleanUa = browserUserAgent(rawUa)
  if (cleanUa) partition.setUserAgent(cleanUa)
  const fullChrome = process.versions.chrome || '136.0.0.0'
  partition.webRequest.onBeforeSendHeaders((details, callback) => {
    let pageUrl =
      details.webContentsId !== undefined ? inFlightUrlsByWebContentsId.get(details.webContentsId) : undefined
    if (!pageUrl && details.webContents && !details.webContents.isDestroyed()) {
      pageUrl = details.webContents.getURL()
    }
    const requestHeaders = browserRequestHeaders(details.requestHeaders, {
      url: details.url,
      referrer: details.referrer,
      resourceType: details.resourceType,
      pageUrl,
      baseUserAgent: cleanUa || rawUa,
      chromeVersion: fullChrome,
      platform: process.platform,
    })
    callback({ requestHeaders })
  })
  partition.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  partition.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission))
  configuredSession = partition
  return partition
}

function createNativeView(
  events: BrowserViewEvents,
  adoptedWebContents?: WebContents,
  initialUrl = '',
): ManagedBrowserView {
  const part = browserSession()
  const raw = adoptedWebContents
    ? new WebContentsView({ webContents: adoptedWebContents })
    : new WebContentsView({ webPreferences: browserWebPreferences(part) })
  raw.setVisible(false)
  let lastBounds: BrowserBounds | null = null
  let lastVisible = false
  let lastBackgrounded = false
  let appliedTheater = false
  let closedByManager = false
  const { webContents } = raw
  const baseUa = browserUserAgent(part.getUserAgent()) || webContents.getUserAgent()
  const startUa = browserUserAgentForUrl(initialUrl, baseUa, process.platform)
  if (startUa && webContents.getUserAgent() !== startUa) webContents.setUserAgent(startUa)

  const loadTracker = createBrowserLoadTracker(
    {
      isLoadingMainFrame: () => !webContents.isDestroyed() && webContents.isLoadingMainFrame(),
    },
    events,
  )

  const uaSync = createBrowserUserAgentSync(
    {
      getURL: () => (webContents.isDestroyed() ? '' : webContents.getURL()),
      getUserAgent: () => (webContents.isDestroyed() ? '' : webContents.getUserAgent()),
      setUserAgent: (ua) => {
        if (!webContents.isDestroyed()) webContents.setUserAgent(ua)
      },
      setCdpUserAgentOverride: (userAgent) => {
        if (webContents.isDestroyed()) return
        try {
          if (userAgent === '') {
            if (webContents.debugger.isAttached()) {
              webContents.debugger.detach()
            }
            return
          }
          if (!webContents.debugger.isAttached()) {
            webContents.debugger.attach('1.3')
          }
          void webContents.debugger.sendCommand('Emulation.setUserAgentOverride', { userAgent }).catch(() => {
            uaSync.onDebuggerDetach()
          })
        } catch {
          uaSync.onDebuggerDetach()
        }
      },
    },
    baseUa,
    process.platform,
  )
  webContents.debugger.on('detach', () => uaSync.onDebuggerDetach())

  webContents.on('will-attach-webview', (event) => event.preventDefault())
  webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument || !isBrowserUrl(details.url)) return
    inFlightUrlsByWebContentsId.set(webContents.id, details.url)
    uaSync.onDidStartNavigation(details.url, details.isMainFrame, details.isSameDocument)
    loadTracker.onDidStartNavigation(details.isMainFrame, details.isSameDocument)
    if (!isBrowserUrl(webContents.getURL())) events.onDidNavigate(details.url)
  })
  webContents.on('will-navigate', (event) => {
    if (!isBrowserUrl(event.url)) event.preventDefault()
  })
  webContents.on('will-redirect', (event) => {
    if (!isBrowserUrl(event.url)) {
      event.preventDefault()
      return
    }
    if (event.isMainFrame) {
      inFlightUrlsByWebContentsId.set(webContents.id, event.url)
      uaSync.onWillRedirect(event.url, event.isMainFrame)
    }
  })
  // Additional browser windows open as switchable tabs inside the same browser panel rather than new windows or tiles.
  // Adopting Chromium's child WebContents preserves window.opener and POST state for OAuth sign-in popups.
  webContents.setWindowOpenHandler(({ url }) => {
    if (!isBrowserUrl(url) && !isBlankBrowserPopupUrl(url)) {
      return { action: 'deny' }
    }
    return {
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: browserWebPreferences(part),
      },
      createWindow: (options) => {
        const guest = (options as { webContents?: WebContents }).webContents
        if (!guest) {
          if (isBrowserUrl(url)) {
            setImmediate(() => events.onOpenWindow?.(url))
          }
          return webContents
        }
        const opened = events.onOpenWindow?.(url, (childEvents) => createNativeView(childEvents, guest, url))
        if (!opened && !guest.isDestroyed()) {
          guest.close()
        }
        return guest
      },
    }
  })

  webContents.on('did-start-loading', () => loadTracker.onDidStartLoading())
  webContents.on('did-frame-finish-load', (_event, isMainFrame) => loadTracker.onDidFinishFrameLoad(isMainFrame))
  webContents.on('did-stop-loading', () => loadTracker.onDidStopLoading())
  webContents.on('did-navigate', (_event, url) => {
    inFlightUrlsByWebContentsId.delete(webContents.id)
    uaSync.onDidNavigate(url)
    events.onDidNavigate(url)
  })
  webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) events.onDidNavigate(url)
  })
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) {
      inFlightUrlsByWebContentsId.delete(webContents.id)
      uaSync.onDidFailLoad(isMainFrame)
      loadTracker.onDidFailLoad(isMainFrame)
    }
    events.onDidFailLoad(errorCode, errorDescription, isMainFrame)
  })
  webContents.on('page-title-updated', (_event, title) => events.onPageTitleUpdated(title))
  webContents.on('focus', () => events.onFocus())
  webContents.once('destroyed', () => {
    inFlightUrlsByWebContentsId.delete(webContents.id)
    if (!closedByManager) events.onClose?.()
  })
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const dir = zoomKey({
      key: input.key,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
    })
    if (!dir) return
    event.preventDefault()
    events.onZoom?.(dir)
  })

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
    isLoading: () => loadTracker.isLoading(),
    setBounds: (bounds) => {
      if (webContents.isDestroyed()) return
      if (
        lastBounds &&
        lastBounds.x === bounds.x &&
        lastBounds.y === bounds.y &&
        lastBounds.width === bounds.width &&
        lastBounds.height === bounds.height
      ) {
        return
      }
      lastBounds = { ...bounds }
      raw.setBounds(bounds)
    },
    setVisible: (visible) => {
      if (webContents.isDestroyed()) return
      if (lastVisible === visible) return
      lastVisible = visible
      if (!visible) lastBounds = null
      raw.setVisible(visible)
      webContents.setBackgroundThrottling(!visible || lastBackgrounded)
    },
    setBackgrounded: (backgrounded) => {
      if (webContents.isDestroyed() || lastBackgrounded === backgrounded) return
      lastBackgrounded = backgrounded
      webContents.setBackgroundThrottling(backgrounded || !lastVisible)
      webContents.setAudioMuted(backgrounded)
      if (isBrowserUrl(webContents.getURL())) {
        void webContents.executeJavaScript(BACKGROUND_MEDIA_SCRIPT(backgrounded), false).catch(() => undefined)
      }
    },
    setTheaterMode: (theater, url) => {
      if (webContents.isDestroyed()) return
      if (!theater && !appliedTheater) return
      appliedTheater = theater
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
    setZoomFactor: (zoom) => {
      if (webContents.isDestroyed() || Math.abs(webContents.getZoomFactor() - zoom) < 0.001) return
      webContents.setZoomFactor(zoom)
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
      closedByManager = true
      if (!webContents.isDestroyed()) {
        raw.setVisible(false)
        webContents.close()
      }
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
      if (!raw || win.isDestroyed() || raw.webContents.isDestroyed()) return
      if (!win.contentView.children.includes(raw)) win.contentView.addChildView(raw)
      syncOrbInWindow(win)
    },
    detach: (view) => {
      const raw = nativeViews.get(view)
      if (!raw || win.isDestroyed() || raw.webContents.isDestroyed()) return
      if (win.contentView.children.includes(raw)) win.contentView.removeChildView(raw)
      syncOrbInWindow(win)
    },
    sendState: (snapshot) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('browser:state', snapshot)
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
    zoomElement: (workspaceId, elementId, direction) => {
      try {
        const { grid } = findElement(workspaceId, elementId)
        changeZoom(workspaceId, elementId, stepZoom(tileZoom(grid, elementId), direction))
      } catch {
        // Element was removed concurrently.
      }
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
  ipcMain.on('orb:sync', (event, raw: unknown) => {
    const winNum = windowNumberOf(event.sender)
    if (winNum === null) return
    const win = windowOf(winNum)
    if (!win || win.isDestroyed()) return
    const payload = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<OrbOverlayState>
    if (!payload.visible && !orbOverlays.has(win)) return
    const entry = getOrCreateOrbOverlay(win)
    entry.state = {
      visible: Boolean(payload.visible),
      x: typeof payload.x === 'number' ? payload.x : entry.state.x,
      y: typeof payload.y === 'number' ? payload.y : entry.state.y,
      size: typeof payload.size === 'number' ? payload.size : 84,
      phase: typeof payload.phase === 'string' ? payload.phase : 'idle',
      logoSrc: typeof payload.logoSrc === 'string' ? payload.logoSrc : entry.state.logoSrc,
    }
    syncOrbInWindow(win)
  })
}

export function closeAllBrowsers(): void {
  activeManager?.closeAll()
}
