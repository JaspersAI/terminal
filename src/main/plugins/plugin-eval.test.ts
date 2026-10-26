import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { bundlePlugin } from './bundle.ts'
import { evaluatePlugin } from './plugin-eval.ts'

async function compileAndEvaluate(id: string, files: Record<string, string>) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'jaspers-plugin-eval-'))
  try {
    const dir = path.join(root, id)
    await fsp.mkdir(dir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(dir, rel)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, content)
    }
    const code = await bundlePlugin(dir, path.join(root, 'bundle.js'))
    return evaluatePlugin(code, id)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

test('a view that references an undeclared identifier like children fails evaluation before mounting', async () => {
  await assert.rejects(
    compileAndEvaluate('option-chain', {
      'Table.tsx': `
        import { useData, usePublish, type PanelRef } from '@jaspers-ai/sdk'
        export function OptionChainTable({ panel }: { panel: PanelRef }) {
          const { data } = useData('option-chain/chain', { symbol: 'FLWS' })
          usePublish(panel, { count: (data ?? []).length })
          return <div className="chain">{children}</div>
        }
      `,
      'plugin.tsx': `
        import { definePlugin, defineSource, defineView } from '@jaspers-ai/sdk'
        import { z } from 'zod'
        import { OptionChainTable } from './Table'
        const chain = defineSource({
          description: 'Options chain',
          input: z.object({ symbol: z.string() }),
          run: async () => [],
        })
        export default definePlugin({
          id: 'option-chain',
          sources: { chain },
          views: {
            table: defineView(OptionChainTable, {
              title: 'Option Chain',
              state: z.object({ symbol: z.string().default('FLWS') }),
              output: z.object({ count: z.number() }),
              renders: [chain],
            }),
          },
        })
      `,
    }),
    /View option-chain\/table.*children is not defined/,
  )
})

test('a helper component inside a view that forgets to destructure children fails evaluation even behind loading, empty, or tab guards', async () => {
  await assert.rejects(
    compileAndEvaluate('option-chain', {
      'Table.tsx': `
        import { useState, type ReactNode } from 'react'
        import { useData, usePublish, type PanelRef } from '@jaspers-ai/sdk'

        function Badge({ tone }: { tone: string; children: ReactNode }) {
          return <span className={tone}>{children}</span>
        }

        export function OptionChainTable({ panel }: { panel: PanelRef }) {
          const state = useData(\`workspaces/\${panel.workspaceId}/panels/\${panel.id}/state\`) as { symbol?: string } | undefined
          if (state === undefined) return <p>Loading state…</p>
          return <ChainBody panel={panel} symbol={state.symbol ?? 'FLWS'} />
        }

        function ChainBody({ panel, symbol }: { panel: PanelRef; symbol: string }) {
          const [tab, setTab] = useState<'calls' | 'greeks'>('calls')
          const { data, error } = useData('option-chain/chain', { symbol })
          const rows = (data ?? []) as { strike: number; iv: number; type: string }[]
          usePublish(panel, { count: rows.length })
          if (error) return <p>{error}</p>
          if (!data) return <p>Loading…</p>
          if (rows.length === 0) return <p>No contracts.</p>
          return (
            <div>
              <button onClick={() => setTab('calls')}>Calls</button>
              <button onClick={() => setTab('greeks')}>Greeks</button>
              {tab === 'calls' ? (
                <table>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.strike}><td>{r.strike.toFixed(2)}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div>
                  {rows.map((r) => (
                    <Badge key={r.strike} tone="iv">{r.iv.toFixed(2)}</Badge>
                  ))}
                </div>
              )}
            </div>
          )
        }
      `,
      'plugin.tsx': `
        import { definePlugin, defineSource, defineView } from '@jaspers-ai/sdk'
        import { z } from 'zod'
        import { OptionChainTable } from './Table'
        const chain = defineSource({
          description: 'Options chain',
          input: z.object({ symbol: z.string() }),
          run: async () => [],
        })
        export default definePlugin({
          id: 'option-chain',
          sources: { chain },
          views: {
            table: defineView(OptionChainTable, {
              title: 'Option Chain',
              state: z.object({ symbol: z.string().default('FLWS') }),
              output: z.object({ count: z.number() }),
              renders: [chain],
            }),
          },
        })
      `,
    }),
    /View option-chain\/table \(in Badge\): ReferenceError: children is not defined/,
  )
})

test('a view that crashes when panel state has not arrived yet fails evaluation', async () => {
  await assert.rejects(
    compileAndEvaluate('broken-state', {
      'plugin.tsx': `
        import { definePlugin, defineView, useData, type PanelRef } from '@jaspers-ai/sdk'
        import { z } from 'zod'
        function View({ panel }: { panel: PanelRef }) {
          const state = useData(\`workspaces/\${panel.workspaceId}/panels/\${panel.id}/state\`) as { symbol: string }
          return <div>{state.symbol.toUpperCase()}</div>
        }
        export default definePlugin({
          id: 'broken-state',
          views: {
            main: defineView(View, {
              title: 'Main',
              state: z.object({ symbol: z.string().default('AAPL') }),
              output: z.object({}),
            }),
          },
        })
      `,
    }),
    /View broken-state\/main.*Cannot read properties of undefined/,
  )
})

test('a view whose summarize callback throws a runtime error fails evaluation', async () => {
  await assert.rejects(
    compileAndEvaluate('broken-summary', {
      'plugin.tsx': `
        import { definePlugin, defineView } from '@jaspers-ai/sdk'
        import { z } from 'zod'
        export default definePlugin({
          id: 'broken-summary',
          views: {
            main: defineView(() => <div>ok</div>, {
              title: 'Main',
              state: z.object({ symbol: z.string().default('AAPL') }),
              output: z.object({ count: z.number().default(0) }),
              summarize: () => missingHelper(),
            }),
          },
        })
      `,
    }),
    /View broken-summary\/main.*missingHelper is not defined/,
  )
})

test('a valid view using React and SDK hooks passes evaluation, while calling a hook outside a view still fails', async () => {
  const validated = await compileAndEvaluate('valid-view', {
    'plugin.tsx': `
      import { createContext, useCallback, useContext, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
      import {
        definePlugin,
        defineSource,
        defineView,
        useBridge,
        useData,
        useDictation,
        usePanel,
        usePanelState,
        usePublish,
        usePublishText,
        type PanelRef,
      } from '@jaspers-ai/sdk'
      import { z } from 'zod'

      const ThemeCtx = createContext('compact')

      const quotes = defineSource({
        description: 'Quotes',
        input: z.object({ symbol: z.string() }),
        run: async () => [],
      })

      function Header({ children }: { children: React.ReactNode }) {
        const mode = useContext(ThemeCtx)
        return <header data-mode={mode}>{children}</header>
      }

      function QuoteView({ panel }: { panel: PanelRef }) {
        const currentPanel = usePanel()
        const bridge = useBridge()
        const dictation = useDictation()
        const [symbol, setSymbol] = usePanelState(panel, 'symbol', 'AAPL')
        const [filter, setFilter] = useState('')
        const [count, dispatch] = useReducer((c: number) => c + 1, 0)
        const ref = useRef<HTMLDivElement | null>(null)
        const id = useId()
        const state = useData(\`workspaces/\${panel.workspaceId}/panels/\${panel.id}/state\`) as { symbol?: string } | undefined
        const { data, loading, error, refetch } = useData('valid-view/quotes', { symbol })
        const rows = useMemo(() => (data ?? []).filter((r) => String(r.symbol ?? '').includes(filter)), [data, filter])
        const onReset = useCallback(() => {
          setFilter('')
          setSymbol('MSFT')
          dispatch()
          refetch()
        }, [setSymbol, refetch])
        useEffect(() => {
          void bridge
        }, [bridge])
        usePublish(panel, { symbol: state?.symbol ?? symbol, count: rows.length })
        usePublishText(panel, rows.length > 0 ? ' Quotes' : null)
        const dark = matchMedia('(prefers-color-scheme: dark)').matches
        if (loading && !data) return <p>Loading {currentPanel.id}…</p>
        if (error) return <p>{error}</p>
        return (
          <ThemeCtx.Provider value={dark ? 'dark' : 'light'}>
            <div ref={ref} id={id}>
              <Header>
                <span>{symbol} ({count}) {dictation.state}</span>
                <button onClick={onReset}>Reset</button>
              </Header>
              <ul>
                {rows.map((r, i) => (
                  <li key={i}>{String(r.symbol)}: {Number(r.price).toFixed(2)}</li>
                ))}
              </ul>
            </div>
          </ThemeCtx.Provider>
        )
      }

      export default definePlugin({
        id: 'valid-view',
        sources: { quotes },
        views: {
          quotes: defineView(QuoteView, {
            title: 'Quotes',
            state: z.object({ symbol: z.string().default('AAPL') }),
            output: z.object({ symbol: z.string(), count: z.number() }),
            renders: [quotes],
            summarize: (s, o) => \`\${s.symbol}: \${o.count}\`,
          }),
        },
      })
    `,
  })
  assert.deepEqual(Object.keys(validated.views), ['quotes'])

  await assert.rejects(
    compileAndEvaluate('hook-at-top', {
      'plugin.tsx': `
        import { definePlugin, useData } from '@jaspers-ai/sdk'
        useData('workspaces/w/panels/p/state')
        export default definePlugin({ id: 'hook-at-top' })
      `,
    }),
    /useData cannot run here; components render only in views/,
  )
})

test('a view that inspects Object.keys(row) or spreads rows before hitting an undeclared identifier still fails evaluation', async () => {
  await assert.rejects(
    compileAndEvaluate('dynamic-cols', {
      'plugin.tsx': `
        import { definePlugin, defineSource, defineView, useData, type PanelRef } from '@jaspers-ai/sdk'
        import { z } from 'zod'
        const rows = defineSource({
          description: 'Rows',
          input: z.object({}),
          run: async () => [],
        })
        function Table({ panel: _panel }: { panel: PanelRef }) {
          const { data } = useData('dynamic-cols/rows', {})
          if (!data || data.length === 0) return <p>Empty</p>
          const copy = { ...data[0] }
          const cols = Object.keys(copy)
          return <div>{cols.join(',')}{children}</div>
        }
        export default definePlugin({
          id: 'dynamic-cols',
          sources: { rows },
          views: {
            table: defineView(Table, {
              title: 'Table',
              state: z.object({}),
              output: z.object({}),
              renders: [rows],
            }),
          },
        })
      `,
    }),
    /View dynamic-cols\/table.*children is not defined/,
  )
})

test('guarded wrapper children, sibling synthetic errors, and idle empty-target useData calls are handled accurately', async () => {
  const valid = await compileAndEvaluate('guarded-modal', {
    'plugin.tsx': `
      import { useState, type ReactNode } from 'react'
      import { definePlugin, defineSource, defineView, useData, type PanelRef } from '@jaspers-ai/sdk'
      import { z } from 'zod'
      const detail = defineSource({
        description: 'Detail',
        input: z.object({ id: z.string() }),
        run: async () => [],
      })
      function Modal({ open, children }: { open: boolean; children: ReactNode }) {
        return open ? <div>{children}</div> : null
      }
      function Detail({ state }: { state: { ticker: string } }) {
        return <span>{state.ticker.toUpperCase()}</span>
      }
      function View({ panel }: { panel: PanelRef }) {
        const state = useData(\`workspaces/\${panel.workspaceId}/panels/\${panel.id}/state\`) as { ticker: string } | undefined
        const [selected] = useState<{ id: string; name: string } | null>(null)
        const { data } = useData(selected ? 'guarded-modal/detail' : '', { id: selected?.id })
        if (data && selected) return <div>{selected.name.toUpperCase()}</div>
        return (
          <Modal open={state !== undefined}>
            <Detail state={state!} />
          </Modal>
        )
      }
      export default definePlugin({
        id: 'guarded-modal',
        sources: { detail },
        views: {
          main: defineView(View, {
            title: 'Main',
            state: z.object({ ticker: z.string().default('AAPL') }),
            output: z.object({}),
            renders: [detail],
          }),
        },
      })
    `,
  })
  assert.deepEqual(Object.keys(valid.views), ['main'])

  await assert.rejects(
    compileAndEvaluate('sibling-ref-error', {
      'plugin.tsx': `
        import { definePlugin, defineSource, defineView, useData, type PanelRef } from '@jaspers-ai/sdk'
        import { z } from 'zod'
        const feed = defineSource({
          description: 'Feed',
          input: z.object({}),
          run: async () => [],
        })
        function FirstChild({ row }: { row: Record<string, unknown> }) {
          const bad = (row.missing as unknown as { nonMethod: () => string }).nonMethod.call(null)
          return <span>{bad}</span>
        }
        function SecondChild() {
          return <span>{children}</span>
        }
        function View({ panel: _panel }: { panel: PanelRef }) {
          const { data } = useData('sibling-ref-error/feed', {})
          if (!data || data.length === 0) return <p>Loading</p>
          return (
            <div>
              <FirstChild row={data[0]!} />
              <SecondChild />
            </div>
          )
        }
        export default definePlugin({
          id: 'sibling-ref-error',
          sources: { feed },
          views: {
            main: defineView(View, {
              title: 'Main',
              state: z.object({}),
              output: z.object({}),
              renders: [feed],
            }),
          },
        })
      `,
    }),
    /View sibling-ref-error\/main.*children is not defined/,
  )
})
