import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from 'react'
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiStyles,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { useData, usePanelState, usePublish, usePublishText, type PanelRef } from '@jaspers-ai/sdk'
import { mapToolResult } from '../../shared/data/datasets'
import { stableStringify } from '../../shared/data/hash'
import { layoutOf, type Grid, type GridElement } from '../../shared/grid/grid'
import { APP_SANDBOX, contextText, type AppOpened } from '../../shared/plugins/apps'
import type { ConnectionTool } from '../../shared/state'
import { send } from '../components/grid/send'
import { BUTTON } from '../components/settings/Row'
import { useColorScheme } from '../lib/color-scheme'
import { errorMessage } from '../lib/errors'
import { dispatch, get, useAppState } from '../lib/state'
import { hostStyles } from './app-context'
import { pageTeller } from './app-tell'
import type { ViewProps } from './index'

// A connection's own view (MCP Apps): a server's page for one of its tools, hosted here. The page is
// the server's code, so it runs in a frame on an origin of its own, sandboxed, with the policy it
// declared and no way to the app but messages; and this is the host those messages reach. It speaks
// the extension's protocol through AppBridge, and has nothing of its own to give a page: the page's
// address, the call it shows, and every tool call the page makes are main's, asked for by this
// panel's id and checked there. What the page may ask of the app at all is the list below.

/** What a page may ask for. A page that checks before it asks, as the extension's own client does, leaves the rest alone. */
const CAPABILITIES: McpUiHostCapabilities = {
  openLinks: {},
  serverTools: {},
  logging: {},
  updateModelContext: { text: {}, structuredContent: {} },
}

type Page = Extract<AppOpened, { kind: 'page' }>

/** Where the panel's opening stands. Every page answer is numbered, so a second answer for the same page is a new frame. */
type Opened =
  | { kind: 'waiting' }
  | { kind: 'loading' }
  | { kind: 'failed'; error: string }
  | { kind: 'ask'; connection: string }
  | (Page & { n: number })

/** What the page is showing, once there is one. */
interface Shown {
  status: 'loading' | 'shown' | 'failed'
  error: string | null
  /** The panel's text: the tool's answer, until the page says what the assistant should read instead. */
  text: string | null
}

const NOTHING_YET: Shown = { status: 'loading', error: null, text: null }

export function App({ panel }: ViewProps): ReactElement {
  const [connection] = usePanelState<string>(panel, 'connection', '')
  const [tool] = usePanelState<string>(panel, 'tool', '')
  const [args] = usePanelState<Record<string, unknown>>(panel, 'args', {})
  const refreshedAt = useData(`workspaces/${panel.workspaceId}/panels/${panel.id}/refreshedAt`)
  // A page cannot be read while its connection is down; it is asked for again when it comes up.
  const ready = useAppState((s) => s.connections[connection]?.status === 'ready')
  const [opened, setOpened] = useState<Opened>({ kind: 'loading' })
  const [shown, setShown] = useState<Shown>(NOTHING_YET)
  const [allowed, setAllowed] = useState(0)
  const [declined, setDeclined] = useState(false)
  const opens = useRef(0)
  const argsKey = stableStringify(args)

  // Main reads the panel itself, so nothing here is sent but its id: this effect only says when to ask
  // again, which is whenever what the panel shows, its refresh stamp, or the user's answer changed.
  useEffect(() => {
    if (!connection || !tool) {
      setOpened({ kind: 'waiting' })
      return
    }
    let current = true
    setOpened({ kind: 'loading' })
    setShown(NOTHING_YET)
    window.app.apps.open(panel.workspaceId, panel.id).then(
      (answer) => {
        if (current) setOpened(answer.kind === 'page' ? { ...answer, n: ++opens.current } : answer)
      },
      (err: unknown) => {
        if (current) setOpened({ kind: 'failed', error: errorMessage(err) })
      },
    )
    return () => {
      current = false
    }
  }, [panel.workspaceId, panel.id, connection, tool, argsKey, refreshedAt, ready, allowed])

  const page = opened.kind === 'page' ? opened : null
  usePublish(panel, {
    connection,
    tool,
    status: page ? shown.status : opened.kind === 'ask' ? 'asking' : opened.kind,
    error: page ? shown.error : opened.kind === 'failed' ? opened.error : null,
  })
  usePublishText(panel, page ? shown.text : null)

  if (opened.kind === 'page') return <Frame key={opened.n} panel={panel} page={opened} onShown={setShown} />
  if (opened.kind === 'waiting') return <Message>Set connection and tool to the tool whose view this shows.</Message>
  if (opened.kind === 'failed') return <Message tone="bad">{opened.error}</Message>
  if (opened.kind === 'loading') return <Message>Loading…</Message>

  const allow = (): void => {
    dispatch({ type: 'connection.allowApps', id: opened.connection }).then(
      () => setAllowed((n) => n + 1),
      (err: unknown) => setOpened({ kind: 'failed', error: errorMessage(err) }),
    )
  }
  return (
    <div className="flex h-full flex-col items-start justify-center gap-3 p-4 text-sm">
      {!declined && (
        <p className="max-w-prose">
          <span className="font-mono">{opened.connection}</span> has a view of its own for this. It is the server's
          page, run apart from the app: it can use that server's tools and open links, and nothing else of yours.
        </p>
      )}
      {declined && <p className="text-muted-foreground">Not shown.</p>}
      <div className="flex gap-2">
        <button type="button" onClick={allow} className={BUTTON}>
          Show
        </button>
        {!declined && (
          <button type="button" onClick={() => setDeclined(true)} className={BUTTON}>
            Not now
          </button>
        )}
      </div>
    </div>
  )
}

interface FrameProps {
  panel: PanelRef
  page: Page
  onShown: Dispatch<SetStateAction<Shown>>
}

/** How long a page that is going has to finish what it is doing before its frame goes. */
const FAREWELL_MS = 500
/** Where a frame that is going waits, out of sight. */
const WAITING_ID = 'app-frames-leaving'
const FRAME_CLASS = 'absolute inset-0 h-full w-full border-0 bg-background'

/**
 * The frame and the host on its other side. Mounted once per page answer: the bridge is connected to
 * the frame's window before the frame is given its address, so the page's first word is heard, and
 * nothing is sent to the page until it says it is initialized, which is the extension's order.
 *
 * The frame is this component's own to make and to remove, not React's. React takes an element out
 * of the document the moment it stops drawing it, and a page whose frame has left the document is
 * gone before a word reaches it; so a frame that is leaving is moved out of sight instead, told it
 * is going, and removed once its page has answered or the wait is up.
 */
function Frame({ panel, page, onShown }: FrameProps): ReactElement {
  const holder = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement | null>(null)
  /** The bridge once its page is initialized, which is when it may be told things. */
  const told = useRef<AppBridge | null>(null)
  const scheme = useColorScheme()
  const version = useAppState((s) => s.updates.version)
  const elementId = useAppState((s) => standing(s.grids[panel.workspaceId], panel.id)?.element.id ?? '')
  const maximized = useAppState((s) => standing(s.grids[panel.workspaceId], panel.id)?.element.mode === 'maximized')
  const focused = useAppState((s) => standing(s.grids[panel.workspaceId], panel.id)?.focused === true)
  const now = useRef({ scheme, maximized, version })
  now.current = { scheme, maximized, version }

  // A layout effect for its cleanup, which runs while the frame is still in the document: the last
  // moment it can be moved rather than lost.
  useLayoutEffect(() => {
    const iframe = document.createElement('iframe')
    iframe.title = page.tool.name
    iframe.setAttribute('sandbox', APP_SANDBOX)
    iframe.className = FRAME_CLASS
    holder.current?.append(iframe)
    const target = iframe.contentWindow
    if (!target) {
      iframe.remove()
      return
    }
    frame.current = iframe
    let gone = false
    const context = (): McpUiHostContext => hostContext(iframe, page.tool, now.current)
    const bridge = new AppBridge(
      null,
      { name: 'jaspers-terminal', version: now.current.version || '0' },
      CAPABILITIES,
      {
        hostContext: context(),
      },
    )

    // Each of these refuses a frame that is going: its page has been told, and what is left is its
    // own to finish.
    //
    // The page's own tool calls: main checks each against this panel's connection, the open this
    // frame was given, and what its server offers a page.
    bridge.oncalltool = async ({ name, arguments: input }) => {
      if (gone) throw new Error('This view is closing.')
      return (await fromMain(
        window.app.apps.call(panel.workspaceId, panel.id, page.url, name, input),
      )) as CallToolResult
    }
    // Main opens https only, and refuses the rest.
    bridge.onopenlink = async ({ url }) => {
      if (gone) return { isError: true }
      try {
        await window.app.openExternal(url)
        return {}
      } catch {
        return { isError: true }
      }
    }
    // What the page says the assistant should read about it becomes the panel's text.
    bridge.onupdatemodelcontext = async (params) => {
      const text = gone ? null : contextText(params)
      if (text !== null) onShown((was) => ({ ...was, text }))
      return {}
    }
    // Fullscreen is the element maximized; inline is the element back where it was.
    bridge.onrequestdisplaymode = async ({ mode }) => {
      const at = gone ? null : standing(get().grids[panel.workspaceId], panel.id)
      if (!at) return { mode: 'inline' }
      const full = at.element.mode === 'maximized'
      const want = mode === 'fullscreen' ? true : mode === 'inline' ? false : full
      if (want !== full) {
        await dispatch({
          type: 'element.setMode',
          workspaceId: panel.workspaceId,
          elementId: at.element.id,
          mode: want ? 'maximized' : (at.element.restoreMode ?? 'tiled'),
        })
      }
      return { mode: want ? 'fullscreen' : 'inline' }
    }
    bridge.onloggingmessage = ({ level, data }) => console.debug(`[app ${page.tool.name}] ${level}:`, data)

    // The input, then the result: the kept one, or the panel's call, made once however often the page initializes.
    const tell = pageTeller(page, () => fromMain(window.app.apps.run(panel.workspaceId, panel.id)))
    bridge.oninitialized = () => {
      if (gone) return
      told.current = bridge
      // Whatever changed while the page was loading.
      bridge.setHostContext(context())
      tell(bridge, () => !gone).then(
        (result) => {
          if (result) onShown(shownAs(result))
        },
        (err: unknown) => {
          if (!gone) onShown({ status: 'failed', error: errorMessage(err), text: null })
        },
      )
    }

    bridge.connect(new PostMessageTransport(target, target)).then(
      () => {
        if (!gone) iframe.src = page.url
      },
      (err: unknown) => {
        if (!gone) onShown({ status: 'failed', error: errorMessage(err), text: null })
      },
    )
    // A page cannot measure the element it fills, so the size it is drawn at is told to it.
    const observer = new ResizeObserver(() => {
      if (told.current === bridge) bridge.setHostContext(context())
    })
    observer.observe(iframe)

    return () => {
      gone = true
      observer.disconnect()
      frame.current = null
      const initialized = told.current === bridge
      told.current = null
      const drop = (): void => {
        iframe.remove()
        void bridge.close().catch(() => undefined)
      }
      // A page that never came up has nothing to finish.
      if (!initialized || !waiting(iframe)) return drop()
      void bridge
        .teardownResource({}, { timeout: FAREWELL_MS })
        .catch(() => undefined)
        .finally(drop)
    }
    // Mounted once: the parent keys this component on the page answer it was opened with.
  }, [])

  // The theme and the mode can change under a page that is up.
  useEffect(() => {
    const iframe = frame.current
    if (iframe && told.current) told.current.setHostContext(hostContext(iframe, page.tool, now.current))
  }, [scheme, maximized, page.tool])

  // A press inside the frame never reaches this page. The window losing focus to the frame is the
  // only sign of one, and it is what focuses the element then.
  useEffect(() => {
    if (focused || !elementId) return
    function onBlur(): void {
      if (document.activeElement === frame.current) {
        send({ type: 'element.focus', workspaceId: panel.workspaceId, elementId })
      }
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [focused, elementId, panel.workspaceId])

  return <div ref={holder} className="absolute inset-0" />
}

/**
 * Moves a frame that is going to where it waits, still alive, and says whether it could. `moveBefore`
 * is the one way to move a frame without its page being loaded again; it needs the frame still in the
 * document, which a layout effect's cleanup has.
 */
function waiting(iframe: HTMLIFrameElement): boolean {
  let room = document.getElementById(WAITING_ID)
  if (!room) {
    room = document.createElement('div')
    room.id = WAITING_ID
    room.hidden = true
    document.body.append(room)
  }
  try {
    room.moveBefore(iframe, null)
    return true
  } catch {
    return false
  }
}

/** What the panel says once its page has the result: the tool's answer as its text, and a refusal as a failure. */
function shownAs(result: CallToolResult): Shown {
  const { text } = mapToolResult(result as { content?: unknown[]; structuredContent?: unknown; isError?: boolean })
  const failed = result.isError === true
  return {
    status: failed ? 'failed' : 'shown',
    error: failed ? text || 'The server refused the call.' : null,
    text: text || null,
  }
}

/** What the page is told about where it is: the app's theme and faces, its mode, and the size it is drawn at. */
function hostContext(
  iframe: HTMLIFrameElement,
  tool: ConnectionTool,
  now: { scheme: 'light' | 'dark'; maximized: boolean; version: string },
): McpUiHostContext {
  const box = iframe.getBoundingClientRect()
  const root = getComputedStyle(document.documentElement)
  return {
    toolInfo: {
      tool: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Tool['inputSchema'] },
    },
    theme: now.scheme,
    styles: { variables: hostStyles((name) => root.getPropertyValue(name)) as McpUiStyles },
    displayMode: now.maximized ? 'fullscreen' : 'inline',
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: { width: Math.round(box.width), height: Math.round(box.height) },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: `jaspers-terminal/${now.version}`,
    platform: 'desktop',
  }
}

/**
 * The panel's element, in whichever window holds it, and whether it has that window's focus: it is the
 * focused one among those it is laid out with, and inside a tile, so is the tile in its window.
 */
function standing(
  grids: Record<number, Grid> | undefined,
  panelId: string,
): { element: GridElement; focused: boolean } | null {
  for (const grid of Object.values(grids ?? {})) {
    const panel = grid.panels.find((one) => one.id === panelId)
    const element = panel && grid.elements.find((one) => one.id === panel.elementId)
    if (!element) continue
    const first = (frame?: string): string | undefined => layoutOf(grid, frame).focus[0]
    const tile = element.parent
    return { element, focused: first(tile) === element.id && (tile === undefined || first() === tile) }
  }
  return null
}

/** Main's own words, without the IPC wrapper around them, since a page shows them to the user. */
async function fromMain<T>(call: Promise<T>): Promise<T> {
  try {
    return await call
  } catch (err) {
    throw new Error(errorMessage(err))
  }
}

function Message({ children, tone }: { children: string; tone?: 'bad' }): ReactElement {
  return <p className={`p-3 text-xs ${tone === 'bad' ? 'text-destructive' : 'text-muted-foreground'}`}>{children}</p>
}
