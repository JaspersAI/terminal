import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { parseDocument } from 'htmlparser2'
import type { ChildNode, Element } from 'domhandler'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EYE_OFF } from '../../../shared/app/eye.ts'
import { PRO_MODE_OFF } from '../../../shared/app/pro-mode.ts'
import { EMPTY_COLLAB, type CollabState } from '../../../shared/collab/collab.ts'
import { EMPTY_GRID, type Grid } from '../../../shared/grid/grid.ts'
import type { Loop } from '../../../shared/loops/loops.ts'
import type { AppState } from '../../../shared/state.ts'

// Vite resolves extensionless TypeScript/TSX imports in `src/renderer/`; resolve and transpile them
// on the fly here so `ElementFrame` renders directly under Node's test runner.
let hooksInstalled = false
function installRendererHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  const reactResolved = JSON.stringify(import.meta.resolve('react'))
  const ssrReactUrl = `data:text/javascript,${encodeURIComponent(
    [
      `import * as R from ${reactResolved};`,
      `export * from ${reactResolved};`,
      'export default R;',
      'export function useSyncExternalStore(sub, get, getServer) {',
      '  return R.useSyncExternalStore(sub, get, getServer ?? get);',
      '}',
    ].join('\n'),
  )}`
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'react' && context.parentURL?.includes('/src/renderer/')) {
        return { url: ssrReactUrl, shortCircuit: true }
      }
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        !path.extname(specifier) &&
        context.parentURL?.startsWith('file:')
      ) {
        const dir = path.dirname(fileURLToPath(context.parentURL))
        for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
          const candidate = path.resolve(dir, `${specifier}${ext}`)
          if (fs.existsSync(candidate)) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true }
          }
        }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && url.includes('/src/renderer/') && (url.endsWith('.tsx') || url.endsWith('.ts'))) {
        const source = fs.readFileSync(fileURLToPath(url), 'utf8').replaceAll('import.meta.glob', '(() => ({}))')
        const { code } = transformSync(source, {
          loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
          jsx: 'automatic',
          format: 'esm',
          target: 'esnext',
          sourcefile: fileURLToPath(url),
        })
        return { format: 'module', source: code, shortCircuit: true }
      }
      return nextLoad(url, context)
    },
  })
}

function findElement(nodes: readonly ChildNode[], match: (el: Element) => boolean): Element | null {
  for (const node of nodes) {
    if (node.type === 'tag') {
      const el = node as Element
      if (match(el)) return el
      const nested = findElement(el.children, match)
      if (nested) return nested
    }
  }
  return null
}

function findAllElements(nodes: readonly ChildNode[], match: (el: Element) => boolean, out: Element[] = []): Element[] {
  for (const node of nodes) {
    if (node.type === 'tag') {
      const el = node as Element
      if (match(el)) out.push(el)
      findAllElements(el.children, match, out)
    }
  }
  return out
}

function hasClass(el: Element, token: string): boolean {
  return (el.attribs['class'] ?? '').split(/\s+/).includes(token)
}

function makeState(options: { grid: Grid; loop: Loop; collab: CollabState; workspaceShareId?: string }): AppState {
  return {
    termsAccepted: true,
    onboardingComplete: true,
    llm: null,
    voice: null,
    search: null,
    workspaces: [
      {
        id: 'ws-1',
        name: 'Workspace',
        ...(options.workspaceShareId ? { shareId: options.workspaceShareId } : {}),
      },
    ],
    currentWorkspaceId: 'ws-1',
    grids: { 'ws-1': { 1: options.grid } },
    loops: { 'ws-1': [options.loop] },
    closedLoops: { 'ws-1': [] },
    windows: [],
    views: {
      'core/browser': { id: 'core/browser', plugin: null, title: 'Browser', renders: [], stateSchema: {} },
    },
    sources: {},
    connections: {},
    plugins: {},
    installing: null,
    skills: {},
    disabledSkills: [],
    secretRequests: [],
    questions: [],
    welcome: null,
    notices: [],
    unread: 0,
    memories: [],
    tasks: [],
    background: { openAtLogin: false, canOpenAtLogin: false },
    updates: { version: '0.14.12', supported: false, status: 'idle', available: null, error: null },
    budgets: { dailyTokens: 1_000_000 },
    theme: 'dark',
    proMode: PRO_MODE_OFF,
    eye: EYE_OFF,
    jaspers: { signedIn: true, email: 'alice@fund.com', reason: null },
    collab: options.collab,
    sourceApprovals: [],
  }
}

const SHARED_COLLAB: CollabState = {
  ...EMPTY_COLLAB,
  connected: true,
  accountId: 'acct-alice',
  firstName: 'Alice',
  lastName: 'Chen',
  teammates: [
    { accountId: 'acct-bob', email: 'bob@fund.com', firstName: 'Bob', lastName: 'Rivera', since: 1, online: true },
    {
      accountId: 'acct-carol',
      email: 'carol.diaz@fund.com',
      firstName: 'Carol',
      lastName: 'Diaz',
      since: 2,
      online: false,
    },
  ],
  shares: [
    {
      shareId: 'share-1',
      kind: 'room',
      role: 'owner',
      ownerAccountId: 'acct-alice',
      ownerEmail: 'alice@fund.com',
      ownerFirstName: 'Alice',
      ownerLastName: 'Chen',
      ownerOnline: true,
      title: 'Room 3',
      members: [
        { accountId: 'acct-bob', email: 'bob@fund.com', firstName: 'Bob', lastName: 'Rivera', addedAt: 1 },
        { accountId: 'acct-carol', email: 'carol.diaz@fund.com', firstName: 'Carol', lastName: 'Diaz', addedAt: 1 },
      ],
      pendingEmails: [],
    },
  ],
}

test('scaling a shared room conversation to 100% (browser at 0%) keeps RoomPeople outside the LoopBox split container', async () => {
  installRendererHooks()

  const browserGrid: Grid = {
    ...EMPTY_GRID,
    size: { cols: 16, rows: 24 },
    elements: [
      { id: 'f3', panelId: 'pf3', rect: { x: 0, y: 0, w: 8, h: 24 }, z: 1, mode: 'tiled', loop: 'f3' },
      { id: 'e4', panelId: 'pe4', parent: 'f3', rect: { x: 0, y: 0, w: 8, h: 24 }, z: 1, mode: 'tiled', loop: 'f3' },
    ],
    panels: [
      {
        id: 'pf3',
        elementId: 'f3',
        content: { kind: 'frame' },
        state: {},
        output: null,
        summary: null,
        text: null,
        refreshedAt: null,
      },
      {
        id: 'pe4',
        elementId: 'e4',
        content: { kind: 'view', view: 'core/browser' },
        state: { url: 'https://example.com/' },
        output: null,
        summary: null,
        text: null,
        refreshedAt: null,
      },
    ],
    focus: ['f3', 'e4'],
  }

  let currentState = makeState({
    grid: browserGrid,
    loop: {
      id: 'f3',
      desc: 'Market watch',
      brief: 'Monitor headlines.',
      plugins: [],
      skills: [],
      createdAt: 1_700_000_000_000,
      shareId: 'share-1',
    },
    collab: SHARED_COLLAB,
    workspaceShareId: 'share-1',
  })
  const stateSubscribers = new Set<(next: AppState) => void>()
  const emitState = (next: AppState): void => {
    for (const cb of stateSubscribers) cb(next)
  }

  const prevWindow = (globalThis as { window?: unknown }).window
  const prevMatchMedia = (globalThis as { matchMedia?: unknown }).matchMedia
  ;(globalThis as { matchMedia?: unknown }).matchMedia = () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    app: {
      windowNumber: 1,
      initialTabId: null,
      state: {
        onChange: (cb: (next: AppState) => void) => {
          stateSubscribers.add(cb)
          return () => {
            stateSubscribers.delete(cb)
          }
        },
        get: async () => currentState,
        dispatch: async () => undefined,
      },
      agent: {
        onEvent: () => () => undefined,
        running: async () => [],
        history: async () => [],
      },
      browser: {
        onState: () => () => undefined,
        sync: async () => ({
          workspaceId: 'ws-1',
          panelId: 'pe4',
          url: 'https://example.com/',
          title: 'Example',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          error: null,
          text: null,
        }),
        detach: async () => undefined,
      },
    },
  }

  try {
    const stateMod = await import('../../lib/state.ts')
    await stateMod.load()
    emitState(currentState)
    const loopBoxMod = await import('./LoopBox.tsx')
    const boxMod = await import('./box.ts')
    const { ElementFrame } = await import('./ElementFrame.tsx')

    // 1. Shared room with Browser view and conversation scaled to 100% (browser scaled to 0%).
    loopBoxMod.updateTileBox({ workspaceId: 'ws-1', on: 'f3' }, (b) =>
      boxMod.tileBoxSplit(boxMod.tileBoxExpanded(b, true), 1),
    )

    const sharedHtml = renderToStaticMarkup(
      React.createElement(ElementFrame, {
        workspaceId: 'ws-1',
        windowNumber: 1,
        grid: browserGrid,
        element: browserGrid.elements[0]!,
        rect: browserGrid.elements[0]!.rect,
        panel: browserGrid.panels[0],
        active: true,
        focused: true,
        covered: false,
        onGrab: () => undefined,
      }),
    )

    const sharedDoc = parseDocument(sharedHtml)
    const loopBox = findElement(sharedDoc.children, (el) => 'data-loop-box' in el.attribs)
    const board = findElement(sharedDoc.children, (el) => el.attribs['id'] === 'board-f3')
    const roomPeople = findElement(sharedDoc.children, (el) => 'data-room-people' in el.attribs)

    assert.ok(loopBox, 'expected LoopBox to render')
    assert.ok(board, 'expected Board to render')
    assert.ok(roomPeople, 'expected RoomPeople footer strip to render')

    assert.equal(loopBox.attribs['data-open'], 'true')
    assert.equal(loopBox.attribs['data-split'], '100')
    assert.match(loopBox.attribs['style'] ?? '', /height:\s*calc\(100% - 0\.5rem\)/)

    const bodyParent = loopBox.parent as Element | null
    assert.ok(bodyParent && bodyParent.type === 'tag', 'expected LoopBox to have an element parent')
    assert.notEqual(
      roomPeople.parent,
      bodyParent,
      'RoomPeople must sit outside LoopBox parentElement so scaling views to zero never scales or clips teammates',
    )
    assert.equal(board.parent, bodyParent, 'LoopBox and Board must share the scalable room body container')
    assert.equal(
      roomPeople.parent,
      bodyParent.parent,
      'RoomPeople must sit as the footer sibling below the room body container',
    )
    assert.ok(hasClass(bodyParent, 'flex-1'), 'scalable room body must flex to fill space above RoomPeople')
    assert.ok(hasClass(bodyParent, 'min-h-0'), 'scalable room body must allow shrinking above RoomPeople')
    assert.ok(hasClass(bodyParent, 'overflow-hidden'), 'scalable room body must clip within the space above RoomPeople')
    assert.ok(hasClass(roomPeople, 'shrink-0'), 'RoomPeople footer must keep shrink-0 so its height is preserved')

    const badges = findAllElements([roomPeople], (el) => (el.attribs['title'] ?? '').includes('@fund.com'))
    assert.equal(badges.length, 2, 'both shared room teammates remain rendered in RoomPeople')

    // 2. Shared empty room (no views yet, `fills` = true) also keeps RoomPeople below the body container.
    const emptyGrid: Grid = {
      ...EMPTY_GRID,
      size: { cols: 16, rows: 24 },
      elements: [{ id: 'f3', panelId: 'pf3', rect: { x: 0, y: 0, w: 8, h: 24 }, z: 1, mode: 'tiled', loop: 'f3' }],
      panels: [
        {
          id: 'pf3',
          elementId: 'f3',
          content: { kind: 'frame' },
          state: {},
          output: null,
          summary: null,
          text: null,
          refreshedAt: null,
        },
      ],
      focus: ['f3'],
    }
    currentState = makeState({
      grid: emptyGrid,
      loop: currentState.loops['ws-1']![0]!,
      collab: SHARED_COLLAB,
      workspaceShareId: 'share-1',
    })
    emitState(currentState)

    const emptyDoc = parseDocument(
      renderToStaticMarkup(
        React.createElement(ElementFrame, {
          workspaceId: 'ws-1',
          windowNumber: 1,
          grid: emptyGrid,
          element: emptyGrid.elements[0]!,
          rect: emptyGrid.elements[0]!.rect,
          panel: emptyGrid.panels[0],
          active: true,
          focused: true,
          covered: false,
          onGrab: () => undefined,
        }),
      ),
    )
    const emptyLoopBox = findElement(emptyDoc.children, (el) => 'data-loop-box' in el.attribs)
    const emptyPeople = findElement(emptyDoc.children, (el) => 'data-room-people' in el.attribs)
    assert.ok(emptyLoopBox && emptyPeople)
    assert.notEqual(emptyPeople.parent, emptyLoopBox.parent)
    assert.equal(emptyPeople.parent, (emptyLoopBox.parent as Element).parent)

    // 3. Unshared room omits RoomPeople while keeping LoopBox and Board in the room body container.
    currentState = makeState({
      grid: browserGrid,
      loop: {
        id: 'f3',
        desc: 'Local room',
        brief: '',
        plugins: [],
        skills: [],
        createdAt: 1_700_000_000_000,
      },
      collab: EMPTY_COLLAB,
    })
    emitState(currentState)

    const unsharedDoc = parseDocument(
      renderToStaticMarkup(
        React.createElement(ElementFrame, {
          workspaceId: 'ws-1',
          windowNumber: 1,
          grid: browserGrid,
          element: browserGrid.elements[0]!,
          rect: browserGrid.elements[0]!.rect,
          panel: browserGrid.panels[0],
          active: true,
          focused: true,
          covered: false,
          onGrab: () => undefined,
        }),
      ),
    )
    const unsharedLoopBox = findElement(unsharedDoc.children, (el) => 'data-loop-box' in el.attribs)
    const unsharedBoard = findElement(unsharedDoc.children, (el) => el.attribs['id'] === 'board-f3')
    assert.ok(unsharedLoopBox && unsharedBoard)
    assert.equal(unsharedLoopBox.parent, unsharedBoard.parent)
    assert.equal(
      findElement(unsharedDoc.children, (el) => 'data-room-people' in el.attribs),
      null,
    )
    assert.equal(
      findElement(unsharedDoc.children, (el) => 'data-room-budget-paused' in el.attribs),
      null,
    )

    // 4. Room with a budget-paused room task renders the clean non-error header badge.
    currentState = {
      ...currentState,
      tasks: [
        {
          id: 't27',
          workspaceId: 'ws-1',
          roomId: 'f3',
          instructions: 'Refresh sentiment brief',
          call: null,
          executeAt: Date.now() - 60_000,
          every: 900_000,
          at: null,
          speak: 'always',
          model: null,
          enabled: true,
          createdAt: Date.now() - 120_000,
          runs: 3,
          lastRun: { at: Date.now() - 60_000, ok: true, result: 'Updated', ms: 100 },
          nextAt: Date.now() + 36_000_000,
          running: false,
          budgetPausedUntil: Date.now() + 36_000_000,
          commands: [],
          history: [],
        },
      ],
    }
    emitState(currentState)
    const pausedRoomDoc = parseDocument(
      renderToStaticMarkup(
        React.createElement(ElementFrame, {
          workspaceId: 'ws-1',
          windowNumber: 1,
          grid: browserGrid,
          element: browserGrid.elements[0]!,
          rect: browserGrid.elements[0]!.rect,
          panel: browserGrid.panels[0],
          active: true,
          focused: true,
          covered: false,
          onGrab: () => undefined,
        }),
      ),
    )
    const budgetBadge = findElement(pausedRoomDoc.children, (el) => 'data-room-budget-paused' in el.attribs)
    const pausedRoomTitle = findElement(pausedRoomDoc.children, (el) => 'data-room-title' in el.attribs)
    assert.ok(budgetBadge, 'expected room header to show Paused (daily budget) when a room task is budget-paused')
    assert.ok(pausedRoomTitle && hasClass(pausedRoomTitle, 'shrink-0'), 'room title stays readable beside badge')
    assert.ok(hasClass(budgetBadge, 'truncate'), 'budget badge truncates cleanly on narrow tiles without overflowing')
    assert.equal(
      findElement(pausedRoomDoc.children, (el) => 'data-room-header-meta' in el.attribs),
      null,
      'budget badge takes the single header meta slot rather than stacking beside roomAsOf',
    )
  } finally {
    if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = prevWindow
    if (prevMatchMedia === undefined) delete (globalThis as { matchMedia?: unknown }).matchMedia
    else (globalThis as { matchMedia?: unknown }).matchMedia = prevMatchMedia
  }
})
