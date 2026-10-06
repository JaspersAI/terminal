import { definePlugin, defineSource } from '@jaspers-ai/sdk'
import { z } from 'zod'

// A feed: one function source that fetches a JSON API and answers rows. The assistant shows the rows
// with the built-in table, chart, and metric views, so a feed needs no view of its own. This one
// reads exchange rates from Frankfurter, which needs no key.

/** The API's host, exactly as it appears in the URL. Every host a source fetches goes in `hosts`. */
const HOST = 'api.frankfurter.dev'

/** What one response looks like: read the field names from the API's example, never guess them. */
interface Latest {
  date: string
  base: string
  rates: Record<string, number>
}

const rates = defineSource({
  description:
    'The latest exchange rates for one base currency, from Frankfurter (European Central Bank reference rates). One row per quoted currency: date, currency, and rate, the amount of that currency one unit of the base buys.',
  hosts: [HOST],
  input: z.object({
    base: z.string().length(3).default('USD').describe('The base currency, as an ISO code like USD or EUR.'),
    symbols: z
      .array(z.string().length(3))
      .max(50)
      .optional()
      .describe('The currencies to quote, as ISO codes. Leave out for every currency the API knows.'),
  }),
  async run(args, ctx) {
    const base = args.base.toUpperCase()
    const query = new URLSearchParams({ base })
    if (args.symbols && args.symbols.length > 0)
      query.set('symbols', args.symbols.map((s) => s.toUpperCase()).join(','))
    const response = await ctx.fetch(`https://${HOST}/v1/latest?${query}`)
    if (!response.ok) {
      const body = (await response.text()).split('\n')[0] ?? ''
      throw new Error(`Frankfurter answered ${response.status}: ${body.slice(0, 200)}`)
    }
    const latest = (await response.json()) as Latest
    // Rows: flat objects, numbers as numbers, dates as ISO strings.
    return Object.entries(latest.rates).map(([currency, rate]) => ({ date: latest.date, base, currency, rate }))
  },
})

export default definePlugin({ id: 'feed', sources: { rates } })
