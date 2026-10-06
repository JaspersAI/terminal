import { useMemo, useState, type ReactElement } from 'react'
import { usePanelState, usePublish, usePublishText } from '@jaspers-ai/sdk'
import type { ViewProps } from './index'
import { cellText, isNumeric, isYearColumn, shownText } from './cells'
import { pickColumns, useRows } from './data'

// A table over any source, or over the store. This is the view that means a server does not need a
// view: connect anything that answers with rows and the assistant can put it on the grid.

/** What goes into the panel's output and its text, so neither grows without bound. */
const TEXT_ROWS = 500

export function Table({ panel }: ViewProps): ReactElement {
  const [source] = usePanelState<string | null>(panel, 'source', null)
  const [args] = usePanelState<Record<string, unknown>>(panel, 'args', {})
  const [sql] = usePanelState<string | null>(panel, 'sql', null)
  const [wanted] = usePanelState<string[] | null>(panel, 'columns', null)
  const [title] = usePanelState<string | null>(panel, 'title', null)
  const [sort, setSort] = useState<{ column: string; descending: boolean } | null>(null)

  const found = useRows({ source, args, sql })
  const columns = pickColumns(found.columns, wanted)
  const rows = useMemo(() => sorted(found.rows, columns, sort), [found.rows, columns, sort])
  const years = useMemo(() => yearColumns(found.rows, columns), [found.rows, columns])

  usePublish(panel, {
    rowCount: found.rows.length,
    columns,
    source: source ?? (sql ? 'store' : null),
    error: found.error,
  })
  usePublishText(panel, rows.length > 0 ? asText(title, columns, rows, years) : found.text)

  if (found.error) return <Message tone="bad">{found.error}</Message>
  if (found.loading && rows.length === 0) return <Message>Loading…</Message>
  if (rows.length === 0) {
    if (found.text)
      return <pre className="h-full overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">{found.text}</pre>
    return <Message>{source || sql ? 'Nothing came back.' : 'Set source, or sql, to fill this table.'}</Message>
  }

  return (
    <div className="flex h-full flex-col">
      {title && <p className="shrink-0 truncate px-3 pt-2 text-xs text-muted-foreground">{title}</p>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-background">
            <tr>
              {columns.map((column) => {
                const numeric = isNumeric(found.rows, column)
                const on = sort?.column === column
                return (
                  <th
                    key={column}
                    scope="col"
                    onClick={() => setSort(on && sort.descending ? null : { column, descending: on })}
                    className={`cursor-pointer border-b border-border px-2 py-1 font-medium whitespace-nowrap hover:bg-muted ${
                      numeric ? 'text-right' : 'text-left'
                    }`}
                  >
                    {column}
                    <span className="text-muted-foreground">{on ? (sort.descending ? ' ↓' : ' ↑') : ''}</span>
                  </th>
                )
              })}
              {/* Soaks up the width left over, so the columns that hold something hug it instead of
                  being spread across a wide element. */}
              <th className="w-full border-b border-border" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="even:bg-muted/40">
                {columns.map((column) => (
                  <td
                    key={column}
                    className={`max-w-80 truncate border-b border-border/50 px-2 py-1 whitespace-nowrap ${isNumeric(found.rows, column) ? 'text-right tabular-nums' : ''}`}
                  >
                    {shownText(row[column], !years.has(column))}
                  </td>
                ))}
                <td className="border-b border-border/50" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="shrink-0 border-t border-border px-3 py-1 text-xs text-muted-foreground">
        {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}
        {found.truncated && ', cut'}
      </p>
    </div>
  )
}

/** In the page, on a column the user pressed. Nothing is asked for again. */
function sorted(
  rows: Record<string, unknown>[],
  columns: string[],
  sort: { column: string; descending: boolean } | null,
): Record<string, unknown>[] {
  if (!sort || !columns.includes(sort.column)) return rows
  const direction = sort.descending ? -1 : 1
  return [...rows].sort((a, b) => {
    const left = a[sort.column]
    const right = b[sort.column]
    if (left === right) return 0
    if (left === null || left === undefined) return 1
    if (right === null || right === undefined) return -1
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction
    return String(left).localeCompare(String(right)) * direction
  })
}

/** The columns written as years, whose digits are not grouped. */
function yearColumns(rows: Record<string, unknown>[], columns: string[]): Set<string> {
  return new Set(columns.filter((column) => isYearColumn(rows, column)))
}

/** The whole table as text, which is what a model reads and quotes from. */
function asText(title: string | null, columns: string[], rows: Record<string, unknown>[], years: Set<string>): string {
  const head = title ? `${title}\n\n` : ''
  const lines = [
    columns.join('\t'),
    ...rows
      .slice(0, TEXT_ROWS)
      .map((row) => columns.map((column) => cellText(row[column], !years.has(column))).join('\t')),
  ]
  const rest = rows.length > TEXT_ROWS ? `\n… ${(rows.length - TEXT_ROWS).toLocaleString()} more rows` : ''
  return `${head}${lines.join('\n')}${rest}`
}

function Message({ children, tone }: { children: string; tone?: 'bad' }): ReactElement {
  return <p className={`p-3 text-xs ${tone === 'bad' ? 'text-destructive' : 'text-muted-foreground'}`}>{children}</p>
}
