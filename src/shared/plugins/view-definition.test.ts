import assert from 'node:assert/strict'
import { test } from 'node:test'
import { definePlugin, defineView } from '@jaspers-ai/sdk/define'
import { z } from 'zod'

test('a view summary infers both schemas and remains usable in a plugin registry', () => {
  const view = defineView(() => null, {
    title: 'Quote',
    state: z.object({ symbol: z.string(), currency: z.string().optional() }),
    output: z.object({ price: z.number() }),
    summarize(state, output) {
      // These errors are checked by tsc: inference must not fall back to any.
      if (false) {
        // @ts-expect-error The state schema has no ticker field.
        void state.ticker
        // @ts-expect-error Prices are numbers, not strings.
        void output.price.toUpperCase()
        // @ts-expect-error Optional fields still need narrowing.
        void state.currency.toUpperCase()
      }
      return `${state.symbol}: ${output.price.toFixed(2)} ${state.currency ?? 'USD'}`
    },
  })
  const plugin = definePlugin({ id: 'quotes', views: { quote: view } })
  assert.equal(plugin.views.quote.summarize?.({ symbol: 'AAPL' }, { price: 123 }), 'AAPL: 123.00 USD')
})
