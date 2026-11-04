import { Component, useEffect, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BridgeProvider, PanelProvider, type Bridge, type PanelRef } from '@jaspers-ai/sdk'
import { createIframeBridge, WorkingProvider } from '@jaspers-ai/sdk/host'
import { clampZoom, ZOOM_DEFAULT } from '../shared/grid/grid'
import { mathSegments, type MathNode } from '../renderer/components/composer/markdown'
import { watchDocumentUse } from '../renderer/lib/eye'

// What runs in the iframe: the query says which view of which panel this frame is, the plugin's own
// bundle comes from the same origin, and its component mounts under a bridge that reaches the app
// over postMessage. Nothing else loads here, so anything that fails is written into the page and
// reported to the host so the panel records why it failed.

/** A plugin's bundle, as far as this file cares: the definition its plugin.tsx exported. */
interface PluginModule {
  default?: { views?: Record<string, { component?: unknown }> }
}

export async function boot(): Promise<void> {
  let failMounted: ((error: unknown) => void) | null = null
  const onUncaught = (error: unknown): void => {
    failMounted?.(error)
    tell(error)
  }
  // What goes wrong or is clicked, typed, or zoomed in the view is told to the page around it, which records it on the panel and tells Eye while it records.
  window.addEventListener('error', (event) => onUncaught(event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => onUncaught(event.reason))
  watchDocumentUse(
    (params) => window.parent.postMessage({ method: 'view.eye', params }, '*'),
    () => true,
    (dir) => {
      window.parent.postMessage({ method: 'view.zoom', params: { name: dir } }, '*')
    },
  )
  const query = new URLSearchParams(location.search)
  applyDocumentZoom(Number(query.get('zoom')))
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent) return
    const data = event.data as { method?: unknown; params?: { zoom?: unknown } } | null
    if (data?.method === 'zoom') applyDocumentZoom(data.params?.zoom)
  })
  const view = query.get('view') ?? ''
  const panel: PanelRef = { id: query.get('panel') ?? '', workspaceId: query.get('workspace') ?? '' }
  const initialWorking = query.get('working') === '1'
  const root = document.getElementById('root')
  if (!root) return
  watchPluginMath(root)
  try {
    const bridge = createIframeBridge()
    // Relative to this page, so it is the plugin's own bundle: jaspers-plugin://<id>/bundle.js.
    // Prime the panel's state in parallel so useData and usePanelState have it on first render.
    const [loaded] = await Promise.all([
      import(new URL('bundle.js', location.href).href) as Promise<PluginModule>,
      panel.workspaceId && panel.id
        ? bridge.get(`workspaces/${panel.workspaceId}/panels/${panel.id}/state`).catch(() => undefined)
        : Promise.resolve(undefined),
    ])
    const component = loaded.default?.views?.[view]?.component as ComponentType<{ panel: PanelRef }> | undefined
    if (!component) throw new Error(`No view "${view}" in this plugin`)
    createRoot(root).render(
      <BridgeProvider value={bridge}>
        <PanelProvider value={panel}>
          <MountedView
            bridge={bridge}
            panel={panel}
            View={component}
            initialWorking={initialWorking}
            onMountFail={(listener) => {
              failMounted = listener
            }}
          />
        </PanelProvider>
      </BridgeProvider>,
    )
  } catch (err) {
    root.textContent = err instanceof Error ? err.message : String(err)
    tell(err)
  }
}

function MountedView({
  bridge,
  panel,
  View,
  initialWorking,
  onMountFail,
}: {
  bridge: Bridge
  panel: PanelRef
  View: ComponentType<{ panel: PanelRef }>
  initialWorking: boolean
  onMountFail: (listener: ((error: unknown) => void) | null) => void
}): ReactElement {
  const [attempt, setAttempt] = useState(0)
  const [uncaught, setUncaught] = useState<string | null>(null)
  const [working, setWorking] = useState(initialWorking)
  const failed = useRef(false)
  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (event.source !== window.parent) return
      const message = event.data as { method?: unknown; params?: { working?: unknown } } | null
      if (message?.method === 'working' && typeof message.params?.working === 'boolean') {
        setWorking(message.params.working)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  useEffect(() => {
    onMountFail((error) => {
      failed.current = true
      setUncaught(error instanceof Error ? error.message : String(error))
    })
    return () => onMountFail(null)
  }, [onMountFail])
  useEffect(() => {
    const retry = (): void => {
      if (!failed.current) return
      failed.current = false
      setUncaught(null)
      setAttempt((n) => n + 1)
    }
    const watch = (path: string): (() => void) => {
      let seen = false
      return bridge.subscribe(path, () => {
        if (!seen) {
          seen = true
          return
        }
        retry()
      })
    }
    let hadError = false
    const offError = bridge.subscribe(`workspaces/${panel.workspaceId}/panels/${panel.id}/error`, (next) => {
      const hasError = typeof next === 'string' && next.length > 0
      if (hasError) failed.current = true
      else if (hadError) retry()
      hadError = hasError
    })
    const offs = [
      watch(`workspaces/${panel.workspaceId}/panels/${panel.id}/state`),
      watch(`workspaces/${panel.workspaceId}/panels/${panel.id}/refreshedAt`),
      offError,
    ]
    return () => offs.forEach((off) => off())
  }, [bridge, panel.workspaceId, panel.id])
  return (
    <WorkingProvider value={working}>
      <ViewBoundary
        attempt={attempt}
        uncaught={uncaught}
        working={working}
        onCaught={() => {
          failed.current = true
        }}
      >
        <View key={attempt} panel={panel} />
      </ViewBoundary>
    </WorkingProvider>
  )
}

class ViewBoundary extends Component<
  { attempt: number; uncaught: string | null; working: boolean; onCaught: () => void; children: ReactNode },
  { error: string | null }
> {
  override state: { error: string | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown): void {
    this.props.onCaught()
    tell(error)
  }

  override componentDidUpdate(prevProps: {
    attempt: number
    uncaught: string | null
    working: boolean
    onCaught: () => void
    children: ReactNode
  }): void {
    if (prevProps.attempt !== this.props.attempt && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  override render(): ReactNode {
    const shown = this.state.error ?? this.props.uncaught
    return shown === null ? this.props.children : this.props.working ? null : shown
  }
}

function tell(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? null) : null
  window.parent.postMessage({ method: 'view.error', params: { message, stack } }, '*')
}

function applyDocumentZoom(raw: unknown): void {
  const zoom = clampZoom(raw)
  document.documentElement.style.zoom = zoom === ZOOM_DEFAULT ? '' : String(zoom)
  if (document.body) {
    document.body.style.fontSize = zoom === ZOOM_DEFAULT ? '' : `${Math.round(14 * zoom * 100) / 100}px`
  }
}

const SKIP_MATH_PARENTS = 'code, pre, textarea, input, script, style, .jp-math'
const TIGHT_DOM_SYMBOLS = new Set([
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ';',
  ':',
  '!',
  '?',
  '%',
  '′',
  '°',
  '|',
  '‖',
  '/',
  '⟨',
  '⟩',
  '⌊',
  '⌋',
  '⌈',
  '⌉',
  '\u00a0',
])

/** Upgrades inline and display LaTeX math inside plugin markdown containers (`.md-doc`, `.ag-md`, `.rs-md`). */
function watchPluginMath(root: HTMLElement): void {
  let running = false
  const run = (): void => {
    if (running) return
    running = true
    try {
      const containers = root.querySelectorAll<HTMLElement>('.md-doc, .ag-md, .rs-md')
      for (const container of containers) renderContainerMath(container)
    } finally {
      running = false
    }
  }
  const observer = new MutationObserver(run)
  observer.observe(root, { childList: true, subtree: true, characterData: true })
}

function renderContainerMath(container: HTMLElement): void {
  for (const block of container.querySelectorAll<HTMLElement>('p, li, td, th, h1, h2, h3, h4, h5, h6')) {
    restoreMathUnderscores(block)
  }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || parent.closest(SKIP_MATH_PARENTS)) continue
    const value = node.nodeValue ?? ''
    if (value.includes('$') || value.includes('\\(') || value.includes('\\[')) textNodes.push(node as Text)
  }
  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? ''
    const segments = mathSegments(value)
    if (!segments.some((seg) => seg.kind === 'math')) continue
    const frag = document.createDocumentFragment()
    for (const seg of segments) {
      if (seg.kind === 'text') {
        frag.appendChild(document.createTextNode(seg.text))
      } else {
        frag.appendChild(buildMathDom(seg.tex, seg.math, seg.display))
      }
    }
    textNode.replaceWith(frag)
  }
}

/** Restores `_..._` subscripts that a plugin's CommonMark parser turned into `<em>` across `$...$` spans. */
function restoreMathUnderscores(block: HTMLElement): void {
  if (!block.querySelector('em')) return
  let openDollar = false
  let changed = false
  for (const child of [...block.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.nodeValue ?? ''
      const count = (text.match(/(?<!\\)\$/g) ?? []).length
      if (count % 2 === 1) openDollar = !openDollar
    } else if (openDollar && child instanceof HTMLElement && child.tagName === 'EM' && child.childElementCount === 0) {
      const emText = child.textContent ?? ''
      const count = (emText.match(/(?<!\\)\$/g) ?? []).length
      if (count % 2 === 1) openDollar = !openDollar
      child.replaceWith(document.createTextNode(`_${emText}_`))
      changed = true
    }
  }
  if (changed) block.normalize()
}

function buildMathDom(tex: string, math: MathNode[], display: boolean): HTMLElement {
  const outer = document.createElement(display ? 'div' : 'span')
  outer.className = `jp-math ${display ? 'jp-math-block' : 'jp-math-inline'}`
  outer.setAttribute('aria-label', tex)
  outer.setAttribute(display ? 'data-math-block' : 'data-math', display ? '' : 'inline')
  const row = document.createElement('span')
  row.className = 'jp-math-row'
  appendMathDomNodes(row, math)
  outer.appendChild(row)
  return outer
}

function appendMathDomNodes(parent: HTMLElement, nodes: MathNode[]): void {
  for (const node of nodes) {
    parent.appendChild(buildMathDomNode(node))
  }
}

function buildMathDomNode(node: MathNode): HTMLElement {
  switch (node.kind) {
    case 'text': {
      const span = document.createElement('span')
      const numeric = /^\d+(?:\.\d+)?$/.test(node.text)
      span.className =
        node.style === 'bold'
          ? 'jp-math-bold'
          : node.style === 'italic'
            ? 'jp-math-italic'
            : node.style === 'mono'
              ? 'jp-math-mono'
              : node.style === 'cal'
                ? 'jp-math-cal'
                : node.style === 'normal' || node.style === 'bb' || numeric
                  ? 'jp-math-normal'
                  : 'jp-math-var'
      span.textContent = node.text
      return span
    }
    case 'symbol': {
      const span = document.createElement('span')
      const tight = TIGHT_DOM_SYMBOLS.has(node.text) || /^[α-ωΑ-Ω∂∇∞ℓℏℜℑ℘ℵ∅]$/.test(node.text)
      span.className = tight ? 'jp-math-sym-tight' : 'jp-math-sym'
      span.textContent = node.text
      return span
    }
    case 'space': {
      const span = document.createElement('span')
      span.className = `jp-math-space-${node.size}`
      return span
    }
    case 'frac': {
      const wrap = document.createElement('span')
      wrap.className = 'jp-math-frac'
      const num = document.createElement('span')
      num.className = 'jp-math-frac-num'
      appendMathDomNodes(num, node.num)
      const den = document.createElement('span')
      den.className = 'jp-math-frac-den'
      appendMathDomNodes(den, node.den)
      wrap.append(num, den)
      return wrap
    }
    case 'sqrt': {
      const wrap = document.createElement('span')
      wrap.className = 'jp-math-sqrt'
      if (node.index) {
        const idx = document.createElement('sup')
        idx.className = 'jp-math-sqrt-index'
        appendMathDomNodes(idx, node.index)
        wrap.appendChild(idx)
      }
      const sign = document.createElement('span')
      sign.className = 'jp-math-sqrt-sign'
      sign.setAttribute('aria-hidden', 'true')
      sign.textContent = '√'
      const body = document.createElement('span')
      body.className = 'jp-math-sqrt-body'
      appendMathDomNodes(body, node.body)
      wrap.append(sign, body)
      return wrap
    }
    case 'scripts': {
      if (node.limits) {
        const wrap = document.createElement('span')
        wrap.className = 'jp-math-limits'
        if (node.sup) {
          const sup = document.createElement('span')
          sup.className = 'jp-math-limit'
          appendMathDomNodes(sup, node.sup)
          wrap.appendChild(sup)
        }
        const op = document.createElement('span')
        op.className = 'jp-math-op'
        appendMathDomNodes(op, node.base)
        wrap.appendChild(op)
        if (node.sub) {
          const sub = document.createElement('span')
          sub.className = 'jp-math-limit'
          appendMathDomNodes(sub, node.sub)
          wrap.appendChild(sub)
        }
        return wrap
      }
      const wrap = document.createElement('span')
      wrap.className = 'jp-math-scripts'
      const base = document.createElement('span')
      appendMathDomNodes(base, node.base)
      wrap.appendChild(base)
      if (node.sub && node.sup) {
        const stack = document.createElement('span')
        stack.className = 'jp-math-scripts-stack'
        const sup = document.createElement('span')
        appendMathDomNodes(sup, node.sup)
        const sub = document.createElement('span')
        appendMathDomNodes(sub, node.sub)
        stack.append(sup, sub)
        wrap.appendChild(stack)
        return wrap
      }
      if (node.sup) {
        const sup = document.createElement('sup')
        sup.className = 'jp-math-sup'
        appendMathDomNodes(sup, node.sup)
        wrap.appendChild(sup)
      }
      if (node.sub) {
        const sub = document.createElement('sub')
        sub.className = 'jp-math-sub'
        appendMathDomNodes(sub, node.sub)
        wrap.appendChild(sub)
      }
      return wrap
    }
    case 'delimited': {
      const wrap = document.createElement('span')
      wrap.className = 'jp-math-delim'
      if (node.left) {
        const left = document.createElement('span')
        left.className = 'jp-math-delim-char'
        left.textContent = node.left
        wrap.appendChild(left)
      }
      const body = document.createElement('span')
      body.className = 'jp-math-row'
      appendMathDomNodes(body, node.body)
      wrap.appendChild(body)
      if (node.right) {
        const right = document.createElement('span')
        right.className = 'jp-math-delim-char'
        right.textContent = node.right
        wrap.appendChild(right)
      }
      return wrap
    }
    case 'accent': {
      if (node.accent === 'bar') {
        const span = document.createElement('span')
        span.className = node.over ? 'jp-math-overline' : 'jp-math-underline'
        appendMathDomNodes(span, node.body)
        return span
      }
      const wrap = document.createElement('span')
      wrap.className = 'jp-math-accent'
      const mark = document.createElement('span')
      mark.className = 'jp-math-accent-mark'
      mark.textContent = node.accent
      const body = document.createElement('span')
      appendMathDomNodes(body, node.body)
      if (node.over) wrap.append(mark, body)
      else wrap.append(body, mark)
      return wrap
    }
    case 'matrix': {
      const wrap = document.createElement('span')
      wrap.className = 'jp-math-delim'
      if (node.open) {
        const left = document.createElement('span')
        left.className = 'jp-math-delim-char'
        left.textContent = node.open
        wrap.appendChild(left)
      }
      const table = document.createElement('table')
      table.className = `jp-math-matrix ${node.align === 'left' ? 'jp-math-matrix-left' : ''}`
      const tbody = document.createElement('tbody')
      for (const row of node.rows) {
        const tr = document.createElement('tr')
        for (const cell of row) {
          const td = document.createElement('td')
          appendMathDomNodes(td, cell)
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      wrap.appendChild(table)
      if (node.close) {
        const right = document.createElement('span')
        right.className = 'jp-math-delim-char'
        right.textContent = node.close
        wrap.appendChild(right)
      }
      return wrap
    }
  }
}
