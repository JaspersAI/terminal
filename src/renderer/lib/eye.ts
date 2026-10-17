import type { Note } from '../../shared/app/eye-events'
import * as state from './state'

// What this window tells Eye while it records: what was clicked, how much was typed into which
// field, and the errors the page met, its views' included. Never the characters typed, and never the
// text of anything but a control: a click names the button, link, or menu item it landed on, or the
// field it went into, so the contents of a cell or a view are never read. Main reads every note as
// untrusted input (`readNote`) and writes nothing while recording is off; nothing is sent then either.

/** How long typing into a field gathers before how much is said. Leaving the field says it at once. */
const TYPED_MS = 2000
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
  '[role=button]',
  '[role=link]',
  '[role=menuitem]',
  '[role=menuitemcheckbox]',
  '[role=menuitemradio]',
  '[role=tab]',
  '[role=option]',
  '[role=checkbox]',
  '[role=switch]',
].join(',')

/** Starts listening, once per window. */
export function watchUse(): void {
  document.addEventListener('click', clicked, { capture: true })
  document.addEventListener('input', typedInto, { capture: true })
  document.addEventListener('focusout', left, { capture: true })
  window.addEventListener('error', (event) => noteError('renderer', event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => noteError('renderer', event.reason))
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

function clicked(event: MouseEvent): void {
  if (!recording() || !(event.target instanceof Element)) return
  send({ kind: 'click', ...labelOf(event.target), x: event.clientX, y: event.clientY })
}

/** What a click landed on, by name: a `data-eye` name, a control's label or text, a field's name, or only the tag. */
function labelOf(target: Element): { name: string; role: string | null } {
  const named = target.closest('[data-eye]')
  if (named) return { name: named.getAttribute('data-eye') ?? '', role: named.getAttribute('role') }
  if (isField(target)) return { name: fieldName(target), role: target.tagName.toLowerCase() }
  const control = target.closest(CONTROL)
  if (!control) return { name: target.tagName.toLowerCase(), role: null }
  const name =
    control.getAttribute('aria-label') ||
    control.getAttribute('title') ||
    (control.textContent ?? '').replace(/\s+/g, ' ').trim() ||
    control.tagName.toLowerCase()
  return { name, role: control.getAttribute('role') ?? control.tagName.toLowerCase() }
}

const typed = new Map<Element, number>()
let typedTimer: number | null = null

function typedInto(event: Event): void {
  const field = event.target
  if (!recording() || !(field instanceof Element) || !isField(field)) return
  // A password field is not even counted.
  if (field instanceof HTMLInputElement && field.type === 'password') return
  const data = (event as InputEvent).data
  typed.set(field, (typed.get(field) ?? 0) + (typeof data === 'string' ? data.length : 1))
  typedTimer ??= window.setTimeout(flushTyped, TYPED_MS)
}

function left(event: FocusEvent): void {
  if (event.target instanceof Element && typed.has(event.target)) flushTyped()
}

function flushTyped(): void {
  if (typedTimer !== null) window.clearTimeout(typedTimer)
  typedTimer = null
  for (const [field, count] of typed) send({ kind: 'type', name: fieldName(field), count })
  typed.clear()
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
