import fs from 'node:fs'
import path from 'node:path'
import type { Exchange } from '../../shared/agent/transcript'
import { EMPTY_COLLAB, findRoomShare, findWorkspaceShare, type SyncedPluginBundle } from '../../shared/collab/collab'
import { addNotice } from '../app/notices'
import { setCollabLoopHooks, sendToLoop } from '../agent/loop'
import { exchanges as readChatExchanges } from '../agent/utils/thread'
import { fileExchange, forgetChat } from '../data/store'
import { exportDatasets, hydrateSyncedDataset, runSource, setSponsoredSourceRunner } from '../data/sources'
import type { RunResult } from '../../shared/data/datasets'
import { asAccount, gatewayAddress, onSignInChange, signedIn } from '../jaspers/jaspers'
import { bundlePath } from '../plugins/plugins'
import { registerSyncedViews } from '../plugins/registry'
import { keepSyncedBundle } from '../plugins/synced-bundles'
import { getState, subscribe, update } from '../state'
import { createCollabEngine, type CollabApi } from './collab-engine'

// Main-process collaboration service: connects to `/v1/collab/*` on Jaspers Account using the
// signed-in account's bearer (`asAccount`), maintains the live SSE event stream, syncs shared
// Rooms and Workspace tabs, and handles owner-sponsored commands.

const PUSH_DEBOUNCE_MS = 180
const RECONNECT_MS = 5_000

let sseController: AbortController | null = null
let reconnectTimer: NodeJS.Timeout | null = null
const pushTimers = new Map<string, NodeJS.Timeout>()
let refreshCallback: ((workspaceId: string, panelId: string) => void) | null = null

export function setCollabRefreshCallback(cb: (workspaceId: string, panelId: string) => void): void {
  refreshCallback = cb
}

function collabUrl(subpath: string): string {
  return `${gatewayAddress()}/collab${subpath}`
}

async function callJson<T>(subpath: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const res = await asAccount(collabUrl(subpath), { ...init, headers })
  const text = await res.text()
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
      if (typeof parsed.error === 'object' && parsed.error?.message) msg = parsed.error.message
      else if (typeof parsed.error === 'string') msg = parsed.error
      else if (typeof parsed.message === 'string') msg = parsed.message
    } catch {
      if (text.trim()) msg = text.trim().slice(0, 200)
    }
    throw new Error(msg)
  }
  return (text ? JSON.parse(text) : {}) as T
}

const api: CollabApi = {
  fetchState: () => callJson('/state'),
  inviteTeammate: (email) => callJson('/teammates', { method: 'POST', body: JSON.stringify({ email }) }),
  acceptInvite: (invite) => callJson('/teammates/accept', { method: 'POST', body: JSON.stringify({ invite }) }),
  declineInvite: (invite) => callJson('/teammates/decline', { method: 'POST', body: JSON.stringify({ invite }) }),
  removeTeammate: (accountId) => callJson(`/teammates/${encodeURIComponent(accountId)}`, { method: 'DELETE' }),
  upsertShare: (input) => callJson('/shares', { method: 'POST', body: JSON.stringify(input) }),
  deleteShare: (shareId) => callJson(`/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' }),
  enqueueCommand: (shareId, input) =>
    callJson(`/shares/${encodeURIComponent(shareId)}/commands`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  claimCommands: async () => {
    const res = await callJson<{ commands: Record<string, unknown>[] }>('/commands/claim', {
      method: 'POST',
      body: '{}',
    })
    return Array.isArray(res.commands) ? res.commands : []
  },
  completeCommand: (commandId, outcome) =>
    callJson(`/commands/${encodeURIComponent(commandId)}/complete`, {
      method: 'POST',
      body: JSON.stringify(outcome),
    }),
}

function exportLocalPluginBundles(pluginIds: Iterable<string>): SyncedPluginBundle[] {
  const state = getState()
  const out: SyncedPluginBundle[] = []
  for (const id of new Set(pluginIds)) {
    const plugin = state.plugins[id]
    if (!plugin || id === 'core') continue
    const jsFile = bundlePath(id)
    const cssFile = path.join(path.dirname(jsFile), 'bundle.css')
    let bundleJs = ''
    try {
      bundleJs = fs.readFileSync(jsFile, 'utf8')
    } catch {
      continue
    }
    if (!bundleJs) continue
    let bundleCss: string | null = null
    try {
      if (fs.existsSync(cssFile)) bundleCss = fs.readFileSync(cssFile, 'utf8')
    } catch {
      bundleCss = null
    }
    const views = Object.values(state.views).filter((v) => v.plugin === id)
    out.push({
      plugin: id,
      bundleJs,
      ...(bundleCss ? { bundleCss } : {}),
      frames: plugin.frames,
      views,
    })
  }
  return out
}

async function replaceRoomExchanges(chat: string, list: Exchange[]): Promise<void> {
  const existing = await readChatExchanges(chat, 100).catch(() => [])
  if (
    existing.length === list.length &&
    existing.every((e, i) => e.question === list[i]?.question && e.answer === list[i]?.answer)
  ) {
    return
  }
  forgetChat(chat)
  for (const ex of list) {
    await fileExchange(chat, ex.at ?? Date.now(), ex)
  }
}

const engine = createCollabEngine({
  getState,
  update,
  api,
  exportDatasets: (workspaceId, allowedPlugins) => exportDatasets(workspaceId, allowedPlugins),
  hydrateDataset: (ds, workspaceId) => hydrateSyncedDataset(ds, workspaceId ?? null),
  exportBundles: exportLocalPluginBundles,
  registerBundle: (bundle) => {
    const kept = keepSyncedBundle(bundle)
    if (kept) registerSyncedViews(kept.plugin, kept.views)
  },
  readRoomExchanges: (chat) => readChatExchanges(chat, 100),
  writeRoomExchanges: replaceRoomExchanges,
  runRoomPrompt: (workspaceId, loopId, input) => sendToLoop(workspaceId, loopId, { typed: input }),
  refreshPanel: (workspaceId, panelId) => refreshCallback?.(workspaceId, panelId),
  runSource: (source, args, workspaceId) => runSource(source, args, { fresh: true, workspaceId }),
  notice: (text) => addNotice('collab', text),
})

function scheduleRoomPush(workspaceId: string, loopId: string): void {
  const key = `room:${workspaceId}/${loopId}`
  const prev = pushTimers.get(key)
  if (prev) clearTimeout(prev)
  pushTimers.set(
    key,
    setTimeout(() => {
      pushTimers.delete(key)
      void engine.pushRoomShareSnapshot(workspaceId, loopId).catch(() => undefined)
    }, PUSH_DEBOUNCE_MS),
  )
}

function scheduleWorkspacePush(workspaceId: string): void {
  const key = `ws:${workspaceId}`
  const prev = pushTimers.get(key)
  if (prev) clearTimeout(prev)
  pushTimers.set(
    key,
    setTimeout(() => {
      pushTimers.delete(key)
      void engine.pushWorkspaceShareSnapshot(workspaceId).catch(() => undefined)
    }, PUSH_DEBOUNCE_MS),
  )
}

async function connectStream(): Promise<void> {
  if (!signedIn()) return
  sseController?.abort()
  const controller = new AbortController()
  sseController = controller
  try {
    await engine.refreshState()
    const res = await asAccount(collabUrl('/events'), {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`SSE status ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!controller.signal.aborted) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const dataLine = block
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim()
        if (!dataLine) continue
        try {
          const event = JSON.parse(dataLine) as { type?: string; share?: Record<string, unknown> }
          if (event.type === 'share.updated' && event.share) {
            await engine.applyRemoteShare(event.share)
          } else if (event.type === 'command.created') {
            await engine.processPendingCommands()
          } else {
            await engine.refreshState()
          }
        } catch {
          // Ignore malformed SSE event frames.
        }
      }
    }
  } catch {
    // Reconnect after a short delay while signed in.
  } finally {
    if (sseController === controller && signedIn()) {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => void connectStream(), RECONNECT_MS)
      reconnectTimer.unref?.()
    }
  }
}

function stopStream(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  sseController?.abort()
  sseController = null
  update((s) => ({ ...s, collab: EMPTY_COLLAB }))
}

export function startCollab(): void {
  setSponsoredSourceRunner(
    (workspaceId, source, args, fresh) =>
      engine.runSponsoredSource(workspaceId, source, args, fresh) as Promise<(RunResult & { text: string }) | null>,
  )
  setCollabLoopHooks({
    runSponsoredPrompt: (workspaceId, loopId, input) => engine.runSponsoredPrompt(workspaceId, loopId, input),
    onRoomExchange: (workspaceId, loopId) => {
      const state = getState()
      const loop = state.loops[workspaceId]?.list.find((l) => l.id === loopId)
      const ws = state.workspaces.find((w) => w.id === workspaceId)
      if (findRoomShare(state.collab ?? EMPTY_COLLAB, workspaceId, loopId, loop?.shareId)) {
        scheduleRoomPush(workspaceId, loopId)
      }
      if (findWorkspaceShare(state.collab ?? EMPTY_COLLAB, workspaceId, ws?.shareId)) {
        scheduleWorkspacePush(workspaceId)
      }
    },
  })

  subscribe((next, prev) => {
    if (!signedIn() || engine.gate.isApplyingRemote()) return
    for (const ws of next.workspaces) {
      if (
        next.grids[ws.id] !== prev.grids[ws.id] ||
        next.loops[ws.id] !== prev.loops[ws.id] ||
        ws !== prev.workspaces.find((w) => w.id === ws.id)
      ) {
        if (findWorkspaceShare(next.collab ?? EMPTY_COLLAB, ws.id, ws.shareId)) {
          scheduleWorkspacePush(ws.id)
        }
        for (const loop of next.loops[ws.id]?.list ?? []) {
          if (findRoomShare(next.collab ?? EMPTY_COLLAB, ws.id, loop.id, loop.shareId)) {
            scheduleRoomPush(ws.id, loop.id)
          }
        }
      }
    }
  })

  onSignInChange((nowSignedIn) => {
    if (nowSignedIn) void connectStream()
    else stopStream()
  })
  if (signedIn()) void connectStream()
}

export function inviteTeammate(email: string): Promise<void> {
  return engine.inviteTeammate(email)
}

export function acceptTeammateInvite(invite: string): Promise<void> {
  return engine.acceptInvite(invite)
}

export function declineTeammateInvite(invite: string): Promise<void> {
  return engine.declineInvite(invite)
}

export function removeTeammate(accountId: string): Promise<void> {
  return engine.removeTeammate(accountId)
}

export function shareRoom(workspaceId: string, loopId: string, memberAccountIds: string[]): Promise<void> {
  return engine.shareRoom(workspaceId, loopId, memberAccountIds)
}

export function unshareRoom(workspaceId: string, loopId: string): Promise<void> {
  return engine.unshareRoom(workspaceId, loopId)
}

export function shareWorkspace(workspaceId: string, memberAccountIds: string[]): Promise<void> {
  return engine.shareWorkspace(workspaceId, memberAccountIds)
}

export function unshareWorkspace(workspaceId: string): Promise<void> {
  return engine.unshareWorkspace(workspaceId)
}

export function runSponsoredRefreshIfNeeded(workspaceId: string, panelId: string): Promise<boolean> {
  return engine.runSponsoredRefresh(workspaceId, panelId)
}
