import { useLayoutEffect, useRef, type ReactElement } from 'react'
import { MarkdownText } from '../composer/MarkdownText'
import { Trail } from '../composer/Transcript'
import type { LiveExchange } from '../composer/live'

interface Props {
  /** The requests still on screen, as the box follows them (`box.ts`). */
  live: LiveExchange[]
  /** Stops the run of one of them, by the name it was sent under. */
  onStop: (ask: string) => void
}

/**
 * What a loop that shows no conversation shows under its command line while its box is open: each
 * request still on screen by what was typed, the steps its run takes while it works, what its model
 * says between them among them and what it is thinking last, with Stop, and once it is over, how it
 * ended, the reply or why it failed, without the steps. Nothing said before is shown: the next request takes the place of what
 * was over. Its end, where the newest step is, stays in view.
 */
export function Progress({ live, onStop }: Props): ReactElement {
  const scroller = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [live])

  return (
    <div
      ref={scroller}
      data-progress
      className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-1.5 text-xs"
    >
      {live.map((row) => (
        <div key={row.ask} data-live={row.working ? 'working' : 'over'} className="mb-2 last:mb-0">
          <p className="mb-1 truncate text-muted-foreground">› {row.question}</p>
          {row.working && (
            <Trail
              steps={row.steps}
              thinking={row.thinking}
              error={null}
              working
              last={false}
              onStop={() => onStop(row.ask)}
            />
          )}
          {row.error !== null ? (
            <p className="text-sm break-words text-destructive">{row.error}</p>
          ) : (
            row.answer !== null && (
              <div data-reply className="font-prose text-sm">
                <MarkdownText source={row.answer} citations={row.citations} />
              </div>
            )
          )}
        </div>
      ))}
    </div>
  )
}
