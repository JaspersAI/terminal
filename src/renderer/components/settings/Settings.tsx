import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useAppState } from '../../lib/state'
import { requestLeave } from './leave-guard'
import { AboutPane } from './AboutPane'
import { AppearancePane } from './AppearancePane'
import { ConnectionsPane } from './ConnectionsPane'
import { DataPane } from './DataPane'
import { EyePane } from './EyePane'
import { LlmPane } from './LlmPane'
import { MemoryPane } from './MemoryPane'
import { PluginsPane } from './PluginsPane'
import { ProModePane } from './ProModePane'
import { SkillsPane } from './SkillsPane'
import { TasksPane } from './TasksPane'

type Pane =
  'llm' | 'plugins' | 'connections' | 'skills' | 'memory' | 'tasks' | 'data' | 'appearance' | 'pro' | 'eye' | 'about'

const PANES: { id: Pane; label: string; icon: () => ReactElement }[] = [
  { id: 'llm', label: 'LLM', icon: ChipIcon },
  { id: 'plugins', label: 'Plugins', icon: PlugIcon },
  { id: 'connections', label: 'Connections', icon: LinkIcon },
  { id: 'skills', label: 'Skills', icon: SkillIcon },
  { id: 'memory', label: 'Memory', icon: MemoryIcon },
  { id: 'tasks', label: 'Tasks', icon: ClockIcon },
  { id: 'data', label: 'Data', icon: DataIcon },
  { id: 'appearance', label: 'Appearance', icon: AppearanceIcon },
  { id: 'pro', label: 'Pro mode', icon: TerminalIcon },
  { id: 'eye', label: 'Eye', icon: EyeIcon },
  { id: 'about', label: 'About', icon: InfoIcon },
]

interface Props {
  onClose: () => void
  /** Leaves Settings for View loops, the loops of the workspace on screen. */
  onViewLoops: () => void
}

/**
 * Settings, over the whole home screen: the panes down the left and the chosen one on the right.
 * Each pane saves through the actions onboarding and the Plugins view dispatch, so closing it
 * loses nothing but a draft that was never saved. Over the panes, while the user is signed in with
 * Jaspers, Account is no pane: it opens the account's page on Account in the browser, and the pane
 * on show stays. Under them, View loops leaves Settings for the list of the workspace's loops, open
 * and closed (`LoopsDialog`). Escape, the cross, or a press on the backdrop closes it.
 */
export function Settings({ onClose, onViewLoops }: Props): ReactElement {
  const [pane, setPane] = useState<Pane>('llm')
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  // Focus starts inside, so keys land here and not on the workspace underneath.
  useEffect(() => dialog.current?.focus(), [])

  // Escape is heard in the capture phase and goes no further: the answer box and the key field
  // above the composer close on Escape too, and settings is on top of both.
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // A dialog over settings (the install prompt) closes itself and leaves settings open.
      if (event.target instanceof Element && event.target.closest('[data-owns-escape]')) return
      event.stopPropagation()
      // Unsaved edits in the skill editor ask first.
      requestLeave(() => close.current())
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [])

  return (
    <div
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestLeave(onClose)
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
    >
      <div
        ref={dialog}
        id="settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        className="flex h-full max-h-176 w-full max-w-6xl border border-border bg-background shadow-2xl outline-none"
      >
        <nav className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border p-3">
          <h2 id="settings-title" className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
            Settings
          </h2>
          {/* No pane, so the one on show stays. Main opens the page, since main knows where Account is. */}
          {signedIn && (
            <NavRow
              id="jaspers-account"
              icon={PersonIcon}
              label="Account"
              out
              onClick={() => void window.app.openAccount()}
            />
          )}
          {PANES.map(({ id, label, icon }) => (
            <NavRow
              key={id}
              icon={icon}
              label={label}
              current={id === pane}
              onClick={() => requestLeave(() => setPane(id))}
            />
          ))}
          <div className="mt-auto border-t border-border pt-2">
            <NavRow id="view-loops" icon={LoopIcon} label="View loops" onClick={() => requestLeave(onViewLoops)} />
          </div>
        </nav>

        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            aria-label="Close settings"
            onClick={() => requestLeave(onClose)}
            className="absolute top-2 right-2 z-10 flex h-8 w-8 items-center justify-center bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-3 w-3 stroke-current stroke-[1.25]">
              <path d="M1 1 9 9M9 1 1 9" />
            </svg>
          </button>
          {/* Keyed by pane, so each one opens scrolled to its top. The panes with a list scroll it and its entry apart. */}
          {pane === 'llm' ||
          pane === 'data' ||
          pane === 'appearance' ||
          pane === 'pro' ||
          pane === 'eye' ||
          pane === 'about' ? (
            // The Data pane scrolls itself, since it reads over IPC when it mounts.
            <div key={pane} className={pane === 'data' ? 'h-full' : 'h-full overflow-y-auto px-8 pt-6 pb-10'}>
              {pane === 'llm' ? (
                <LlmPane />
              ) : pane === 'data' ? (
                <DataPane />
              ) : pane === 'pro' ? (
                <ProModePane />
              ) : pane === 'eye' ? (
                <EyePane />
              ) : pane === 'about' ? (
                <AboutPane />
              ) : (
                <AppearancePane />
              )}
            </div>
          ) : (
            <div key={pane} className="h-full">
              {pane === 'plugins' ? (
                <PluginsPane />
              ) : pane === 'connections' ? (
                <ConnectionsPane />
              ) : pane === 'skills' ? (
                <SkillsPane />
              ) : pane === 'memory' ? (
                <MemoryPane />
              ) : (
                <TasksPane />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface NavRowProps {
  id?: string
  icon: () => ReactElement
  label: string
  /** Whether it is the pane on show. A row that is no pane never is. */
  current?: boolean
  /** It opens in the browser, which the arrow at its end says. */
  out?: boolean
  onClick: () => void
}

/** One row of the list down the left: an icon and what it names. */
function NavRow({ id, icon: Icon, label, current = false, out = false, onClick }: NavRowProps): ReactElement {
  return (
    <button
      id={id}
      type="button"
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-2 py-1.5 text-left text-sm ${current ? 'bg-muted font-medium' : 'hover:bg-muted'}`}
    >
      <span className="text-muted-foreground">
        <Icon />
      </span>
      {label}
      {out && (
        <span aria-hidden className="ml-auto text-xs text-muted-foreground">
          ↗
        </span>
      )}
    </button>
  )
}

/** A head and shoulders: who is signed in. */
function PersonIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M8 2.5a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5zM2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
    </svg>
  )
}

/** An eye, open: what Eye is, and the same shape as the dot in the workspace bar. */
function EyeIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  )
}

function TerminalIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M2 3h12v10H2zM4.5 6.5 6 8l-1.5 1.5M8 9.5h3.5" />
    </svg>
  )
}

function ChipIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M4.5 4.5h7v7h-7zM6.5 2v2.5M9.5 2v2.5M6.5 11.5V14M9.5 11.5V14M2 6.5h2.5M2 9.5h2.5M11.5 6.5H14M11.5 9.5H14" />
    </svg>
  )
}

/** Two links: a server on the other end of one. */
function LinkIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1" />
    </svg>
  )
}

/** A stack of discs: one file, many runs. */
function DataIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M8 2c2.8 0 5 .9 5 2s-2.2 2-5 2-5-.9-5-2 2.2-2 5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </svg>
  )
}

/** A disc half filled: light and dark. */
function AppearanceIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2z" />
      <path d="M8 2a6 6 0 0 1 0 12z" className="fill-current" />
    </svg>
  )
}

/** Two arrows chasing each other round: a loop. */
function LoopIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M13 6.5A5 5 0 0 0 3.6 5M3 9.5A5 5 0 0 0 12.4 11M3.5 2.5V5H6M12.5 13.5V11H10" />
    </svg>
  )
}

function ClockIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.5V8l2.5 1.5" />
    </svg>
  )
}

function SkillIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M3.5 2h6.5l2.5 2.5V14h-9zM10 2v2.5h2.5M5.5 7.5h5M5.5 10h5" />
    </svg>
  )
}

/** A knot: something tied so it is still there later. */
function MemoryIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M8 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM5 6.5h6M5 9.5h6" />
    </svg>
  )
}

function PlugIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M6 1.5V5M10 1.5V5M4 5h8v3.5L10 11H6L4 8.5zM8 11v3.5" />
    </svg>
  )
}

/** A circle with an i: what this is. */
function InfoIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="h-4 w-4 stroke-current stroke-[1.25]">
      <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 7.5V11M8 5v.5" />
    </svg>
  )
}
