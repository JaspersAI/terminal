import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent, AgentOrigin } from '../shared/agent/agent'
import type { AppOpened } from '../shared/plugins/apps'
import type { ConnectionForm } from '../shared/plugins/connection-plugin'
import type { RunResult } from '../shared/data/datasets'
import type { DragMove, DragOver } from '../shared/grid/drag'
import type { HubItem, HubMe, PublishAnswer } from '../shared/hub/hub'
import type { InstallRequest, PrepareResult } from '../shared/plugins/install'
import type { Memory } from '../shared/agent/memory'
import type { SkillInstallRequest, SkillPrepareResult } from '../shared/skills/skill-install'
import type { SkillFile } from '../shared/skills/skills'
import type { Action, AppState } from '../shared/state'
import type { QueryResult, StoreStats } from '../shared/data/store'
import type { Exchange } from '../shared/agent/transcript'
import { MAIN_WINDOW, WINDOWS_MAX } from '../shared/grid/windows'

// Everything the renderer may touch goes through this bridge.
const api = {
  platform: process.platform,
  /** Which window this page is, from its URL: 1 is the main window, the rest are extensions. */
  windowNumber: readWindowNumber(),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  state: {
    /** The whole tree, read once on load. After that every change arrives through `onChange`. */
    get: (): Promise<AppState> => ipcRenderer.invoke('state:get'),
    /** Asks main for a change. Resolves once applied; the new tree comes through `onChange`, not here. */
    dispatch: (action: Action): Promise<void> => ipcRenderer.invoke('state:dispatch', action),
    /** Main sends the whole tree here after every change, whoever made it. Returns an unsubscribe. */
    onChange: (listener: (state: AppState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: AppState): void => listener(state)
      ipcRenderer.on('state:changed', handler)
      return () => ipcRenderer.removeListener('state:changed', handler)
    },
  },
  agent: {
    /**
     * One input through the assistant. Resolves with its final text, which main also logs. It starts
     * at once, whatever else is running. `ask` is this window's own name for the request, which the
     * run's start event carries back, so its events can be told from another request's. `on` is the
     * tile whose box the message was typed in, by its element's id: its loop's own agent answers, one
     * request at a time, on a conversation of its own. Left out, the global assistant answers.
     */
    run: (input: string, ask?: string, on?: string): Promise<string> =>
      ipcRenderer.invoke('agent:run', input, ask ?? null, on ?? null),
    /**
     * Stops one run, or every run in flight. Answers whether anything was running. With `ask`, the
     * request sent under that name is the only one stopped: its run, or its wait for a turn on a tile.
     */
    stop: (runId?: string, ask?: string): Promise<boolean> =>
      ipcRenderer.invoke('agent:stop', runId ?? null, ask ?? null),
    /**
     * What is in flight, for a window that opened partway through a run: each with the name it was
     * sent under, and a tile's run with its workspace, its loop, its tile, and what was asked.
     */
    running: (): Promise<
      {
        runId: string
        origin: AgentOrigin
        ask?: string
        workspaceId?: string
        loop?: string
        on?: string
        request?: string
      }[]
    > => ipcRenderer.invoke('agent:running'),
    /**
     * The end of a chat, oldest first, keys masked: its last `limit` exchanges, or with `before` the
     * last ones ahead of the exchange with that id. The chat on screen, or with `loop` that loop's own.
     */
    history: (limit: number, before?: number, loop?: string): Promise<Exchange[]> =>
      ipcRenderer.invoke('agent:history', limit, before ?? null, loop ?? null),
    /** The welcome after setup, once the workspace is on screen: main says its messages into the chat on its own. */
    welcome: (): Promise<void> => ipcRenderer.invoke('agent:welcome'),
    /** What a run is doing, as it does it. For showing only: the reply comes back from `run`. */
    onEvent: (listener: (event: AgentEvent) => void): (() => void) => on('agent:event', listener),
  },
  sources: {
    /**
     * Runs one source by registry id, for a view on a workspace. Rows land in main as a dataset; `rows`
     * reads them back. Fresh skips a dataset still good for the arguments.
     */
    run: (
      source: string,
      args: unknown,
      options: { fresh?: boolean; workspaceId?: string } = {},
    ): Promise<RunResult & { text: string }> => ipcRenderer.invoke('source:run', source, args, options),
    rows: (datasetId: string): Promise<Record<string, unknown>[]> => ipcRenderer.invoke('dataset:rows', datasetId),
  },
  voice: {
    /** Ask the OS for the microphone. False means the user has to allow it in system settings. */
    requestMicrophone: (): Promise<boolean> => ipcRenderer.invoke('voice:request-microphone'),
    /** Recorded audio in, transcript out. */
    transcribe: (audio: ArrayBuffer, mimeType: string): Promise<string> =>
      ipcRenderer.invoke('voice:transcribe', audio, mimeType),
  },
  live: {
    /** One value a plugin published for its views, or undefined. */
    get: (plugin: string, key: string): Promise<unknown> => ipcRenderer.invoke('live:get', plugin, key),
    /** Starts hearing one key and resolves with its value now; changes arrive through `onChange`. */
    subscribe: (plugin: string, key: string): Promise<unknown> => ipcRenderer.invoke('live:subscribe', plugin, key),
    unsubscribe: (plugin: string, key: string): Promise<void> => ipcRenderer.invoke('live:unsubscribe', plugin, key),
    onChange: (listener: (plugin: string, key: string, value: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, plugin: string, key: string, value: unknown): void =>
        listener(plugin, key, value)
      ipcRenderer.on('live:changed', handler)
      return () => ipcRenderer.removeListener('live:changed', handler)
    },
  },
  /** Installing a plugin: check an archive, then install or drop what was checked. */
  plugins: {
    prepare: (request: InstallRequest): Promise<PrepareResult> => ipcRenderer.invoke('plugin:install-prepare', request),
    confirm: (token: string): Promise<void> => ipcRenderer.invoke('plugin:install-confirm', token),
    cancel: (token: string): Promise<void> => ipcRenderer.invoke('plugin:install-cancel', token),
  },
  /** Jaspers Hub, asked through main: the directory's plugins, and what Hub holds of the signed-in user. */
  hub: {
    /** The plugins Hub's operator features, in their order. */
    featured: (): Promise<HubItem[]> => ipcRenderer.invoke('hub:featured'),
    /** One page of every plugin, most starred first, from 1. */
    page: (page: number): Promise<{ items: HubItem[]; more: boolean }> => ipcRenderer.invoke('hub:page', page),
    search: (q: string): Promise<HubItem[]> => ipcRenderer.invoke('hub:search', q),
    /** The user's handle and what they published. Needs the sign-in. */
    me: (): Promise<HubMe> => ipcRenderer.invoke('hub:me'),
    /** Claims a handle, once. Resolves with the handle claimed. */
    claim: (handle: string): Promise<string> => ipcRenderer.invoke('hub:claim', handle),
    /** Packs a plugin or skill of the user's own and publishes it, or says a handle has to be claimed first. */
    publish: (request: { kind: 'plugin' | 'skill'; id: string }): Promise<PublishAnswer> =>
      ipcRenderer.invoke('hub:publish', request),
  },
  /** What the assistant knows: one memory's body, read when something wants it, and the AGENT.md files. */
  memory: {
    read: (name: string): Promise<Memory | null> => ipcRenderer.invoke('memory:read', name),
    write: (name: string, about: string, body: string): Promise<void> =>
      ipcRenderer.invoke('memory:write', name, about, body),
    /** Answers whether there was one to forget. */
    remove: (name: string): Promise<boolean> => ipcRenderer.invoke('memory:remove', name),
    /** AGENT.md as it is on disk: the app's with null, a workspace's with its id. */
    standing: (workspaceId: string | null): Promise<string> => ipcRenderer.invoke('memory:standing', workspaceId),
    saveStanding: (workspaceId: string | null, text: string): Promise<void> =>
      ipcRenderer.invoke('memory:save-standing', workspaceId, text),
  },
  /** Skills: the editor's file calls, by skill id and a path relative to its folder, and installing from GitHub or an upload. */
  skills: {
    files: (id: string): Promise<SkillFile[]> => ipcRenderer.invoke('skill:files', id),
    read: (id: string, path: string): Promise<{ text: string; hash: string }> =>
      ipcRenderer.invoke('skill:read', id, path),
    /** baseHash is the hash read had; null creates a file that must not exist yet. */
    write: (id: string, path: string, text: string, baseHash: string | null): Promise<{ hash: string }> =>
      ipcRenderer.invoke('skill:write', id, path, text, baseHash),
    removeFile: (id: string, path: string): Promise<void> => ipcRenderer.invoke('skill:remove-file', id, path),
    /** Writes a new skill from the template and resolves with its id once it is listed. */
    create: (name: string): Promise<string> => ipcRenderer.invoke('skill:create', name),
    duplicate: (id: string, name: string): Promise<string> => ipcRenderer.invoke('skill:duplicate', id, name),
    /** Fetches and checks; nothing is installed until confirm names the skills to install. */
    prepare: (request: SkillInstallRequest): Promise<SkillPrepareResult> =>
      ipcRenderer.invoke('skill:install-prepare', request),
    confirm: (token: string, names: string[]): Promise<string[]> =>
      ipcRenderer.invoke('skill:install-confirm', token, names),
    cancel: (token: string): Promise<void> => ipcRenderer.invoke('skill:install-cancel', token),
  },
  /** A drag by hand leaving this window for another. The source reports; the window under the pointer hears. */
  drag: {
    /** Where the pointer is now, in screen pixels. Sent, not awaited: one per frame. */
    move: (move: DragMove): void => ipcRenderer.send('drag:move', move),
    /** The drag ended: dropped where the pointer was, or cancelled. */
    end: (dropped: boolean): void => ipcRenderer.send('drag:end', dropped),
    /** An element from another window is over this one, at these client pixels. */
    onOver: (listener: (over: DragOver) => void): (() => void) => on('drag:over', listener),
    /** It left this window without dropping. */
    onLeave: (listener: () => void): (() => void) => on('drag:leave', listener),
    /** It was let go over this window. */
    onDrop: (listener: (over: DragOver) => void): (() => void) => on('drag:drop', listener),
  },
  /** The store: what is in the file every source run is filed to, and reclaiming its space. */
  store: {
    query: (sql: string, limit?: number): Promise<QueryResult> => ipcRenderer.invoke('store:query', sql, limit),
    stats: (): Promise<StoreStats> => ipcRenderer.invoke('store:stats'),
    /** What each kind of run has spent today. */
    usage: (): Promise<{ origin: string; input: number; output: number; runs: number }[]> =>
      ipcRenderer.invoke('store:usage'),
    compact: (): Promise<StoreStats> => ipcRenderer.invoke('store:compact'),
  },
  /** The inbox: everything the app has told you, kept. The unread count rides the state tree. */
  inbox: {
    list: (limit?: number): Promise<{ id: number; at: number; source: string; text: string; read: boolean }[]> =>
      ipcRenderer.invoke('inbox:list', limit),
  },
  /** Connections the user adds here, which the app writes as a plugin folder of their own. */
  connections: {
    add: (form: ConnectionForm): Promise<string> => ipcRenderer.invoke('connection:add', form),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('connection:remove', id),
    list: (): Promise<Record<string, ConnectionForm>> => ipcRenderer.invoke('connection:list'),
  },
  /**
   * A connection's own view (an MCP server's page for one of its tools), for the `core/app` panel that
   * shows it. Each call names its panel; main reads what the panel shows and checks the rest.
   */
  apps: {
    /** The question to put to the user first, or the page and the call it shows. */
    open: (workspaceId: string, panelId: string): Promise<AppOpened> =>
      ipcRenderer.invoke('app:open', workspaceId, panelId),
    /** Makes the panel's call and keeps it. Resolves with the server's own result. */
    run: (workspaceId: string, panelId: string): Promise<unknown> =>
      ipcRenderer.invoke('app:run', workspaceId, panelId),
    /** A call the page itself asks for, on its own connection. `from` is the address the page was opened at. */
    call: (
      workspaceId: string,
      panelId: string,
      from: string,
      tool: string,
      args: Record<string, unknown> | undefined,
    ): Promise<unknown> => ipcRenderer.invoke('app:call', workspaceId, panelId, from, tool, args),
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  /** Settings: opens the signed-in account's page on Account in the browser. Takes no address; main knows where Account is. */
  openAccount: (): Promise<void> => ipcRenderer.invoke('shell:open-account'),
  /** Settings > Pro mode: shows the folder commands run in. Takes no path; main knows the one folder there is. */
  showProFolder: (): Promise<void> => ipcRenderer.invoke('shell:show-pro-folder'),
  /** Settings > Eye: shows the folder Eye records into. Main knows the path. */
  showEyeFolder: (): Promise<void> => ipcRenderer.invoke('shell:show-eye-folder'),
  /** Deletes every frame and every line of telemetry Eye has kept, sent or not. */
  deleteEyeRecordings: (): Promise<void> => ipcRenderer.invoke('eye:delete-all'),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  /** The menu bar's Settings…, which the window answers by opening Settings. */
  onOpenSettings: (listener: () => void): (() => void) => on('menu:settings', listener),
  /** The page's first screen is up. A window opened to be seen shows itself now, and not before. */
  rendered: (): void => ipcRenderer.send('window:rendered'),
}

/** Hears one channel from main, the payload alone. Returns an unsubscribe. */
function on<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/** The window number main put in the page's query; anything else reads as the main window. */
function readWindowNumber(): number {
  const n = Number(new URLSearchParams(window.location.search).get('window'))
  return Number.isInteger(n) && n >= MAIN_WINDOW && n <= WINDOWS_MAX ? n : MAIN_WINDOW
}

export type AppApi = typeof api

contextBridge.exposeInMainWorld('app', api)
