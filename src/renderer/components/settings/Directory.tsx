import { useId, useState, type ReactElement } from 'react'
import type { HubItem } from '../../../shared/hub/hub'
import { initials, itemKey, standing, useHubDirectory, type HubDirectory, type Standing } from '../../lib/hub-directory'
import { useAppState } from '../../lib/state'
import { StatusLine } from './InstallPrompt'
import type { Install } from './use-install'
import { BUTTON, FIELD } from './Row'

// The directory: what Jaspers Hub lists, the featured plugins first in Hub's order, then every other
// plugin there by stars. An entry installs through the three calls a pasted link uses, so nothing
// about trust changes: main checks the archive against the hash Hub sent, and the prompt still asks.
// While Hub cannot be reached, each part says so with Retry, and installing from a link still works.

/**
 * A logo per plugin id, bundled from `assets/providers/<id>.png`. Dropping a file in there is the
 * whole of adding one; an item with no file falls back to its title's letters.
 */
const LOGOS = import.meta.glob<string>('../../assets/providers/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})

/** The square in front of a title: the plugin's logo, or its letters when we bundle none. */
function Mark({ item, size }: { item: HubItem; size: 'sm' | 'lg' }): ReactElement {
  const logo = LOGOS[`../../assets/providers/${item.name}.png`]
  const box = size === 'lg' ? 'h-12 w-12' : 'h-8 w-8'
  if (logo)
    return <img src={logo} alt="" aria-hidden className={`${box} shrink-0 border border-border object-contain`} />
  return (
    <span
      aria-hidden
      className={`${box} flex shrink-0 items-center justify-center border border-border bg-muted font-mono tracking-tight text-muted-foreground ${
        size === 'lg' ? 'text-[11px]' : 'text-[9px]'
      }`}
    >
      {initials(item.title)}
    </span>
  )
}

/**
 * The Plugins pane's way in, and onboarding's last step: the featured plugins, the rest of Hub, and
 * the link field for anything not on it. Settings also searches Hub. One install runs at a time, so
 * the entry that started it holds the line.
 */
export function Directory({ installer, search }: { installer: Install; search: boolean }): ReactElement {
  const plugins = useAppState((s) => s.plugins)
  // What a Jaspers sign-up comes with, installing with no prompt: nothing else starts meanwhile.
  const installing = useAppState((s) => s.installing)
  const directory = useHubDirectory({ search })
  // Which entry started the install under way, so its line lands there and not in the link field's.
  const [startedBy, setStartedBy] = useState<string | null>(null)

  function begin(item: HubItem, now: Standing): void {
    setStartedBy(itemKey(item))
    installer.start(
      now === 'update' ? { kind: 'update', id: item.name } : { kind: 'hub', handle: item.handle, name: item.name },
    )
  }

  const entry = (item: HubItem): EntryProps => ({
    item,
    standing: standing(item, plugins),
    installing: installing === item.name,
    busy: installer.busy || installing !== null,
    onStart: begin,
    line: startedBy === itemKey(item) ? installer.line : null,
  })

  return (
    <section aria-label="Add a plugin">
      <div className="pr-8">
        <h3 className="text-base font-semibold">Add a plugin</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything on the grid comes from a plugin. Install one from Jaspers Hub, from a link, or write your own.
        </p>
      </div>

      <Featured directory={directory} entry={entry} />
      <Others directory={directory} entry={entry} search={search} />

      <FromLink
        installer={installer}
        // An Update started in a plugin's own section is that section's to say.
        line={startedBy === null && installer.lineFor === null ? installer.line : null}
        onStart={() => setStartedBy(null)}
      />
    </section>
  )
}

interface PartProps {
  directory: HubDirectory
  entry: (item: HubItem) => EntryProps
}

/** The plugins Hub features, as cards, in Hub's order. Nothing while they load, or when there are none. */
function Featured({ directory, entry }: PartProps): ReactElement | null {
  const { featured, retryFeatured } = directory
  if (!featured.error && featured.items.length === 0) return null
  return (
    <div className="mt-5">
      <h4 className="text-xs text-muted-foreground">Featured</h4>
      {featured.error ? (
        <Unreachable error={featured.error} onRetry={retryFeatured} />
      ) : (
        <div className="mt-2 grid gap-4 @min-[44rem]:grid-cols-2">
          {featured.items.map((item) => (
            <FeatureCard key={itemKey(item)} {...entry(item)} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Every other plugin on Hub, a page at a time, or what the search finds while it holds text. */
function Others({ directory, entry, search }: PartProps & { search: boolean }): ReactElement {
  const { others, query, setQuery, more, retryOthers } = directory
  const searching = query.trim() !== ''
  return (
    <div className="mt-8">
      <h4 className="text-xs text-muted-foreground">On Jaspers Hub</h4>
      {search && (
        <input
          type="search"
          aria-label="Search Jaspers Hub"
          value={query}
          placeholder="Search Jaspers Hub"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          // The browser's own clear button is drawn in its own colors, which are not the app's.
          className={`${FIELD} mt-2 [&::-webkit-search-cancel-button]:hidden`}
        />
      )}
      {others.items.length > 0 && (
        <ul className="mt-2 border-t border-border">
          {others.items.map((item) => (
            <SourceRow key={itemKey(item)} {...entry(item)} />
          ))}
        </ul>
      )}
      {others.error ? (
        <Unreachable error={others.error} onRetry={retryOthers} />
      ) : others.loading ? (
        <p className="mt-2 text-sm text-muted-foreground">{searching ? 'Searching…' : 'Loading…'}</p>
      ) : others.items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {searching ? 'Nothing on Jaspers Hub matches.' : 'Nothing more on Jaspers Hub yet.'}
        </p>
      ) : (
        others.more && (
          <button type="button" onClick={more} className={`${BUTTON} mt-3`}>
            More
          </button>
        )
      )}
    </div>
  )
}

/** A part Hub could not give: why, and the way to ask again. */
function Unreachable({ error, onRetry }: { error: string; onRetry: () => void }): ReactElement {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1 text-sm break-words text-destructive">{error}</p>
      <button type="button" onClick={onRetry} className={BUTTON}>
        Retry
      </button>
    </div>
  )
}

interface EntryProps {
  item: HubItem
  standing: Standing
  /** Being installed with no prompt, as what a Jaspers sign-up comes with is. */
  installing: boolean
  busy: boolean
  onStart: (item: HubItem, now: Standing) => void
  line: Install['line']
}

/** A featured plugin: what it is, who published it, and the way in. */
function FeatureCard(props: EntryProps): ReactElement {
  const { item, line } = props
  return (
    <div className="flex flex-col border border-border p-4">
      <div className="flex items-start gap-3">
        <Mark item={item} size="lg" />
        <div className="min-w-0">
          <h5 className="text-sm font-semibold">{item.title}</h5>
          <Facts item={item} />
        </div>
      </div>
      <p className="mt-3 flex-1 text-sm text-muted-foreground">{item.description}</p>
      <div className="mt-4 flex items-center gap-3">
        <Action {...props} />
        <Page item={item} />
      </div>
      <StatusLine line={line} />
    </div>
  )
}

/** Any other plugin: its mark, what it is, who published it, and where it stands. */
function SourceRow(props: EntryProps): ReactElement {
  const { item, line } = props
  return (
    <li className="border-b border-border py-2.5">
      <div className="flex items-center gap-3">
        <Mark item={item} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{item.title}</p>
          <p className="truncate text-xs text-muted-foreground">{item.description}</p>
          <Facts item={item} />
        </div>
        <span className="hidden shrink-0 @min-[44rem]:block">
          <Page item={item} />
        </span>
        <span className="flex w-20 shrink-0 justify-end">
          <Action {...props} />
        </span>
      </div>
      <StatusLine line={line} />
    </li>
  )
}

/** Who published it, with Jaspers' mark on its own, the version Hub shows, and whether Hub reviewed it. */
function Facts({ item }: { item: HubItem }): ReactElement {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <span>{item.handle}</span>
      {item.official && <span className="border border-border px-1 text-[10px] text-foreground">Official</span>}
      <span>· {item.version}</span>
      {item.reviewed && <span>· Reviewed</span>}
    </p>
  )
}

/** Install, Update, or Installed, or Installing… while it installs with no prompt. */
function Action({ item, standing: now, installing, busy, onStart }: EntryProps): ReactElement {
  if (installing) return <span className="text-sm text-muted-foreground">Installing…</span>
  if (now === 'installed') return <span className="text-sm text-muted-foreground">Installed</span>
  return (
    <button type="button" disabled={busy} onClick={() => onStart(item, now)} className={BUTTON}>
      {now === 'update' ? 'Update' : 'Install'}
    </button>
  )
}

/** The item's page on Jaspers Hub, opened in the browser. */
function Page({ item }: { item: HubItem }): ReactElement {
  return (
    <button
      type="button"
      onClick={() => void window.app.openExternal(item.page)}
      className="text-xs text-muted-foreground hover:text-foreground"
    >
      Hub page ↗
    </button>
  )
}

/** The way in for anything not on Hub: a repo, a link to an archive, or a file. */
function FromLink({
  installer,
  line,
  onStart,
}: {
  installer: Install
  line: Install['line']
  onStart: () => void
}): ReactElement {
  const [text, setText] = useState('')
  const field = useId()
  const { busy, start } = installer

  function begin(request: Parameters<Install['start']>[0]): void {
    onStart()
    start(request)
  }

  return (
    <div className="mt-8 border-t border-border pt-4">
      <label htmlFor={field} className="text-sm font-semibold">
        From a link
      </label>
      <p className="mt-0.5 text-xs text-muted-foreground">
        A GitHub repo with a release, an https link to a .zip or .tar.gz, or a file. A plugin runs with your
        permissions, so install what you trust.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          id={field}
          value={text}
          placeholder="https://github.com/owner/repo"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !busy && text.trim()) begin({ kind: 'url', text })
          }}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => begin({ kind: 'url', text })}
          className={BUTTON}
        >
          Install
        </button>
        <button type="button" disabled={busy} onClick={() => begin({ kind: 'file' })} className={BUTTON}>
          Choose file…
        </button>
      </div>
      <StatusLine line={line} />
    </div>
  )
}
