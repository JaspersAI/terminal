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
  normalizeBrowserUrl,
  type BrowserAction,
  type BrowserBounds,
  type BrowserSnapshot,
} from '../../shared/grid/browser'
import { errorMessage } from '../lib/errors'
import { useAppState } from '../lib/state'
import { displayAddress, publishedOutput, viewportVisible } from './browser-view'
import type { ViewProps } from './index'

// The built-in browser (`core/browser`). Renders navigation chrome and a viewport anchor element;
// main positions a partitioned native `WebContentsView` over the anchor so sites that refuse iframe
// embedding (such as Bloomberg Live TV) load and authenticate in a top-level browsing context.

const EMPTY_SNAPSHOT = (panelId: string): BrowserSnapshot => ({
  panelId,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  text: null,
})

const NAV_BUTTON =
  'flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent'

export function Browser({ panel }: ViewProps): ReactElement {
  const [stateUrl] = usePanelState<string>(panel, 'url', '')
  const refreshedAt = useData(`workspaces/${panel.workspaceId}/panels/${panel.id}/refreshedAt`)
  const currentWorkspaceId = useAppState((s) => s.currentWorkspaceId)
  const grids = useAppState((s) => s.grids[panel.workspaceId])
  const questions = useAppState((s) => s.questions)
  const secretRequests = useAppState((s) => s.secretRequests)
  const notices = useAppState((s) => s.notices)

  const [snapshot, setSnapshot] = useState<BrowserSnapshot>(() => EMPTY_SNAPSHOT(panel.id))
  const [draft, setDraft] = useState(() => normalizeBrowserUrl(stateUrl) ?? stateUrl)
  const [editing, setEditing] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)

  const viewportRef = useRef<HTMLDivElement>(null)
  const lastSyncRef = useRef<string>('')

  const activeAddress = useMemo(() => displayAddress(stateUrl, snapshot), [stateUrl, snapshot])
  const output = useMemo(() => publishedOutput(stateUrl, snapshot), [stateUrl, snapshot])

  usePublish(panel, output as unknown as Record<string, unknown>)
  usePublishText(panel, snapshot.text)

  useEffect(() => {
    if (!editing) setDraft(activeAddress)
  }, [activeAddress, editing])

  useEffect(
    () =>
      window.app.browser.onState((next) => {
        if (next.panelId === panel.id) setSnapshot(next)
      }),
    [panel.id],
  )

  const syncBounds = useCallback(
    (force = false): void => {
      const anchor = viewportRef.current
      if (!anchor) return
      const bounds = rectOf(anchor)
      const visible =
        Boolean(normalizeBrowserUrl(stateUrl)) &&
        inputError === null &&
        viewportVisible({
          bounds,
          inert: anchor.closest('[inert]') !== null,
          modalOpen: document.querySelector('[aria-modal="true"]') !== null,
          dragging: document.getElementById('drag-ghost') !== null,
          overlays: collectOverlays(anchor),
        })
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height},${visible},${stateUrl},${String(refreshedAt ?? '')}`
      if (!force && lastSyncRef.current === key) return
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
    },
    [panel.workspaceId, panel.id, stateUrl, refreshedAt, inputError],
  )

  useLayoutEffect(() => {
    syncBounds(true)
  }, [syncBounds, currentWorkspaceId, grids, questions, secretRequests, notices])

  useEffect(() => {
    const anchor = viewportRef.current
    if (!anchor) return
    let frameId: number | null = null
    const schedule = (): void => {
      if (frameId !== null) return
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        syncBounds(false)
      })
    }
    const resizeObserver = new ResizeObserver(() => syncBounds(false))
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
  }, [panel.workspaceId, panel.id, syncBounds])

  function runAction(action: BrowserAction, targetUrl?: string): void {
    setInputError(null)
    window.app.browser.navigate(panel.workspaceId, panel.id, action, targetUrl).then(
      (next) => {
        setSnapshot(next)
        lastSyncRef.current = ''
        syncBounds(true)
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
    setEditing(false)
    setDraft(normalized)
    runAction('load', normalized)
  }

  const shownError = inputError ?? snapshot.error
  const canOpenExternal = activeAddress.startsWith('https://')

  return (
    <div className="flex h-full w-full flex-col bg-background select-none">
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
            onBlur={() => setEditing(false)}
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
      <div ref={viewportRef} data-browser-viewport={panel.id} className="relative min-h-0 flex-1 bg-background">
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
 * Collects bounding boxes of floating UI layers that sit above grid tiles (menus, popovers, the
 * floating composer when open, and floating grid tiles other than this panel's own).
 */
function collectOverlays(anchor: HTMLElement): BrowserBounds[] {
  const ownTile = anchor.closest('[id^="element-"]')
  const selectors = [
    '[role="menu"]',
    '[role="dialog"]',
    '#slash-menu',
    '#composer > div:first-child:not([inert])',
    '#composer > div:nth-child(2):not(button)',
    '[id^="element-"][data-mode="floating"]',
  ]
  const overlays: BrowserBounds[] = []
  for (const node of document.querySelectorAll(selectors.join(', '))) {
    if (anchor.contains(node) || (ownTile && ownTile === node)) continue
    const bounds = rectOf(node)
    if (bounds.width > 0 && bounds.height > 0) overlays.push(bounds)
  }
  return overlays
}
