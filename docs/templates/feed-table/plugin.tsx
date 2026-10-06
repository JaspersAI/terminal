import { definePlugin, defineSource, defineView } from '@jaspers-ai/sdk'
import { z } from 'zod'
import { SeriesTable } from './SeriesTable'

// A feed with a key and a view of its own. The source reads a FRED series; the key is declared under
// secrets and written as ${secret:apikey} in the URL, and the app asks the user for it the first time
// the source runs. The view is a table the assistant places and drives through its state.

const HOST = 'api.stlouisfed.org'

/** What FRED answers: observations, with a value of "." on a day nothing was published. */
interface Observations {
  observations: { date: string; value: string }[]
}

const series = defineSource({
  description:
    "Observations of one FRED series, newest first: date and value. Series ids are FRED's, like DGS10 (10-year Treasury yield), UNRATE (unemployment rate), CPIAUCSL (CPI).",
  hosts: [HOST],
  input: z.object({
    series: z.string().min(1).describe('The FRED series id, like DGS10.'),
    limit: z.number().int().min(1).max(5000).default(250).describe('How many observations, newest first.'),
  }),
  async run(args, ctx) {
    const query = new URLSearchParams({
      series_id: args.series.toUpperCase(),
      file_type: 'json',
      sort_order: 'desc',
      limit: String(args.limit),
      // Single quotes: a template literal would read this as an interpolation.
      api_key: '${secret:apikey}',
    })
    const response = await ctx.fetch(`https://${HOST}/fred/series/observations?${query}`)
    if (!response.ok) {
      const body = (await response.text()).split('\n')[0] ?? ''
      throw new Error(`FRED answered ${response.status}: ${body.slice(0, 200)}`)
    }
    const { observations } = (await response.json()) as Observations
    return observations
      .filter((o) => o.value !== '.')
      .map((o) => ({ date: o.date, series: args.series.toUpperCase(), value: Number(o.value) }))
  },
})

export default definePlugin({
  id: 'feed-table',
  secrets: { apikey: { label: 'FRED API key' } },
  sources: { series },
  views: {
    table: defineView(SeriesTable, {
      title: 'FRED series',
      // What the assistant sets. Every write is checked against this, whole.
      state: z.object({
        series: z.string().default('DGS10').describe('The FRED series id to show.'),
        limit: z.number().int().min(1).max(5000).default(30),
      }),
      // What the view reports about itself, for the assistant to read.
      output: z.object({ series: z.string(), count: z.number(), latest: z.number().nullable() }),
      instructions: 'A table of one FRED series. Set state.series to the series id and state.limit to how many rows.',
      renders: [series],
      summarize: (state, output) => `${state.series ?? 'FRED'}: ${output.count} rows, latest ${output.latest ?? '–'}`,
    }),
  },
})
