import { useState, type FormEvent, type ReactElement } from 'react'
import type { WaitingView } from '../../../shared/plugins/needs'
import { errorMessage } from '../../lib/errors'
import { dispatch } from '../../lib/state'

interface Props {
  /** The view that is waiting, and what its plugin needs. */
  waiting: WaitingView
  /** The tile it is asked in, by its element's id, which the field's id carries. */
  on: string
  /** Sets the ask aside, which shows the view as it is, without what it needs. */
  onSkip: () => void
}

/**
 * What a plugin needs from the user before a view of its has anything to show, asked for in the box
 * of the tile that holds the view, in its line's place: a key in a secure field, or a sign-in. The
 * view is not drawn meanwhile: it would only show its calls failing, in words written for the
 * assistant. A key goes from this field straight to main, which seals it, as it does from the field a
 * run asks with; the tree then says the key is set, the ask goes, and the view comes up with it. A
 * sign-in opens the browser, and the view comes up once the connection has its token. The cross sets
 * the ask aside, and the view is drawn as it is.
 */
export function Need({ waiting, on, onSkip }: Props): ReactElement {
  const { plugin, title, need } = waiting
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (need.kind !== 'key' || !value.trim() || busy) return
    setBusy(true)
    setError(null)
    // Main marks the key set once it is sealed, which takes this away.
    dispatch({ type: 'plugin.setSecret', plugin, key: need.key, value }).catch((err: unknown) => {
      setError(errorMessage(err))
      setBusy(false)
    })
  }

  function authorize(): void {
    if (need.kind !== 'authorization') return
    setBusy(true)
    setError(null)
    dispatch({ type: 'connection.authorize', id: need.connection }).catch((err: unknown) => {
      setError(errorMessage(err))
      setBusy(false)
    })
  }

  return (
    <div data-need={need.kind} className="relative shrink-0 bg-background">
      {need.kind === 'key' ? (
        <form onSubmit={save} className="py-2 pr-8 pl-3 text-sm">
          <label htmlFor={`need-input-${on}`} className="block">
            <span className="font-medium">{need.label}</span>
            <span className="text-muted-foreground"> for {title}</span>
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id={`need-input-${on}`}
              name="element-secret"
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
      ) : (
        <div className="py-2 pr-8 pl-3 text-sm">
          <p>
            <span className="font-medium">{title}</span>
            <span className="text-muted-foreground"> needs you to sign in before it can show anything.</span>
          </p>
          <button
            type="button"
            onClick={authorize}
            className="mt-1.5 bg-primary px-3 py-1 text-sm font-medium text-primary-foreground"
          >
            Authorize
          </button>
          <p className={`mt-1.5 text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>
            {error ?? (busy ? 'Waiting for you to sign in, in your browser.' : 'Opens your browser to sign in.')}
          </p>
        </div>
      )}
      <button
        type="button"
        id={`need-skip-${on}`}
        aria-label="Show the view without it"
        onClick={onSkip}
        className="absolute top-0 right-0 flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
          <path d="M1 1 9 9M9 1 1 9" />
        </svg>
      </button>
    </div>
  )
}
