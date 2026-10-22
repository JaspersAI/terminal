import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react'
import { useData, usePanelState, usePublish, usePublishText } from '@jaspers-ai/sdk'
import {
  DEFAULT_BROWSER_URL,
  isVideoPageUrl,
  normalizeBrowserUrl,
  type BrowserAction,
  type BrowserBounds,
  type BrowserSnapshot,
  type BrowserTab,
} from '../../shared/grid/browser'
import { errorMessage } from '../lib/errors'
import { dispatch, useAppState } from '../lib/state'
import { displayAddress, publishedOutput, tabLabel, viewportVisible } from './browser-view'
import type { ViewProps } from './index'

// The built-in browser (`core/browser`). Renders a switchable tab bar, navigation chrome (including
// theater mode), and an inset viewport anchor element; main positions the active tab's partitioned
// native `WebContentsView` over the anchor so sites that refuse iframe embedding (such as Bloomberg
// Live TV) load and authenticate in a top-level browsing context while leaving the tile's resize
// edges uncovered.

const EMPTY_SNAPSHOT = (workspaceId: string, panelId: string, initialUrl: string): BrowserSnapshot => ({
  workspaceId,
  panelId,
  url: initialUrl,
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  theater: isVideoPageUrl(initialUrl),
  tabCount: 1,
  activeTabId: 't1',
  tabs: [
    {
      id: 't1',
      url: initialUrl,
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      theater: isVideoPageUrl(initialUrl),
      error: null,
    },
  ],
  error: null,
  text: null,
})

const NAV_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent'

export function Browser({ panel }: ViewProps): ReactElement {
  const [stateUrl] = usePanelState<string>(panel, 'url', DEFAULT_BROWSER_URL)
  const refreshedAt = useData(`workspaces/${panel.workspaceId}/panels/${panel.id}/refreshedAt`)
  const grids = useAppState((s) => s.grids[panel.workspaceId])
  const updateAvailable = useAppState((s) => (s.updates.status === 'ready' ? s.updates.available : null))

  const initialAddress = normalizeBrowserUrl(stateUrl) || DEFAULT_BROWSER_URL
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>(() =>
    EMPTY_SNAPSHOT(panel.workspaceId, panel.id, initialAddress),
  )
  const [draft, setDraft] = useState(() => initialAddress)
  const [editing, setEditing] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)

  const viewportRef = useRef<HTMLDivElement>(null)
  const lastSyncRef = useRef<string>('')

  const activeAddress = useMemo(() => displayAddress(stateUrl, snapshot), [stateUrl, snapshot])
  const output = useMemo(() => publishedOutput(stateUrl, snapshot), [stateUrl, snapshot])
  const tabs: BrowserTab[] = useMemo(
    () =>
      snapshot.tabs && snapshot.tabs.length > 0
        ? snapshot.tabs
        : [
            {
              id: 't1',
              url: activeAddress,
              title: snapshot.title,
              loading: snapshot.loading,
              canGoBack: snapshot.canGoBack,
              canGoForward: snapshot.canGoForward,
              theater: output.theater ?? false,
              error: snapshot.error,
            },
          ],
    [snapshot, activeAddress, output.theater],
  )
  const activeTabId = snapshot.activeTabId || tabs[0]!.id
  const theaterOn = output.theater === true

  usePublish(panel, output as unknown as Record<string, unknown>)
  usePublishText(panel, snapshot.text)

  useEffect(() => {
    setInputError(null)
  }, [stateUrl])

  useEffect(() => {
    if (!editing) setDraft(activeAddress)
  }, [activeAddress, editing])

  useEffect(
    () =>
      window.app.browser.onState((next) => {
        if (next.workspaceId === panel.workspaceId && next.panelId === panel.id) setSnapshot(next)
      }),
    [panel.workspaceId, panel.id],
  )

  const syncBounds = useCallback((): void => {
    const anchor = viewportRef.current
    if (!anchor) return
    const bounds = rectOf(anchor)
    const hasUrl = Boolean(normalizeBrowserUrl(stateUrl) || snapshot.url || DEFAULT_BROWSER_URL)
    const visible =
      hasUrl &&
      inputError === null &&
      viewportVisible({
        bounds,
        inert: anchor.closest('[inert]') !== null,
        modalOpen: document.querySelector('[aria-modal="true"]') !== null,
        dragging: document.querySelector('[data-grid-drag], #drag-ghost') !== null,
        overlays: collectOverlays(anchor),
      })
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height},${visible},${stateUrl},${String(refreshedAt ?? '')}`
    if (lastSyncRef.current === key) return
    lastSyncRef.current = key
    window.app.browser.sync(panel.workspaceId, panel.id, bounds, visible).then(
      (next) => setSnapshot(next),
      (err: unknown) =>
        setSnapshot((prev) => ({
          ...prev,
          loading: false,
          error: errorMessage(err),
        })),
    )
  }, [panel.workspaceId, panel.id, stateUrl, snapshot.url, refreshedAt, inputError])

  const syncRef = useRef(syncBounds)
  syncRef.current = syncBounds

  useLayoutEffect(() => {
    syncBounds()
  }, [syncBounds, grids])

  useEffect(() => {
    const anchor = viewportRef.current
    if (!anchor) return
    let frameId: number | null = null
    const schedule = (): void => {
      if (frameId !== null) return
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        syncRef.current()
      })
    }
    const resizeObserver = new ResizeObserver(() => syncRef.current())
    resizeObserver.observe(anchor)
    resizeObserver.observe(document.documentElement)

    const mutationObserver = new MutationObserver(schedule)
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['inert', 'aria-expanded', 'aria-modal', 'data-mode', 'style', 'class'],
    })

    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      lastSyncRef.current = ''
      void window.app.browser.detach(panel.workspaceId, panel.id).catch(() => undefined)
    }
  }, [panel.workspaceId, panel.id])

  function runAction(action: BrowserAction, targetUrl?: string): void {
    setInputError(null)
    window.app.browser.navigate(panel.workspaceId, panel.id, action, targetUrl).then(
      (next) => {
        setSnapshot(next)
        lastSyncRef.current = ''
        syncRef.current()
      },
      (err: unknown) => setInputError(errorMessage(err)),
    )
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const normalized = normalizeBrowserUrl(draft)
    if (normalized === null) {
      setInputError('Enter an https:// or http:// address.')
      return
    }
    const target = normalized || DEFAULT_BROWSER_URL
    setEditing(false)
    setDraft(target)
    runAction('load', target)
  }

  const shownError = inputError ?? snapshot.error
  const canOpenExternal = activeAddress.startsWith('https://')

  return (
    <div className="flex h-full w-full flex-col bg-background select-none">
      <div
        role="tablist"
        aria-label="Browser tabs"
        className="flex h-6 shrink-0 items-center overflow-x-auto border-b border-border bg-muted/40 px-1"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const label = tabLabel(tab)
          return (
            <div
              key={tab.id}
              className={`flex h-full max-w-48 min-w-20 shrink-0 items-center border-r border-border ${
                active ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={label}
                onClick={() => runAction('select-tab', tab.id)}
                className="flex h-full min-w-0 flex-1 items-center px-2 text-left text-xs"
              >
                <span className="truncate">{label}</span>
              </button>
              {tabs.length > 1 && (
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  title="Close tab"
                  onClick={() => runAction('close-tab', tab.id)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2 w-2 stroke-current stroke-[1.5]">
                    <path d="M2 2 8 8M8 2 2 8" />
                  </svg>
                </button>
              )}
            </div>
          )
        })}
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={() => runAction('new-tab')}
          className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
            <path d="M5 1.5v7M1.5 5h7" />
          </svg>
        </button>
      </div>
      <header className="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-background px-1.5">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          disabled={!snapshot.canGoBack}
          onClick={() => runAction('back')}
          className={NAV_BUTTON}
        >
          <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
            <path d="M6.5 1.5 3 5l3.5 3.5" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          disabled={!snapshot.canGoForward}
          onClick={() => runAction('forward')}
          className={NAV_BUTTON}
        >
          <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
            <path d="M3.5 1.5 7 5 3.5 8.5" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Reload"
          title="Reload"
          disabled={!activeAddress}
          onClick={() => runAction('reload')}
          className={NAV_BUTTON}
        >
          <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
            <path d="M8.5 5a3.5 3.5 0 1 1-1-2.5M8.5 1.5v2h-2" />
          </svg>
        </button>
        <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-1">
          <input
            type="text"
            aria-label="Address"
            spellCheck={false}
            autoComplete="off"
            value={draft}
            placeholder="Enter an https:// address…"
            onFocus={() => setEditing(true)}
            onBlur={() => {
              setEditing(false)
              setInputError(null)
            }}
            onChange={(event) => {
              setDraft(event.target.value)
              if (inputError) setInputError(null)
            }}
            className="h-5 min-w-0 flex-1 border border-border bg-muted px-2 font-mono text-xs text-foreground outline-none focus:border-foreground"
          />
        </form>
        {snapshot.loading && (
          <span
            aria-label="Loading"
            className="h-1.5 w-1.5 shrink-0 animate-dots bg-foreground motion-reduce:animate-none"
          />
        )}
        {updateAvailable && (
          <button
            type="button"
            aria-label={`Update browser to ${updateAvailable}`}
            title={`Restart to update browser (${updateAvailable})`}
            onClick={() => void dispatch({ type: 'updates.install' })}
            className="shrink-0 border border-primary px-1.5 py-0.5 text-[10px] text-primary hover:bg-muted"
          >
            Update {updateAvailable}
          </button>
        )}
        <button
          type="button"
          aria-label="Theater mode"
          aria-pressed={theaterOn}
          title={theaterOn ? 'Exit theater mode' : 'Theater mode'}
          onClick={() => runAction('toggle-theater')}
          className={`flex h-6 w-6 shrink-0 items-center justify-center ${
            theaterOn
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
            <rect x="1" y="2" width="8" height="6" />
          </svg>
        </button>
        {canOpenExternal && (
          <button
            type="button"
            aria-label="Open in browser"
            title="Open in default browser"
            onClick={() => void window.app.openExternal(activeAddress)}
            className={NAV_BUTTON}
          >
            <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
              <path d="M4 2H2v6h6V6M6 1.5h2.5V4M8.5 1.5 4.5 5.5" />
            </svg>
          </button>
        )}
      </header>
      {/* Inset by 6px on left, right, and bottom so the tile's 5px resize edges and corners stay uncovered by the native view. */}
      <div
        ref={viewportRef}
        data-browser-viewport={panel.id}
        className="relative mx-1.5 mb-1.5 min-h-0 flex-1 bg-background"
      >
        {shownError ? (
          <div className="flex h-full flex-col items-start justify-center gap-2 p-4 text-xs">
            <p className="text-destructive">{shownError}</p>
            {activeAddress && (
              <button
                type="button"
                onClick={() => runAction('reload')}
                className="border border-border px-2 py-1 text-foreground hover:bg-muted"
              >
                Try again
              </button>
            )}
          </div>
        ) : !activeAddress ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
            Enter a web address above or ask the assistant to open a page.
          </div>
        ) : null}
      </div>
    </div>
  )
}

function rectOf(element: Element): BrowserBounds {
  const box = element.getBoundingClientRect()
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.max(0, Math.round(box.width)),
    height: Math.max(0, Math.round(box.height)),
  }
}

/**
 * Collects bounding boxes of dropdown menus, popovers, and higher-z floating sibling tiles that sit
 * over this browser tile. The floating composer (superagent) is excluded so video playback remains
 * visible while chatting with the assistant.
 */
function collectOverlays(anchor: HTMLElement): BrowserBounds[] {
  const selectors = ['[role="menu"]', '[role="dialog"]', '[id^="element-"][data-mode="floating"]']
  const overlays: BrowserBounds[] = []
  for (const node of document.querySelectorAll(selectors.join(', '))) {
    if (node.contains(anchor) || anchor.contains(node)) continue
    if (node.id.startsWith('element-')) {
      const ownAtLevel = Array.from(node.parentElement?.children ?? []).find((child) => child.contains(anchor))
      if (!ownAtLevel) continue
      const nodeZ = Number((node as HTMLElement).style.zIndex || 0)
      const ownZ = Number((ownAtLevel as HTMLElement).style.zIndex || 0)
      if (nodeZ <= ownZ) continue
    }
    const bounds = rectOf(node)
    if (bounds.width > 0 && bounds.height > 0) overlays.push(bounds)
  }
  return overlays
}
