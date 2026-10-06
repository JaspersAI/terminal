import type { ReactElement } from 'react'
import { usePanelState, usePublish, usePublishText } from '@jaspers-ai/sdk'
import type { ViewProps } from './index'
import { cellText, shownText } from './cells'
import { useRows } from './data'

// One number, large. What a small element is for, and what a watch will point at: the first row of
// whatever a source or a query answers, read through one column.

export function Metric({ panel }: ViewProps): ReactElement {
  const [source] = usePanelState<string | null>(panel, 'source', null)
  const [args] = usePanelState<Record<string, unknown>>(panel, 'args', {})
  const [sql] = usePanelState<string | null>(panel, 'sql', null)
  const [column] = usePanelState<string | null>(panel, 'value', null)
  const [label] = usePanelState<string | null>(panel, 'label', null)
  const [unit] = usePanelState<string | null>(panel, 'unit', null)
  const [deltaColumn] = usePanelState<string | null>(panel, 'delta', null)

  const found = useRows({ source, args, sql })
  const row = found.rows[0]
  const key = column ?? found.columns[0] ?? null
  const value = row && key ? row[key] : undefined
  const delta = row && deltaColumn ? row[deltaColumn] : undefined
  const shown = cellText(value)

  usePublish(panel, { value: value ?? null, label: label ?? key, delta: delta ?? null, error: found.error })
  usePublishText(panel, shown ? `${label ?? key ?? 'value'}: ${shown}${unit ?? ''}` : null)

  if (found.error) return <Centered tone="bad">{found.error}</Centered>
  if (found.loading && !row) return <Centered>Loading…</Centered>
  if (!row || !key)
    return <Centered>{source || sql ? 'Nothing came back.' : 'Set source, or sql, and value.'}</Centered>

  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-3 text-center">
      <p className="text-3xl leading-none tabular-nums">
        {shownText(value)}
        {unit && <span className="text-xl text-muted-foreground">{unit}</span>}
      </p>
      {delta !== undefined && delta !== null && (
        <p
          className={`text-sm tabular-nums ${typeof delta === 'number' ? (delta < 0 ? 'text-destructive' : 'text-muted-foreground') : 'text-muted-foreground'}`}
        >
          {typeof delta === 'number' && delta > 0 ? '+' : ''}
          {shownText(delta)}
        </p>
      )}
      <p className="truncate text-xs text-muted-foreground">{label ?? key}</p>
    </div>
  )
}

function Centered({ children, tone }: { children: string; tone?: 'bad' }): ReactElement {
  return (
    <p
      className={`flex h-full items-center justify-center p-3 text-center text-xs ${tone === 'bad' ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {children}
    </p>
  )
}
