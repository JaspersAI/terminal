import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BridgeProvider, PanelProvider, useData, usePanelState, type PanelRef } from '@jaspers-ai/sdk'
import { createIframeBridge } from '@jaspers-ai/sdk/host'

function withWindow<T>(
  run: (host: { onPost: ((msg: unknown) => void) | null; sendToFrame: (data: unknown) => void }) => Promise<T>,
): Promise<T> {
  const prev = (globalThis as { window?: unknown }).window
  const listeners = new Set<(event: MessageEvent) => void>()
  const hostWindow = {} as Window
  const controller = {
    onPost: null as ((msg: unknown) => void) | null,
    sendToFrame(data: unknown) {
      const event = { source: hostWindow, data } as MessageEvent
      for (const fn of [...listeners]) fn(event)
    },
  }
  const fakeWindow = {
    parent: hostWindow,
    addEventListener(type: string, fn: (event: MessageEvent) => void) {
      if (type === 'message') listeners.add(fn)
    },
    removeEventListener(type: string, fn: (event: MessageEvent) => void) {
      if (type === 'message') listeners.delete(fn)
    },
  }
  ;(hostWindow as unknown as { postMessage: (msg: unknown) => void }).postMessage = (msg: unknown) => {
    controller.onPost?.(msg)
  }
  ;(globalThis as { window?: unknown }).window = fakeWindow
  return run(controller).finally(() => {
    if (prev === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = prev
  })
}

test('after panel state is loaded, usePanelState and useData read keys synchronously on first render and preserve null', async () => {
  await withWindow(async (host) => {
    const panelState = {
      symbols: ['000300.SS', '^GSPC', 'AAPL'],
      interval: '15m',
      mode: 'lines',
      active: null,
      volume: false,
      source: 'yahoo',
    }
    let nextSub = 1
    const setStateCalls: { path: string[]; value: unknown }[] = []

    host.onPost = (raw) => {
      const req = raw as { id: number; method: string; params: Record<string, unknown> }
      if (req.method === 'store.get' && req.params['path'] === 'workspaces/ws1/panels/p83/state') {
        host.sendToFrame({ id: req.id, result: panelState })
        return
      }
      if (req.method === 'store.subscribe') {
        const subId = nextSub++
        host.sendToFrame({ id: req.id, result: subId })
        const path = String(req.params['path'])
        if (path === 'workspaces/ws1/panels/p83/state') {
          host.sendToFrame({ method: 'store.changed', params: { subId, value: panelState } })
        } else if (path.startsWith('workspaces/ws1/panels/p83/state/')) {
          const key = path.slice('workspaces/ws1/panels/p83/state/'.length) as keyof typeof panelState
          host.sendToFrame({ method: 'store.changed', params: { subId, value: panelState[key] } })
        }
        return
      }
      if (req.method === 'panel.setState') {
        setStateCalls.push({ path: req.params['path'] as string[], value: req.params['value'] })
        host.sendToFrame({ id: req.id, result: null })
      }
    }

    const bridge = createIframeBridge()
    await bridge.get('workspaces/ws1/panels/p83/state')

    assert.equal(bridge.peek?.('workspaces/ws1/panels/p83/state/interval'), '15m')
    assert.equal(bridge.peek?.('workspaces/ws1/panels/p83/state/volume'), false)
    assert.equal(bridge.peek?.('workspaces/ws1/panels/p83/state/active'), null)

    const seenSubValues: unknown[] = []
    bridge.subscribe('workspaces/ws1/panels/p83/state/volume', (v) => seenSubValues.push(v))
    assert.deepEqual(seenSubValues, [false])

    const panel: PanelRef = { id: 'p83', workspaceId: 'ws1' }
    let rendered: {
      stateDefined: boolean
      interval: string
      volume: boolean
      active: string | null
      symbolsCount: number
    } | null = null

    function Chart({ panel: p }: { panel: PanelRef }) {
      const [symbols] = usePanelState(p, 'symbols', ['AAPL'])
      const [interval] = usePanelState(p, 'interval', '1d')
      const [volume] = usePanelState(p, 'volume', true)
      const [active] = usePanelState<string | null>(p, 'active', '000300.SS')
      rendered = { stateDefined: true, interval, volume, active, symbolsCount: symbols.length }
      return createElement('div', null, `${interval}:${String(volume)}:${String(active)}:${symbols.length}`)
    }

    function ChartView({ panel: p }: { panel: PanelRef }) {
      const state = useData(`workspaces/${p.workspaceId}/panels/${p.id}/state`)
      if (state === undefined) return createElement('p', null, 'Loading…')
      return createElement(Chart, { panel: p })
    }

    const html = renderToStaticMarkup(
      createElement(
        BridgeProvider,
        { value: bridge },
        createElement(PanelProvider, { value: panel }, createElement(ChartView, { panel })),
      ),
    )

    assert.equal(html, '<div>15m:false:null:3</div>')
    assert.deepEqual(rendered, {
      stateDefined: true,
      interval: '15m',
      volume: false,
      active: null,
      symbolsCount: 3,
    })
    assert.deepEqual(setStateCalls, [])

    // Wait for async store.subscribe replies to flush: the seeded value must not be delivered twice,
    // while a subsequent change from the host is delivered and updates peek.
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(seenSubValues, [false])
    host.sendToFrame({ method: 'store.changed', params: { subId: 1, value: true } })
    assert.deepEqual(seenSubValues, [false, true])
    assert.equal(bridge.peek?.('workspaces/ws1/panels/p83/state/volume'), true)

    await bridge.setState(panel, ['interval'], '1h')
    assert.equal(bridge.peek?.('workspaces/ws1/panels/p83/state/interval'), '1h')
    assert.equal((bridge.peek?.('workspaces/ws1/panels/p83/state') as Record<string, unknown>)['interval'], '1h')
  })
})
