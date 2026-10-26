import vm from 'node:vm'
import * as zod from 'zod'
import * as sdkDefine from '@jaspers-ai/sdk/define'
import * as sdkSkills from '@jaspers-ai/sdk/skills'
import { validatePluginDefinition, type ValidatedPlugin } from '../../shared/plugins/plugins.ts'

// A plugin's definitions, read by running its build. Main does it to register what the plugin
// defines; the plugin's host does it again to run what the plugin does. The sandbox is the new
// context's global object, so the require shim is the only way in and module, exports, and console
// are the only things out. It contains mistakes, not malice: a vm context can be escaped.

/** Long enough for a definitions file, short enough that a loop in one does not hang the process. */
const EVAL_TIMEOUT_MS = 2000
const MAX_TREE_DEPTH = 48
const MAX_CANDIDATE_STATES = 8

const ELEMENT = Symbol.for('react.element')
const FRAGMENT = Symbol.for('react.fragment')
const SAMPLE_NODE = Symbol.for('jaspers.eval.sample')

interface EvalElement {
  $$typeof: symbol
  type: unknown
  props: Record<string, unknown>
  key: unknown
}

interface RenderContext {
  panel: { id: string; workspaceId: string }
  state: Record<string, unknown> | undefined
  sourceResult: Record<string, unknown>
  liveValue: unknown
  flipState: boolean
  stateIndex: number
  stateOverrides: Map<number, unknown>
  candidates: { index: number; value: unknown }[]
  seenCandidates: Set<string>
}

let activeRender: RenderContext | null = null

const noop = (): void => {}

/**
 * The definitions, read by running them, followed by a smoke render of each declared view so broken
 * components (such as undeclared variable references) fail the build before mounting in the renderer.
 */
export function evaluatePlugin(code: string, id: string): ValidatedPlugin {
  const wrapper = { exports: {} as Record<string, unknown> }
  const sandbox: Record<string, unknown> = {
    module: wrapper,
    exports: wrapper.exports,
    require: (name: string) => {
      const found = MODULES[name]
      if (found) return found
      throw new Error(`Plugins may import only react, zod, and @jaspers-ai/sdk; ${name} is not available`)
    },
    console,
    // The web platform's own pieces a backend needs, none of which reach a file or the network:
    // timers, cancellation, URLs, text encoding, cloning. fetch comes from the context, guarded.
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
  }
  const context = vm.createContext(sandbox)
  activeRender = null
  vm.runInContext(code, context, { timeout: EVAL_TIMEOUT_MS, filename: `${id}/plugin.tsx` })
  const exported = wrapper.exports['default'] ?? wrapper.exports
  const validated = validatePluginDefinition(exported, id)
  if (Object.keys(validated.views).length > 0) {
    checkViewsInContext(validated, sandbox, context)
  }
  return validated
}

/** Runs view smoke checks inside the VM context so the evaluation timeout also guards component execution. */
function checkViewsInContext(validated: ValidatedPlugin, sandbox: Record<string, unknown>, context: vm.Context): void {
  const restore = installBrowserGlobals(sandbox)
  sandbox['__jaspersCheckViews'] = () => checkViews(validated)
  try {
    vm.runInContext('__jaspersCheckViews()', context, {
      timeout: EVAL_TIMEOUT_MS,
      filename: `${validated.id}/plugin.tsx`,
    })
  } finally {
    activeRender = null
    delete sandbox['__jaspersCheckViews']
    restore()
  }
}

/** Smoke-renders each view across its lifecycle states and checks its summarize callback. */
function checkViews(validated: ValidatedPlugin): void {
  const panel = { id: 'p1', workspaceId: 'ws1' }
  for (const [name, view] of Object.entries(validated.views)) {
    const viewId = `${validated.id}/${name}`
    const defaultState = sampleFromSchema(view.state, false)
    const populatedState = sampleFromSchema(view.state, true)

    if (typeof view.summarize === 'function') {
      const defaultOutput = sampleFromSchema(view.output, false)
      const strictSummary =
        Boolean(view.state.safeParse(defaultState).success) && Boolean(view.output.safeParse(defaultOutput).success)
      try {
        view.summarize(defaultState, defaultOutput)
      } catch (err) {
        if (strictSummary || isFatalSyntheticError(err)) {
          throw new Error(formatViewError(viewId, err))
        }
      }
    }

    const loadingResult = {
      data: undefined,
      loading: true,
      error: null,
      datasetId: null,
      meta: {},
      refetch: noop,
    }
    const emptyResult = {
      data: [],
      loading: false,
      error: null,
      datasetId: 'check',
      meta: {},
      refetch: noop,
    }
    const errorResult = {
      data: undefined,
      loading: false,
      error: 'Source failed',
      datasetId: null,
      meta: {},
      refetch: noop,
    }

    const strictStates: (Record<string, unknown> | undefined)[] = [undefined, defaultState]
    if (
      JSON.stringify(populatedState) !== JSON.stringify(defaultState) &&
      view.state.safeParse(populatedState).success
    ) {
      strictStates.push(populatedState)
    }

    for (const state of strictStates) {
      const results = state === undefined ? [loadingResult] : [loadingResult, emptyResult, errorResult]
      for (const sourceResult of results) {
        runViewPass(viewId, view.component, {
          panel,
          state,
          sourceResult,
          liveValue: undefined,
          flipState: false,
          stateOverrides: new Map(),
          strict: true,
          collectInteractions: false,
        })
      }
    }

    const sampleRows = createSampleRows(0)
    const sampleMeta = createSampleProxy(0) as Record<string, unknown>
    const populatedResult = {
      data: sampleRows,
      loading: false,
      error: null,
      datasetId: 'check',
      meta: sampleMeta,
      refetch: noop,
    }
    const candidates = runViewPass(viewId, view.component, {
      panel,
      state: populatedState,
      sourceResult: populatedResult,
      liveValue: undefined,
      flipState: false,
      stateOverrides: new Map(),
      strict: false,
      collectInteractions: true,
    })

    const flippedCandidates = runViewPass(viewId, view.component, {
      panel,
      state: populatedState,
      sourceResult: { ...populatedResult, text: 'sample' },
      liveValue: createSampleProxy(0),
      flipState: true,
      stateOverrides: new Map(),
      strict: false,
      collectInteractions: true,
    })

    const allCandidates = [...candidates, ...flippedCandidates].slice(0, MAX_CANDIDATE_STATES)
    for (const candidate of allCandidates) {
      runViewPass(viewId, view.component, {
        panel,
        state: populatedState,
        sourceResult: populatedResult,
        liveValue: createSampleProxy(0),
        flipState: false,
        stateOverrides: new Map([[candidate.index, candidate.value]]),
        strict: false,
        collectInteractions: false,
      })
    }
  }
}

interface PassOptions {
  panel: { id: string; workspaceId: string }
  state: Record<string, unknown> | undefined
  sourceResult: Record<string, unknown>
  liveValue: unknown
  flipState: boolean
  stateOverrides: Map<number, unknown>
  strict: boolean
  collectInteractions: boolean
}

function runViewPass(viewId: string, component: unknown, options: PassOptions): { index: number; value: unknown }[] {
  const ctx: RenderContext = {
    panel: options.panel,
    state: options.state,
    sourceResult: options.sourceResult,
    liveValue: options.liveValue,
    flipState: options.flipState,
    stateIndex: 0,
    stateOverrides: options.stateOverrides,
    candidates: [],
    seenCandidates: new Set(),
  }
  const visited = new WeakSet<object>()
  activeRender = ctx
  try {
    const root = createElement(component, { panel: options.panel })
    walkNode(root, 0, visited, options.strict, options.collectInteractions)
  } catch (err) {
    if (options.strict || isFatalSyntheticError(err)) {
      throw new Error(formatViewError(viewId, err))
    }
  } finally {
    activeRender = null
  }
  return ctx.candidates
}

function walkNode(
  node: unknown,
  depth: number,
  visited: WeakSet<object>,
  strict: boolean,
  collectInteractions: boolean,
): void {
  if (depth > MAX_TREE_DEPTH) return
  if (
    node === null ||
    node === undefined ||
    typeof node === 'boolean' ||
    typeof node === 'string' ||
    typeof node === 'number' ||
    typeof node === 'bigint' ||
    typeof node === 'symbol'
  ) {
    return
  }
  if (isSampleNode(node)) return
  if (Array.isArray(node)) {
    for (const child of node) walkNode(child, depth + 1, visited, strict, collectInteractions)
    return
  }
  if (typeof node !== 'object') return

  if ((node as { $$typeof?: unknown }).$$typeof === ELEMENT) {
    if (visited.has(node)) return
    visited.add(node)
    const element = node as EvalElement
    const { type, props } = element

    if (typeof type === 'function') {
      const proto = (type as { prototype?: { render?: unknown } }).prototype
      let rendered: unknown
      try {
        rendered =
          proto && typeof proto.render === 'function'
            ? new (type as new (p: Record<string, unknown>) => { render(): unknown })(props).render()
            : (type as (p: Record<string, unknown>) => unknown)(props)
      } catch (err) {
        if (strict || isFatalSyntheticError(err)) throw err
        walkNode(props['children'], depth + 1, visited, false, collectInteractions)
        return
      }
      walkNode(rendered, depth + 1, visited, strict, collectInteractions)
      walkNode(props['children'], depth + 1, visited, false, collectInteractions)
      return
    }

    if (typeof type === 'object' && type !== null && '_currentValue' in type) {
      const ctxObj = type as { _currentValue: unknown; _defaultValue: unknown }
      const previous = ctxObj._currentValue
      ctxObj._currentValue = 'value' in props ? props['value'] : ctxObj._defaultValue
      try {
        walkNode(props['children'], depth + 1, visited, strict, collectInteractions)
      } finally {
        ctxObj._currentValue = previous
      }
      return
    }

    if (collectInteractions && typeof type === 'string') {
      exerciseElementHandlers(type, props)
    }

    walkNode(props['children'], depth + 1, visited, strict, collectInteractions)
  }
}

function exerciseElementHandlers(tag: string, props: Record<string, unknown>): void {
  const onClick = props['onClick']
  if (typeof onClick === 'function') {
    invokeSyntheticHandler(() => onClick(syntheticEvent('')))
  }
  const onChange = props['onChange']
  if (typeof onChange === 'function') {
    if (tag === 'select') {
      for (const value of collectOptionValues(props['children'])) {
        invokeSyntheticHandler(() => onChange(syntheticEvent(value)))
      }
    } else {
      invokeSyntheticHandler(() => onChange(syntheticEvent('sample')))
    }
  }
}

function invokeSyntheticHandler(fn: () => unknown): void {
  try {
    fn()
  } catch (err) {
    if (isFatalSyntheticError(err)) throw err
  }
}

function collectOptionValues(node: unknown, out: string[] = []): string[] {
  if (!node || isSampleNode(node)) return out
  if (Array.isArray(node)) {
    for (const child of node) collectOptionValues(child, out)
    return out
  }
  if (typeof node === 'object' && (node as { $$typeof?: unknown }).$$typeof === ELEMENT) {
    const element = node as EvalElement
    if (element.type === 'option' && typeof element.props['value'] === 'string') {
      out.push(element.props['value'])
    }
    collectOptionValues(element.props['children'], out)
  }
  return out
}

function syntheticEvent(value: string): Record<string, unknown> {
  const target = { value, checked: true, dataset: {} }
  return {
    target,
    currentTarget: target,
    preventDefault: noop,
    stopPropagation: noop,
  }
}

/** True for errors that always indicate a broken view regardless of synthetic data shape. */
function isFatalSyntheticError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: unknown }).name
  const message = typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : ''
  return name === 'ReferenceError' || name === 'SyntaxError' || message.includes('cannot run here')
}

function formatViewError(viewId: string, err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const name = typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : 'Error'
    const message =
      typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : String(err)
    const detail = name && name !== 'Error' && !message.startsWith(name) ? `${name}: ${message}` : message
    const fn = componentInStack((err as { stack?: unknown }).stack)
    return fn ? `View ${viewId} (in ${fn}): ${detail}` : `View ${viewId}: ${detail}`
  }
  return `View ${viewId}: ${String(err)}`
}

function componentInStack(stack: unknown): string | null {
  if (typeof stack !== 'string') return null
  for (const line of stack.split('\n')) {
    const match = /^\s*at\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+\([^)]*\/plugin\.tsx:/.exec(line)
    const fn = match?.[1]
    if (fn && fn !== '__jaspersCheckViews' && fn !== 'eval') return fn
  }
  return null
}

/** Builds a sample state or output object from a Zod schema, optionally populating empty array fields. */
function sampleFromSchema(schema: unknown, populateArrays: boolean): Record<string, unknown> {
  const parsed = (schema as { safeParse?: (v: unknown) => { success: boolean; data?: unknown } })?.safeParse?.({})
  const base =
    parsed?.success && typeof parsed.data === 'object' && parsed.data !== null && !Array.isArray(parsed.data)
      ? { ...(parsed.data as Record<string, unknown>) }
      : {}
  try {
    const json = zod.toJSONSchema(schema as zod.ZodType, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >
    const generated = sampleFromJsonSchema(json, populateArrays)
    if (typeof generated === 'object' && generated !== null && !Array.isArray(generated)) {
      const merged: Record<string, unknown> = { ...(generated as Record<string, unknown>), ...base }
      if (populateArrays) {
        const props =
          typeof json['properties'] === 'object' && json['properties'] !== null
            ? (json['properties'] as Record<string, unknown>)
            : {}
        for (const [key, propSchema] of Object.entries(props)) {
          if (Array.isArray(merged[key]) && (merged[key] as unknown[]).length === 0) {
            const populated = sampleFromJsonSchema(propSchema, true)
            if (Array.isArray(populated) && populated.length > 0) merged[key] = populated
          }
        }
      }
      return merged
    }
  } catch {
    // Non-Zod test stub schema: base is sufficient.
  }
  return base
}

function sampleFromJsonSchema(schema: unknown, populateArrays: boolean): unknown {
  if (typeof schema !== 'object' || schema === null) return undefined
  const s = schema as Record<string, unknown>
  if ('default' in s && s['default'] !== undefined) {
    if (populateArrays && Array.isArray(s['default']) && s['default'].length === 0 && s['items']) {
      return [sampleFromJsonSchema(s['items'], true) ?? 'AAPL']
    }
    return s['default']
  }
  if ('const' in s) return s['const']
  if (Array.isArray(s['enum']) && s['enum'].length > 0) return s['enum'][0]
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = s[key]
    if (Array.isArray(branches) && branches.length > 0) {
      const nonNull = branches.find((b) => (b as { type?: unknown })?.type !== 'null') ?? branches[0]
      return sampleFromJsonSchema(nonNull, populateArrays)
    }
  }
  const type = Array.isArray(s['type']) ? s['type'].find((t) => t !== 'null') : s['type']
  switch (type) {
    case 'string':
      return 'AAPL'
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return false
    case 'array':
      return populateArrays ? [sampleFromJsonSchema(s['items'], true) ?? 'AAPL'] : []
    case 'object': {
      const out: Record<string, unknown> = {}
      const props =
        typeof s['properties'] === 'object' && s['properties'] !== null
          ? (s['properties'] as Record<string, unknown>)
          : {}
      for (const [k, v] of Object.entries(props)) {
        const val = sampleFromJsonSchema(v, populateArrays)
        if (val !== undefined) out[k] = val
      }
      return out
    }
    default:
      return null
  }
}

function isSampleNode(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    (value as Record<symbol, unknown>)[SAMPLE_NODE] === true
  )
}

/** Creates a 1-row array whose filter/slice/sort preserve a sample row so chained filters still render rows. */
function createSampleRows(depth: number): Record<string, unknown>[] {
  if (depth >= 4) return []
  const row = createSampleProxy(depth) as Record<string, unknown>
  const arr = [row]
  Object.defineProperty(arr, 'filter', {
    value: (fn: (item: unknown, index: number, array: unknown[]) => unknown) => {
      if (typeof fn === 'function') fn(row, 0, arr)
      return createSampleRows(depth + 1)
    },
  })
  Object.defineProperty(arr, 'slice', {
    value: () => createSampleRows(depth + 1),
  })
  Object.defineProperty(arr, 'sort', {
    value: (fn?: (a: unknown, b: unknown) => number) => {
      if (typeof fn === 'function') fn(row, row)
      return arr
    },
  })
  return arr
}

/** A forgiving value for synthetic row passes so property reads and formatting calls do not abort before reaching JSX. */
function createSampleProxy(depth: number): unknown {
  if (depth > 5) return 'sample'
  const base = (): unknown => createSampleProxy(depth + 1)
  base.value = 1
  const proxy: unknown = new Proxy(base, {
    get(_target, prop) {
      if (prop === SAMPLE_NODE) return true
      if (prop === '$$typeof' || prop === 'then') return undefined
      if (prop === Symbol.toPrimitive) return (hint: string) => (hint === 'string' ? 'sample' : 1)
      if (prop === 'valueOf') return () => 1
      if (prop === 'toString') return () => 'sample'
      if (prop === 'toJSON') return () => ({ id: 'sample', value: 1 })
      if (prop === Symbol.iterator) {
        return function* () {
          if (depth < 2) yield createSampleProxy(depth + 1)
        }
      }
      switch (prop) {
        case 'toFixed':
          return () => '1.00'
        case 'toLocaleString':
          return () => '1'
        case 'toPrecision':
          return () => '1.0'
        case 'toExponential':
          return () => '1e+0'
        case 'toUpperCase':
          return () => 'SAMPLE'
        case 'toLowerCase':
        case 'trim':
        case 'trimStart':
        case 'trimEnd':
        case 'padStart':
        case 'padEnd':
        case 'replace':
        case 'replaceAll':
        case 'substring':
          return () => 'sample'
        case 'charAt':
          return () => 's'
        case 'split':
          return () => ['sample']
        case 'startsWith':
        case 'endsWith':
        case 'includes':
          return () => true
        case 'match':
          return () => null
        case 'length':
        case 'size':
          return depth < 2 ? 1 : 0
        case 'map':
          return (fn: (item: unknown, i: number, a: unknown[]) => unknown) =>
            depth < 2 ? [fn(createSampleProxy(depth + 1), 0, [])] : []
        case 'flatMap':
          return (fn: (item: unknown, i: number, a: unknown[]) => unknown) => {
            if (depth >= 2) return []
            const res = fn(createSampleProxy(depth + 1), 0, [])
            return Array.isArray(res) ? res : [res]
          }
        case 'filter':
          return (fn: (item: unknown, i: number, a: unknown[]) => unknown) => {
            if (depth >= 2) return []
            const item = createSampleProxy(depth + 1)
            fn(item, 0, [])
            return [item]
          }
        case 'forEach':
          return (fn: (item: unknown, i: number, a: unknown[]) => unknown) => {
            if (depth < 2) fn(createSampleProxy(depth + 1), 0, [])
          }
        case 'find':
          return (fn: (item: unknown, i: number, a: unknown[]) => unknown) => {
            if (depth >= 2) return undefined
            const item = createSampleProxy(depth + 1)
            fn(item, 0, [])
            return item
          }
        case 'some':
        case 'every':
          return (fn: (item: unknown, i: number, a: unknown[]) => unknown) => {
            if (depth < 2) fn(createSampleProxy(depth + 1), 0, [])
            return true
          }
        case 'reduce':
          return (fn: (acc: unknown, item: unknown, i: number, a: unknown[]) => unknown, init?: unknown) =>
            depth < 2 ? fn(init ?? createSampleProxy(depth + 1), createSampleProxy(depth + 1), 0, []) : init
        case 'slice':
        case 'concat':
        case 'sort':
        case 'reverse':
        case 'flat':
          return () => (depth < 2 ? [createSampleProxy(depth + 1)] : [])
        case 'join':
          return () => 'sample'
        default:
          return createSampleProxy(depth + 1)
      }
    },
  })
  return proxy
}

function installBrowserGlobals(sandbox: Record<string, unknown>): () => void {
  const matchMedia = (query: string) => ({
    matches: false,
    media: String(query),
    onchange: null,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  })
  class StubObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const additions: Record<string, unknown> = {
    matchMedia,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    ResizeObserver: StubObserver,
    IntersectionObserver: StubObserver,
    MutationObserver: StubObserver,
    devicePixelRatio: 1,
    innerWidth: 800,
    innerHeight: 600,
    navigator: { language: 'en-US', userAgent: 'JaspersTerminal', clipboard: { writeText: async () => {} } },
    performance,
    crypto,
  }
  const added: string[] = []
  for (const [key, value] of Object.entries(additions)) {
    if (!(key in sandbox)) {
      sandbox[key] = value
      added.push(key)
    }
  }
  return () => {
    for (const key of added) delete sandbox[key]
  }
}

/** Ensures a hook is called only while rendering a view component. */
function requireRender(name: string): RenderContext {
  if (!activeRender) {
    throw new Error(`${name} cannot run here; components render only in views`)
  }
  return activeRender
}

function createElement(type: unknown, rawProps?: Record<string, unknown> | null, ...children: unknown[]): EvalElement {
  const props: Record<string, unknown> = { ...(rawProps ?? {}) }
  if (children.length === 1) props['children'] = children[0]
  else if (children.length > 1) props['children'] = children
  const key = props['key'] ?? null
  return { $$typeof: ELEMENT, type, props, key }
}

function jsx(type: unknown, rawProps?: Record<string, unknown> | null, key?: unknown): EvalElement {
  return {
    $$typeof: ELEMENT,
    type,
    props: (rawProps ?? {}) as Record<string, unknown>,
    key: key ?? null,
  }
}

class ReactComponent {
  props: Record<string, unknown>
  state: unknown = {}
  context: unknown = undefined
  refs: Record<string, unknown> = {}
  constructor(props: Record<string, unknown>, context?: unknown) {
    this.props = props
    this.context = context
  }
  setState(): void {}
  forceUpdate(): void {}
}
;(ReactComponent.prototype as unknown as Record<string, unknown>)['isReactComponent'] = {}

const reactChildren = {
  toArray(children: unknown): unknown[] {
    if (children === null || children === undefined || typeof children === 'boolean') return []
    return Array.isArray(children) ? children.flat() : [children]
  },
  map(children: unknown, fn: (child: unknown, index: number) => unknown): unknown[] {
    return reactChildren.toArray(children).map(fn)
  },
  forEach(children: unknown, fn: (child: unknown, index: number) => void): void {
    reactChildren.toArray(children).forEach(fn)
  },
  count(children: unknown): number {
    return reactChildren.toArray(children).length
  },
  only(children: unknown): unknown {
    const arr = reactChildren.toArray(children)
    if (arr.length !== 1) throw new Error('React.Children.only expected to receive a single React element child.')
    return arr[0]
  },
}

const reactStub = {
  Component: ReactComponent,
  PureComponent: ReactComponent,
  Children: reactChildren,
  createElement,
  cloneElement: (element: EvalElement, nextProps?: Record<string, unknown> | null, ...children: unknown[]) =>
    createElement(element?.type, { ...(element?.props ?? {}), ...(nextProps ?? {}) }, ...children),
  isValidElement: (value: unknown) =>
    typeof value === 'object' && value !== null && (value as { $$typeof?: unknown }).$$typeof === ELEMENT,
  createRef: () => ({ current: null }),
  Fragment: FRAGMENT,
  StrictMode: FRAGMENT,
  Suspense: FRAGMENT,
  Profiler: FRAGMENT,
  createContext: (defaultValue: unknown) => {
    const ctx = {
      _currentValue: defaultValue,
      _defaultValue: defaultValue,
      Provider: null as unknown,
      Consumer: ({ children }: { children?: unknown }) =>
        typeof children === 'function' ? (children as (v: unknown) => unknown)(ctx._currentValue) : null,
    }
    ctx.Provider = ctx
    return ctx
  },
  forwardRef: (component: unknown) => component,
  memo: (component: unknown) => component,
  lazy: (loader: unknown) => loader,
  startTransition: (fn: () => void) => void fn(),
  useState: (init?: unknown) => {
    const ctx = requireRender('useState')
    const idx = ctx.stateIndex++
    const resolved = typeof init === 'function' ? (init as () => unknown)() : init
    let value: unknown
    if (ctx.stateOverrides.has(idx)) {
      value = ctx.stateOverrides.get(idx)
    } else if (ctx.flipState && resolved === false) {
      value = true
    } else if (ctx.flipState && (resolved === null || resolved === undefined)) {
      value = createSampleProxy(0)
    } else {
      value = resolved
    }
    const set = (next: unknown): void => {
      const nextVal = typeof next === 'function' ? (next as (prev: unknown) => unknown)(value) : next
      if (nextVal === value || ctx.candidates.length >= MAX_CANDIDATE_STATES) return
      let key: string
      try {
        key = `${idx}:${JSON.stringify(nextVal)}`
      } catch {
        return
      }
      if (!ctx.seenCandidates.has(key)) {
        ctx.seenCandidates.add(key)
        ctx.candidates.push({ index: idx, value: nextVal })
      }
    }
    return [value, set]
  },
  useEffect: (_fn?: unknown) => {
    requireRender('useEffect')
  },
  useLayoutEffect: (_fn?: unknown) => {
    requireRender('useLayoutEffect')
  },
  useInsertionEffect: (_fn?: unknown) => {
    requireRender('useInsertionEffect')
  },
  useImperativeHandle: () => {
    requireRender('useImperativeHandle')
  },
  useDebugValue: () => {
    requireRender('useDebugValue')
  },
  useMemo: (fn: () => unknown) => {
    requireRender('useMemo')
    return fn()
  },
  useRef: (init?: unknown) => {
    requireRender('useRef')
    return { current: init }
  },
  useCallback: (fn: unknown) => {
    requireRender('useCallback')
    return fn
  },
  useContext: (context: unknown) => {
    requireRender('useContext')
    return (context as { _currentValue?: unknown } | null | undefined)?._currentValue
  },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => {
    requireRender('useSyncExternalStore')
    return getSnapshot()
  },
  useReducer: (_reducer: unknown, initialArg: unknown, init?: unknown) => {
    requireRender('useReducer')
    const value = typeof init === 'function' ? (init as (arg: unknown) => unknown)(initialArg) : initialArg
    return [value, noop]
  },
  useId: () => {
    requireRender('useId')
    return ':r0:'
  },
  useTransition: () => {
    requireRender('useTransition')
    return [false, (fn: () => void) => void fn()]
  },
  useDeferredValue: (value: unknown) => {
    requireRender('useDeferredValue')
    return value
  },
  useOptimistic: (passthrough: unknown) => {
    requireRender('useOptimistic')
    return [passthrough, noop]
  },
  useActionState: (_fn: unknown, initialState: unknown) => {
    requireRender('useActionState')
    return [initialState, noop, false]
  },
  use: (usable: unknown) => {
    requireRender('use')
    if (typeof usable === 'object' && usable !== null && '_currentValue' in usable) {
      return (usable as { _currentValue: unknown })._currentValue
    }
    return undefined
  },
}

const stubBridge = {
  get: async () => undefined,
  subscribe: () => noop,
  setState: async () => {},
  publish: async () => {},
  publishText: async () => {},
  runSource: async () => ({ kind: 'dataset', datasetId: 'check', rowCount: 0, columns: [], meta: {} }),
  datasetRows: async () => [],
  openLink: async () => {},
  copyText: async () => {},
  startDictation: async () => {},
  stopDictation: async () => '',
  cancelDictation: async () => {},
}

/** The SDK as a process without views can offer it, with hooks active only during view validation renders. */
const sdkForBackend = {
  ...sdkDefine,
  ...sdkSkills,
  BridgeProvider: ({ children }: { children?: unknown }) => children ?? null,
  PanelProvider: ({ children }: { children?: unknown }) => children ?? null,
  useBridge: () => {
    requireRender('useBridge')
    return stubBridge
  },
  usePanel: () => {
    const ctx = requireRender('usePanel')
    return ctx.panel
  },
  usePanelState: (_panel: unknown, key: string, init: unknown) => {
    const ctx = requireRender('usePanelState')
    const fromState = ctx.state && key in ctx.state && ctx.state[key] !== undefined ? ctx.state[key] : init
    return [fromState, noop]
  },
  usePublish: (_panel: unknown, output: unknown) => {
    requireRender('usePublish')
    JSON.stringify(output)
  },
  usePublishText: (_panel: unknown, _text: unknown) => {
    requireRender('usePublishText')
  },
  useData: (target: string, ...rest: [unknown?]) => {
    const ctx = requireRender('useData')
    if (rest.length > 0) {
      if (!target) {
        return { data: undefined, loading: false, error: null, datasetId: null, meta: {}, refetch: noop }
      }
      return ctx.sourceResult
    }
    if (typeof target === 'string') {
      if (target.endsWith('/state')) return ctx.state
      const stateIdx = target.indexOf('/state/')
      if (stateIdx !== -1) {
        const key = target.slice(stateIdx + '/state/'.length)
        return ctx.state?.[key]
      }
      if (target.startsWith('live/')) return ctx.liveValue
    }
    return undefined
  },
  useDictation: () => {
    requireRender('useDictation')
    return {
      state: 'idle' as const,
      error: null,
      start: async () => {},
      stop: async () => '',
      cancel: async () => {},
    }
  },
}

const reactDomStub = {
  createPortal: (children: unknown) => children,
  flushSync: (fn: () => unknown) => fn(),
}

/** The five names a plugin may import. zod is this process's own, so the schemas a plugin builds are ones it can run. */
const MODULES: Record<string, unknown> = {
  react: { ...reactStub, default: reactStub },
  'react/jsx-runtime': { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: FRAGMENT },
  'react-dom': { ...reactDomStub, default: reactDomStub },
  'react-dom/client': {},
  '@jaspers-ai/sdk': { ...sdkForBackend, default: sdkForBackend },
  zod: { ...zod, default: zod },
}
