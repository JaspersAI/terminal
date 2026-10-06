import { useEffect, useRef, useState, type FormEvent, type ReactElement, type RefObject } from 'react'
import type { SecretRequest } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch } from '../../lib/state'
import { hears } from './hears'

interface Props {
  request: SecretRequest
  /**
   * The composer's spring drives this, as it does the answer's: the field sits where replies land.
   * Left out in the docked chat, which does not move: the field is a row of it, above its command line.
   */
  box?: RefObject<HTMLDivElement | null>
}

/** Over the composer, riding its spring; in the docked chat, a plain row above the command line; in a tile's box, in its line's place. */
const FLOATING = 'pointer-events-auto absolute inset-x-0 bottom-39 border border-border bg-background shadow-lg'
const DOCKED = 'relative shrink-0 border-t border-border bg-background'
const TILE = 'relative shrink-0 bg-background'

/**
 * The one way a credential enters the app, asked for where the assistant's replies appear. The
 * assistant opens it with set_secret when a connection needs a key, and askForMissingSecret opens it
 * for any call that reached one without its key; the value goes from this field straight to main,
 * which seals it, so it never passes through the model, the logs, or the tree. The cross in the
 * corner cancels, as Escape does.
 *
 * One a tile's own run asked for is drawn in that tile's box (`on` names the tile), as its questions
 * are: its ids carry the tile, it takes the keyboard only from its own tile's line, and it hears
 * Escape only when it is pressed in its own box.
 */
export function SecretField({ request, box }: Props): ReactElement {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // The tile it is asked in, by its element's id: a box draws only its own workspace's tiles.
  const on = request.place?.on
  const id = (name: string): string => (on ? `${name}-${on}` : name)

  useEffect(() => {
    if (!on) input.current?.focus()
  }, [on])

  // Escape cancels, except where something else on screen owns the key, as for the answer.
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !hears(on, event.target)) return
      if (event.target instanceof HTMLElement && event.target.closest('#workspace-title')) return
      if (document.querySelector('[role=menu]')) return
      cancel()
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [])

  function cancel(): void {
    void dispatch({ type: 'secret.dismiss', ...(request.place ? { place: request.place } : {}) })
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    // Main clears the request once the value is sealed, which unmounts this.
    dispatch({ type: 'plugin.setSecret', plugin: request.plugin, key: request.key, value }).catch((err: unknown) => {
      setError(errorMessage(err))
      setBusy(false)
    })
  }

  return (
    <div ref={box} id={id('secret-field')} className={box ? FLOATING : on ? TILE : DOCKED}>
      <form onSubmit={submit} className="py-2 pr-8 pl-3 text-sm">
        <label htmlFor={id('secret-input')} className="block">
          <span className="font-medium">{request.label}</span>
          <span className="text-muted-foreground"> for the {request.plugin} plugin</span>
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            ref={input}
            id={id('secret-input')}
            name="secret"
            type="password"
            value={value}
            autoComplete="off"
            spellCheck={false}
            placeholder="paste the key"
            onChange={(event) => setValue(event.target.value)}
            className="min-w-0 flex-1 border border-border bg-background px-2 py-1 font-mono text-sm outline-none focus:border-foreground"
          />
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Save
          </button>
        </div>
        <p className={`mt-1.5 text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>
          {error ?? 'Sealed in your system keychain. The assistant never sees it.'}
        </p>
      </form>
      <button
        type="button"
        id={id('secret-field-cancel')}
        aria-label="Cancel"
        onClick={cancel}
        className="absolute top-0 right-0 flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
          <path d="M1 1 9 9M9 1 1 9" />
        </svg>
      </button>
    </div>
  )
}
