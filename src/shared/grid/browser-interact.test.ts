import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { BROWSER_VIEW, formatBrowserPageText } from './browser.ts'
import { EMPTY_GRID, layoutOf, placeView, withLayout } from './grid.ts'
import {
  browserEdgeScrollScript,
  browserReadPageScript,
  browserResolveTargetScript,
  browserSelectAllActiveScript,
  extractBrowserTextSummary,
  formatBrowserControls,
  MAX_BROWSER_CONTROL_LABEL,
  normalizeControlId,
  readBrowserInteraction,
  resolveBrowserKeySpec,
  resolveBrowserPanelTarget,
} from './browser-interact.ts'

interface MockRect {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
}

interface MockNodeInit {
  tagName: string
  id?: string
  type?: string
  value?: string
  checked?: boolean
  disabled?: boolean
  readOnly?: boolean
  isContentEditable?: boolean
  innerText?: string
  href?: string
  attrs?: Record<string, string>
  style?: Record<string, string>
  rect?: { left: number; top: number; width: number; height: number }
  children?: MockNode[]
  options?: { value: string; textContent: string; label?: string }[]
}

class MockNode {
  nodeType = 1
  isConnected = true
  tagName: string
  id: string
  type: string
  value: string
  checked: boolean
  disabled: boolean
  readOnly: boolean
  isContentEditable: boolean
  innerText: string
  textContent: string
  href: string
  attrs: Map<string, string>
  style: Record<string, string>
  rect: MockRect
  children: MockNode[]
  parentElement: MockNode | null = null
  selectedOptions: { value: string; textContent: string; label?: string }[] = []
  options: { value: string; textContent: string; label?: string }[] = []
  events: string[] = []
  scrolledIntoView = 0
  selectedAll = false
  scrollTop = 0
  scrollHeight = 400
  clientHeight = 400

  constructor(init: MockNodeInit) {
    this.tagName = init.tagName.toUpperCase()
    this.id = init.id ?? ''
    this.type = init.type ?? (this.tagName === 'INPUT' ? 'text' : '')
    this.value = init.value ?? ''
    this.checked = init.checked ?? false
    this.disabled = init.disabled ?? false
    this.readOnly = init.readOnly ?? false
    this.isContentEditable = init.isContentEditable ?? false
    this.innerText = init.innerText ?? ''
    this.textContent = init.innerText ?? ''
    this.href = init.href ?? ''
    this.attrs = new Map(Object.entries(init.attrs ?? {}))
    if (this.id) this.attrs.set('id', this.id)
    if (init.href && !this.attrs.has('href')) this.attrs.set('href', init.href)
    this.style = { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto', ...init.style }
    const r = init.rect ?? { left: 20, top: 20, width: 100, height: 36 }
    this.rect = { ...r, right: r.left + r.width, bottom: r.top + r.height }
    this.children = init.children ?? []
    for (const child of this.children) child.parentElement = this
    if (init.options) {
      this.options = init.options
      this.selectedOptions = init.options.filter((o) => o.value === this.value)
    }
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  setAttribute(): void {
    throw new Error('DOM attributes must never be mutated by isolated-world browser scripts')
  }

  getBoundingClientRect(): MockRect {
    return this.rect
  }

  getClientRects(): MockRect[] {
    return this.rect.width > 0 && this.rect.height > 0 ? [this.rect] : []
  }

  contains(other: MockNode | null): boolean {
    let cur: MockNode | null = other
    while (cur) {
      if (cur === this) return true
      cur = cur.parentElement
    }
    return false
  }

  matches(selector: string): boolean {
    return matchesSimpleSelectorList(this, selector)
  }

  closest(selector: string): MockNode | null {
    let cur: MockNode | null = this
    while (cur) {
      if (matchesSimpleSelectorList(cur, selector)) return cur
      cur = cur.parentElement
    }
    return null
  }

  querySelector(selector: string): MockNode | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): MockNode[] {
    if (selector.includes('[')) {
      if ((selector.match(/\[/g)?.length ?? 0) !== (selector.match(/\]/g)?.length ?? 0)) {
        throw new SyntaxError(`Invalid selector: ${selector}`)
      }
    }
    const out: MockNode[] = []
    const walk = (node: MockNode): void => {
      for (const child of node.children) {
        if (matchesSimpleSelectorList(child, selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  scrollIntoView(): void {
    this.scrolledIntoView++
    if (this.rect.top > 760 || this.rect.top < 0) {
      this.rect = {
        left: this.rect.left,
        top: 300,
        width: this.rect.width,
        height: this.rect.height,
        right: this.rect.left + this.rect.width,
        bottom: 300 + this.rect.height,
      }
    }
  }

  select(): void {
    this.selectedAll = true
  }

  dispatchEvent(ev: { type: string }): boolean {
    this.events.push(ev.type)
    return true
  }
}

function matchesSinglePart(node: MockNode, part: string): boolean {
  const s = part.trim()
  if (!s) return false
  if (s === '*') return true
  if (s.startsWith('#')) return node.id === s.slice(1)
  if (s === 'dialog[open]') return node.tagName === 'DIALOG' && node.attrs.has('open')
  if (s === 'a[href]') return node.tagName === 'A' && node.attrs.has('href')
  if (s === 'img[alt]') return node.tagName === 'IMG' && node.attrs.has('alt')
  if (s === 'label[for]') return node.tagName === 'LABEL' && node.attrs.has('for')
  const attrMatch = s.match(/^([a-z0-9]*)?\[([a-z0-9_-]+)(?:="([^"]*)")?\]$/i)
  if (attrMatch) {
    const [, tag, attr, val] = attrMatch
    if (tag && node.tagName !== tag.toUpperCase()) return false
    if (!node.attrs.has(attr!)) return false
    if (val !== undefined && node.attrs.get(attr!) !== val) return false
    return true
  }
  return node.tagName === s.toUpperCase()
}

function matchesSimpleSelectorList(node: MockNode, selectorList: string): boolean {
  return selectorList.split(',').some((part) => matchesSinglePart(node, part))
}

function makeSandbox(body: MockNode, hitAt?: (x: number, y: number) => MockNode | null) {
  const doc = {
    body,
    documentElement: body,
    scrollingElement: body,
    activeElement: body as MockNode,
    getElementById(id: string) {
      return body.querySelectorAll('*').find((n) => n.id === id) ?? null
    },
    querySelectorAll(sel: string) {
      return body.querySelectorAll(sel)
    },
    elementFromPoint(x: number, y: number) {
      if (hitAt) return hitAt(x, y)
      const all = body.querySelectorAll('*')
      for (let i = all.length - 1; i >= 0; i--) {
        const n = all[i]!
        const r = n.rect
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && n.style.display !== 'none') {
          return n
        }
      }
      return body
    },
    createRange() {
      return { selectNodeContents() {} }
    },
  }
  const win: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 800,
    document: doc,
    getComputedStyle(el: MockNode) {
      return el.style
    },
    getSelection() {
      return { removeAllRanges() {}, addRange() {} }
    },
    scrollTo(arg: number | { top?: number }, y?: number) {
      body.scrollTop = typeof arg === 'object' ? (arg.top ?? 0) : (y ?? 0)
    },
  }
  win.window = win
  return {
    win,
    doc,
    evalScript<T>(code: string): T {
      const raw = vm.runInNewContext(code, {
        window: win,
        document: doc,
        WeakRef,
        Event: class {
          type: string
          constructor(type: string) {
            this.type = type
          }
        },
      })
      return raw === undefined ? (undefined as T) : (JSON.parse(JSON.stringify(raw)) as T)
    },
  }
}

test('formatBrowserControls, formatBrowserPageText, and extractBrowserTextSummary include interactive controls while redacting passwords and preserving tail sections', () => {
  assert.equal(normalizeControlId('[C3]'), 'c3')
  assert.equal(normalizeControlId('c12'), 'c12')
  assert.equal(normalizeControlId('c0'), null)
  assert.equal(normalizeControlId('bad'), null)

  const controlsBlock = formatBrowserControls([
    { id: 'c1', role: 'button', label: 'Follow @acme', inDialog: true },
    { id: 'c2', role: 'searchbox', label: 'Search directory', value: 'earnings' },
    { id: 'c3', role: 'password', label: 'Password', value: 'super-secret-password' },
    { id: 'c4', role: 'checkbox', label: 'Keep me signed in', checked: true },
  ])
  assert.equal(
    controlsBlock,
    [
      'Controls:',
      '- [c1] button "Follow @acme" (in dialog)',
      '- [c2] searchbox "Search directory" (value: "earnings")',
      '- [c3] password "Password"',
      '- [c4] checkbox "Keep me signed in" (checked)',
    ].join('\n'),
  )
  assert.doesNotMatch(controlsBlock, /super-secret-password/)

  const formatted = formatBrowserPageText(
    'Follow @acme?\nCompany filings and updates.',
    [{ text: 'View profile', url: 'https://example.com/acme' }],
    'https://example.com/follow?account=acme',
    200_000,
    [
      { id: 'c1', role: 'button', label: 'Follow', inDialog: true },
      { id: 'c2', role: 'button', label: 'Cancel', inDialog: true },
    ],
  )
  assert.equal(
    formatted,
    [
      'Follow @acme?\nCompany filings and updates.',
      '',
      'Controls:',
      '- [c1] button "Follow" (in dialog)',
      '- [c2] button "Cancel" (in dialog)',
      '',
      'Links:',
      '- [View profile](https://example.com/acme)',
    ].join('\n'),
  )

  const summary = extractBrowserTextSummary(formatted)
  assert.deepEqual(summary, {
    textPreview: 'Follow @acme?\nCompany filings and updates.',
    controls: ['[c1] button "Follow" (in dialog)', '[c2] button "Cancel" (in dialog)'],
  })

  // Large body preserves Controls and Links within maxChars budget.
  const hugeBody = 'A'.repeat(2_000)
  const budgeted = formatBrowserPageText(
    hugeBody,
    [{ text: 'Profile', url: 'https://example.com/acme' }],
    'https://example.com/home',
    500,
    [{ id: 'c1', role: 'button', label: 'Follow' }],
  )
  assert.ok(budgeted && budgeted.length <= 500)
  assert.match(budgeted!, /Controls:\n- \[c1\] button "Follow"/)
  assert.match(budgeted!, /Links:\n- \[Profile\]\(https:\/\/example\.com\/acme\)/)
})

test('readBrowserInteraction and resolveBrowserKeySpec validate actions, targets, aliases, and key chords', () => {
  assert.deepEqual(readBrowserInteraction({ action: 'click', control: '[c2]' }), {
    action: 'click',
    control: 'c2',
  })
  assert.deepEqual(readBrowserInteraction({ action: 'click', text: 'Follow', index: 1, doubleClick: true }), {
    action: 'click',
    text: 'Follow',
    index: 1,
    doubleClick: true,
  })
  assert.deepEqual(
    readBrowserInteraction({ action: 'type', selector: 'input[name="q"]', value: 'NVDA', submit: true }),
    {
      action: 'type',
      selector: 'input[name="q"]',
      value: 'NVDA',
      clear: true,
      submit: true,
    },
  )
  assert.deepEqual(readBrowserInteraction({ action: 'type', value: 'appended' }), {
    action: 'type',
    value: 'appended',
    clear: false,
    submit: false,
  })
  assert.deepEqual(readBrowserInteraction({ action: 'scroll' }), {
    action: 'scroll',
    direction: 'down',
    pixels: 500,
  })
  assert.deepEqual(readBrowserInteraction({ action: 'goto', url: 'example.com/follow?account=acme' }), {
    action: 'navigate',
    url: 'https://example.com/follow?account=acme',
  })
  assert.deepEqual(readBrowserInteraction({ action: 'select-tab', tabId: 't2' }), {
    action: 'select_tab',
    tabId: 't2',
  })

  assert.throws(() => readBrowserInteraction({ action: 'click' }), /Give control/)
  assert.throws(() => readBrowserInteraction({ action: 'click', x: 10 }), /x and y must both/)
  assert.throws(() => readBrowserInteraction({ action: 'navigate', url: 'javascript:alert(1)' }), /https:\/\//)
  assert.throws(() => readBrowserInteraction({ action: 'press', key: 'NotARealKeyName' }), /key must be/)

  assert.deepEqual(resolveBrowserKeySpec('Enter'), {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
    modifiers: 0,
    accelerator: 'Enter',
  })
  assert.deepEqual(resolveBrowserKeySpec('Shift+Tab'), {
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
    modifiers: 8,
    accelerator: 'Tab',
  })
  assert.deepEqual(resolveBrowserKeySpec('/'), {
    key: '/',
    code: '',
    windowsVirtualKeyCode: 47,
    text: '/',
    modifiers: 0,
    accelerator: '/',
  })
})

test('isolated-world DOM scripts prioritize open modal controls, reject covered/file controls, never touch DOM attributes, and support select/clear/scroll helpers', () => {
  const sidebarFollow = new MockNode({
    tagName: 'button',
    id: 'sidebar-follow',
    innerText: 'Follow',
    rect: { left: 900, top: 120, width: 90, height: 32 },
  })
  const backdrop = new MockNode({
    tagName: 'div',
    attrs: { role: 'presentation' },
    rect: { left: 0, top: 0, width: 1280, height: 800 },
  })
  const modalFollow = new MockNode({
    tagName: 'button',
    id: 'modal-follow',
    innerText: 'Follow',
    attrs: { 'data-testid': 'confirmationSheetConfirm' },
    rect: { left: 540, top: 380, width: 200, height: 44 },
  })
  const modalCancel = new MockNode({
    tagName: 'button',
    innerText: 'Cancel',
    rect: { left: 540, top: 436, width: 200, height: 44 },
  })
  const dialog = new MockNode({
    tagName: 'div',
    attrs: { role: 'dialog', 'aria-modal': 'true' },
    rect: { left: 480, top: 240, width: 320, height: 280 },
    children: [modalFollow, modalCancel],
  })
  const searchInput = new MockNode({
    tagName: 'input',
    type: 'search',
    value: 'old query',
    attrs: { placeholder: 'Search accounts' },
    rect: { left: 40, top: 20, width: 240, height: 36 },
  })
  const passwordInput = new MockNode({
    tagName: 'input',
    type: 'password',
    value: 'do-not-leak',
    attrs: { 'aria-label': 'Password' },
    rect: { left: 40, top: 70, width: 240, height: 36 },
  })
  const fileInput = new MockNode({
    tagName: 'input',
    type: 'file',
    attrs: { 'aria-label': 'Upload avatar' },
    rect: { left: 40, top: 120, width: 200, height: 32 },
  })
  const listSelect = new MockNode({
    tagName: 'select',
    id: 'list-select',
    value: 'rates',
    attrs: { 'aria-label': 'Watchlist' },
    rect: { left: 40, top: 170, width: 200, height: 32 },
    options: [
      { value: 'rates', textContent: 'Global Rates' },
      { value: 'semis', textContent: 'Semiconductors' },
    ],
  })
  const articleLink = new MockNode({
    tagName: 'a',
    innerText: 'Markets Wrap',
    href: 'https://www.bloomberg.com/markets',
    rect: { left: 40, top: 230, width: 140, height: 24 },
  })

  const body = new MockNode({
    tagName: 'body',
    innerText: 'Follow @acme?',
    rect: { left: 0, top: 0, width: 1280, height: 800 },
    children: [sidebarFollow, searchInput, passwordInput, fileInput, listSelect, articleLink, backdrop, dialog],
  })

  const { doc, evalScript } = makeSandbox(body, (x, y) => {
    // Modal buttons sit on top; everything outside the modal is covered by `backdrop` except top search bar for testing.
    for (const topNode of [modalFollow, modalCancel, searchInput, listSelect, fileInput]) {
      const r = topNode.rect
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return topNode
    }
    return backdrop
  })

  const page = evalScript<{
    text: string
    links: { text: string; url: string }[]
    controls: { id: string; role: string; label: string; value?: string; inDialog?: boolean }[]
  }>(browserReadPageScript())

  assert.equal(page.links.length, 1)
  assert.equal(page.links[0]?.url, 'https://www.bloomberg.com/markets')
  // Modal controls come first (c1, c2), file inputs are excluded, password values are redacted, and plain http links aren't duplicated.
  assert.equal(page.controls[0]?.id, 'c1')
  assert.equal(page.controls[0]?.label, 'Follow')
  assert.equal(page.controls[0]?.inDialog, true)
  assert.equal(page.controls[1]?.label, 'Cancel')
  assert.equal(
    page.controls.some((c) => c.label === 'Upload avatar'),
    false,
  )
  const pwControl = page.controls.find((c) => c.role === 'password')
  assert.ok(pwControl)
  assert.equal(pwControl?.value, undefined)

  // Clicking "Follow" by text resolves the unobstructed modal button (540..740, 380..424), NOT the covered sidebar Follow button!
  const clickFollow = evalScript<{ ok: boolean; x?: number; y?: number; label?: string }>(
    browserResolveTargetScript({ mode: 'click', target: { text: 'Follow' } }),
  )
  assert.equal(clickFollow.ok, true)
  assert.equal(clickFollow.x, 640)
  assert.equal(clickFollow.y, 402)

  // Clicking by control id "c1" resolves the exact WeakRef control from isolated-world memory.
  const clickC1 = evalScript<{ ok: boolean; x?: number; y?: number }>(
    browserResolveTargetScript({ mode: 'click', target: { control: 'c1' } }),
  )
  assert.equal(clickC1.ok, true)
  assert.equal(clickC1.x, 640)

  // Clicking the covered sidebar Follow button directly by selector reports that it is obstructed.
  const clickCovered = evalScript<{ ok: boolean; error?: string }>(
    browserResolveTargetScript({ mode: 'click', target: { selector: '#sidebar-follow' } }),
  )
  assert.equal(clickCovered.ok, false)
  assert.match(clickCovered.error!, /covered/)

  // File upload inputs are refused even by coordinates.
  const clickFile = evalScript<{ ok: boolean; error?: string }>(
    browserResolveTargetScript({ mode: 'click', target: { x: 80, y: 130 } }),
  )
  assert.equal(clickFile.ok, false)
  assert.match(clickFile.error!, /File upload inputs/)

  // <select> elements select matching option by text and fire input + change.
  const selectRes = evalScript<{ ok: boolean; handledSelect?: boolean; selectedText?: string }>(
    browserResolveTargetScript({
      mode: 'type',
      target: { selector: '#list-select' },
      selectValue: 'Semiconductors',
    }),
  )
  assert.equal(selectRes.ok, true)
  assert.equal(selectRes.handledSelect, true)
  assert.equal(listSelect.value, 'semis')
  assert.deepEqual(listSelect.events, ['input', 'change'])

  // browserSelectAllActiveScript selects existing content in the focused input.
  doc.activeElement = searchInput
  const selAll = evalScript<{ hasContent: boolean }>(browserSelectAllActiveScript())
  assert.equal(selAll.hasContent, true)
  assert.equal(searchInput.selectedAll, true)

  // browserEdgeScrollScript scrolls to bottom/top.
  body.scrollHeight = 3200
  assert.equal(evalScript<boolean>(browserEdgeScrollScript('bottom')), true)
  assert.equal(body.scrollTop, 3200)
  assert.equal(evalScript<boolean>(browserEdgeScrollScript('top')), true)
  assert.equal(body.scrollTop, 0)

  // Offscreen button scrolls into view before resolving click coordinates.
  const belowFoldButton = new MockNode({
    tagName: 'button',
    id: 'load-more',
    innerText: 'Show more',
    rect: { left: 200, top: 1400, width: 140, height: 40 },
  })
  belowFoldButton.parentElement = body
  body.children.push(belowFoldButton)
  const offscreenSandbox = makeSandbox(body)
  const clickOffscreen = offscreenSandbox.evalScript<{ ok: boolean; x?: number; y?: number }>(
    browserResolveTargetScript({ mode: 'click', target: { text: 'Show more' } }),
  )
  assert.equal(clickOffscreen.ok, true)
  assert.equal(belowFoldButton.scrolledIntoView, 1)
  assert.equal(clickOffscreen.x, 270)
  assert.equal(clickOffscreen.y, 320)
})

test('resolveBrowserPanelTarget resolves element ids, panel ids, and single-browser rooms while rejecting non-browser or ambiguous targets', () => {
  const framePlaced = placeView(EMPTY_GRID, {
    content: { kind: 'frame' },
    loop: 'f1',
  })
  const firstBrowser = placeView(layoutOf(framePlaced.grid, framePlaced.element.id), {
    content: { kind: 'view', view: BROWSER_VIEW },
    state: { url: 'https://example.com/home' },
    size: 'quarter',
    loop: 'f1',
  })
  const baseGrid = withLayout(framePlaced.grid, framePlaced.element.id, firstBrowser.grid)
  const loops = [{ id: 'f1', desc: 'Market Feed', brief: '', plugins: [], skills: [], createdAt: 1 }]
  const grids = { 1: baseGrid }

  assert.equal(resolveBrowserPanelTarget(grids, loops, firstBrowser.element.id, 'f1').panel.id, firstBrowser.panel.id)
  assert.equal(resolveBrowserPanelTarget(grids, loops, firstBrowser.panel.id, 'f1').elementId, firstBrowser.element.id)
  assert.equal(resolveBrowserPanelTarget(grids, loops, 'room_1', 'f1').elementId, firstBrowser.element.id)
  assert.equal(resolveBrowserPanelTarget(grids, loops, undefined, 'f1').elementId, firstBrowser.element.id)

  // Add a non-browser view and a second browser view inside the same room frame.
  const withTable = placeView(layoutOf(baseGrid, framePlaced.element.id), {
    content: { kind: 'view', view: 'core/table' },
    size: 'quarter',
    loop: 'f1',
  })
  const gridWithTable = withLayout(baseGrid, framePlaced.element.id, withTable.grid)
  assert.throws(
    () => resolveBrowserPanelTarget({ 1: gridWithTable }, loops, withTable.element.id, 'f1'),
    /does not show a core\/browser view/,
  )

  const withSecondBrowser = placeView(layoutOf(gridWithTable, framePlaced.element.id), {
    content: { kind: 'view', view: BROWSER_VIEW },
    size: 'quarter',
    loop: 'f1',
  })
  const gridWithTwo = withLayout(gridWithTable, framePlaced.element.id, withSecondBrowser.grid)
  assert.throws(
    () => resolveBrowserPanelTarget({ 1: gridWithTwo }, loops, 'room_1', 'f1'),
    /Multiple core\/browser views/,
  )
})

test('control ids stick to their DOM element across lazy feed insertions, refuse removed or cross-document stale ids, and cap container labels and roles', () => {
  const buttons: MockNode[] = []
  for (let i = 1; i <= 12; i++) {
    buttons.push(
      new MockNode({
        tagName: 'button',
        innerText: `Post ${i}`,
        rect: { left: 40, top: i * 40, width: 120, height: 32 },
      }),
    )
  }
  const archiveSpan = new MockNode({
    tagName: 'span',
    innerText: 'Archive',
    rect: { left: 44, top: 564, width: 112, height: 24 },
  })
  const archiveButton = new MockNode({
    tagName: 'button',
    innerText: 'Archive',
    rect: { left: 40, top: 560, width: 120, height: 32 },
    children: [archiveSpan],
  })
  buttons.push(archiveButton)

  const hugeArticleText = Array.from(
    { length: 200 },
    (_, i) => `Story headline number ${i + 1} with summary text.`,
  ).join(' ')
  const article = new MockNode({
    tagName: 'article',
    innerText: hugeArticleText,
    rect: { left: 300, top: 40, width: 800, height: 700 },
    children: buttons,
  })
  const body = new MockNode({
    tagName: 'body',
    innerText: hugeArticleText,
    rect: { left: 0, top: 0, width: 1280, height: 800 },
    children: [article],
  })

  const sandbox = makeSandbox(body)
  const firstRead = sandbox.evalScript<{
    controls: { id: string; role: string; label: string }[]
    nextControlSeq: number
  }>(browserReadPageScript())

  const archiveEntry = firstRead.controls.find((c) => c.label === 'Archive')
  assert.deepEqual(archiveEntry, { id: 'c13', role: 'button', label: 'Archive' })
  assert.equal(firstRead.nextControlSeq, 13)

  // A lazy-loaded feed inserts a "Late arrival" button at the top above everything else, and re-reads page text.
  const lateArrival = new MockNode({
    tagName: 'button',
    innerText: 'Late arrival',
    rect: { left: 40, top: 8, width: 120, height: 28 },
  })
  lateArrival.parentElement = article
  article.children.unshift(lateArrival)

  const secondRead = sandbox.evalScript<{
    controls: { id: string; role: string; label: string }[]
    nextControlSeq: number
  }>(browserReadPageScript(80, firstRead.nextControlSeq))

  assert.deepEqual(secondRead.controls[0], { id: 'c14', role: 'button', label: 'Late arrival' })
  assert.deepEqual(
    secondRead.controls.find((c) => c.label === 'Archive'),
    { id: 'c13', role: 'button', label: 'Archive' },
  )

  // Clicking c13 still resolves to Archive (100, 576), NEVER Late arrival (100, 22)!
  const clickC13 = sandbox.evalScript<{ ok: boolean; x?: number; y?: number; role?: string; label?: string }>(
    browserResolveTargetScript({ mode: 'click', target: { control: 'c13' }, minNextSeq: secondRead.nextControlSeq }),
  )
  assert.equal(clickC13.ok, true)
  assert.equal(clickC13.label, 'Archive')
  assert.equal(clickC13.x, 100)
  assert.equal(clickC13.y, 576)

  // Once Archive is removed from the DOM, clicking c13 refuses rather than rebinding to another button.
  archiveButton.isConnected = false
  article.children = article.children.filter((c) => c !== archiveButton)
  const clickRemoved = sandbox.evalScript<{ ok: boolean; error?: string; nextControlSeq?: number }>(
    browserResolveTargetScript({ mode: 'click', target: { control: 'c13' }, minNextSeq: secondRead.nextControlSeq }),
  )
  assert.equal(clickRemoved.ok, false)
  assert.match(clickRemoved.error ?? '', /Control c13 is no longer visible/)

  // Across a full document navigation (fresh isolated-world window), minNextSeq prevents c13 from ever matching on the new page.
  const nextDocBtn = new MockNode({
    tagName: 'button',
    innerText: 'Delete account',
    rect: { left: 40, top: 40, width: 140, height: 36 },
  })
  const nextDocBody = new MockNode({
    tagName: 'body',
    innerText: 'Settings',
    rect: { left: 0, top: 0, width: 1280, height: 800 },
    children: [nextDocBtn],
  })
  const nextSandbox = makeSandbox(nextDocBody)
  const nextDocRead = nextSandbox.evalScript<{
    controls: { id: string; label: string }[]
    nextControlSeq: number
  }>(browserReadPageScript(80, clickRemoved.nextControlSeq ?? secondRead.nextControlSeq))
  assert.equal(nextDocRead.controls[0]?.id, 'c15')
  const staleCrossDoc = nextSandbox.evalScript<{ ok: boolean; error?: string }>(
    browserResolveTargetScript({ mode: 'click', target: { control: 'c13' }, minNextSeq: nextDocRead.nextControlSeq }),
  )
  assert.equal(staleCrossDoc.ok, false)

  // Coordinate click landing on the multi-thousand-char <article> container reports role 'article' and empty label (not 'button' + 10k chars).
  const clickContainerCoords = sandbox.evalScript<{ ok: boolean; role?: string; label?: string }>(
    browserResolveTargetScript({ mode: 'click', target: { x: 500, y: 300 } }),
  )
  assert.equal(clickContainerCoords.ok, true)
  assert.equal(clickContainerCoords.role, 'article')
  assert.equal(clickContainerCoords.label, '')

  // Coordinate click landing on an inner <span> inside a <button> resolves the enclosing button's role and label.
  archiveButton.isConnected = true
  article.children.push(archiveButton)
  const clickInnerSpanCoords = sandbox.evalScript<{ ok: boolean; role?: string; label?: string }>(
    browserResolveTargetScript({ mode: 'click', target: { x: 60, y: 570 } }),
  )
  assert.equal(clickInnerSpanCoords.ok, true)
  assert.equal(clickInnerSpanCoords.role, 'button')
  assert.equal(clickInnerSpanCoords.label, 'Archive')

  // Broad selector click on 'article' reports role 'article' (not 'button') and caps label to MAX_BROWSER_CONTROL_LABEL + ellipsis.
  const clickArticleSelector = sandbox.evalScript<{ ok: boolean; role?: string; label?: string }>(
    browserResolveTargetScript({ mode: 'click', target: { selector: 'article' } }),
  )
  assert.equal(clickArticleSelector.ok, true)
  assert.equal(clickArticleSelector.role, 'article')
  assert.ok((clickArticleSelector.label?.length ?? 0) <= MAX_BROWSER_CONTROL_LABEL + 1)
  assert.match(clickArticleSelector.label ?? '', /…$/)
})
