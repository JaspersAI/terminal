import type { ReactElement } from 'react'
import { usePanelState, usePublish, type PanelRef } from '@jaspers-ai/sdk'

/**
 * The one built-in view: a square text area filling its element. What it holds is the panel's
 * state, so the orchestrator can write it and the box follows; what it shows is the panel's
 * output, so the orchestrator can read what is on screen without being told.
 */
export function Note({ panel }: { panel: PanelRef }): ReactElement {
  const [text, setText] = usePanelState(panel, 'text', '')
  usePublish(panel, { text })
  return (
    <textarea
      value={text}
      onChange={(event) => setText(event.target.value)}
      placeholder="Write…"
      spellCheck={false}
      aria-label="Note"
      className="h-full w-full resize-none bg-background p-3 text-sm outline-none"
    />
  )
}
