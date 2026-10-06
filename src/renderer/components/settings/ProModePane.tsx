import { useState, type ReactElement } from 'react'
import { OUTPUT_DEFAULT, TIMEOUT_DEFAULT, type ApprovalMode, type ProMode } from '../../../shared/app/pro-mode'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { BUTTON, FIELD } from './Row'
import { Row } from './Row'

// Settings > Pro mode: the one switch that lets the assistant run commands on this computer. Off
// until the user turns it on here, and nothing else can turn it on: no tool reaches the action
// behind it. The warning is the point of the pane, so it is above the switch, not under it.

const APPROVALS: { mode: ApprovalMode; label: string }[] = [
  { mode: 'always', label: 'Every command' },
  { mode: 'once', label: 'Once per command' },
  { mode: 'session', label: 'Once per conversation' },
]

/** What each choice means, under the row, since the widest of them gives up the most. */
const APPROVAL_HINTS: Record<ApprovalMode, string> = {
  always: 'Every command is put in front of you before it runs.',
  once: 'A command you have already approved runs again without asking in the same conversation — that exact line and nothing else.',
  session:
    'The first command offers "Allow every command in this conversation". Take it and nothing else is asked until the conversation ends: every command the assistant runs, whatever it is, inside the folder. /new ends it, and so does quitting Jaspers. Choose this for a long piece of work you are watching, not as a standing setting.',
}

export function ProModePane(): ReactElement {
  const proMode = useAppState((s) => s.proMode)
  const [failed, setFailed] = useState<string | null>(null)

  const showFolder = (): void => {
    setFailed(null)
    window.app.showProFolder().catch((err: unknown) => setFailed(errorMessage(err)))
  }

  const change = (change: Partial<ProMode>): void => {
    setFailed(null)
    dispatch({ type: 'proMode.set', proMode: change }).catch((err: unknown) => setFailed(errorMessage(err)))
  }

  return (
    <section aria-labelledby="settings-pro-mode-title">
      <h3 id="settings-pro-mode-title" className="text-base font-semibold">
        Pro mode
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Lets the assistant run shell commands on this computer, inside Jaspers's own folder, asking you before each one.
      </p>
      <div className="mt-5 border border-destructive p-3 text-sm">
        <p className="font-medium">Turn this on only if you understand what it allows.</p>
        <p className="mt-1.5 text-muted-foreground">
          A command runs as you, in your own login shell, with everything on your PATH: it can read, change, and delete
          your files, install software, and send data out. Jaspers asks you to approve the exact command first, and
          nothing runs unless you do — but a language model can be talked into asking for the wrong thing by text it
          reads along the way, in a web page, a filing, or a plugin's output. Read each command before you allow it.
          This is a trust setting, not a sandbox.
        </p>
      </div>
      {failed && <p className="mt-3 text-sm text-destructive">{failed}</p>}
      <div className="mt-5 border-t border-border">
        <Row
          label="Pro mode"
          hint={
            proMode.enabled ? 'The assistant can ask to run commands.' : 'The assistant has no way to run anything.'
          }
        >
          <div className="flex">
            {[false, true].map((on) => (
              <button
                key={String(on)}
                type="button"
                aria-pressed={proMode.enabled === on}
                onClick={() => change({ enabled: on })}
                className={`-ml-px border border-border px-3 py-1 text-sm first:ml-0 ${
                  proMode.enabled === on
                    ? 'relative z-10 border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                {on ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Ask me"
          hint={
            proMode.approval === 'session' ? (
              <span className="text-destructive">{APPROVAL_HINTS.session}</span>
            ) : (
              APPROVAL_HINTS[proMode.approval]
            )
          }
        >
          <div className="flex">
            {APPROVALS.map(({ mode, label }) => (
              <button
                key={mode}
                type="button"
                disabled={!proMode.enabled}
                aria-pressed={proMode.approval === mode}
                onClick={() => change({ approval: mode })}
                className={`-ml-px border border-border px-3 py-1 text-sm first:ml-0 disabled:opacity-50 ${
                  proMode.approval === mode
                    ? 'relative z-10 border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Read-only commands"
          hint="Runs a plain read without asking: ls, cat, grep, git status and the like, one program, no pipes, no redirection. Everything else still asks."
        >
          <div className="flex">
            {[false, true].map((on) => (
              <button
                key={String(on)}
                type="button"
                disabled={!proMode.enabled}
                aria-pressed={proMode.allowReadOnly === on}
                onClick={() => change({ allowReadOnly: on })}
                className={`-ml-px border border-border px-3 py-1 text-sm first:ml-0 disabled:opacity-50 ${
                  proMode.allowReadOnly === on
                    ? 'relative z-10 border-primary bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                {on ? 'Run them' : 'Ask'}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Folder"
          hint="The only place a command can write, and what it leaves is yours to open. It can also read your Desktop and Downloads, and change nothing there."
        >
          <button type="button" onClick={() => showFolder()} className={BUTTON}>
            Show folder
          </button>
        </Row>
        <Row
          label="Stop a command after"
          htmlFor="pro-mode-timeout"
          hint={`Seconds, and the most a command may ever run: the assistant can ask for longer than usual for a download or a long pass, never for longer than this. ${TIMEOUT_DEFAULT} by default.`}
        >
          <input
            id="pro-mode-timeout"
            type="number"
            min={1}
            max={600}
            value={proMode.timeoutSeconds}
            disabled={!proMode.enabled}
            onChange={(event) => change({ timeoutSeconds: Number(event.target.value) })}
            className={FIELD}
          />
        </Row>
        <Row
          label="Keep of the output"
          htmlFor="pro-mode-output"
          hint={`Characters given to the assistant; the rest is cut. ${OUTPUT_DEFAULT.toLocaleString()} by default.`}
        >
          <input
            id="pro-mode-output"
            type="number"
            min={1000}
            max={1000000}
            step={1000}
            value={proMode.outputMax}
            disabled={!proMode.enabled}
            onChange={(event) => change({ outputMax: Number(event.target.value) })}
            className={FIELD}
          />
        </Row>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Every command asked for is written to <code>~/Jaspers/data/shell.jsonl</code> — what was asked, where, what you
        answered, and how it ended. Scheduled tasks can never run commands: there is nobody there to approve one.
      </p>
    </section>
  )
}
