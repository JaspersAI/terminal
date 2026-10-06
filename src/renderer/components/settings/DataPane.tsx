import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { StoreStats } from '../../../shared/data/store'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { BUTTON, FIELD, Row } from './Row'

// Settings > Data: the one file every source run is filed to. It is the whole of what the app keeps
// of what it fetched, and the point of showing it is that the user can take it: the path copies,
// and sqlite3, DuckDB, and pandas read it where it lies.
//
// Read over IPC when the pane opens, never from the state tree: the tree is pushed whole to every
// window on every change, and a run count that moves every few seconds does not belong in one.

type Usage = { origin: string; input: number; output: number; runs: number }

export function DataPane(): ReactElement {
  const [stats, setStats] = useState<StoreStats | null>(null)
  const [usage, setUsage] = useState<Usage[] | null>(null)
  const budget = useAppState((s) => s.budgets.dailyTokens)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const read = useCallback((): void => {
    window.app.store
      .stats()
      .then((found) => {
        setStats(found)
        setError(null)
      })
      .catch((err: unknown) => setError(errorMessage(err)))
    window.app.store
      .usage()
      .then(setUsage)
      .catch(() => undefined)
  }, [])

  useEffect(read, [read])

  function compact(): void {
    setBusy(true)
    window.app.store
      .compact()
      .then(setStats)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false))
  }

  function copy(): void {
    if (!stats) return
    void window.app.copyText(stats.path).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <section aria-label="Data" className="h-full overflow-y-auto px-8 pt-6 pb-10">
      <div className="pr-8">
        <h3 className="text-base font-semibold">Data</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Every run of every source is kept here, with what was asked and when. The assistant reads across all of it
          with SQL. Nothing expires, and nothing leaves this machine.
        </p>
      </div>

      {error && <p className="mt-4 text-sm break-words text-destructive">{error}</p>}

      <div className="mt-5 border-t border-border">
        <Row label="File" hint="Open it with sqlite3, DuckDB, or pandas while Jaspers runs">
          <p className="font-mono text-xs break-all text-muted-foreground">{stats?.path ?? '…'}</p>
          <button type="button" disabled={!stats} onClick={copy} className={`${BUTTON} self-end`}>
            {copied ? 'Copied' : 'Copy path'}
          </button>
        </Row>
        <Row label="Size" hint="The database and what it keeps beside it">
          <span className="text-right text-sm text-muted-foreground">{stats ? size(stats.bytes) : '…'}</span>
        </Row>
        <Row label="Runs">
          <span className="text-right text-sm text-muted-foreground">
            {stats
              ? `${count(stats.runs)} from ${stats.sources.length} source${stats.sources.length === 1 ? '' : 's'}`
              : '…'}
          </span>
        </Row>
        <Row label="Rows" hint="What a source said in words is searchable by phrase">
          <span className="text-right text-sm text-muted-foreground">
            {stats ? `${count(stats.rows)} rows, ${count(stats.docs)} with text` : '…'}
          </span>
        </Row>
        <Row label="Oldest run">
          <span className="text-right text-sm text-muted-foreground">
            {stats ? (stats.oldest ? when(stats.oldest) : 'Nothing filed yet') : '…'}
          </span>
        </Row>
        <Row label="Spent today" hint="What the assistant's own calls cost, by what asked for them">
          <span className="text-right text-sm text-muted-foreground">
            {usage === null
              ? '…'
              : usage.length === 0
                ? 'Nothing yet'
                : usage
                    .map(
                      (one) =>
                        `${one.origin === 'user' ? 'You' : 'On its own'}: ${count(one.input + one.output)} tokens over ${count(one.runs)} run${one.runs === 1 ? '' : 's'}`,
                    )
                    .join(' · ')}
          </span>
        </Row>
        <Row
          label="Daily budget"
          htmlFor="budget"
          hint="Tokens a day for work that runs on its own. Your own requests are never capped"
        >
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (draft === null) return
              dispatch({ type: 'budget.set', dailyTokens: Number(draft.replace(/[^0-9]/g, '')) })
                .then(() => setDraft(null))
                .catch((err: unknown) => setError(errorMessage(err)))
            }}
          >
            <input
              id="budget"
              name="budget"
              value={draft ?? count(budget)}
              inputMode="numeric"
              autoComplete="off"
              onChange={(event) => setDraft(event.target.value)}
              className={`${FIELD} min-w-0 flex-1 text-right tabular-nums`}
            />
            <button type="submit" disabled={draft === null} className={BUTTON}>
              Save
            </button>
          </form>
        </Row>
        <Row label="Compact" hint="Reclaims the space rows deleted by hand left behind">
          <button type="button" disabled={busy || !stats} onClick={compact} className={`${BUTTON} self-end`}>
            {busy ? 'Compacting…' : 'Compact'}
          </button>
        </Row>
      </div>
    </section>
  )
}

/** Bytes as a person reads them. Exported for the Eye pane, which counts the same thing on disk. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function count(n: number): string {
  return n.toLocaleString()
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
