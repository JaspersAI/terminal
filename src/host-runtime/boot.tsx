import { Component, useEffect, useState, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BridgeProvider, PanelProvider, type Bridge, type PanelRef } from '@jaspers-ai/sdk'
import { createIframeBridge } from '@jaspers-ai/sdk/host'
import { watchDocumentUse } from '../renderer/lib/eye'

// What runs in the iframe: the query says which view of which panel this frame is, the plugin's own
// bundle comes from the same origin, and its component mounts under a bridge that reaches the app
// over postMessage. Nothing else loads here, so anything that fails is written into the page and
// reported to the host so the panel records why it failed.

/** A plugin's bundle, as far as this file cares: the definition its plugin.tsx exported. */
interface PluginModule {
  default?: { views?: Record<string, { component?: unknown }> }
}

export async function boot(): Promise<void> {
  // What goes wrong or is clicked, typed, or zoomed in the view is told to the page around it, which records it on the panel and tells Eye while it records.
  window.addEventListener('error', (event) => tell(event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => tell(event.reason))
  watchDocumentUse((params) => window.parent.postMessage({ method: 'view.eye', params }, '*'))
  const query = new URLSearchParams(location.search)
  const view = query.get('view') ?? ''
  const panel: PanelRef = { id: query.get('panel') ?? '', workspaceId: query.get('workspace') ?? '' }
  const root = document.getElementById('root')
  if (!root) return
  try {
    // Relative to this page, so it is the plugin's own bundle: jaspers-plugin://<id>/bundle.js.
    const loaded = (await import(new URL('bundle.js', location.href).href)) as PluginModule
    const component = loaded.default?.views?.[view]?.component as ComponentType<{ panel: PanelRef }> | undefined
    if (!component) throw new Error(`No view "${view}" in this plugin`)
    const bridge = createIframeBridge()
    createRoot(root).render(
      <BridgeProvider value={bridge}>
        <PanelProvider value={panel}>
          <MountedView bridge={bridge} panel={panel} View={component} />
        </PanelProvider>
      </BridgeProvider>,
    )
  } catch (err) {
    root.textContent = err instanceof Error ? err.message : String(err)
    tell(err)
  }
}

function MountedView({
  bridge,
  panel,
  View,
}: {
  bridge: Bridge
  panel: PanelRef
  View: ComponentType<{ panel: PanelRef }>
}): ReactElement {
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const watch = (path: string): (() => void) => {
      let seen = false
      return bridge.subscribe(path, () => {
        if (!seen) {
          seen = true
          return
        }
        setAttempt((n) => n + 1)
      })
    }
    const offs = [
      watch(`workspaces/${panel.workspaceId}/panels/${panel.id}/state`),
      watch(`workspaces/${panel.workspaceId}/panels/${panel.id}/refreshedAt`),
    ]
    return () => offs.forEach((off) => off())
  }, [bridge, panel.workspaceId, panel.id])
  return (
    <ViewBoundary attempt={attempt}>
      <View panel={panel} />
    </ViewBoundary>
  )
}

class ViewBoundary extends Component<{ attempt: number; children: ReactNode }, { error: string | null }> {
  override state: { error: string | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown): void {
    tell(error)
  }

  override componentDidUpdate(prevProps: { attempt: number; children: ReactNode }): void {
    if (prevProps.attempt !== this.props.attempt && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  override render(): ReactNode {
    return this.state.error === null ? this.props.children : this.state.error
  }
}

function tell(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? null) : null
  window.parent.postMessage({ method: 'view.error', params: { message, stack } }, '*')
}
