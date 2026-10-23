import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { BridgeProvider, PanelProvider, type PanelRef } from '@jaspers-ai/sdk'
import { createIframeBridge } from '@jaspers-ai/sdk/host'

// What runs in the iframe: the query says which view of which panel this frame is, the plugin's own
// bundle comes from the same origin, and its component mounts under a bridge that reaches the app
// over postMessage. Nothing else loads here, so anything that fails is written into the page.

/** A plugin's bundle, as far as this file cares: the definition its plugin.tsx exported. */
interface PluginModule {
  default?: { views?: Record<string, { component?: unknown }> }
}

export async function boot(): Promise<void> {
  // What goes wrong or is clicked, typed, or zoomed in the view is told to the page around it, which tells Eye while it records.
  window.addEventListener('error', (event) => tell(event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => tell(event.reason))
  watchFrameUse()
  const query = new URLSearchParams(location.search)
  const view = query.get('view') ?? ''
  const panel: PanelRef = { id: query.get('panel') ?? '', workspaceId: query.get('workspace') ?? '' }
  const root = document.getElementById('root')
  if (!root) return
  try {
    // Relative to this page, so it is the plugin's own bundle: jaspers-plugin://<id>/bundle.js.
    const loaded = (await import(new URL('bundle.js', location.href).href)) as PluginModule
    const component = loaded.default?.views?.[view]?.component as ComponentType<{ panel: PanelRef }> | undefined
    if (!component) throw new Error(`No view "${view}" in this plugin`)
    const Component = component
    createRoot(root).render(
      <BridgeProvider value={createIframeBridge()}>
        <PanelProvider value={panel}>
          <Component panel={panel} />
        </PanelProvider>
      </BridgeProvider>,
    )
  } catch (err) {
    root.textContent = err instanceof Error ? err.message : String(err)
    tell(err)
  }
}

function tell(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? null) : null
  window.parent.postMessage({ method: 'view.error', params: { message, stack } }, '*')
}

const CONTROL = [
  'button',
  'a[href]',
  'summary',
  'label',
  'select',
  'th',
  '[role=button]',
  '[role=link]',
  '[role=menuitem]',
  '[role=menuitemcheckbox]',
  '[role=menuitemradio]',
  '[role=tab]',
  '[role=option]',
  '[role=checkbox]',
  '[role=switch]',
  '[role=slider]',
].join(',')

function tellEye(params: Record<string, unknown>): void {
  window.parent.postMessage({ method: 'view.eye', params }, '*')
}

function watchFrameUse(): void {
  let lastRightAt = -Infinity
  const sendClick = (event: MouseEvent, button: number): void => {
    if (!(event.target instanceof Element)) return
    const detail = Math.max(1, event.detail || 1)
    tellEye({
      kind: 'click',
      ...labelOf(event.target),
      x: event.clientX,
      y: event.clientY,
      ...(button > 0 ? { button } : {}),
      ...(detail > 1 ? { detail } : {}),
    })
  }
  document.addEventListener('click', (event) => sendClick(event, event.button), { capture: true })
  document.addEventListener(
    'auxclick',
    (event) => {
      if (event.button === 2 && Date.now() - lastRightAt < 150) return
      sendClick(event, event.button)
    },
    { capture: true },
  )
  document.addEventListener(
    'contextmenu',
    (event) => {
      lastRightAt = Date.now()
      sendClick(event, 2)
    },
    { capture: true },
  )

  const typed = new Map<Element, number>()
  let typedTimer: number | null = null
  const flushTyped = (): void => {
    if (typedTimer !== null) window.clearTimeout(typedTimer)
    typedTimer = null
    for (const [field, count] of typed) tellEye({ kind: 'type', name: fieldName(field), count })
    typed.clear()
  }
  document.addEventListener(
    'input',
    (event) => {
      const field = event.target
      if (!(field instanceof Element) || !isField(field)) return
      if (field instanceof HTMLInputElement && field.type === 'password') return
      const data = (event as InputEvent).data
      typed.set(field, (typed.get(field) ?? 0) + (typeof data === 'string' ? data.length : 1))
      typedTimer ??= window.setTimeout(flushTyped, 2000)
    },
    { capture: true },
  )
  document.addEventListener(
    'focusout',
    (event) => {
      if (event.target instanceof Element && typed.has(event.target)) flushTyped()
    },
    { capture: true },
  )

  let zoomTimer: number | null = null
  let pendingZoom: 'in' | 'out' | null = null
  document.addEventListener(
    'wheel',
    (event) => {
      if ((!event.ctrlKey && !event.metaKey) || !Number.isFinite(event.deltaY) || event.deltaY === 0) return
      pendingZoom = event.deltaY < 0 ? 'in' : 'out'
      if (zoomTimer !== null) window.clearTimeout(zoomTimer)
      zoomTimer = window.setTimeout(() => {
        zoomTimer = null
        if (pendingZoom) tellEye({ kind: 'zoom', name: pendingZoom })
        pendingZoom = null
      }, 400)
    },
    { capture: true, passive: true },
  )
  document.addEventListener(
    'keydown',
    (event) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey) return
      const dir =
        event.key === '+' || event.key === '='
          ? 'in'
          : event.key === '-' || event.key === '_'
            ? 'out'
            : event.key === '0'
              ? 'reset'
              : null
      if (dir) tellEye({ kind: 'zoom', name: dir })
    },
    { capture: true },
  )
}

function isField(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  )
}

function fieldName(field: Element): string {
  return (
    field.getAttribute('name') ||
    field.getAttribute('aria-label') ||
    field.id ||
    field.getAttribute('placeholder') ||
    field.tagName.toLowerCase()
  )
}

function labelOf(target: Element): { name: string; role: string | null } {
  const named = target.closest('[data-eye]')
  if (named) return { name: named.getAttribute('data-eye') ?? '', role: named.getAttribute('role') }
  if (isField(target)) return { name: fieldName(target), role: target.tagName.toLowerCase() }
  const control = target.closest(CONTROL)
  if (control) {
    const name =
      control.getAttribute('aria-label') ||
      control.getAttribute('title') ||
      (control.textContent ?? '').replace(/\s+/g, ' ').trim() ||
      control.tagName.toLowerCase()
    return { name, role: control.getAttribute('role') ?? control.tagName.toLowerCase() }
  }
  const labelled = target.closest('[aria-label],[title]')
  if (labelled) {
    const name = labelled.getAttribute('aria-label') || labelled.getAttribute('title') || target.tagName.toLowerCase()
    return { name, role: labelled.getAttribute('role') ?? labelled.tagName.toLowerCase() }
  }
  return { name: target.tagName.toLowerCase(), role: target.getAttribute('role') }
}
