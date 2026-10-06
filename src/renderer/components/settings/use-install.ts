import { createElement, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { InstallRequest, PreparedInstall } from '../../../shared/plugins/install'
import { errorMessage } from '../../lib/errors'
import { InstallPrompt } from './InstallPrompt'

export type InstallLine = { text: string; error: boolean } | null

export interface Install {
  /** Checking, installing, or waiting on the prompt: nothing starts another install meanwhile. */
  busy: boolean
  line: InstallLine
  /** Whose line it is: the plugin an Update is for, or null for an install from the directory. */
  lineFor: string | null
  start: (request: InstallRequest) => void
  prompt: ReactElement | null
}

/**
 * One install from start to finish: main checks the archive, the prompt asks, and main moves it
 * into place. The plugin list holds one for the directory and every Update, since main runs one
 * install at a time and a plugin's section is gone once another is picked; each shows the line only
 * when it is its own. Starting one drops whatever install main has waiting, so none starts while
 * the prompt is up: the buttons under it are covered, not unreachable, since Tab still gets there.
 */
export function useInstall(): Install {
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<InstallLine>(null)
  const [lineFor, setLineFor] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedInstall | null>(null)

  function start(request: InstallRequest): void {
    if (busy || prepared) return
    setBusy(true)
    setLineFor(request.kind === 'update' ? request.id : null)
    setLine({ text: request.kind === 'file' ? 'Checking the file…' : 'Downloading and checking…', error: false })
    window.app.plugins
      .prepare(request)
      .then((result) => {
        if (result === null) setLine(null)
        else if ('upToDate' in result)
          setLine({ text: `${result.id} ${result.version} is already up to date.`, error: false })
        else {
          setLine(null)
          setPrepared(result)
        }
      })
      .catch((err: unknown) => setLine({ text: errorMessage(err), error: true }))
      .finally(() => setBusy(false))
  }

  function install(): void {
    if (!prepared) return
    const { token, id, version } = prepared
    setPrepared(null)
    setBusy(true)
    setLine({ text: `Installing ${id}…`, error: false })
    window.app.plugins
      .confirm(token)
      .then(() => setLine({ text: `Installed ${id} ${version}.`, error: false }))
      .catch((err: unknown) => setLine({ text: errorMessage(err), error: true }))
      .finally(() => setBusy(false))
  }

  function cancel(): void {
    if (prepared) void window.app.plugins.cancel(prepared.token)
    setPrepared(null)
    setLine(null)
  }

  // On the body: an element on the grid is a stacking context, and the core/plugins view lives in one.
  const prompt = prepared
    ? createPortal(
        createElement(InstallPrompt, { install: prepared, onInstall: install, onCancel: cancel }),
        document.body,
      )
    : null
  return { busy: busy || prepared !== null, line, lineFor, start, prompt }
}
