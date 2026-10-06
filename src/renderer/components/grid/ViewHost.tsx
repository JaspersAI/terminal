import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { BridgeProvider, PanelProvider } from '@jaspers-ai/sdk'
import type { BridgeRequest } from '@jaspers-ai/sdk/host'
import { liveKeyOf } from '../../../shared/plugins/live'
import { viewSandbox } from '../../../shared/plugins/plugins'
import { hostBridge, runSourceIn } from '../../lib/bridge'
import { subscribeLive } from '../../lib/live'
import { useAppState } from '../../lib/state'
import { BUILT_IN_VIEWS } from '../../views'
import { send } from './send'

interface Props {
  workspaceId: string
  panelId: string
  elementId: string
  /** A registry id, like core/note. */
  view: string
  focused: boolean
}

/**
 * What mounts a view inside an element: the component for the id, with the bridge it reads and
 * writes the panel through. A built-in view is a component in this bundle and gets the host bridge
 * itself; a plugin's is a bundle of its own and gets an iframe, and a bridge over postMessage that
 * answers the same calls, so the hooks inside never learn which of the two they have. Either way
 * the view is keyed on its plugin's build version, so a rebuild remounts it and it reads its state
 * and output back from the tree.
 *
 * Nothing but a view is drawn here. A view nothing is registered for draws nothing: its plugin is
 * still being built as the app starts, or is gone. One whose plugin is waiting on the user is not
 * mounted at all: its tile asks for what the plugin needs, in its box (`ElementFrame`).
 */
export function ViewHost({ workspaceId, panelId, elementId, view, focused }: Props): ReactElement | null {
  const panel = useMemo(() => ({ id: panelId, workspaceId }), [panelId, workspaceId])
  const views = useAppState((s) => s.views)
  const plugins = useAppState((s) => s.plugins)
  const plugin = views[view]?.plugin
  if (plugin) {
    const sandbox = viewSandbox(plugins[plugin]?.frames ?? [])
    return (
      <PluginView
        // A sandbox applies when a frame loads, so a new one remounts the frame just as a rebuild does.
        key={`${plugins[plugin]?.version ?? 0}:${sandbox}`}
        workspaceId={workspaceId}
        panelId={panelId}
        elementId={elementId}
        plugin={plugin}
        // The registry id is `<plugin>/<name>`, and the frame asks for the view by name.
        name={view.slice(plugin.length + 1)}
        version={plugins[plugin]?.version ?? 0}
        sandbox={sandbox}
        title={views[view]?.title ?? view}
        focused={focused}
      />
    )
  }
  const View = BUILT_IN_VIEWS[view]
  if (!View) return null
  return (
    <BridgeProvider value={hostBridge}>
      <PanelProvider value={panel}>
        <View panel={panel} />
      </PanelProvider>
    </BridgeProvider>
  )
}

interface FrameProps {
  workspaceId: string
  panelId: string
  elementId: string
  plugin: string
  name: string
  version: number
  sandbox: string
  title: string
  focused: boolean
}

/**
 * A plugin's view: an iframe on the plugin's own origin, and the relay between it and the host
 * bridge. Nothing in the frame is trusted beyond the shape of its messages: every write goes
 * through the same dispatch a built-in view uses and main validates it there.
 */
function PluginView({
  workspaceId,
  panelId,
  elementId,
  plugin,
  name,
  version,
  sandbox,
  title,
  focused,
}: FrameProps): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const iframe = frame.current
    if (!iframe) return
    const subscriptions = new Map<number, () => void>()
    let nextSub = 1

    const post = (message: unknown): void => iframe.contentWindow?.postMessage(message, '*')

    function onMessage(event: MessageEvent): void {
      // Only this element's own frame. Its origin is opaque, or shared with every frame of its
      // plugin when the plugin frames a site, so the window is what identifies it.
      if (event.source !== iframe?.contentWindow) return
      const request = event.data as BridgeRequest
      if (typeof request?.id !== 'number' || typeof request.method !== 'string') return
      const params = (request.params ?? {}) as Record<string, unknown>
      if (request.method === 'store.subscribe') return subscribe(request.id, String(params['path']))
      if (request.method === 'store.unsubscribe') {
        const subId = Number(params['subId'])
        subscriptions.get(subId)?.()
        subscriptions.delete(subId)
        post({ id: request.id, result: null })
        return
      }
      void (async () => {
        try {
          post({ id: request.id, result: await run(request.method, params) })
        } catch (err) {
          post({ id: request.id, error: { message: err instanceof Error ? err.message : String(err) } })
        }
      })()
    }

    /**
     * The value there now arrives while `subscribe` is still running, and the frame cannot route it
     * until it knows the id, so it goes out behind the reply rather than in front of it. A `live/`
     * path is a value the frame's own plugin published; every other path is the tree.
     */
    function subscribe(id: number, path: string): void {
      const subId = nextSub++
      const held: unknown[] = []
      let replied = false
      const deliver = (value: unknown): void => {
        if (replied) post({ method: 'store.changed', params: { subId, value } })
        else held.push(value)
      }
      try {
        const key = liveKeyOf(path)
        subscriptions.set(
          subId,
          key !== null ? subscribeLive(plugin, key, deliver) : hostBridge.subscribe(path, deliver),
        )
      } catch (err) {
        post({ id, error: { message: err instanceof Error ? err.message : String(err) } })
        return
      }
      post({ id, result: subId })
      replied = true
      for (const value of held) post({ method: 'store.changed', params: { subId, value } })
    }

    /** The rest of the bridge, one call each. The frame names its panel; the workspace is this one. */
    async function run(method: string, params: Record<string, unknown>): Promise<unknown> {
      const panel = { id: String(params['panelId']), workspaceId }
      switch (method) {
        case 'store.get': {
          const path = String(params['path'])
          const key = liveKeyOf(path)
          return key !== null ? window.app.live.get(plugin, key) : hostBridge.get(path)
        }
        case 'panel.setState':
          return hostBridge.setState(panel, params['path'] as string[], params['value'])
        case 'panel.publish':
          return hostBridge.publish(panel, params['output'] as Record<string, unknown>)
        case 'panel.publishText':
          return hostBridge.publishText(panel, params['text'] as string | null)
        case 'source.run':
          // The frame's own workspace, never one the frame names: a plugin's code reads it as ctx.workspace.
          return runSourceIn(workspaceId, String(params['source']), params['args'], { fresh: params['fresh'] === true })
        case 'dataset.rows':
          return hostBridge.datasetRows(String(params['datasetId']))
        case 'link.open':
          return hostBridge.openLink(String(params['url']))
        case 'clipboard.write':
          return hostBridge.copyText(params['text'] as string)
        default:
          throw new Error(`Unknown bridge method ${method}.`)
      }
    }

    window.addEventListener('message', onMessage)
    // A frame cannot measure the element it fills, so the size it is drawn at is sent to it.
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box) post({ method: 'resize', params: { width: box.width, height: box.height } })
    })
    observer.observe(iframe)
    return () => {
      window.removeEventListener('message', onMessage)
      observer.disconnect()
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      subscriptions.clear()
    }
  }, [workspaceId, plugin])

  // Nothing in the SDK reads this yet; it is the half of the protocol the host owns.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ method: 'focus', params: { focused } }, '*')
  }, [focused])

  // A press inside the frame never reaches this page. The window losing focus to the frame is the
  // only sign of one, and it is what focuses the element then.
  useEffect(() => {
    if (focused) return
    function onBlur(): void {
      if (document.activeElement === frame.current) send({ type: 'element.focus', workspaceId, elementId })
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [focused, workspaceId, elementId])

  return (
    <iframe
      ref={frame}
      title={title}
      sandbox={sandbox}
      src={`jaspers-plugin://${plugin}/index.html?view=${encodeURIComponent(name)}&panel=${panelId}&workspace=${workspaceId}&v=${version}`}
      className="absolute inset-0 h-full w-full border-0 bg-background"
    />
  )
}
