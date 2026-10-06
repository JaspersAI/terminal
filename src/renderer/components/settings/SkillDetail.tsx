import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { SkillFile } from '../../../shared/skills/skills'
import type { SkillInfo } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { StatusLine } from './InstallPrompt'
import { sizeText } from './format'
import { holdLeave } from './leave-guard'
import { PublishToHub } from './HubPublish'
import { BUTTON, FIELD, PRIMARY } from './Row'
import { useSkillInstall } from './SkillInstall'
import { skillTitle } from './summary'

type Line = { text: string; error: boolean; reload?: boolean } | null

interface Doc {
  path: string
  text: string
  hash: string
}

/** A question asked in place, above the editor. */
type Ask =
  | { kind: 'discard'; proceed: () => void }
  | { kind: 'remove' }
  | { kind: 'delete-file'; path: string }
  | { kind: 'new-file' }
  | { kind: 'duplicate' }

interface Props {
  id: string
  onBack: () => void
  onOpen: (id: string) => void
}

/**
 * One skill: what it is, its files, and a text editor. The user's own skills save; installed and
 * plugin skills read only, with Duplicate for a copy that is the user's. Unsaved edits ask before
 * anything leaves them, here or in Settings.
 */
export function SkillDetail({ id, onBack, onOpen }: Props): ReactElement {
  const skill = useAppState((s) => s.skills[id])
  const enabled = useAppState((s) => !s.disabledSkills.includes(id))
  const update = useSkillInstall(id)
  const [files, setFiles] = useState<SkillFile[]>([])
  const [current, setCurrent] = useState('SKILL.md')
  const [doc, setDoc] = useState<Doc | null>(null)
  const [hidden, setHidden] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [line, setLine] = useState<Line>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [saving, setSaving] = useState(false)
  // The file on screen now: a read or a save that answers for another one is dropped.
  const shownPath = useRef('SKILL.md')
  const editable = skill?.origin === 'local'
  const dirty = doc !== null && draft !== doc.text

  const loadFiles = useCallback((): void => {
    window.app.skills
      .files(id)
      .then(setFiles)
      .catch((err: unknown) => setLine({ text: errorMessage(err), error: true }))
  }, [id])
  // The tree's list changes when a file is added or removed, here or on disk.
  const listed = skill?.files.join('\n')
  useEffect(() => {
    if (listed !== undefined) loadFiles()
  }, [loadFiles, listed])

  const read = useCallback(
    (path: string): void => {
      shownPath.current = path
      setCurrent(path)
      setAsk(null)
      window.app.skills
        .read(id, path)
        .then((result) => {
          if (shownPath.current !== path) return
          setDoc({ path, ...result })
          setDraft(result.text)
          setHidden(null)
          setLine(null)
        })
        .catch((err: unknown) => {
          if (shownPath.current !== path) return
          setDoc(null)
          setHidden(errorMessage(err))
        })
    },
    [id],
  )
  useEffect(() => read('SKILL.md'), [read])

  // While there are unsaved edits, closing Settings or changing pane asks here first.
  useEffect(() => {
    if (!dirty) return
    return holdLeave((proceed) => setAsk({ kind: 'discard', proceed }))
  }, [dirty])

  // Removed while open, here or on disk: back to the list.
  const gone = skill === undefined
  useEffect(() => {
    if (gone) onBack()
  }, [gone, onBack])
  if (!skill) return <p className="text-sm text-muted-foreground">This skill is gone.</p>

  const leave = (proceed: () => void): void => (dirty ? setAsk({ kind: 'discard', proceed }) : proceed())

  function save(): void {
    if (!doc || !editable || !dirty || saving) return
    const written = { path: doc.path, text: draft }
    setSaving(true)
    setLine({ text: 'Saving…', error: false })
    window.app.skills
      .write(id, written.path, written.text, doc.hash)
      .then(({ hash }) => {
        if (shownPath.current !== written.path) return
        setDoc({ ...written, hash })
        setLine({ text: 'Saved.', error: false })
      })
      .catch((err: unknown) => {
        if (shownPath.current !== written.path) return
        const text = errorMessage(err)
        setLine({ text, error: true, reload: /changed since you opened it|is gone/.test(text) })
      })
      .finally(() => setSaving(false))
  }

  const badges = [skill.modelInvocable ? null : 'only by /name', skill.userInvocable ? null : 'assistant only'].filter(
    (badge) => badge !== null,
  )

  return (
    <div id="skill-detail">
      {/* Clear of the close cross in the corner. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pr-8">
        <h3 className="font-mono text-base font-semibold break-all">{skillTitle(skill)}</h3>
        <span className="text-sm text-muted-foreground">{[originText(skill), ...badges].join(' · ')}</span>
      </div>
      {skill.description && <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={enabled}
          aria-label={`${enabled ? 'Turn off' : 'Turn on'} ${skill.id}`}
          onClick={() => {
            dispatch({ type: 'skill.setEnabled', id, enabled: !enabled }).catch((err: unknown) =>
              setLine({ text: errorMessage(err), error: true }),
            )
          }}
          className={BUTTON}
        >
          {enabled ? 'On' : 'Off'}
        </button>
        <span className="flex-1" />
        <button type="button" onClick={() => leave(() => setAsk({ kind: 'duplicate' }))} className={BUTTON}>
          Duplicate
        </button>
        {skill.install?.updatable && (
          <button
            type="button"
            disabled={update.busy}
            onClick={() => update.start({ kind: 'update', id })}
            className={BUTTON}
          >
            Update
          </button>
        )}
        {skill.origin !== 'plugin' && (
          <button type="button" onClick={() => setAsk({ kind: 'remove' })} className={BUTTON}>
            {skill.origin === 'installed' ? 'Remove' : 'Delete'}
          </button>
        )}
        {/* Last in the row: what it has to say takes whole lines under it. */}
        {skill.origin === 'local' && <PublishToHub kind="skill" id={id} />}
      </div>
      <StatusLine line={update.line} />
      {ask && (
        <AskRow
          key={ask.kind}
          ask={ask}
          skill={skill}
          onDone={() => setAsk(null)}
          onBack={onBack}
          onOpen={onOpen}
          onRead={read}
          onFiles={loadFiles}
        />
      )}

      <div className="mt-4 flex h-[26rem] border border-border">
        <ul aria-label="Files" className="w-44 shrink-0 overflow-y-auto border-r border-border py-1">
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                title={file.path}
                onClick={() => {
                  if (file.path !== current) leave(() => read(file.path))
                }}
                className={`flex w-full items-baseline gap-2 px-3 py-1 text-left font-mono text-xs ${file.path === current ? 'bg-muted' : 'hover:bg-muted'} ${
                  file.text ? '' : 'text-muted-foreground'
                }`}
              >
                <span className="min-w-0 truncate">{file.path}</span>
                {!file.text && <span className="shrink-0">{sizeText(file.size)}</span>}
              </button>
            </li>
          ))}
        </ul>
        {doc ? (
          <textarea
            id="skill-editor"
            aria-label={`${current} in ${skill.id}`}
            value={draft}
            readOnly={!editable}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault()
                save()
              }
            }}
            className="min-w-0 flex-1 resize-none p-3 font-mono text-xs leading-relaxed outline-none"
          />
        ) : (
          <p className="min-w-0 flex-1 p-3 text-sm text-muted-foreground">{hidden ?? 'Loading…'}</p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <SkillState skill={skill} current={current} editable={editable} />
        {editable && (
          <div className="flex gap-2">
            <button type="button" onClick={() => leave(() => setAsk({ kind: 'new-file' }))} className={BUTTON}>
              New file
            </button>
            {current !== 'SKILL.md' && (
              <button type="button" onClick={() => setAsk({ kind: 'delete-file', path: current })} className={BUTTON}>
                Delete file
              </button>
            )}
            <button id="skill-save" type="button" disabled={!dirty || saving} onClick={save} className={PRIMARY}>
              Save
            </button>
          </div>
        )}
      </div>
      <StatusLine line={line} />
      {line?.reload && (
        <button type="button" onClick={() => read(current)} className={`${BUTTON} mt-1`}>
          Reload
        </button>
      )}
    </div>
  )
}

function originText(skill: SkillInfo): string {
  if (skill.origin === 'plugin') return `from the ${skill.plugin} plugin`
  if (skill.origin === 'local') return 'yours'
  const version = skill.install?.version ? ` ${skill.install.version}` : ''
  return `installed${version}${skill.install ? ` from ${skill.install.source}` : ''}`
}

/** Under the editor: what the tree says of SKILL.md, and why a file is read only. */
function SkillState({
  skill,
  current,
  editable,
}: {
  skill: SkillInfo
  current: string
  editable: boolean
}): ReactElement {
  const readOnly = editable
    ? null
    : `Read only: ${skill.origin === 'plugin' ? 'the plugin owns it' : 'an update would replace edits'}. Duplicate it to edit a copy.`
  if (current !== 'SKILL.md') return <p className="min-w-0 flex-1 text-xs text-muted-foreground">{readOnly}</p>
  return (
    <div id="skill-state" className="min-w-0 flex-1 text-xs">
      {skill.error ? (
        <p className="break-words text-destructive">{skill.error}</p>
      ) : (
        <p className="break-words text-muted-foreground">
          {skill.warnings.join(' ') || 'Ready: the assistant sees this skill by its description.'}
        </p>
      )}
      {readOnly && <p className="mt-0.5 text-muted-foreground">{readOnly}</p>}
    </div>
  )
}

interface AskProps {
  ask: Ask
  skill: SkillInfo
  onDone: () => void
  onBack: () => void
  onOpen: (id: string) => void
  onRead: (path: string) => void
  onFiles: () => void
}

/** The question over the editor: discard edits, remove the skill, delete a file, name a new file or a copy. It owns Escape. */
function AskRow({ ask, skill, onDone, onBack, onOpen, onRead, onFiles }: AskProps): ReactElement {
  const [value, setValue] = useState(ask.kind === 'duplicate' ? `${skill.name}-copy` : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fail = (err: unknown): void => {
    setBusy(false)
    setError(errorMessage(err))
  }

  function confirm(): void {
    if (busy) return
    setError(null)
    switch (ask.kind) {
      case 'discard':
        onDone()
        ask.proceed()
        return
      case 'remove':
        setBusy(true)
        dispatch({ type: 'skill.remove', id: skill.id }).then(onBack, fail)
        return
      case 'delete-file':
        setBusy(true)
        window.app.skills.removeFile(skill.id, ask.path).then(() => {
          onDone()
          onFiles()
          onRead('SKILL.md')
        }, fail)
        return
      case 'new-file': {
        if (value.trim().endsWith('/')) {
          setError('Name a file, like references/notes.md.')
          return
        }
        const path = value
          .trim()
          .split('/')
          .filter((part) => part !== '' && part !== '.')
          .join('/')
        setBusy(true)
        window.app.skills.write(skill.id, path, '', null).then(() => {
          onDone()
          onFiles()
          onRead(path)
        }, fail)
        return
      }
      case 'duplicate':
        setBusy(true)
        window.app.skills.duplicate(skill.id, value.trim()).then(onOpen, fail)
        return
    }
  }

  const question =
    ask.kind === 'discard'
      ? 'Discard your unsaved changes?'
      : ask.kind === 'remove'
        ? `${skill.origin === 'installed' ? 'Remove' : 'Delete'} ${skill.id}? Its folder goes to the trash.`
        : ask.kind === 'delete-file'
          ? `Delete ${ask.path}?`
          : ask.kind === 'new-file'
            ? 'New file, relative to the skill’s folder:'
            : 'Name the copy:'
  const verb = {
    discard: 'Discard',
    remove: skill.origin === 'installed' ? 'Remove' : 'Delete',
    'delete-file': 'Delete',
    'new-file': 'Create',
    duplicate: 'Duplicate',
  }[ask.kind]
  const named = ask.kind === 'new-file' || ask.kind === 'duplicate'
  const destructive = ask.kind === 'discard' || ask.kind === 'remove' || ask.kind === 'delete-file'

  return (
    <div
      data-owns-escape
      id="skill-ask"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onDone()
      }}
      className="mt-3 border border-border p-3"
    >
      <p className="text-sm">{question}</p>
      {named && (
        <input
          autoFocus
          aria-label={question}
          value={value}
          placeholder={ask.kind === 'new-file' ? 'references/notes.md' : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') confirm()
          }}
          className={`${FIELD} mt-2`}
        />
      )}
      {error && <p className="mt-1 text-xs break-words text-destructive">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" autoFocus={!named} onClick={onDone} className={BUTTON}>
          {ask.kind === 'discard' ? 'Keep editing' : 'Cancel'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={confirm}
          className={destructive ? `${BUTTON} text-destructive` : PRIMARY}
        >
          {verb}
        </button>
      </div>
    </div>
  )
}
