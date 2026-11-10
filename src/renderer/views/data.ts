import { useEffect, useRef, useState } from 'react'
import { useBridge, useData, usePanel, type PanelRef, type SourceData } from '@jaspers-ai/sdk'
import { sqlMatchesSource } from '../../shared/data/store'
import { formatAsOf } from '../../shared/tasks/tasks'
import { useAppState } from '../lib/state'
import { beginSqlRun, EMPTY_ROWS as EMPTY, sqlAfterFailure, sqlAfterResult, type Rows } from './cells'

// How a generic view gets its rows. Two ways in, one shape out: a source by registry id, which is
// what a plugin's data is reached by, or SQL over the store, which is the only way to see further
// back than the last call. A view takes one or the other, never both.
//
// Both hooks run every render, whichever is in use, so their order never changes; the one that is
// not in use is handed no target and does nothing.

export interface Ask {
  source?: string | null
  args?: unknown
  sql?: string | null
  limit?: number
}

export function useRows({ source, args, sql, limit }: Ask): Rows {
  const bridge = useBridge()
  const panel = usePanel()
  // Called every render either way, so the hook order never changes; an empty source is idle.
  const fromSource: SourceData = useData(source ?? '', args ?? {})
  const [fromSql, setFromSql] = useState<Rows>(EMPTY)
  const [sqlNonce, setSqlNonce] = useState(0)
  const lastSql = useRef<string | null>(null)
  const [sourceUpdatedAt, setSourceUpdatedAt] = useState<number | null>(null)

  useEffect(() => {
    if (!source || fromSource.loading || fromSource.error) return
    if ((fromSource.data && fromSource.data.length > 0) || fromSource.text) {
      setSourceUpdatedAt(Date.now())
    }
  }, [source, fromSource.data, fromSource.text, fromSource.loading, fromSource.error])

  useEffect(() => {
    if (!panel || !sql || source) return
    let seen = false
    return bridge.subscribe(`workspaces/${panel.workspaceId}/panels/${panel.id}/refreshedAt`, (stamp) => {
      if (!seen) {
        seen = true
        return
      }
      if (stamp === null || stamp === undefined) return
      setSqlNonce((n) => n + 1)
    })
  }, [bridge, panel, sql, source])

  useEffect(() => {
    if (!sql || source || typeof window === 'undefined' || !window.app?.store?.onRecorded) return
    return window.app.store.onRecorded((recordedSource) => {
      if (sqlMatchesSource(sql, recordedSource)) {
        setSqlNonce((n) => n + 1)
      }
    })
  }, [sql, source])

  useEffect(() => {
    if (!sql || source) {
      lastSql.current = null
      setFromSql(EMPTY)
      return
    }
    let live = true
    const sameSql = lastSql.current === sql
    lastSql.current = sql
    setFromSql(beginSqlRun)
    const read = bridge.query
    if (!read) {
      setFromSql({ ...EMPTY, error: 'This view cannot read the store here.' })
      return
    }
    void read(sql, limit)
      .then((result) => {
        if (!live) return
        setFromSql((previous) => sqlAfterResult(previous, result, sameSql, Date.now()))
      })
      .catch((error: unknown) => {
        if (!live) return
        const message = error instanceof Error ? error.message : String(error)
        setFromSql((previous) => sqlAfterFailure(previous, message))
      })
    return () => {
      live = false
    }
  }, [bridge, sql, source, limit, sqlNonce])

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
    updatedAt: sourceUpdatedAt,
  }
}

/**
 * Resolves the formatted `as of YYYY-MM-DD <12h><am|pm> <TZ>` system-time stamp for a panel's work
 * product from its own `refreshedAt` / `rowsUpdatedAt` and its owning room's `lastActiveAt` / `createdAt`.
 */
export function usePanelAsOf(panel: PanelRef, rowsUpdatedAt?: number | null): string {
  return useAppState((s) => {
    const grids = s.grids[panel.workspaceId] ?? {}
    let refreshedAt = 0
    let loopId: string | undefined
    for (const grid of Object.values(grids)) {
      const found = grid.panels.find((p) => p.id === panel.id)
      if (found) {
        refreshedAt = found.refreshedAt ?? 0
        loopId = grid.elements.find((e) => e.id === found.elementId)?.loop
        break
      }
    }
    const loop = loopId ? s.loops[panel.workspaceId]?.find((one) => one.id === loopId) : undefined
    const latest = Math.max(rowsUpdatedAt ?? 0, refreshedAt, loop?.lastActiveAt ?? 0, loop?.createdAt ?? 0)
    return latest > 0 ? formatAsOf(latest) : ''
  })
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
