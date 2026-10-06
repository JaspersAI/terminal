import { useEffect, useRef, type ReactElement } from 'react'
import type { PreparedInstall } from '../../../shared/plugins/install'
import type { InstallLine } from './use-install'
import { BUTTON } from './Row'

export function StatusLine({ line }: { line: InstallLine }): ReactElement | null {
  if (!line) return null
  return (
    <p className={`text-xs break-words ${line.error ? 'text-destructive' : 'text-muted-foreground'}`}>{line.text}</p>
  )
}

interface PromptProps {
  install: PreparedInstall
  onInstall: () => void
  onCancel: () => void
}

/**
 * The trust prompt. Everything on it came from the archive's package.json and from main, never from
 * running the plugin; from Hub, also who published it and whether Hub reviewed this version. It owns
 * Escape while it is up, so Settings under it stays open.
 */
export function InstallPrompt({ install, onInstall, onCancel }: PromptProps): ReactElement {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => dialog.current?.focus(), [])
  const { id, version, description, source, sha256, replaces, hub } = install
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
        id="install-prompt"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="install-title"
        aria-describedby={hub ? 'install-review install-warning' : 'install-warning'}
        tabIndex={-1}
        className="w-full max-w-lg border border-border bg-background p-6 shadow-2xl outline-none"
      >
        <h2 id="install-title" className="text-base font-semibold">
          Install {id} {version}?
        </h2>
        {description && <p className="mt-1 text-sm">{description}</p>}
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">From</dt>
          <dd className="break-all">
            {source}
            {hub && (
              <span className="block text-muted-foreground">
                Published by {hub.handle}
                {hub.official && ' · official'}
                {' · '}
                <button
                  type="button"
                  onClick={() => void window.app.openExternal(hub.page)}
                  className="hover:text-foreground"
                >
                  Its page on Jaspers Hub ↗
                </button>
              </span>
            )}
          </dd>
          <dt className="text-muted-foreground">SHA-256</dt>
          <dd className="font-mono text-xs break-all">{sha256}</dd>
          {replaces && (
            <>
              <dt className="text-muted-foreground">Replaces</dt>
              <dd>
                {id} {replaces.version} → {version}
              </dd>
            </>
          )}
        </dl>
        {hub && (
          <p
            id="install-review"
            className={`mt-4 border-l-2 pl-3 text-sm ${hub.reviewed ? 'border-border' : 'border-destructive'}`}
          >
            {hub.reviewed ? 'Reviewed by Jaspers Hub.' : 'Not yet reviewed: Hub has not approved this version.'}
          </p>
        )}
        <p id="install-warning" className="mt-4 border-l-2 border-destructive pl-3 text-sm">
          Plugins run code on your computer with your permissions. Jaspers runs a plugin in its own process to contain
          crashes, not to stop harmful code. Install only plugins from people you trust.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={BUTTON}>
            Cancel
          </button>
          <button
            id="install-confirm"
            type="button"
            onClick={onInstall}
            className="shrink-0 border border-foreground bg-foreground px-2.5 py-1 text-sm text-background"
          >
            Install
          </button>
        </div>
      </div>
    </div>
  )
}
