// What a source run gives back, as a view and a plugin's backend see it. Types only: the app pulls
// the rows out of a tool result and holds them.

/** Rows a source run produced, held by the app for a while and read by id. */
export interface Dataset {
  id: string
  source: string
  args: unknown
  rows: Record<string, unknown>[]
  meta: Record<string, unknown>
  at: number
  ttlMs: number
}

/** What a run gives a view: rows to read by id, or text to show. */
export type RunResult =
  | { kind: 'dataset'; datasetId: string; rowCount: number; meta: Record<string, unknown> }
  | { kind: 'text'; resultId: string; text: string }
