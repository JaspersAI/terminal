import { useEffect, useRef, useState, type FormEvent, type ReactElement, type RefObject } from 'react'
import type { Question } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch } from '../../lib/state'
import { hears } from './hears'

interface Props {
  question: Question
  /**
   * The composer's spring drives this, as it does the answer's: the question sits where replies land.
   * Left out in the docked chat, which does not move: it is a row of it, above its command line.
   */
  box?: RefObject<HTMLDivElement | null>
  /** Whether it is drawn where it can be read. A tile's box says no while another element is maximized over its tile. */
  shown?: boolean
}

/** Over the composer, riding its spring; in the docked chat, a plain row above the command line; in a tile's box, in its line's place. */
const FLOATING = 'pointer-events-auto absolute inset-x-0 bottom-39 border border-border bg-background shadow-lg'
const DOCKED = 'relative shrink-0 border-t border-border bg-background'
const TILE = 'relative shrink-0 bg-background'

/**
 * The assistant asking something and waiting for the answer, in the place its replies appear and the
 * place a key is asked for. It opens this with ask_user when a request reads two ways and nothing it
 * can look at settles which; the run sits in main until this is answered, closed, or ten minutes
 * pass. A scheduled task never opens one: nobody is there to answer it.
 *
 * A question may carry text it is about — the shell script pro mode is asking to run — which is shown
 * under it as it was written, monospaced, every line, and scrolled rather than cut once it is taller
 * than the box: approving what you cannot read is not approving.
 *
 * Requests run side by side, so a question asked while more than one is working carries the request
 * it came from (`about`), in small type over it.
 *
 * One asked by a tile's own run is drawn in that tile's box (`on` names the tile), so several can be
 * up at once. Its ids carry the tile, since an id names one thing. It takes the keyboard only from its
 * own tile's line, which the box sees to, and hears Escape only when it is pressed in its own box.
 */
export function QuestionField({ question, box, shown = true }: Props): ReactElement {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // The tile it is asked in, by its element's id: a box draws only its own workspace's tiles.
  const on = question.place?.on
  const id = (name: string): string => (on ? `${name}-${on}` : name)

  useEffect(() => {
    if (!on) input.current?.focus()
  }, [question.id, on])

  // A tile's question begins its wait once its tile has drawn it, which only a window can say: main
  // cannot tell a tile on a workspace off screen, in a closed window, or under a maximized element.
  useEffect(() => {
    if (on && shown) void dispatch({ type: 'question.seen', id: question.id }).catch(() => undefined)
  }, [question.id, on, shown])

  // Escape closes it, and the run carries on without an answer, as the cross does.
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !hears(on, event.target)) return
      if (event.target instanceof HTMLElement && event.target.closest('#workspace-title')) return
      if (document.querySelector('[role=menu]')) return
      answer('')
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  })

  function answer(text: string): void {
    if (busy) return
    setBusy(true)
    setError(null)
    // Main clears the question once it has the answer, which unmounts this.
    dispatch({ type: 'question.answer', id: question.id, answer: text }).catch((err: unknown) => {
      setError(errorMessage(err))
      setBusy(false)
    })
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!value.trim()) return
    answer(value)
  }

  return (
    <div ref={box} id={id('question-field')} className={box ? FLOATING : on ? TILE : DOCKED}>
      <form onSubmit={submit} className="py-2 pr-8 pl-3 text-sm">
        {question.about && (
          <p id={id('question-about')} className="mb-1 truncate text-xs text-muted-foreground">
            {question.about}
          </p>
        )}
        <label htmlFor={id('question-input')} className="block font-medium">
          {question.text}
        </label>
        {question.code && (
          <pre
            // Its own scroller, and wrapped, so a long line is readable without the field growing
            // past the window and the buttons going with it.
            tabIndex={0}
            className="mt-1.5 max-h-64 overflow-auto border border-border bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words outline-none"
          >
            {question.code}
          </pre>
        )}
        {question.choices.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {question.choices.map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={busy}
                onClick={() => answer(choice)}
                className="border border-border px-2.5 py-1 text-sm hover:bg-muted disabled:opacity-50"
              >
                {choice}
              </button>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex gap-2">
          <input
            ref={input}
            id={id('question-input')}
            name="answer"
            value={value}
            autoComplete="off"
            placeholder={question.choices.length > 0 ? 'or say it yourself' : 'your answer'}
            onChange={(event) => setValue(event.target.value)}
            className="min-w-0 flex-1 border border-border bg-background px-2 py-1 text-sm outline-none focus:border-foreground"
          />
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Send
          </button>
        </div>
        {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      </form>
      <button
        type="button"
        id={id('question-field-close')}
        aria-label="Close"
        onClick={() => answer('')}
        className="absolute top-0 right-0 flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
          <path d="M1 1 9 9M9 1 1 9" />
        </svg>
      </button>
    </div>
  )
}
