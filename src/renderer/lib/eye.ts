import { readNote, zoomKey, zoomWheel, type Note, type ZoomNoteName } from '../../shared/app/eye-events'
import * as state from './state'

// What this window tells Eye while it records: what was clicked, how much was typed into which
// field, zoom in and out, how a chart was played with, and the errors the page met, its views'
// included. Never the characters typed, and never the text of anything but a control: a click names
// the button, link, or menu item it landed on, or the field it went into, so the contents of a cell
// or a view are never read. Main reads every note as untrusted input (`readNote`) and writes nothing
// while recording is off; nothing is sent then either.

/** How long typing into a field gathers before how much is said. Leaving the field says it at once. */
const TYPED_MS = 2000
/** How long wheel/pinch zoom gathers before the gesture is said. */
const ZOOM_MS = 400
/** The same error again within this is the one already told. */
const REPEAT_MS = 10_000
/** Past this many a minute, a page in an error loop is not told any more of. */
const ERRORS_PER_MINUTE = 10

/** What counts as a control: what a click on is named by its label or its text. */
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

/** Starts listening, once per window. */
export function watchUse(): void {
  watchDocumentUse(send, recording)
  window.addEventListener('error', (event) => noteError('renderer', event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => noteError('renderer', event.reason))
}

/**
 * Watches a document (the main window's or a plugin view iframe's) for clicks, field typing counts,
 * and wheel/keyboard zoom gestures, handing each `Note` to `emit` when `enabled()` is true.
 */
export function watchDocumentUse(
  emit: (note: Note) => void,
  enabled: () => boolean = () => true,
  onZoomKey?: (dir: ZoomNoteName) => void,
): void {
  let lastRightClickAt = -Infinity

  const sendClick = (event: MouseEvent, button: number): void => {
    if (!enabled() || !(event.target instanceof Element)) return
    const detail = Math.max(1, event.detail || 1)
    emit({
      kind: 'click',
      ...labelOf(event.target),
      x: event.clientX,
      y: event.clientY,
      ...(button > 0 ? { button } : {}),
      ...(detail > 1 ? { detail } : {}),
      ...viewContextOf(event.target),
    })
  }

  document.addEventListener('click', (event) => sendClick(event, event.button), { capture: true })
  document.addEventListener(
    'auxclick',
    (event) => {
      // Right-click fires contextmenu as well; keep auxclick for middle/auxiliary buttons unless contextmenu did not fire.
      if (event.button === 2 && Date.now() - lastRightClickAt < 150) return
      sendClick(event, event.button)
    },
    { capture: true },
  )
  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!enabled()) return
      lastRightClickAt = Date.now()
      sendClick(event, 2)
    },
    { capture: true },
  )

  const typed = new Map<Element, { count: number; context: { view?: string; plugin?: string; panel?: string } }>()
  let typedTimer: number | null = null

  const flushTyped = (): void => {
    if (typedTimer !== null) window.clearTimeout(typedTimer)
    typedTimer = null
    for (const [field, { count, context }] of typed) {
      if (enabled()) emit({ kind: 'type', name: fieldName(field), count, ...context })
    }
    typed.clear()
  }

  document.addEventListener(
    'input',
    (event) => {
      const field = event.target
      if (!enabled() || !(field instanceof Element) || !isField(field)) return
      // A password field is not even counted.
      if (field instanceof HTMLInputElement && field.type === 'password') return
      const data = (event as InputEvent).data
      const prev = typed.get(field)
      typed.set(field, {
        count: (prev?.count ?? 0) + (typeof data === 'string' ? data.length : 1),
        context: prev?.context ?? viewContextOf(field),
      })
      typedTimer ??= window.setTimeout(flushTyped, TYPED_MS)
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

  let pendingZoom: { name: ZoomNoteName; context: { view?: string; plugin?: string; panel?: string } } | null = null
  let zoomTimer: number | null = null

  const flushZoom = (): void => {
    zoomTimer = null
    if (!pendingZoom) return
    const { name, context } = pendingZoom
    pendingZoom = null
    if (enabled()) emit({ kind: 'zoom', name, factor: window.devicePixelRatio, ...context })
  }

  document.addEventListener(
    'wheel',
    (event) => {
      if (!enabled()) return
      const dir = zoomWheel(event)
      if (!dir) return
      pendingZoom = {
        name: dir,
        context: event.target instanceof Element ? viewContextOf(event.target) : {},
      }
      if (zoomTimer !== null) window.clearTimeout(zoomTimer)
      zoomTimer = window.setTimeout(flushZoom, ZOOM_MS)
    },
    { capture: true, passive: true },
  )

  document.addEventListener(
    'keydown',
    (event) => {
      const dir = zoomKey(event)
      if (!dir) return
      if (onZoomKey) {
        event.preventDefault()
        onZoomKey(dir)
        return
      }
      if (!enabled()) return
      const context = event.target instanceof Element ? viewContextOf(event.target) : {}
      emit({ kind: 'zoom', name: dir, factor: window.devicePixelRatio, ...context })
    },
    { capture: true },
  )
}

/** Records a loop zoom change with the resulting zoom factor while recording is on. */
export function noteZoom(name: ZoomNoteName, factor: number, target: Element | null): void {
  if (!recording()) return
  send({ kind: 'zoom', name, factor, ...(target ? viewContextOf(target) : {}) })
}

function recording(): boolean {
  try {
    return state.get().eye.recording
  } catch {
    return false
  }
}

function send(note: Note): void {
  if (recording()) window.app.eye.note(note)
}

/** Which view and panel an element sits inside, when it is inside one on the grid. */
function viewContextOf(target: Element | null): { view?: string; plugin?: string; panel?: string } {
  const host = target?.closest('[data-eye-view]')
  if (!host) return {}
  const view = host.getAttribute('data-eye-view') || undefined
  const plugin = host.getAttribute('data-eye-plugin') || undefined
  const panel = host.getAttribute('data-eye-panel') || undefined
  return {
    ...(view ? { view } : {}),
    ...(plugin ? { plugin } : {}),
    ...(panel ? { panel } : {}),
  }
}

/** What a click landed on, by name: a `data-eye` name, a control's label or text, a field's name, or only the tag. */
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

/** Records a chart interaction (`zoom`, `legend`, `point`, `hover`) while recording is on. */
export function noteChart(note: Omit<Extract<Note, { kind: 'chart' }>, 'kind'>): void {
  if (!recording()) return
  send({ kind: 'chart', ...note })
}

/** Relays a click, type, or zoom note sent by a plugin view iframe, stamped with that view's identity. */
export function noteFromView(raw: unknown, where: { view: string; plugin: string; panel: string }): void {
  if (!recording() || typeof raw !== 'object' || raw === null) return
  const validated = readNote({ ...(raw as Record<string, unknown>), ...where })
  if (validated) send(validated)
}

function isField(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  )
}

/** A field by the name the app gave it, never by what is in it. */
function fieldName(field: Element): string {
  return (
    field.getAttribute('name') ||
    field.getAttribute('aria-label') ||
    field.id ||
    field.getAttribute('placeholder') ||
    field.tagName.toLowerCase()
  )
}

const told = new Map<string, number>()
let minuteAt = 0
let inMinute = 0

/**
 * An error this window met, or one of its plugin views did: told once per distinct message every
 * `REPEAT_MS`, and no more than `ERRORS_PER_MINUTE`, so a page failing in a loop is a few lines, not
 * thousands.
 */
export function noteError(name: 'renderer' | 'view', error: unknown, where?: { view: string; plugin: string }): void {
  if (!recording()) return
  // An Error here, or what a view's page sent for one: anything with a message and a stack.
  const said = typeof error === 'object' && error !== null ? (error as { message?: unknown; stack?: unknown }) : {}
  const message = typeof said.message === 'string' ? said.message : String(error)
  const stack = typeof said.stack === 'string' ? said.stack : null
  const now = Date.now()
  if ((told.get(message) ?? -Infinity) > now - REPEAT_MS) return
  if (told.size > 100) for (const [seen, at] of told) if (at <= now - REPEAT_MS) told.delete(seen)
  told.set(message, now)
  if (now - minuteAt > 60_000) {
    minuteAt = now
    inMinute = 0
  }
  if (++inMinute > ERRORS_PER_MINUTE) return
  send({ kind: 'error', name, message, stack, view: where?.view ?? null, plugin: where?.plugin ?? null })
}
