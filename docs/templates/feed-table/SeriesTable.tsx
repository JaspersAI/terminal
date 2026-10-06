import { useData, usePublish, type PanelRef } from '@jaspers-ai/sdk'
import './styles.css'

/** A row as the source answers it. Rows reach a view as plain records, so the view says what it expects. */
interface Observation {
  date: string
  value: number
  [field: string]: unknown
}

interface State {
  series?: string
  limit?: number
}

// The panel's state arrives a moment after the view mounts: read it first, so the source's first
// run asks for the right series.
export function SeriesTable({ panel }: { panel: PanelRef }) {
  const state = useData(`workspaces/${panel.workspaceId}/panels/${panel.id}/state`) as State | undefined
  if (state === undefined) return <p className="ft-note">Loading…</p>
  return <Table panel={panel} series={state.series ?? 'DGS10'} limit={state.limit ?? 30} />
}

function Table({ panel, series, limit }: { panel: PanelRef; series: string; limit: number }) {
  // Runs the source again whenever the arguments change by value.
  const { data, error } = useData('feed-table/series', { series, limit })
  const rows = (data ?? []) as Observation[]
  usePublish(panel, { series, count: rows.length, latest: rows[0]?.value ?? null })

  if (error) return <p className="ft-note ft-error">{error}</p>
  if (!data) return <p className="ft-note">Loading…</p>
  return (
    <table className="ft">
      <thead>
        <tr>
          <th>Date</th>
          <th>{series}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.date}>
            <td>{row.date}</td>
            <td className="ft-number">{row.value.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
