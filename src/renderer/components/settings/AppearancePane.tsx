import { useEffect, useState, type ReactElement } from 'react'
import { DEFAULT_SIZE, SIZE_MAX, SIZE_MIN, type GridSize } from '../../../shared/grid/grid'
import { MAIN_WINDOW } from '../../../shared/grid/windows'
import type { Theme } from '../../../shared/app/theme'
import { errorMessage } from '../../lib/errors'
import { currentWorkspace, dispatch, useAppState } from '../../lib/state'
import { BUTTON, FIELD, Row } from './Row'

// Settings > Appearance: light, dark, or the system's, and how many cells the workspace's grid has.
// Main hands the theme to the OS, which is what turns every window and every plugin view with it.
// The grid size belongs to one workspace, the one on screen, and every window of it shows the same.

const CHOICES: { theme: Theme; label: string }[] = [
  { theme: 'system', label: 'System' },
  { theme: 'light', label: 'Light' },
  { theme: 'dark', label: 'Dark' },
]

export function AppearancePane(): ReactElement {
  const theme = useAppState((s) => s.theme)
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <section aria-labelledby="settings-appearance-title">
      <h3 id="settings-appearance-title" className="text-base font-semibold">
        Appearance
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">How Jaspers and its plugins' views look.</p>
      {/* One line, not a Row: a Row keeps a wide column for a text field, and this is three buttons. */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-y border-border py-3">
        <div className="min-w-0 text-sm">
          <span id="settings-theme">Theme</span>
          <div className={`mt-0.5 text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
            {failed ?? 'System follows your computer, and changes when it does.'}
          </div>
        </div>
        <div role="group" aria-labelledby="settings-theme" className="flex">
          {CHOICES.map((choice) => (
            <button
              key={choice.theme}
              type="button"
              aria-pressed={theme === choice.theme}
              onClick={() => {
                setFailed(null)
                dispatch({ type: 'theme.set', theme: choice.theme }).catch((err: unknown) =>
                  setFailed(errorMessage(err)),
                )
              }}
              className={`-ml-px border border-border px-3 py-1 text-sm first:ml-0 ${
                theme === choice.theme
                  ? 'relative z-10 border-primary bg-primary text-primary-foreground'
                  : 'hover:bg-muted'
              }`}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>
      <GridSizeRow />
    </section>
  )
}

/**
 * How many cells the grid of the workspace on screen has. The fields hold what is being typed and
 * are put back to the grid's own size when it changes, so a half-typed number is never the setting.
 * Main refuses a size that would leave an element or a written cell outside the grid, and says which
 * — the answer is to move those first, so the message is shown here rather than swallowed.
 */
function GridSizeRow(): ReactElement {
  const workspace = useAppState(currentWorkspace)
  const size = useAppState((s) => s.grids[s.currentWorkspaceId]?.[MAIN_WINDOW]?.size) ?? DEFAULT_SIZE
  const [draft, setDraft] = useState<{ cols: string; rows: string }>({
    cols: String(size.cols),
    rows: String(size.rows),
  })
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    setDraft({ cols: String(size.cols), rows: String(size.rows) })
  }, [size.cols, size.rows])

  const apply = (): void => {
    setFailed(null)
    const next: GridSize = { cols: Number(draft.cols), rows: Number(draft.rows) }
    dispatch({ type: 'grid.setSize', workspaceId: workspace.id, size: next }).catch((err: unknown) => {
      setFailed(errorMessage(err))
      setDraft({ cols: String(size.cols), rows: String(size.rows) })
    })
  }

  const unchanged = Number(draft.cols) === size.cols && Number(draft.rows) === size.rows
  return (
    <Row
      label="Grid size"
      htmlFor="settings-grid-cols"
      hint={
        failed ? (
          <span className="text-destructive">{failed}</span>
        ) : (
          `Columns × rows of cells in ${workspace.name}, ${SIZE_MIN.cols} × ${SIZE_MIN.rows} to ${SIZE_MAX.cols} × ${SIZE_MAX.rows}. Every window of this workspace shows the same grid.`
        )
      }
    >
      <div className="flex items-center gap-2">
        <input
          id="settings-grid-cols"
          type="number"
          inputMode="numeric"
          min={SIZE_MIN.cols}
          max={SIZE_MAX.cols}
          aria-label="Columns"
          value={draft.cols}
          onChange={(event) => setDraft({ ...draft, cols: event.target.value })}
          onKeyDown={(event) => event.key === 'Enter' && apply()}
          className={`${FIELD} w-20`}
        />
        <span className="text-sm text-muted-foreground">×</span>
        <input
          type="number"
          inputMode="numeric"
          min={SIZE_MIN.rows}
          max={SIZE_MAX.rows}
          aria-label="Rows"
          value={draft.rows}
          onChange={(event) => setDraft({ ...draft, rows: event.target.value })}
          onKeyDown={(event) => event.key === 'Enter' && apply()}
          className={`${FIELD} w-20`}
        />
        <button type="button" disabled={unchanged} onClick={apply} className={BUTTON}>
          Apply
        </button>
      </div>
    </Row>
  )
}
