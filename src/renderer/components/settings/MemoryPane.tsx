import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ABOUT_MAX, BODY_MAX, type Memory } from '../../../shared/agent/memory'
import { STANDING_MAX } from '../../../shared/agent/standing'
import { errorMessage } from '../../lib/errors'
import { useAppState } from '../../lib/state'
import { StatusLine } from './InstallPrompt'
import { holdLeave, requestLeave } from './leave-guard'
import { BUTTON, FIELD } from './Row'
import { Entry, ListHeading, PinnedEntry, Split } from './Split'
import { shownEntry } from './summary'

/** The entry above the memories. A memory's name is lower case and never starts with +. */
const ALWAYS = '+always'

const PRIMARY =
  'shrink-0 border border-foreground bg-foreground px-2.5 py-1 text-sm text-background disabled:opacity-50'

type Line = { text: string; error: boolean } | null

/** A question asked in place, under the editor that raised it. */
function Ask({
  question,
  verb,
  busy,
  onCancel,
  onConfirm,
}: {
  question: string
  verb: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}): ReactElement {
  return (
    <div
      data-owns-escape
      id="memory-ask"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onCancel()
      }}
      className="mt-3 border border-border p-3"
    >
      <p className="text-sm">{question}</p>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" autoFocus onClick={onCancel} className={BUTTON}>
          {verb === 'Discard' ? 'Keep editing' : 'Cancel'}
        </button>
        <button type="button" disabled={busy} onClick={onConfirm} className={`${BUTTON} text-destructive`}>
          {verb}
        </button>
      </div>
    </div>
  )
}

/**
 * Settings' Memory pane: what is always true, and then one entry per thing the assistant has
 * learned, each of which is a file it wrote and this reads back. The app is the way to the files:
 * what it knows is here, in the open, and deleting one is forgetting.
 */
export function MemoryPane(): ReactElement {
  const memories = useAppState((s) => s.memories)
  const [open, setOpen] = useState<string | null>(null)
  const newest = [...memories].sort((a, b) => b.at - a.at)
  const shown = shownEntry(open, [ALWAYS, ...newest.map((one) => one.name)])
  // Unsaved edits in either editor ask before another entry takes its place.
  const pick = (id: string | null): void => requestLeave(() => setOpen(id))

  return (
    <Split
      label="Memory"
      shown={shown.id}
      picked={shown.picked}
      onBack={() => pick(null)}
      list={
        <>
          <PinnedEntry id={ALWAYS} selected={shown.id === ALWAYS} onSelect={() => pick(ALWAYS)}>
            Always true
          </PinnedEntry>
          <section aria-label="Memories">
            <ListHeading>What it has learned</ListHeading>
            {newest.length === 0 ? (
              <p className="px-4 py-1 text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
              <ul>
                {newest.map((one) => (
                  <Entry
                    key={one.name}
                    id={one.name}
                    selected={shown.id === one.name}
                    onSelect={() => pick(one.name)}
                    title={<span className="font-mono">{one.name}</span>}
                    line={one.about}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      }
      detail={
        shown.id !== null && shown.id !== ALWAYS ? (
          <MemoryDetail key={shown.id} name={shown.id} onBack={() => setOpen(null)} />
        ) : (
          <AlwaysDetail />
        )
      }
    />
  )
}

/** What is always true: the two AGENT.md files, read into every request's fixed block. */
function AlwaysDetail(): ReactElement {
  const workspace = useAppState((s) => s.workspaces.find((one) => one.id === s.currentWorkspaceId))
  return (
    <div id="memory-always">
      <h3 className="pr-8 text-base font-semibold">Always true</h3>
      <p className="mt-1 mb-6 pr-8 text-sm text-muted-foreground">
        Standing instructions, sent with every request: how you like replies, what you follow, what never to do. A skill
        is how to do one kind of work and is loaded when a request calls for it; this is what holds whatever the
        request.
      </p>
      <StandingEditor
        workspaceId={null}
        label="Everywhere"
        example={'Figures in millions, one decimal.\nI follow retail, not energy.'}
      />
      {workspace && (
        <div className="mt-8">
          <StandingEditor
            workspaceId={workspace.id}
            label={`On ${workspace.name} only`}
            example="What this workspace is for, and what belongs on it."
          />
        </div>
      )}
    </div>
  )
}

/** One AGENT.md. Empty removes the file, since having none is the ordinary case. */
function StandingEditor({
  workspaceId,
  label,
  example,
}: {
  workspaceId: string | null
  label: string
  example: string
}): ReactElement {
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [line, setLine] = useState<Line>(null)
  const [busy, setBusy] = useState(false)
  const dirty = saved !== null && draft !== saved

  useEffect(() => {
    let live = true
    window.app.memory
      .standing(workspaceId)
      .then((text) => {
        if (!live) return
        setSaved(text)
        setDraft(text)
      })
      .catch((err: unknown) => live && setLine({ text: errorMessage(err), error: true }))
    return () => {
      live = false
    }
  }, [workspaceId])

  const proceed = useRef<(() => void) | null>(null)
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (!dirty) return
    return holdLeave((go) => {
      proceed.current = go
      setAsking(true)
    })
  }, [dirty])

  const save = (): void => {
    if (!dirty || busy) return
    const written = draft
    setBusy(true)
    setLine({ text: 'Saving…', error: false })
    window.app.memory
      .saveStanding(workspaceId, written)
      .then(() => {
        setSaved(written)
        setLine({
          text: written.trim() ? 'Saved.' : 'Saved; the file is gone, which is the same as empty.',
          error: false,
        })
      })
      .catch((err: unknown) => setLine({ text: errorMessage(err), error: true }))
      .finally(() => setBusy(false))
  }

  const over = draft.trim().length - STANDING_MAX
  return (
    <section aria-label={label}>
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium">{label}</h4>
        <span className="font-mono text-xs text-muted-foreground">AGENT.md</span>
      </div>
      <textarea
        aria-label={label}
        value={draft}
        readOnly={saved === null}
        spellCheck={false}
        placeholder={saved === null ? 'Loading…' : example}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            save()
          }
        }}
        className="mt-2 h-40 w-full resize-none border border-border p-3 font-mono text-xs leading-relaxed outline-none focus:border-foreground"
      />
      <div className="mt-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {over > 0 && (
            <p className="text-xs text-destructive">
              {over} characters past the {STANDING_MAX} that are sent. The rest is left off.
            </p>
          )}
          <StatusLine line={line} />
        </div>
        <button type="button" disabled={!dirty || busy} onClick={save} className={PRIMARY}>
          Save
        </button>
      </div>
      {asking && (
        <Ask
          question="Discard your unsaved changes?"
          verb="Discard"
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false)
            setDraft(saved ?? '')
            proceed.current?.()
          }}
        />
      )}
    </section>
  )
}

/** One memory: the line the prompt carries, the body a tool reads, and the way to forget it. */
function MemoryDetail({ name, onBack }: { name: string; onBack: () => void }): ReactElement {
  const listed = useAppState((s) => s.memories.some((one) => one.name === name))
  const [saved, setSaved] = useState<Memory | null>(null)
  const [about, setAbout] = useState('')
  const [body, setBody] = useState('')
  const [line, setLine] = useState<Line>(null)
  const [asking, setAsking] = useState<'forget' | 'discard' | null>(null)
  const [busy, setBusy] = useState(false)
  const proceed = useRef<(() => void) | null>(null)
  const dirty = saved !== null && (about !== saved.about || body !== saved.body)

  useEffect(() => {
    let live = true
    window.app.memory
      .read(name)
      .then((one) => {
        if (!live || !one) return
        setSaved(one)
        setAbout(one.about)
        setBody(one.body)
      })
      .catch((err: unknown) => live && setLine({ text: errorMessage(err), error: true }))
    return () => {
      live = false
    }
  }, [name])

  useEffect(() => {
    if (!dirty) return
    return holdLeave((go) => {
      proceed.current = go
      setAsking('discard')
    })
  }, [dirty])

  // Forgotten while open, here or on disk.
  useEffect(() => {
    if (!listed) onBack()
  }, [listed, onBack])

  const save = (): void => {
    if (!dirty || busy) return
    const written = { about, body }
    setBusy(true)
    setLine({ text: 'Saving…', error: false })
    window.app.memory
      .write(name, written.about, written.body)
      .then(() => {
        setSaved((was) => (was ? { ...was, ...written } : was))
        setLine({ text: 'Saved.', error: false })
      })
      .catch((err: unknown) => setLine({ text: errorMessage(err), error: true }))
      .finally(() => setBusy(false))
  }

  const forget = (): void => {
    setBusy(true)
    window.app.memory
      .remove(name)
      .then(onBack)
      .catch((err: unknown) => {
        setLine({ text: errorMessage(err), error: true })
        setBusy(false)
      })
  }

  return (
    <div id="memory-detail">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pr-8">
        <h3 className="font-mono text-base font-semibold break-all">{name}</h3>
        <span className="font-mono text-xs text-muted-foreground">memory/{name}.md</span>
      </div>
      {saved && <p className="mt-1 text-sm text-muted-foreground">Written {new Date(saved.at).toLocaleString()}</p>}

      <label htmlFor="memory-about" className="mt-6 block text-sm">
        What it is about
      </label>
      <p className="mt-0.5 text-xs text-muted-foreground">
        The one line carried in every request. The body below is read only when this line looks like it bears on what
        was asked.
      </p>
      <input
        id="memory-about"
        name="memory-about"
        value={about}
        readOnly={saved === null}
        maxLength={ABOUT_MAX}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setAbout(event.target.value)}
        className={`${FIELD} mt-2`}
      />

      <label htmlFor="memory-body" className="mt-4 block text-sm">
        The memory
      </label>
      <textarea
        id="memory-body"
        value={body}
        readOnly={saved === null}
        maxLength={BODY_MAX}
        spellCheck={false}
        placeholder={saved === null ? 'Loading…' : undefined}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            save()
          }
        }}
        className="mt-2 h-64 w-full resize-none border border-border p-3 font-mono text-xs leading-relaxed outline-none focus:border-foreground"
      />

      <div className="mt-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <StatusLine line={line} />
        </div>
        <button type="button" onClick={() => setAsking('forget')} className={`${BUTTON} text-destructive`}>
          Forget
        </button>
        <button id="memory-save" type="button" disabled={!dirty || busy} onClick={save} className={PRIMARY}>
          Save
        </button>
      </div>

      {asking && (
        <Ask
          question={asking === 'forget' ? `Forget ${name}? Its file is deleted.` : 'Discard your unsaved changes?'}
          verb={asking === 'forget' ? 'Forget' : 'Discard'}
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            if (asking === 'forget') return forget()
            setAsking(null)
            setAbout(saved?.about ?? '')
            setBody(saved?.body ?? '')
            proceed.current?.()
          }}
        />
      )}
    </div>
  )
}
