import { useEffect, useState } from 'react'
import { useBridge, useData, type SourceData } from '@jaspers-ai/sdk'

// How a generic view gets its rows. Two ways in, one shape out: a source by registry id, which is
// what a plugin's data is reached by, or SQL over the store, which is the only way to see further
// back than the last call. A view takes one or the other, never both.
//
// Both hooks run every render, whichever is in use, so their order never changes; the one that is
// not in use is handed no target and does nothing.

export interface Rows {
  rows: Record<string, unknown>[]
  /** The columns in the order they should read, from the first row unless the query named them. */
  columns: string[]
  loading: boolean
  error: string | null
  /** What a source that answered in prose said, when there were no rows. */
  text: string | null
  truncated: boolean
}

const EMPTY: Rows = { rows: [], columns: [], loading: false, error: null, text: null, truncated: false }

export interface Ask {
  source?: string | null
  args?: unknown
  sql?: string | null
  limit?: number
}

export function useRows({ source, args, sql, limit }: Ask): Rows {
  const bridge = useBridge()
  // Called every render either way, so the hook order never changes; an empty source is idle.
  const fromSource: SourceData = useData(source ?? '', args ?? {})
  const [fromSql, setFromSql] = useState<Rows>(EMPTY)

  useEffect(() => {
    if (!sql || source) {
      setFromSql(EMPTY)
      return
    }
    let live = true
    setFromSql((previous) => ({ ...previous, loading: true, error: null }))
    const read = bridge.query
    if (!read) {
      setFromSql({ ...EMPTY, error: 'This view cannot read the store here.' })
      return
    }
    void read(sql, limit)
      .then((result) => {
        if (!live) return
        setFromSql({
          rows: result.rows.map((row) => Object.fromEntries(result.columns.map((column, i) => [column, row[i]]))),
          columns: result.columns,
          loading: false,
          error: null,
          text: null,
          truncated: result.truncated,
        })
      })
      .catch((error: unknown) => {
        if (live) setFromSql({ ...EMPTY, error: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      live = false
    }
  }, [bridge, sql, source, limit])

  if (!source && sql) return fromSql
  if (!source) return EMPTY
  const rows = fromSource.data ?? []
  return {
    rows,
    columns: columnsOf(rows),
    loading: fromSource.loading,
    error: fromSource.error,
    text: fromSource.text ?? null,
    truncated: false,
  }
}

/** Every key any of the first rows has, in the order they first appear, so a sparse row adds nothing late. */
export function columnsOf(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = []
  for (const row of rows.slice(0, 20)) for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key)
  return seen
}

/** The columns a view shows: what it asked for, kept to the ones that are there, else all of them. */
export function pickColumns(all: string[], wanted: string[] | null | undefined): string[] {
  if (!wanted || wanted.length === 0) return all
  const kept = wanted.filter((column) => all.includes(column))
  return kept.length > 0 ? kept : all
}
