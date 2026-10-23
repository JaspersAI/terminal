import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { BridgeProvider, PanelProvider, type PanelRef } from '@jaspers-ai/sdk'
import { createIframeBridge } from '@jaspers-ai/sdk/host'
import { watchDocumentUse } from '../renderer/lib/eye'

// What runs in the iframe: the query says which view of which panel this frame is, the plugin's own
// bundle comes from the same origin, and its component mounts under a bridge that reaches the app
// over postMessage. Nothing else loads here, so anything that fails is written into the page.

/** A plugin's bundle, as far as this file cares: the definition its plugin.tsx exported. */
interface PluginModule {
  default?: { views?: Record<string, { component?: unknown }> }
}

export async function boot(): Promise<void> {
  // What goes wrong or is clicked, typed, or zoomed in the view is told to the page around it, which tells Eye while it records.
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
    const Component = component
    createRoot(root).render(
      <BridgeProvider value={createIframeBridge()}>
        <PanelProvider value={panel}>
          <Component panel={panel} />
        </PanelProvider>
      </BridgeProvider>,
    )
  } catch (err) {
    root.textContent = err instanceof Error ? err.message : String(err)
    tell(err)
  }
}

function tell(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? null) : null
  window.parent.postMessage({ method: 'view.error', params: { message, stack } }, '*')
}
