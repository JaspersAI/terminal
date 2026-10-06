import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { PreparedSkills, SkillInstallRequest } from '../../../shared/skills/skill-install'
import { errorMessage } from '../../lib/errors'
import { BUTTON } from './Row'

type Line = { text: string; error: boolean } | null

/** What an upload may be, checked here too so a large file is refused before it is read. */
const UPLOAD_MAX = 100 * 1024 * 1024

/**
 * The skill install under way, from start to finish: main fetches and checks, the prompt asks which
 * skills, and main moves them into place. Main holds one install at a time and a new one drops the
 * one waiting, so there is one here too: the pane's install row and an installed skill's Update
 * share it, and neither starts while the other is being checked or waits for an answer.
 */
interface Flow {
  /** Checking or installing. */
  working: boolean
  line: Line
  /** The skill an Update was started for; null for the pane's own installs. */
  updating: string | null
  prepared: PreparedSkills | null
}

let flow: Flow = { working: false, line: null, updating: null, prepared: null }
const listeners = new Set<() => void>()

function change(patch: Partial<Flow>): void {
  flow = { ...flow, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function read(): Flow {
  return flow
}

function idle(): boolean {
  return !flow.working && flow.prepared === null
}

function start(updating: string | null, request: SkillInstallRequest): void {
  if (idle()) check(updating, request)
}

function upload(file: File): void {
  if (!idle()) return
  if (file.size > UPLOAD_MAX) {
    change({ updating: null, line: { text: `${file.name} is larger than 100 MB.`, error: true } })
    return
  }
  change({ working: true, updating: null, line: { text: `Checking ${file.name}…`, error: false } })
  file
    .arrayBuffer()
    .then((bytes) => check(null, { kind: 'upload', name: file.name, bytes }))
    .catch((err: unknown) => change({ working: false, line: { text: errorMessage(err), error: true } }))
}

function check(updating: string | null, request: SkillInstallRequest): void {
  change({
    working: true,
    updating,
    line: { text: request.kind === 'upload' ? `Checking ${request.name}…` : 'Downloading and checking…', error: false },
  })
  window.app.skills
    .prepare(request)
    .then((result) => {
      if ('upToDate' in result) change({ line: { text: `${result.id} is already up to date.`, error: false } })
      else change({ line: null, prepared: result })
    })
    .catch((err: unknown) => change({ line: { text: errorMessage(err), error: true } }))
    .finally(() => change({ working: false }))
}

function install(names: string[]): void {
  const { prepared } = flow
  if (!prepared) return
  change({ working: true, prepared: null, line: { text: `Installing ${names.join(', ')}…`, error: false } })
  window.app.skills
    .confirm(prepared.token, names)
    .then((done) => change({ line: { text: `Installed ${done.join(', ')}.`, error: false } }))
    .catch((err: unknown) => change({ line: { text: errorMessage(err), error: true } }))
    .finally(() => change({ working: false }))
}

function cancel(): void {
  const { prepared } = flow
  if (prepared) void window.app.skills.cancel(prepared.token)
  change({ prepared: null, line: null })
}

/**
 * A view's hold on the skill install. The pane's (no skill) shows every line, an Update's included,
 * since the pane and a skill are never on screen together; a skill's shows the line of its own Update.
 */
export function useSkillInstall(skill: string | null = null): {
  busy: boolean
  line: Line
  start: (request: SkillInstallRequest) => void
  upload: (file: File) => void
} {
  const current = useSyncExternalStore(subscribe, read)
  useEffect(() => {
    if (skill !== null) return
    // Leaving the pane takes a finished install's line with it.
    return () => {
      if (idle()) change({ line: null, updating: null })
    }
  }, [skill])
  return {
    busy: current.working || current.prepared !== null,
    line: skill === null || current.updating === skill ? current.line : null,
    start: (request) => start(skill, request),
    upload,
  }
}

/** The prompt for the install that waits, whichever view started it. The Skills pane renders it once, on the body over Settings. */
export function PendingSkillInstall(): ReactElement | null {
  const { prepared } = useSyncExternalStore(subscribe, read)
  if (!prepared) return null
  return createPortal(
    <SkillInstallPrompt key={prepared.token} prepared={prepared} onInstall={install} onCancel={cancel} />,
    document.body,
  )
}

interface PromptProps {
  prepared: PreparedSkills
  onInstall: (names: string[]) => void
  onCancel: () => void
}

/**
 * The trust prompt: where the skills came from, what each one is, its SKILL.md to read, and which to
 * install. Everything on it came from reading the files, never from running anything. It owns
 * Escape while it is up, so Settings under it stays open.
 */
export function SkillInstallPrompt({ prepared, onInstall, onCancel }: PromptProps): ReactElement {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => dialog.current?.focus(), [])
  const [chosen, setChosen] = useState<string[]>(() =>
    prepared.skills.filter((skill) => skill.checked).map((skill) => skill.name),
  )
  const [shown, setShown] = useState<number | null>(null)
  const installable = prepared.skills.filter((skill) => skill.error === null).map((skill) => skill.name)
  const toggle = (name: string): void =>
    setChosen((list) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]))
  return (
    <div
      data-owns-escape
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onCancel()
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-4"
    >
      <div
        ref={dialog}
        id="skill-install-prompt"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="skill-install-title"
        aria-describedby="skill-install-warning"
        tabIndex={-1}
        className="flex max-h-full w-full max-w-2xl flex-col border border-border bg-background shadow-2xl outline-none"
      >
        <div className="border-b border-border p-6 pb-4">
          <h2 id="skill-install-title" className="text-base font-semibold break-words">
            Install skills from {prepared.source}?
          </h2>
          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
            {prepared.commit ? `commit ${prepared.commit}` : `SHA-256 ${prepared.sha256}`}
          </p>
          <p id="skill-install-warning" className="mt-3 border-l-2 border-destructive pl-3 text-sm">
            A skill's instructions go into the assistant's context and steer what it does with your plugins, views, and
            keys. Install only skills you trust.
          </p>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-6">
          {prepared.skills.map((skill, index) => {
            const details = [
              `${skill.files} file${skill.files === 1 ? '' : 's'}`,
              skill.scripts ? 'has scripts, not run here' : null,
              skill.replaces ? `replaces installed${skill.replaces.version ? ` ${skill.replaces.version}` : ''}` : null,
            ].filter(Boolean)
            return (
              <li
                key={`${index}:${skill.name}`}
                data-skill={skill.name}
                className="border-b border-border py-3 last:border-b-0"
              >
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={skill.error === null && chosen.includes(skill.name)}
                    disabled={skill.error !== null}
                    onChange={() => toggle(skill.name)}
                    className="mt-1 h-3.5 w-3.5 shrink-0 appearance-none border border-foreground checked:bg-foreground disabled:border-border disabled:opacity-50"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-mono text-sm">{skill.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{details.join(', ')}</span>
                    {skill.description && (
                      <span className="mt-0.5 line-clamp-3 text-sm text-muted-foreground">{skill.description}</span>
                    )}
                    {skill.error && (
                      <span className="mt-0.5 block text-sm break-words text-destructive">{skill.error}</span>
                    )}
                    {skill.warnings.length > 0 && (
                      <span className="mt-0.5 block text-xs break-words text-muted-foreground">
                        {skill.warnings.join(' ')}
                      </span>
                    )}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => setShown(shown === index ? null : index)}
                  className="mt-1 ml-6.5 text-xs text-muted-foreground underline hover:text-foreground"
                >
                  {shown === index ? 'Hide SKILL.md' : 'Show SKILL.md'}
                </button>
                {shown === index && (
                  <pre className="mt-2 ml-6.5 max-h-64 overflow-auto border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                    {skill.preview}
                  </pre>
                )}
              </li>
            )
          })}
        </ul>
        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          {installable.length > 1 ? (
            <div className="flex gap-2">
              <button type="button" onClick={() => setChosen(installable)} className={BUTTON}>
                Select all
              </button>
              <button type="button" onClick={() => setChosen([])} className={BUTTON}>
                None
              </button>
            </div>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className={BUTTON}>
              Cancel
            </button>
            <button
              id="skill-install-confirm"
              type="button"
              disabled={chosen.length === 0}
              onClick={() => onInstall(chosen)}
              className="shrink-0 border border-foreground bg-foreground px-2.5 py-1 text-sm text-background disabled:opacity-50"
            >
              Install {chosen.length === 1 ? '1 skill' : `${chosen.length} skills`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
