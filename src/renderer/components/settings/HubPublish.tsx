import { useCallback, useEffect, useId, useState, type ReactElement } from 'react'
import { HANDLE_RULE, isHandle, type HubMe } from '../../../shared/hub/hub'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { BUTTON, FIELD, PRIMARY } from './Row'

// Publishing to Jaspers Hub from Settings: the button on a plugin or a skill of the user's own, the
// handle asked for the first time, what Hub answered, and what the user has published there with how
// each version's review stands. Main packs the folder and sends it as the account.

type Line = { text: string; error: boolean; page?: string } | null

const STATE: Record<string, string> = {
  pending: 'pending review',
  approved: 'approved',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
}

const ANALYSIS: Record<string, string> = {
  waiting: 'analysis waiting',
  done: 'analysis done',
  refused: 'analysis refused',
  failed: 'analysis failed',
  off: 'not analyzed',
}

/**
 * Publish to Hub, or Sign in with Jaspers without the sign-in. The handle asked for the first time,
 * and what Hub answered, take whole lines after it: in a row that wraps, put it last.
 */
export function PublishToHub({ kind, id }: { kind: 'plugin' | 'skill'; id: string }): ReactElement {
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [line, setLine] = useState<Line>(null)

  function send(): void {
    setBusy(true)
    setAsking(false)
    setLine({ text: 'Packing and sending…', error: false })
    window.app.hub
      .publish({ kind, id })
      .then(
        (answer) => {
          if ('needsHandle' in answer) {
            setLine(null)
            setAsking(true)
            return
          }
          const { version, page } = answer.published
          setLine({ text: `Published ${version} to Jaspers Hub, pending review.`, error: false, page })
        },
        (err: unknown) => setLine({ text: errorMessage(err), error: true }),
      )
      .finally(() => setBusy(false))
  }

  function signIn(): void {
    setBusy(true)
    setLine(null)
    dispatch({ type: 'jaspers.signIn' })
      .catch((err: unknown) => setLine({ text: errorMessage(err), error: true }))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <div className="flex justify-end">
        <button type="button" disabled={busy} onClick={signedIn ? send : signIn} className={BUTTON}>
          {signedIn ? 'Publish to Hub' : busy ? 'Waiting for the browser…' : 'Sign in with Jaspers'}
        </button>
      </div>
      {asking && <ClaimHandle onClaimed={send} onCancel={() => setAsking(false)} />}
      {line && (
        <p className={`w-full text-xs break-words ${line.error ? 'text-destructive' : 'text-muted-foreground'}`}>
          {line.text}
          {line.page && (
            <>
              {' '}
              <OpenPage page={line.page} />
            </>
          )}
        </p>
      )}
    </>
  )
}

/** The handle Hub needs before a first publish: asked here, checked against Hub's rule, then claimed. It owns Escape. */
function ClaimHandle({ onClaimed, onCancel }: { onClaimed: () => void; onCancel: () => void }): ReactElement {
  const [handle, setHandle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = useId()

  function claim(): void {
    const wanted = handle.trim()
    if (busy || !wanted) return
    if (!isHandle(wanted)) return setError(HANDLE_RULE)
    setBusy(true)
    setError(null)
    window.app.hub.claim(wanted).then(onClaimed, (err: unknown) => {
      setError(errorMessage(err))
      setBusy(false)
    })
  }

  return (
    <div
      data-owns-escape
      role="group"
      aria-labelledby={`${field}-label`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // Settings lets this have Escape; nothing under Settings should hear it too.
        event.stopPropagation()
        onCancel()
      }}
      className="w-full border border-border p-3"
    >
      <label id={`${field}-label`} htmlFor={field} className="text-sm">
        Choose your handle on Jaspers Hub. What you publish is listed under it, and it is claimed once.
      </label>
      <p className="mt-0.5 text-xs text-muted-foreground">{HANDLE_RULE}</p>
      <input
        id={field}
        autoFocus
        value={handle}
        placeholder="acme"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setHandle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') claim()
        }}
        className={`${FIELD} mt-2 font-mono`}
      />
      {error && <p className="mt-1 text-xs break-words text-destructive">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
        <button type="button" disabled={busy || !handle.trim()} onClick={claim} className={PRIMARY}>
          Claim and publish
        </button>
      </div>
    </div>
  )
}

/**
 * Settings > Plugins' Your Hub items: what the user has published to Hub, each item's versions
 * highest first, how each one's review stands, a rejection's note, and Hub's analysis of it.
 */
export function HubItems(): ReactElement {
  const [me, setMe] = useState<HubMe | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    setError(null)
    window.app.hub.me().then(setMe, (err: unknown) => setError(errorMessage(err)))
  }, [])
  useEffect(load, [load])

  return (
    <section aria-label="Your Hub items">
      {/* Clear of the close cross in the corner. */}
      <div className="pr-8">
        <h3 className="text-base font-semibold">Your Hub items</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {me?.handle
            ? `What you published to Jaspers Hub as ${me.handle}. Hub reviews each version before it is listed.`
            : 'What you publish to Jaspers Hub, from a plugin or a skill of your own. Your first publish claims your handle there.'}
        </p>
      </div>
      {error ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 text-sm break-words text-destructive">{error}</p>
          <button type="button" onClick={load} className={BUTTON}>
            Retry
          </button>
        </div>
      ) : !me ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : me.items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Nothing published yet.</p>
      ) : (
        <ul className="mt-4 border-t border-border">
          {me.items.map((item) => (
            <li key={`${item.handle}/${item.name}`} className="border-b border-border py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono">
                  {item.handle}/{item.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.kind} · {item.listed ? `listed ${item.listed}` : 'not listed'}
                </span>
              </div>
              <ul className="mt-1 space-y-0.5">
                {item.versions.map((version) => (
                  <li key={version.version} className="text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">{version.version}</span>{' '}
                    {STATE[version.state] ?? version.state} · {ANALYSIS[version.analysis] ?? version.analysis}
                    {version.note && <p className="break-words text-destructive">{version.note}</p>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** A page on Jaspers Hub, opened in the browser. */
function OpenPage({ page }: { page: string }): ReactElement {
  return (
    <button
      type="button"
      onClick={() => void window.app.openExternal(page)}
      className="underline hover:text-foreground"
    >
      Its page ↗
    </button>
  )
}
