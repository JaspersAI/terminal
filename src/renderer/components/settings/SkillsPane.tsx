import { useId, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { SkillInfo } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { useAppState } from '../../lib/state'
import { StatusLine } from './InstallPrompt'
import { requestLeave } from './leave-guard'
import { BUTTON, FIELD, Row } from './Row'
import { SkillDetail } from './SkillDetail'
import { PendingSkillInstall, useSkillInstall } from './SkillInstall'
import { Entry, ListHeading, PinnedEntry, PlusIcon, Split } from './Split'
import { shownEntry, skillTitle } from './summary'

/** The entry above the skills. A skill's id is a name, which never starts with +. */
const ADD = '+add'

/**
 * Settings' Skills pane: the user's skills and then each plugin's, and beside them the one picked, in
 * its editor, or the ways to add one: installing from GitHub or an upload, or writing a new one. The
 * app is the user's way to the files: nothing here sends anyone to a folder.
 */
export function SkillsPane(): ReactElement {
  const skills = useAppState((s) => s.skills)
  const disabled = useAppState((s) => s.disabledSkills)
  const install = useSkillInstall()
  const [open, setOpen] = useState<string | null>(null)

  const list = Object.values(skills)
  const plugins = [...new Set(list.flatMap((skill) => (skill.plugin ? [skill.plugin] : [])))].sort()
  const groups = [
    { title: 'Your skills', skills: list.filter((skill) => skill.plugin === null) },
    ...plugins.map((plugin) => ({ title: `From ${plugin}`, skills: list.filter((skill) => skill.plugin === plugin) })),
  ]
  const shown = shownEntry(open, [ADD, ...groups.flatMap((group) => group.skills.map((skill) => skill.id))])
  // Unsaved edits in the editor ask before another entry takes its place.
  const pick = (id: string | null): void => requestLeave(() => setOpen(id))

  return (
    <DropZone onFile={install.upload}>
      <Split
        label="Skills"
        shown={shown.id}
        picked={shown.picked}
        onBack={() => pick(null)}
        list={
          <>
            <PinnedEntry id={ADD} selected={shown.id === ADD} onSelect={() => pick(ADD)} icon={<PlusIcon />}>
              Add a skill
            </PinnedEntry>
            {groups.map((group) => (
              <section key={group.title} aria-label={group.title}>
                <ListHeading>{group.title}</ListHeading>
                {group.skills.length === 0 ? (
                  <p className="px-4 py-1 text-sm text-muted-foreground">None yet.</p>
                ) : (
                  <ul>
                    {group.skills.map((skill) => (
                      <SkillEntry
                        key={skill.id}
                        skill={skill}
                        enabled={!disabled.includes(skill.id)}
                        selected={shown.id === skill.id}
                        onSelect={() => pick(skill.id)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </>
        }
        detail={
          shown.id !== null && shown.id !== ADD ? (
            <SkillDetail id={shown.id} onBack={() => setOpen(null)} onOpen={setOpen} />
          ) : (
            <AddDetail install={install} onCreated={setOpen} />
          )
        }
      />
      {/* The install that waits asks here, whichever entry is on screen and whichever started it. */}
      <PendingSkillInstall />
    </DropZone>
  )
}

function SkillEntry({
  skill,
  enabled,
  selected,
  onSelect,
}: {
  skill: SkillInfo
  enabled: boolean
  selected: boolean
  onSelect: () => void
}): ReactElement {
  return (
    <Entry
      id={skill.id}
      selected={selected}
      onSelect={onSelect}
      title={<span className={`font-mono ${enabled ? '' : 'text-muted-foreground'}`}>{skillTitle(skill)}</span>}
      tag={enabled ? undefined : 'off'}
      line={skill.error ? <span className="text-destructive">{skill.error}</span> : skill.description}
    />
  )
}

/** The ways to add a skill: a GitHub link, an upload, or a new one written here. */
function AddDetail({
  install,
  onCreated,
}: {
  install: ReturnType<typeof useSkillInstall>
  onCreated: (id: string) => void
}): ReactElement {
  return (
    <>
      <p className="mb-6 pr-8 text-sm text-muted-foreground">
        Instructions the assistant loads when a request matches what a skill is for, or when you type /name in the text
        field. Your own, and the ones plugins bring.
      </p>
      <div className="border-t border-border">
        <InstallRow install={install} />
        {/* Not a Row: its hint is long, and a Row that wraps leaves the buttons stranded mid-line. */}
        <div className="border-b border-border py-3 text-sm">
          <p>Add your own</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Upload a .zip, .skill, or SKILL.md, or drop one on this pane. Or write a new one.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <UploadButton busy={install.busy} onFile={install.upload} />
            <NewSkill onCreated={onCreated} />
          </div>
        </div>
      </div>
    </>
  )
}

function InstallRow({ install }: { install: ReturnType<typeof useSkillInstall> }): ReactElement {
  const [text, setText] = useState('')
  const field = useId()
  const go = (): void => {
    if (!install.busy && text.trim()) install.start({ kind: 'github', text })
  }
  return (
    <Row label="Install from GitHub" htmlFor={field} hint="A repo, a folder in one, or a SKILL.md">
      <div className="flex gap-2">
        <input
          id={field}
          name="skill-link"
          value={text}
          placeholder="https://github.com/owner/repo"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') go()
          }}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <button type="button" disabled={install.busy || !text.trim()} onClick={go} className={BUTTON}>
          Install
        </button>
      </div>
      <StatusLine line={install.line} />
    </Row>
  )
}

function UploadButton({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }): ReactElement {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className={BUTTON}>
        Upload…
      </button>
      <input
        ref={input}
        id="skill-upload"
        type="file"
        accept=".zip,.skill,.gz,.tgz,.md"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) onFile(file)
        }}
      />
    </>
  )
}

/** A name, then the template, then its editor. The field owns Escape, so Settings stays open. */
function NewSkill({ onCreated }: { onCreated: (id: string) => void }): ReactElement {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!naming) {
    return (
      <button type="button" onClick={() => setNaming(true)} className={BUTTON}>
        New skill
      </button>
    )
  }
  const create = (): void => {
    if (busy || !name.trim()) return
    setBusy(true)
    setError(null)
    window.app.skills
      .create(name.trim())
      .then(onCreated)
      .catch((err: unknown) => {
        setError(errorMessage(err))
        setBusy(false)
      })
  }
  return (
    <div data-owns-escape className="flex w-full flex-col gap-1">
      <div className="flex gap-2">
        <input
          autoFocus
          name="new-skill"
          aria-label="New skill name"
          value={name}
          placeholder="morning-brief"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') create()
            if (event.key === 'Escape') {
              // Settings lets this field have Escape; nothing under Settings should hear it too.
              event.stopPropagation()
              setNaming(false)
            }
          }}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <button type="button" disabled={busy || !name.trim()} onClick={create} className={BUTTON}>
          Create
        </button>
        <button type="button" onClick={() => setNaming(false)} className={BUTTON}>
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** The whole pane takes a dropped file, outlined while one is over it. */
function DropZone({ onFile, children }: { onFile: (file: File) => void; children: ReactNode }): ReactElement {
  const [over, setOver] = useState(false)
  return (
    <div
      id="skills-drop"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        const file = event.dataTransfer.files[0]
        if (file) onFile(file)
      }}
      className={`h-full -outline-offset-4 ${over ? 'outline-2 outline-foreground outline-dashed' : ''}`}
    >
      {children}
    </div>
  )
}
