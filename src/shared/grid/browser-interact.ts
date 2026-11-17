// Structured interaction rules and isolated-world DOM scripts for `core/browser`.
// Pure TypeScript without Node or DOM imports so validation, key mapping, control formatting,
// and DOM target scripts can be unit-tested directly under Node's test runner.

import { BROWSER_VIEW, DEFAULT_BROWSER_URL, normalizeBrowserUrl } from './browser.ts'
import { panelOf, type Grid, type Panel } from './grid.ts'
import { elementTarget, frameOf, type Loop } from '../loops/loops.ts'

export interface BrowserPageControl {
  id?: unknown
  role?: unknown
  label?: unknown
  value?: unknown
  checked?: unknown
  inDialog?: unknown
}

export const MAX_BROWSER_CONTROLS = 80
export const MAX_BROWSER_CONTROL_LABEL = 120
export const MAX_BROWSER_CONTROL_VALUE = 80
export const MAX_BROWSER_TYPE_CHARS = 10_000

export const BROWSER_INTERACTION_ACTIONS = [
  'click',
  'type',
  'press',
  'scroll',
  'navigate',
  'back',
  'forward',
  'reload',
  'new_tab',
  'select_tab',
  'close_tab',
] as const

export type BrowserInteractionAction = (typeof BROWSER_INTERACTION_ACTIONS)[number]

export const BROWSER_SCROLL_DIRECTIONS = ['down', 'up', 'left', 'right', 'top', 'bottom'] as const

export type BrowserScrollDirection = (typeof BROWSER_SCROLL_DIRECTIONS)[number]

export interface BrowserTargetSpec {
  control?: string
  text?: string
  selector?: string
  x?: number
  y?: number
  index?: number
}

export type BrowserInteraction =
  | ({ action: 'click'; doubleClick?: boolean } & BrowserTargetSpec)
  | ({ action: 'type'; value: string; clear: boolean; submit: boolean } & BrowserTargetSpec)
  | { action: 'press'; key: string }
  | ({ action: 'scroll'; direction: BrowserScrollDirection; pixels: number } & BrowserTargetSpec)
  | { action: 'navigate'; url: string }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }
  | { action: 'new_tab'; url: string }
  | { action: 'select_tab'; tabId: string }
  | { action: 'close_tab'; tabId?: string }

export interface BrowserInteractionOutcome {
  detail: string
  x?: number
  y?: number
  role?: string
  label?: string
}

export interface BrowserKeySpec {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
  modifiers: number
  accelerator: string
}

const ACTION_ALIASES: Record<string, BrowserInteractionAction> = {
  load: 'navigate',
  goto: 'navigate',
  open: 'navigate',
  'new-tab': 'new_tab',
  'select-tab': 'select_tab',
  'switch-tab': 'select_tab',
  switch_tab: 'select_tab',
  'close-tab': 'close_tab',
}

const SCROLL_DIRECTION_SET = new Set<string>(BROWSER_SCROLL_DIRECTIONS)

/** Formats extracted interactive controls into a concise `Controls:` block for `panels/<id>/text`. */
export function formatBrowserControls(rawControls: readonly BrowserPageControl[] = []): string {
  if (rawControls.length === 0) return ''
  const lines: string[] = []
  const seenIds = new Set<string>()
  for (const item of rawControls) {
    if (!isRecord(item)) continue
    const id = normalizeControlId(item['id'])
    if (!id || seenIds.has(id)) continue
    const role = typeof item['role'] === 'string' && item['role'].trim() ? item['role'].trim() : 'button'
    const rawLabel = typeof item['label'] === 'string' ? item['label'].replace(/\s+/g, ' ').trim() : ''
    if (!rawLabel && role !== 'textbox' && role !== 'searchbox' && role !== 'combobox' && role !== 'password') {
      continue
    }
    seenIds.add(id)
    const label =
      rawLabel.length > MAX_BROWSER_CONTROL_LABEL
        ? `${rawLabel.slice(0, MAX_BROWSER_CONTROL_LABEL).trimEnd()}…`
        : rawLabel
    const notes: string[] = []
    if (role !== 'password' && typeof item['value'] === 'string') {
      const cleanVal = item['value'].replace(/\s+/g, ' ').trim()
      if (cleanVal) {
        const cappedVal =
          cleanVal.length > MAX_BROWSER_CONTROL_VALUE
            ? `${cleanVal.slice(0, MAX_BROWSER_CONTROL_VALUE).trimEnd()}…`
            : cleanVal
        notes.push(`value: ${JSON.stringify(cappedVal)}`)
      }
    }
    if (item['checked'] === true) notes.push('checked')
    if (item['inDialog'] === true) notes.push('in dialog')
    const labelPart = label ? ` ${JSON.stringify(label)}` : ''
    const notePart = notes.length > 0 ? ` (${notes.join(', ')})` : ''
    lines.push(`- [${id}] ${role}${labelPart}${notePart}`)
    if (lines.length >= MAX_BROWSER_CONTROLS) break
  }
  return lines.length > 0 ? ['Controls:', ...lines].join('\n') : ''
}

/** Extracts a concise body preview and control list from formatted `panels/<id>/text` output. */
export function extractBrowserTextSummary(
  formattedText: string | null,
  maxPreviewChars = 1_200,
  maxControls = 25,
): { textPreview?: string; controls?: string[] } {
  if (typeof formattedText !== 'string' || !formattedText.trim()) return {}
  let body = formattedText
  let controlsSection = ''

  const controlsIdx = findSectionHeading(body, 'Controls:')
  const linksIdx = findSectionHeading(body, 'Links:')

  if (controlsIdx >= 0) {
    const endIdx = linksIdx > controlsIdx ? linksIdx : body.length
    controlsSection = body.slice(controlsIdx + 'Controls:'.length, endIdx).trim()
    body = body.slice(0, controlsIdx).trim()
  } else if (linksIdx >= 0) {
    body = body.slice(0, linksIdx).trim()
  } else {
    body = body.trim()
  }

  const controls = controlsSection
    ? controlsSection
        .split('\n')
        .map((line) => line.replace(/^-\s*/, '').trim())
        .filter((line) => line.length > 0)
        .slice(0, maxControls)
    : []

  const textPreview =
    body.length > 0
      ? body.length > maxPreviewChars
        ? `${body.slice(0, maxPreviewChars).trimEnd()}…`
        : body
      : undefined

  return {
    ...(textPreview ? { textPreview } : {}),
    ...(controls.length > 0 ? { controls } : {}),
  }
}

function findSectionHeading(text: string, heading: string): number {
  if (text.startsWith(`${heading}\n`) || text === heading) return 0
  const marker = `\n\n${heading}`
  const idx = text.indexOf(marker)
  return idx >= 0 ? idx + 2 : -1
}

/** Normalizes a control identifier such as `"c1"` or `"[c1]"` to `"c1"`, or returns `null`. */
export function normalizeControlId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .trim()
    .toLowerCase()
  return /^c[1-9]\d*$/.test(cleaned) ? cleaned : null
}

function readTargetSpec(raw: Record<string, unknown>): BrowserTargetSpec {
  const spec: BrowserTargetSpec = {}
  if (raw['control'] !== undefined && raw['control'] !== null && String(raw['control']).trim() !== '') {
    const control = normalizeControlId(raw['control'])
    if (!control) {
      throw new Error('control must be a control id from Controls in panels/<id>/text, like "c1".')
    }
    spec.control = control
  }
  if (typeof raw['text'] === 'string' && raw['text'].trim() !== '') {
    spec.text = raw['text'].trim()
  }
  if (typeof raw['selector'] === 'string' && raw['selector'].trim() !== '') {
    spec.selector = raw['selector'].trim()
  }
  const hasX = raw['x'] !== undefined && raw['x'] !== null
  const hasY = raw['y'] !== undefined && raw['y'] !== null
  if (hasX || hasY) {
    if (!isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y']) || raw['x'] < 0 || raw['y'] < 0) {
      throw new Error('x and y must both be non-negative viewport coordinates in CSS pixels.')
    }
    spec.x = Math.round(raw['x'])
    spec.y = Math.round(raw['y'])
  }
  if (raw['index'] !== undefined && raw['index'] !== null) {
    if (typeof raw['index'] !== 'number' || !Number.isInteger(raw['index']) || raw['index'] < 0) {
      throw new Error('index must be a non-negative integer (0 for the first match).')
    }
    spec.index = raw['index']
  }
  return spec
}

function hasAnyTarget(spec: BrowserTargetSpec): boolean {
  return (
    spec.control !== undefined ||
    spec.text !== undefined ||
    spec.selector !== undefined ||
    (spec.x !== undefined && spec.y !== undefined)
  )
}

/** Validates and normalizes untrusted tool input into a `BrowserInteraction`. */
export function readBrowserInteraction(raw: unknown): BrowserInteraction {
  if (!isRecord(raw)) {
    throw new Error('Browser interaction input must be an object.')
  }
  const rawAction = typeof raw['action'] === 'string' ? raw['action'].trim().toLowerCase() : ''
  const mapped = ACTION_ALIASES[rawAction] ?? rawAction
  if (!(BROWSER_INTERACTION_ACTIONS as readonly string[]).includes(mapped)) {
    throw new Error(`action must be one of ${BROWSER_INTERACTION_ACTIONS.join(', ')}.`)
  }
  const action = mapped as BrowserInteractionAction

  switch (action) {
    case 'click': {
      const target = readTargetSpec(raw)
      if (!hasAnyTarget(target)) {
        throw new Error('Give control (like "c1"), text (like "Follow"), selector, or x and y to click.')
      }
      return {
        action: 'click',
        ...target,
        ...(raw['doubleClick'] === true ? { doubleClick: true } : {}),
      }
    }
    case 'type': {
      const target = readTargetSpec(raw)
      if (typeof raw['value'] !== 'string') {
        throw new Error('value must be the string to type into the field.')
      }
      if (raw['value'].length > MAX_BROWSER_TYPE_CHARS) {
        throw new Error(`value may not exceed ${MAX_BROWSER_TYPE_CHARS} characters.`)
      }
      const clear = typeof raw['clear'] === 'boolean' ? raw['clear'] : hasAnyTarget(target)
      const submit = raw['submit'] === true
      return {
        action: 'type',
        ...target,
        value: raw['value'],
        clear,
        submit,
      }
    }
    case 'press': {
      const spec = resolveBrowserKeySpec(raw['key'])
      if (!spec) {
        throw new Error(
          'key must be a key name like "Enter", "Escape", "Tab", "Space", "Backspace", "ArrowDown", or a single character.',
        )
      }
      return { action: 'press', key: typeof raw['key'] === 'string' ? raw['key'].trim() || 'Space' : spec.key }
    }
    case 'scroll': {
      const target = readTargetSpec(raw)
      const rawDir =
        typeof raw['direction'] === 'string' && raw['direction'].trim() ? raw['direction'].trim().toLowerCase() : 'down'
      if (!SCROLL_DIRECTION_SET.has(rawDir)) {
        throw new Error(`direction must be one of ${BROWSER_SCROLL_DIRECTIONS.join(', ')}.`)
      }
      const rawPixels = raw['pixels']
      let pixels = 500
      if (rawPixels !== undefined && rawPixels !== null) {
        if (!isFiniteNumber(rawPixels) || rawPixels <= 0) {
          throw new Error('pixels must be a positive number.')
        }
        pixels = Math.min(4_000, Math.max(20, Math.round(rawPixels)))
      }
      return {
        action: 'scroll',
        ...target,
        direction: rawDir as BrowserScrollDirection,
        pixels,
      }
    }
    case 'navigate': {
      const normalized = normalizeBrowserUrl(raw['url'])
      if (!normalized) {
        throw new Error('url must be an https:// or http:// address.')
      }
      return { action: 'navigate', url: normalized }
    }
    case 'new_tab': {
      if (raw['url'] === undefined || raw['url'] === null || String(raw['url']).trim() === '') {
        return { action: 'new_tab', url: DEFAULT_BROWSER_URL }
      }
      const normalized = normalizeBrowserUrl(raw['url'])
      if (!normalized) {
        throw new Error('url must be an https:// or http:// address.')
      }
      return { action: 'new_tab', url: normalized }
    }
    case 'select_tab': {
      const tabId = typeof raw['tabId'] === 'string' ? raw['tabId'].trim() : ''
      if (!tabId) {
        throw new Error('tabId is required for select_tab, like "t2".')
      }
      return { action: 'select_tab', tabId }
    }
    case 'close_tab': {
      const tabId = typeof raw['tabId'] === 'string' && raw['tabId'].trim() ? raw['tabId'].trim() : undefined
      return { action: 'close_tab', ...(tabId ? { tabId } : {}) }
    }
    case 'back':
      return { action: 'back' }
    case 'forward':
      return { action: 'forward' }
    case 'reload':
      return { action: 'reload' }
  }
}

interface NamedKey {
  key: string
  code: string
  vk: number
  text?: string
  accelerator: string
}

const NAMED_KEYS: Record<string, NamedKey> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r', accelerator: 'Enter' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r', accelerator: 'Enter' },
  escape: { key: 'Escape', code: 'Escape', vk: 27, accelerator: 'Escape' },
  esc: { key: 'Escape', code: 'Escape', vk: 27, accelerator: 'Escape' },
  tab: { key: 'Tab', code: 'Tab', vk: 9, accelerator: 'Tab' },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ', accelerator: 'Space' },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8, accelerator: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete', vk: 46, accelerator: 'Delete' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38, accelerator: 'Up' },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38, accelerator: 'Up' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40, accelerator: 'Down' },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40, accelerator: 'Down' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37, accelerator: 'Left' },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37, accelerator: 'Left' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39, accelerator: 'Right' },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39, accelerator: 'Right' },
  home: { key: 'Home', code: 'Home', vk: 36, accelerator: 'Home' },
  end: { key: 'End', code: 'End', vk: 35, accelerator: 'End' },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33, accelerator: 'PageUp' },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34, accelerator: 'PageDown' },
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
}

/** Resolves a key name or chord (such as `"Enter"`, `"Escape"`, `"Shift+Tab"`, or `"/"`) into CDP key metadata. */
export function resolveBrowserKeySpec(rawKey: unknown): BrowserKeySpec | null {
  if (typeof rawKey !== 'string') return null
  if (rawKey === ' ') {
    const sp = NAMED_KEYS['space']!
    return {
      key: sp.key,
      code: sp.code,
      windowsVirtualKeyCode: sp.vk,
      text: sp.text,
      modifiers: 0,
      accelerator: sp.accelerator,
    }
  }
  const trimmed = rawKey.trim()
  if (!trimmed) return null

  const parts =
    trimmed === '+'
      ? ['+']
      : trimmed
          .split('+')
          .map((p) => p.trim())
          .filter(Boolean)
  if (parts.length === 0) return null

  let modifiers = 0
  for (let i = 0; i < parts.length - 1; i++) {
    const bit = MODIFIER_BITS[parts[i]!.toLowerCase()]
    if (bit === undefined) return null
    modifiers |= bit
  }

  const main = parts[parts.length - 1]!
  const named = NAMED_KEYS[main.toLowerCase()]
  if (named) {
    return {
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      ...(named.text && (modifiers & 6) === 0 ? { text: named.text } : {}),
      modifiers,
      accelerator: named.accelerator,
    }
  }

  const chars = Array.from(main)
  if (chars.length !== 1) return null
  const ch = chars[0]!
  const upper = ch.toUpperCase()
  const isLetter = /^[A-Z]$/.test(upper)
  const isDigit = /^[0-9]$/.test(ch)
  const code = isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : ''
  const vk = isLetter || isDigit ? upper.charCodeAt(0) : ch.charCodeAt(0)
  const effectiveModifiers = isLetter && ch === upper && ch !== ch.toLowerCase() ? modifiers | 8 : modifiers
  const hasShortcutMod = (effectiveModifiers & 6) !== 0
  return {
    key: ch,
    code,
    windowsVirtualKeyCode: vk,
    ...(!hasShortcutMod ? { text: ch } : {}),
    modifiers: effectiveModifiers,
    accelerator: ch,
  }
}

const BROWSER_DOM_HELPERS = `
  const CONTROL_SELECTOR = [
    'button',
    'input',
    'textarea',
    'select',
    'summary',
    'a',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
  ].join(', ');

  const normSpace = (s) => String(s || '').replace(/\\s+/g, ' ').trim();

  const capLabel = (s, max = ${MAX_BROWSER_CONTROL_LABEL}) => {
    const clean = normSpace(s);
    if (!clean) return '';
    return clean.length > max ? clean.slice(0, max).trimEnd() + '…' : clean;
  };

  const isVisible = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isConnected === false) return false;
    if (typeof el.closest === 'function' && el.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
    const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(el)
      : null;
    if (style) {
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (style.pointerEvents === 'none') return false;
      const op = parseFloat(style.opacity || '1');
      if (!Number.isNaN(op) && op <= 0.01) return false;
    }
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
    return true;
  };

  const isDisabled = (el) => {
    if (!el) return true;
    if (el.disabled === true) return true;
    const aria = typeof el.getAttribute === 'function' ? el.getAttribute('aria-disabled') : null;
    return aria === 'true';
  };

  const isFileInput = (el) => {
    return Boolean(el && String(el.tagName || '').toUpperCase() === 'INPUT' && String(el.type || '').toLowerCase() === 'file');
  };

  const isHiddenInput = (el) => {
    return Boolean(el && String(el.tagName || '').toUpperCase() === 'INPUT' && String(el.type || '').toLowerCase() === 'hidden');
  };

  const isEditable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return !isDisabled(el);
    if (tag === 'INPUT') {
      const t = String(el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image'].includes(t)) return false;
      return !isDisabled(el) && !el.readOnly;
    }
    const ce = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
    return Boolean(el.isContentEditable || ce === '' || ce === 'true');
  };

  const findOpenDialog = () => {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    const dialogs = Array.from(
      document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]'),
    ).filter((d) => isVisible(d));
    return dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
  };

  const controlRole = (el) => {
    if (!el || el === document.body || el === document.documentElement) return 'page';
    const explicit = normSpace(typeof el.getAttribute === 'function' ? el.getAttribute('role') : '').toLowerCase();
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'A') return 'link';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = String(el.type || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'password') return 'password';
      return 'textbox';
    }
    const ce = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null;
    if (el.isContentEditable || ce === '' || ce === 'true') return 'textbox';
    return tag ? tag.toLowerCase() : 'element';
  };

  const readLabelledBy = (el) => {
    if (typeof el.getAttribute !== 'function' || typeof document.getElementById !== 'function') return '';
    const ids = normSpace(el.getAttribute('aria-labelledby'));
    if (!ids) return '';
    return ids
      .split(' ')
      .map((id) => {
        const ref = document.getElementById(id);
        return ref ? normSpace(ref.innerText || ref.textContent || '') : '';
      })
      .filter(Boolean)
      .join(' ');
  };

  const readAssociatedLabels = (el) => {
    const parts = [];
    if (el.labels && el.labels.length > 0) {
      for (const lbl of Array.from(el.labels)) {
        const txt = normSpace(lbl.innerText || lbl.textContent || '');
        if (txt) parts.push(txt);
      }
    } else if (el.id && typeof document.querySelectorAll === 'function') {
      for (const lbl of Array.from(document.querySelectorAll('label[for]'))) {
        if (lbl.getAttribute('for') === el.id) {
          const txt = normSpace(lbl.innerText || lbl.textContent || '');
          if (txt) parts.push(txt);
        }
      }
    }
    if (parts.length === 0 && typeof el.closest === 'function') {
      const wrapping = el.closest('label');
      if (wrapping) {
        const txt = normSpace(wrapping.innerText || wrapping.textContent || '');
        if (txt) parts.push(txt);
      }
    }
    return parts.join(' ');
  };

  const humanizeTestId = (raw) => {
    const cleaned = normSpace(raw);
    if (!cleaned) return '';
    return cleaned
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
  };

  const candidateLabels = (el) => {
    if (!el || el === document.body || el === document.documentElement) {
      return { primary: '', all: [] };
    }
    const tag = String(el.tagName || '').toUpperCase();
    const isInputLike = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const inputType = tag === 'INPUT' ? String(el.type || 'text').toLowerCase() : '';
    const isButtonInput = tag === 'INPUT' && ['button', 'submit', 'reset', 'image'].includes(inputType);

    const ariaLabel = normSpace(typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : '');
    const labelledBy = readLabelledBy(el);
    const assocLabel = isInputLike && !isButtonInput ? readAssociatedLabels(el) : '';
    const inner = !isInputLike ? normSpace(el.innerText || el.textContent || '') : '';
    const buttonVal = isButtonInput ? normSpace(el.value || '') : '';
    const placeholder = normSpace(typeof el.getAttribute === 'function' ? el.getAttribute('placeholder') : '');
    const title = normSpace(typeof el.getAttribute === 'function' ? el.getAttribute('title') : '');
    const imgAlt = typeof el.querySelector === 'function'
      ? normSpace(el.querySelector('img[alt]')?.getAttribute('alt') || '')
      : '';
    const nameAttr = isInputLike ? normSpace(typeof el.getAttribute === 'function' ? el.getAttribute('name') : '') : '';
    const testId = typeof el.getAttribute === 'function' ? humanizeTestId(el.getAttribute('data-testid')) : '';

    const rawPrimary = ariaLabel || labelledBy || assocLabel || inner || buttonVal || placeholder || title || imgAlt || nameAttr || testId;
    const primary = capLabel(rawPrimary);
    const all = [ariaLabel, labelledBy, assocLabel, inner, buttonVal, placeholder, title, imgAlt, nameAttr, testId].filter(Boolean);
    return { primary, all };
  };

  const getControlState = (minNextSeq) => {
    const w = typeof window !== 'undefined' ? window : globalThis;
    let state = w.__jaspersControlState;
    if (!state || typeof state !== 'object') {
      state = {
        elementIds: new WeakMap(),
        byId: new Map(),
        nextSeq: 0,
      };
      w.__jaspersControlState = state;
    }
    if (typeof minNextSeq === 'number' && Number.isFinite(minNextSeq) && minNextSeq > state.nextSeq) {
      state.nextSeq = Math.floor(minNextSeq);
    }
    if (state.byId.size > 500) {
      for (const [key, ref] of state.byId.entries()) {
        const node = ref && typeof ref.deref === 'function' ? ref.deref() : null;
        if (!node || node.isConnected === false) state.byId.delete(key);
      }
    }
    return state;
  };

  const isNavigableHttpAnchor = (el) => {
    if (String(el.tagName || '').toUpperCase() !== 'A') return false;
    const rawHref = normSpace(typeof el.getAttribute === 'function' ? el.getAttribute('href') : '');
    if (!rawHref || rawHref.startsWith('#') || /^(?:javascript|mailto|tel|data|blob|file|about):/i.test(rawHref)) return false;
    const url = String(el.href || '');
    return url.startsWith('https://') || url.startsWith('http://');
  };

  const collectControls = (maxCount, minNextSeq) => {
    const w = typeof window !== 'undefined' ? window : globalThis;
    const state = getControlState(minNextSeq);
    const dialog = findOpenDialog();
    const rawNodes = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll(CONTROL_SELECTOR))
      : [];
    const acceptedElements = [];
    const items = [];

    for (const el of rawNodes) {
      if (isHiddenInput(el) || isFileInput(el) || isDisabled(el) || !isVisible(el)) continue;
      const inDialog = Boolean(dialog && typeof dialog.contains === 'function' && dialog.contains(el));
      const explicitRole = normSpace(typeof el.getAttribute === 'function' ? el.getAttribute('role') : '').toLowerCase();
      if (isNavigableHttpAnchor(el) && !inDialog && (!explicitRole || explicitRole === 'link')) {
        continue;
      }
      const tag = String(el.tagName || '').toUpperCase();
      const distinctTag = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (!distinctTag && acceptedElements.some((prev) => typeof prev.contains === 'function' && prev.contains(el))) {
        continue;
      }
      const role = controlRole(el);
      const labels = candidateLabels(el);
      if (!labels.primary && role !== 'textbox' && role !== 'searchbox' && role !== 'combobox' && role !== 'password') {
        continue;
      }
      const rect = el.getBoundingClientRect();
      const vh = (w && w.innerHeight) || 800;
      const vw = (w && w.innerWidth) || 1280;
      const inViewport = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;

      let value = '';
      if (role !== 'password') {
        if (tag === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'image'].includes(String(el.type || 'text').toLowerCase())) {
          value = normSpace(el.value || '');
        } else if (tag === 'TEXTAREA') {
          value = normSpace(el.value || '');
        } else if (tag === 'SELECT') {
          const opt = el.selectedOptions && el.selectedOptions[0];
          value = normSpace((opt && (opt.textContent || opt.value)) || el.value || '');
        } else if (el.isContentEditable || (typeof el.getAttribute === 'function' && el.getAttribute('contenteditable') === 'true')) {
          value = normSpace(el.innerText || el.textContent || '');
        }
      }
      const ariaChecked = typeof el.getAttribute === 'function' ? el.getAttribute('aria-checked') : null;
      const checked = el.checked === true || ariaChecked === 'true';

      acceptedElements.push(el);
      items.push({ el, role, label: labels.primary, allLabels: labels.all, value, checked, inDialog, inViewport });
    }

    items.sort((a, b) => {
      if (a.inDialog !== b.inDialog) return a.inDialog ? -1 : 1;
      if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
      return 0;
    });

    const limited = typeof maxCount === 'number' && maxCount > 0 ? items.slice(0, maxCount) : items;
    const serialized = limited.map((item) => {
      let id = state.elementIds.get(item.el);
      if (!id) {
        id = 'c' + (++state.nextSeq);
        state.elementIds.set(item.el, id);
        state.byId.set(id, typeof WeakRef === 'function' ? new WeakRef(item.el) : { deref: () => item.el });
      }
      return {
        id,
        role: item.role,
        label: item.label,
        ...(item.value ? { value: item.value } : {}),
        ...(item.checked ? { checked: true } : {}),
        ...(item.inDialog ? { inDialog: true } : {}),
      };
    });
    return { items, serialized, state };
  };
`

/**
 * Isolated-world script that reads a `core/browser` page's visible text, navigable `http(s)` links,
 * and visible interactive controls without mutating page DOM attributes or reading password values.
 * Control ids stick to their DOM elements via a `WeakMap` and advance monotonically from `minNextSeq`.
 */
export function browserReadPageScript(maxControls = MAX_BROWSER_CONTROLS, minNextSeq = 0): string {
  const safeMax = Math.max(1, Math.floor(maxControls))
  const safeMinSeq = Math.max(0, Math.floor(minNextSeq))
  return `(() => {
  if (typeof document === 'undefined' || !document.body) return { text: '', links: [], controls: [], nextControlSeq: ${safeMinSeq} };
  ${BROWSER_DOM_HELPERS}
  const text = document.body.innerText || '';
  const links = [];
  for (const el of document.querySelectorAll('a[href]')) {
    const rawHref = normSpace(el.getAttribute('href'));
    if (!rawHref || rawHref.startsWith('#') || /^(?:javascript|mailto|tel|data|blob|file|about):/i.test(rawHref)) continue;
    const url = String(el.href || '');
    if (!url.startsWith('https://') && !url.startsWith('http://')) continue;
    if (!isVisible(el)) continue;
    const imgAlt = el.querySelector?.('img[alt]')?.getAttribute('alt') || '';
    const label = normSpace(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || imgAlt || '');
    if (!label) continue;
    links.push({ text: label, url });
  }
  const { serialized, state } = collectControls(${safeMax}, ${safeMinSeq});
  return { text, links, controls: serialized, nextControlSeq: state.nextSeq };
})()`
}

export interface BrowserResolveScriptOptions {
  mode: 'click' | 'type' | 'scroll'
  target: BrowserTargetSpec
  selectValue?: string
  minNextSeq?: number
}

/**
 * Isolated-world script that resolves a target element or coordinate, scrolls it into view, verifies
 * it is unobstructed in the viewport, and returns CSS pixel coordinates for native input dispatch.
 */
export function browserResolveTargetScript(options: BrowserResolveScriptOptions): string {
  const payload = JSON.stringify(options)
  return `(() => {
  if (typeof document === 'undefined' || !document.body) {
    return { ok: false, error: 'Page has no document body yet.' };
  }
  const opts = ${payload};
  const target = opts.target || {};
  const w = typeof window !== 'undefined' ? window : globalThis;
  ${BROWSER_DOM_HELPERS}

  const vw = () => Math.max(1, Number(w.innerWidth) || 1280);
  const vh = () => Math.max(1, Number(w.innerHeight) || 800);

  const INTERACTIVE_WRAPPER_SELECTOR =
    'button, a, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]';

  const isSameControl = (hit, el) => {
    if (!hit || !el) return false;
    if (hit === el) return true;
    if (typeof el.contains === 'function' && el.contains(hit)) return true;
    if (
      hit !== document.body &&
      hit !== document.documentElement &&
      typeof hit.contains === 'function' &&
      hit.contains(el) &&
      typeof hit.matches === 'function' &&
      hit.matches(INTERACTIVE_WRAPPER_SELECTOR)
    ) {
      return true;
    }
    if (typeof hit.closest === 'function') {
      const hitLabel = hit.closest('label');
      if (hitLabel && ((typeof hitLabel.contains === 'function' && hitLabel.contains(el)) || (el.id && hitLabel.getAttribute('for') === el.id))) {
        return true;
      }
    }
    return false;
  };

  const hitTestElement = (el, scrollFirst) => {
    if (scrollFirst && typeof el.scrollIntoView === 'function') {
      const r0 = el.getBoundingClientRect();
      if (r0.top < 4 || r0.bottom > vh() - 4 || r0.left < 4 || r0.right > vw() - 4) {
        try {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        } catch {
          try { el.scrollIntoView(true); } catch {}
        }
      }
    }
    const rawRects = typeof el.getClientRects === 'function' ? Array.from(el.getClientRects()) : [];
    const rects = rawRects.filter((r) => r.width >= 2 && r.height >= 2);
    const baseRect = rects[0] || el.getBoundingClientRect();
    if (!baseRect || baseRect.width < 1 || baseRect.height < 1) {
      return { ok: false, obstructed: false, error: 'Target element has zero visible size.' };
    }
    const ratios = [
      [0.5, 0.5],
      [0.3, 0.5],
      [0.7, 0.5],
      [0.5, 0.3],
      [0.5, 0.7],
    ];
    let sawVisibleSlice = false;
    let lastBlocker = null;
    for (const r of rects.length > 0 ? rects : [baseRect]) {
      const left = Math.max(1, r.left);
      const right = Math.min(vw() - 1, r.right);
      const top = Math.max(1, r.top);
      const bottom = Math.min(vh() - 1, r.bottom);
      if (right <= left || bottom <= top) continue;
      sawVisibleSlice = true;
      for (const [rx, ry] of ratios) {
        const px = Math.round(left + (right - left) * rx);
        const py = Math.round(top + (bottom - top) * ry);
        if (typeof document.elementFromPoint !== 'function') {
          return { ok: true, x: px, y: py };
        }
        const hit = document.elementFromPoint(px, py);
        if (!hit || isSameControl(hit, el)) {
          return { ok: true, x: px, y: py };
        }
        lastBlocker = hit;
      }
    }
    if (!sawVisibleSlice) {
      return {
        ok: false,
        offscreen: true,
        error: 'Target control is outside the visible viewport.',
      };
    }
    const blockerRole = lastBlocker ? controlRole(lastBlocker) : 'overlay';
    const blockerDialog = lastBlocker && typeof lastBlocker.closest === 'function'
      ? lastBlocker.closest('dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]')
      : null;
    const blockerDesc = blockerDialog ? 'an open dialog or modal' : blockerRole;
    return {
      ok: false,
      obstructed: true,
      x: Math.max(1, Math.min(vw() - 1, Math.round(baseRect.left + baseRect.width / 2))),
      y: Math.max(1, Math.min(vh() - 1, Math.round(baseRect.top + baseRect.height / 2))),
      error: 'Target control is covered by ' + blockerDesc + '; interact with or dismiss the covering element first.',
    };
  };

  // Explicit coordinates
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    const px = Math.max(0, Math.min(vw() - 1, Math.round(target.x)));
    const py = Math.max(0, Math.min(vh() - 1, Math.round(target.y)));
    const rawHit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(px, py) : null;
    const hitControl = rawHit && typeof rawHit.closest === 'function' ? rawHit.closest(CONTROL_SELECTOR) : null;
    if ((rawHit && isFileInput(rawHit)) || (hitControl && isFileInput(hitControl))) {
      return { ok: false, error: 'File upload inputs cannot be clicked by the assistant.' };
    }
    if (hitControl) {
      const labels = candidateLabels(hitControl);
      const role = controlRole(hitControl);
      return {
        ok: true,
        x: px,
        y: py,
        role,
        label: labels.primary,
        editable: isEditable(hitControl),
        nextControlSeq: getControlState(opts.minNextSeq).nextSeq,
      };
    }
    let leafLabel = '';
    if (rawHit && rawHit !== document.body && rawHit !== document.documentElement) {
      const attrLabel = typeof rawHit.getAttribute === 'function'
        ? (rawHit.getAttribute('aria-label') || rawHit.getAttribute('title') || '')
        : '';
      const hasChildren = Boolean(rawHit.children && rawHit.children.length > 0);
      leafLabel = capLabel(attrLabel || (!hasChildren ? (rawHit.innerText || rawHit.textContent || '') : ''));
    }
    const role = rawHit ? controlRole(rawHit) : 'point';
    return {
      ok: true,
      x: px,
      y: py,
      role,
      label: leafLabel,
      editable: rawHit ? isEditable(rawHit) : false,
      nextControlSeq: getControlState(opts.minNextSeq).nextSeq,
    };
  }

  // No target given (allowed for type into activeElement or scroll viewport)
  if (!target.control && !target.selector && !target.text) {
    if (opts.mode === 'scroll') {
      const dialog = findOpenDialog();
      if (dialog) {
        const dr = dialog.getBoundingClientRect();
        if (dr.width >= 10 && dr.height >= 10) {
          return {
            ok: true,
            x: Math.max(1, Math.min(vw() - 1, Math.round(dr.left + dr.width / 2))),
            y: Math.max(1, Math.min(vh() - 1, Math.round(dr.top + dr.height / 2))),
            role: 'dialog',
            label: 'dialog',
            nextControlSeq: getControlState(opts.minNextSeq).nextSeq,
          };
        }
      }
      return {
        ok: true,
        x: Math.round(vw() / 2),
        y: Math.round(vh() / 2),
        role: 'page',
        label: '',
        nextControlSeq: getControlState(opts.minNextSeq).nextSeq,
      };
    }
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement || !isEditable(active)) {
      return {
        ok: false,
        error: 'No editable field is focused; pass control, text, or selector to name the field to type into.',
      };
    }
    if (isFileInput(active)) {
      return { ok: false, error: 'File upload inputs cannot be edited by the assistant.' };
    }
    const labels = candidateLabels(active);
    return {
      ok: true,
      alreadyFocused: true,
      role: controlRole(active),
      label: labels.primary,
      editable: true,
      nextControlSeq: getControlState(opts.minNextSeq).nextSeq,
    };
  }

  const index = typeof target.index === 'number' && target.index >= 0 ? target.index : 0;
  let resolvedEl = null;

  if (target.control) {
    const state = getControlState(opts.minNextSeq);
    const ref = state.byId.get(target.control);
    const candidate = ref && typeof ref.deref === 'function' ? ref.deref() : null;
    if (!candidate || !isVisible(candidate)) {
      const { serialized } = collectControls(8, opts.minNextSeq);
      const hint = serialized.map((c) => '[' + c.id + '] ' + c.role + (c.label ? ' "' + c.label + '"' : '')).join(', ');
      return {
        ok: false,
        nextControlSeq: state.nextSeq,
        error: 'Control ' + target.control + ' is no longer visible on the page.' + (hint ? ' Visible controls: ' + hint + '.' : ''),
      };
    }
    if (isDisabled(candidate)) {
      return {
        ok: false,
        nextControlSeq: state.nextSeq,
        error: 'Control ' + target.control + ' is disabled.',
      };
    }
    resolvedEl = candidate;
  } else if (target.selector) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(target.selector));
    } catch (err) {
      return { ok: false, error: 'Invalid CSS selector ' + JSON.stringify(target.selector) + '.' };
    }
    const visible = nodes.filter((el) => isVisible(el) && !isDisabled(el));
    if (visible.length === 0) {
      return { ok: false, error: 'No visible enabled element matched selector ' + JSON.stringify(target.selector) + '.' };
    }
    if (index >= visible.length) {
      return {
        ok: false,
        error: 'Selector ' + JSON.stringify(target.selector) + ' matched ' + visible.length + ' element(s); index ' + index + ' is out of range.',
      };
    }
    resolvedEl = visible[index];
  } else if (target.text) {
    const query = normSpace(target.text).toLowerCase();
    const { items, serialized, state } = collectControls(${MAX_BROWSER_CONTROLS}, opts.minNextSeq);
    const dialog = findOpenDialog();
    const candidates = items.map((item) => ({
      el: item.el,
      inDialog: item.inDialog,
      allLabels: item.allLabels,
      editable: isEditable(item.el),
    }));

    // Also include navigable <a> links when clicking/scrolling by text!
    if (opts.mode !== 'type') {
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        if (!isVisible(a) || isDisabled(a)) continue;
        if (candidates.some((c) => c.el === a)) continue;
        const labels = candidateLabels(a);
        if (!labels.primary) continue;
        candidates.push({
          el: a,
          inDialog: Boolean(dialog && typeof dialog.contains === 'function' && dialog.contains(a)),
          allLabels: labels.all,
          editable: false,
        });
      }
    }

    const filtered = opts.mode === 'type' ? candidates.filter((c) => c.editable) : candidates;
    const isExact = (c) => c.allLabels.some((l) => l.toLowerCase() === query);
    const isSub = (c) => c.allLabels.some((l) => l.toLowerCase().includes(query));
    const isUnobscured = (c) => {
      const check = hitTestElement(c.el, false);
      return check.ok;
    };

    const tiers = [
      filtered.filter((c) => c.inDialog && isExact(c) && isUnobscured(c)),
      filtered.filter((c) => isExact(c) && isUnobscured(c)),
      filtered.filter((c) => c.inDialog && isExact(c)),
      filtered.filter((c) => isExact(c)),
      filtered.filter((c) => c.inDialog && isSub(c) && isUnobscured(c)),
      filtered.filter((c) => isSub(c) && isUnobscured(c)),
      filtered.filter((c) => c.inDialog && isSub(c)),
      filtered.filter((c) => isSub(c)),
    ];

    let chosenTier = tiers.find((t) => t.length > 0) || [];

    // Fallback for custom clickable divs/spans without ARIA roles when clicking by visible text
    if (chosenTier.length === 0 && opts.mode === 'click') {
      const leafMatches = [];
      for (const el of Array.from(document.querySelectorAll('div, span, li, label'))) {
        if (!isVisible(el) || isDisabled(el)) continue;
        const directText = normSpace(el.innerText || el.textContent || '');
        if (!directText || directText.length > 120) continue;
        const lower = directText.toLowerCase();
        if (lower !== query && !lower.includes(query)) continue;
        const hasSmallerMatch = Array.from(el.children || []).some((child) => {
          const ct = normSpace(child.innerText || child.textContent || '').toLowerCase();
          return ct === query || (lower !== query && ct.includes(query));
        });
        if (hasSmallerMatch) continue;
        leafMatches.push({
          el,
          inDialog: Boolean(dialog && typeof dialog.contains === 'function' && dialog.contains(el)),
          exact: lower === query,
        });
      }
      leafMatches.sort((a, b) => {
        if (a.inDialog !== b.inDialog) return a.inDialog ? -1 : 1;
        if (a.exact !== b.exact) return a.exact ? -1 : 1;
        return 0;
      });
      chosenTier = leafMatches;
    }

    if (chosenTier.length === 0) {
      const hint = serialized
        .slice(0, 8)
        .map((c) => '[' + c.id + '] ' + c.role + (c.label ? ' "' + c.label + '"' : ''))
        .join(', ');
      return {
        ok: false,
        nextControlSeq: state.nextSeq,
        error:
          'No visible ' +
          (opts.mode === 'type' ? 'editable field' : 'control') +
          ' matched text ' +
          JSON.stringify(target.text) +
          '.' +
          (hint ? ' Visible controls: ' + hint + '.' : ''),
      };
    }
    if (index >= chosenTier.length) {
      return {
        ok: false,
        nextControlSeq: state.nextSeq,
        error:
          'Text ' +
          JSON.stringify(target.text) +
          ' matched ' +
          chosenTier.length +
          ' control(s); index ' +
          index +
          ' is out of range.',
      };
    }
    resolvedEl = chosenTier[index].el;
  }

  if (!resolvedEl) {
    return { ok: false, error: 'Could not resolve target control.' };
  }
  if (isFileInput(resolvedEl)) {
    return { ok: false, error: 'File upload inputs cannot be clicked or edited by the assistant.' };
  }
  if (opts.mode === 'type' && !isEditable(resolvedEl)) {
    return { ok: false, error: 'Target control is not an editable input, textarea, select, or contenteditable field.' };
  }

  const labels = candidateLabels(resolvedEl);
  const role = controlRole(resolvedEl);
  const label = labels.primary;
  const seqAfter = getControlState(opts.minNextSeq).nextSeq;

  if (opts.mode === 'type' && String(resolvedEl.tagName || '').toUpperCase() === 'SELECT') {
    const wanted = String(opts.selectValue ?? '').trim();
    const wantedLower = wanted.toLowerCase();
    const optionsList = Array.from(resolvedEl.options || []);
    const match =
      optionsList.find((o) => String(o.value) === wanted) ||
      optionsList.find((o) => normSpace(o.textContent || o.label || '').toLowerCase() === wantedLower) ||
      optionsList.find((o) => normSpace(o.textContent || o.label || '').toLowerCase().includes(wantedLower));
    if (!match) {
      const available = optionsList
        .slice(0, 10)
        .map((o) => JSON.stringify(capLabel(o.textContent || o.value)))
        .join(', ');
      return {
        ok: false,
        nextControlSeq: seqAfter,
        error: 'No option matching ' + JSON.stringify(wanted) + ' in select ' + JSON.stringify(label || role) + (available ? ' (options: ' + available + ').' : '.'),
      };
    }
    resolvedEl.value = match.value;
    if (typeof Event === 'function') {
      resolvedEl.dispatchEvent(new Event('input', { bubbles: true }));
      resolvedEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return {
      ok: true,
      handledSelect: true,
      role,
      label,
      selectedText: capLabel(match.textContent || match.value),
      nextControlSeq: seqAfter,
    };
  }

  const hit = hitTestElement(resolvedEl, true);
  if (!hit.ok) {
    if (opts.mode === 'scroll' && typeof hit.x === 'number' && typeof hit.y === 'number') {
      return { ok: true, x: hit.x, y: hit.y, role, label, nextControlSeq: seqAfter };
    }
    return { ok: false, nextControlSeq: seqAfter, error: hit.error };
  }

  return {
    ok: true,
    x: hit.x,
    y: hit.y,
    role,
    label,
    editable: isEditable(resolvedEl),
    nextControlSeq: seqAfter,
  };
})()`
}

/**
 * Selects all existing text inside the currently focused input, textarea, or contenteditable
 * element so a subsequent native `Backspace` + `Input.insertText` cleanly replaces its value.
 */
export function browserSelectAllActiveScript(): string {
  return `(() => {
  if (typeof document === 'undefined') return { hasContent: false };
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { hasContent: false };
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const val = String(el.value || '');
    if (!val) return { hasContent: false };
    try {
      if (typeof el.select === 'function') el.select();
      else if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, val.length);
    } catch {}
    return { hasContent: true };
  }
  if (el.isContentEditable || (typeof el.getAttribute === 'function' && el.getAttribute('contenteditable') === 'true')) {
    const txt = String(el.innerText || el.textContent || '');
    if (!txt) return { hasContent: false };
    try {
      const sel = typeof window !== 'undefined' && typeof window.getSelection === 'function' ? window.getSelection() : null;
      const range = typeof document.createRange === 'function' ? document.createRange() : null;
      if (sel && range) {
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {}
    return { hasContent: true };
  }
  return { hasContent: false };
})()`
}

/** Scrolls the nearest scrollable ancestor at `(x, y)` (or the document) directly to its top or bottom edge. */
export function browserEdgeScrollScript(direction: 'top' | 'bottom', point?: { x: number; y: number }): string {
  const payload = JSON.stringify({ direction, point })
  return `(() => {
  if (typeof document === 'undefined') return false;
  const { direction, point } = ${payload};
  const w = typeof window !== 'undefined' ? window : globalThis;
  let container = null;
  if (point && typeof document.elementFromPoint === 'function') {
    let cur = document.elementFromPoint(point.x, point.y);
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const style = typeof w.getComputedStyle === 'function' ? w.getComputedStyle(cur) : null;
      const overflowY = style ? style.overflowY : '';
      if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && cur.scrollHeight > cur.clientHeight + 4) {
        container = cur;
        break;
      }
      cur = cur.parentElement;
    }
  }
  if (container) {
    container.scrollTop = direction === 'top' ? 0 : container.scrollHeight;
    return true;
  }
  const root = document.scrollingElement || document.documentElement || document.body;
  const targetTop = direction === 'top' ? 0 : (root ? root.scrollHeight : 1000000);
  if (typeof w.scrollTo === 'function') {
    try {
      w.scrollTo({ top: targetTop, behavior: 'instant' });
      return true;
    } catch {
      w.scrollTo(0, targetTop);
      return true;
    }
  }
  if (root) root.scrollTop = targetTop;
  return true;
})()`
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolves a `core/browser` panel on `grids` from an element, panel, or room identifier (or the
 * single browser tile inside `loopId` when omitted or when the room's frame id is given).
 */
export function resolveBrowserPanelTarget(
  grids: Record<number, Grid>,
  loops: readonly Loop[],
  rawTarget?: unknown,
  loopId?: string,
): { elementId: string; panel: Panel } {
  const targetStr = typeof rawTarget === 'string' ? rawTarget.trim() : ''
  if (!targetStr) {
    if (loopId) {
      const frame = frameOf(grids, loopId)
      if (frame) {
        return singleBrowserInsideFrame(grids, frame.window, frame.element.id)
      }
    }
    throw new Error('elementId must be a core/browser element id from the grid, like e3.')
  }

  const resolvedElementId = elementTarget(grids, [...loops], targetStr)
  for (const [winKey, grid] of Object.entries(grids)) {
    const element = grid.elements.find((e) => e.id === resolvedElementId)
    if (!element) continue
    const panel = panelOf(grid, element.id)
    if (panel.content.kind === 'frame') {
      return singleBrowserInsideFrame(grids, Number(winKey), element.id)
    }
    if (panel.content.kind !== 'view' || panel.content.view !== BROWSER_VIEW) {
      throw new Error(`${element.id} does not show a core/browser view.`)
    }
    return { elementId: element.id, panel }
  }
  throw new Error(`No element ${resolvedElementId}.`)
}

function singleBrowserInsideFrame(
  grids: Record<number, Grid>,
  windowNumber: number,
  frameElementId: string,
): { elementId: string; panel: Panel } {
  const grid = grids[windowNumber]
  if (!grid) throw new Error(`No element ${frameElementId}.`)
  const children = grid.elements.filter((e) => e.parent === frameElementId)
  const browsers: { elementId: string; panel: Panel }[] = []
  for (const child of children) {
    const panel = grid.panels.find((p) => p.id === child.panelId || p.elementId === child.id)
    if (panel && panel.content.kind === 'view' && panel.content.view === BROWSER_VIEW) {
      browsers.push({ elementId: child.id, panel })
    }
  }
  if (browsers.length === 0) {
    throw new Error('No core/browser view is placed in this room yet; call place_view with view "core/browser" first.')
  }
  if (browsers.length > 1) {
    throw new Error(
      `Multiple core/browser views are in this room (${browsers.map((b) => b.elementId).join(', ')}); pass the specific elementId.`,
    )
  }
  return browsers[0]!
}
