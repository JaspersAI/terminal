import type { Exchange } from '../../shared/agent/transcript.ts'
import {
  applyRoomSnapshot,
  applyWorkspaceSnapshot,
  buildRoomSnapshot,
  buildWorkspaceSnapshot,
  createRevisionGate,
  EMPTY_COLLAB,
  findRoomShare,
  findWorkspaceShare,
  isSponsoredRoom,
  isSponsoredWorkspace,
  validateSyncedPluginBundle,
  type CollabShareInfo,
  type CollabState,
  type SharedRoomSnapshot,
  type SharedWorkspaceSnapshot,
  type ShareMember,
  type SyncedDataset,
  type SyncedPluginBundle,
  type Teammate,
  type TeammateInvite,
} from '../../shared/collab/collab.ts'
import { globalSeq } from '../../shared/loops/closed.ts'
import { loopChat, loopTitle, NO_LOOPS, viewPlugin, type Loops } from '../../shared/loops/loops.ts'
import type { Grid } from '../../shared/grid/grid.ts'
import type { Workspace } from '../../shared/state.ts'

export interface CollabEngineState {
  workspaces: Workspace[]
  currentWorkspaceId: string
  grids: Record<string, Record<number, Grid>>
  loops: Record<string, Loops>
  jaspers: { email: string | null; tokens: string | null }
  collab?: CollabState
}

export interface CollabApi {
  fetchState(): Promise<{
    teammates: { account_id: string; email: string; since: number }[]
    outgoing_invites: {
      invite_id: string
      token: string
      inviter_account_id: string
      inviter_email: string
      invitee_email: string
      status: 'pending' | 'accepted' | 'declined'
      created_at: number
    }[]
    incoming_invites: {
      invite_id: string
      token: string
      inviter_account_id: string
      inviter_email: string
      invitee_email: string
      status: 'pending' | 'accepted' | 'declined'
      created_at: number
    }[]
    shares: Record<string, unknown>[]
    pending_commands: Record<string, unknown>[]
  }>
  inviteTeammate(email: string): Promise<unknown>
  acceptInvite(invite: string): Promise<unknown>
  declineInvite(invite: string): Promise<unknown>
  removeTeammate(accountId: string): Promise<unknown>
  upsertShare(input: {
    share_id?: string
    kind: 'room' | 'workspace'
    local_id: string
    title: string
    snapshot: Record<string, unknown>
    member_account_ids?: string[]
  }): Promise<{ share: Record<string, unknown> }>
  deleteShare(shareId: string): Promise<unknown>
  enqueueCommand(
    shareId: string,
    input: { kind: 'prompt' | 'refresh' | 'source'; payload: Record<string, unknown>; wait?: boolean },
  ): Promise<{ command: Record<string, unknown> }>
  claimCommands(): Promise<Record<string, unknown>[]>
  completeCommand(commandId: string, outcome: { result?: Record<string, unknown>; error?: string }): Promise<unknown>
}

export interface CollabEngineDeps<S extends CollabEngineState = CollabEngineState> {
  getState(): S
  update(mutate: (state: S) => S): void
  api: CollabApi
  exportDatasets(workspaceId: string): SyncedDataset[]
  hydrateDataset(ds: SyncedDataset, workspaceId?: string): void
  exportBundles(pluginIds: Iterable<string>): SyncedPluginBundle[]
  registerBundle(bundle: SyncedPluginBundle): void
  readRoomExchanges(chat: string): Promise<Exchange[]>
  writeRoomExchanges(chat: string, exchanges: Exchange[]): Promise<void>
  runRoomPrompt(workspaceId: string, loopId: string, input: string): Promise<string>
  refreshPanel(workspaceId: string, panelId: string): void
  runSource(source: string, args: unknown, workspaceId: string): Promise<unknown>
  notice?: (text: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mapInvite(raw: Record<string, unknown>): TeammateInvite | null {
  if (typeof raw.invite_id !== 'string' || typeof raw.token !== 'string') return null
  if (typeof raw.inviter_account_id !== 'string' || typeof raw.inviter_email !== 'string') return null
  if (typeof raw.invitee_email !== 'string') return null
  return {
    inviteId: raw.invite_id,
    token: raw.token,
    inviterAccountId: raw.inviter_account_id,
    inviterEmail: raw.inviter_email,
    inviteeEmail: raw.invitee_email,
    status: raw.status === 'accepted' || raw.status === 'declined' ? raw.status : 'pending',
    createdAt: typeof raw.created_at === 'number' ? raw.created_at : 0,
  }
}

function mapShareInfo(
  raw: Record<string, unknown>,
  myAccountId: string | null,
  myEmail: string | null,
): CollabShareInfo | null {
  if (typeof raw.share_id !== 'string') return null
  if (raw.kind !== 'room' && raw.kind !== 'workspace') return null
  const ownerAccountId = typeof raw.owner_account_id === 'string' ? raw.owner_account_id : ''
  const ownerEmail = typeof raw.owner_email === 'string' ? raw.owner_email : ''
  const members: ShareMember[] = []
  for (const m of Array.isArray(raw.members) ? raw.members : []) {
    if (!isRecord(m) || typeof m.account_id !== 'string' || typeof m.email !== 'string') continue
    members.push({
      accountId: m.account_id,
      email: m.email,
      addedAt: typeof m.added_at === 'number' ? m.added_at : 0,
    })
  }
  const isOwner =
    (myAccountId !== null && ownerAccountId === myAccountId) ||
    (myEmail !== null && ownerEmail.toLowerCase() === myEmail.toLowerCase())
  return {
    shareId: raw.share_id,
    kind: raw.kind,
    ownerAccountId,
    ownerEmail,
    localId: typeof raw.local_id === 'string' ? raw.local_id : '',
    title: typeof raw.title === 'string' ? raw.title : 'Shared',
    revision: typeof raw.revision === 'number' ? raw.revision : 1,
    members,
    updatedAt: typeof raw.updated_at === 'number' ? raw.updated_at : 0,
    isOwner,
  }
}

export function createCollabEngine<S extends CollabEngineState>(deps: CollabEngineDeps<S>) {
  const gate = createRevisionGate()

  const collectRoomPlugins = (grids: Record<number, Grid>, loops: Loops, loopId: string): Set<string> => {
    const set = new Set<string>()
    const loop = loops.list.find((l) => l.id === loopId)
    for (const p of loop?.plugins ?? []) set.add(p)
    for (const grid of Object.values(grids)) {
      const elemIds = new Set(grid.elements.filter((e) => e.loop === loopId).map((e) => e.id))
      for (const panel of grid.panels) {
        if (!elemIds.has(panel.elementId) || panel.content.kind !== 'view') continue
        const plugin = viewPlugin(panel.content.view)
        if (plugin) set.add(plugin)
      }
    }
    return set
  }

  const collectWorkspacePlugins = (grids: Record<number, Grid>, loops: Loops): Set<string> => {
    const set = new Set<string>()
    for (const loop of loops.list) {
      for (const p of loop.plugins) set.add(p)
    }
    for (const grid of Object.values(grids)) {
      for (const panel of grid.panels) {
        if (panel.content.kind !== 'view') continue
        const plugin = viewPlugin(panel.content.view)
        if (plugin) set.add(plugin)
      }
    }
    return set
  }

  const applyRemoteShare = async (rawShare: Record<string, unknown>): Promise<void> => {
    const current = deps.getState()
    const info = mapShareInfo(rawShare, current.collab?.accountId ?? null, current.jaspers.email)
    if (!info) return
    if (!gate.shouldApplyRemote(info.shareId, info.revision)) return
    const snapshot = isRecord(rawShare.snapshot) ? rawShare.snapshot : null
    if (!snapshot) return

    // Hydrate bundles and datasets first so views mount with data and code ready
    for (const rawBundle of Array.isArray(snapshot.bundles) ? snapshot.bundles : []) {
      const valid = validateSyncedPluginBundle(rawBundle)
      if (valid) deps.registerBundle(valid)
    }

    if (info.kind === 'room' && snapshot.kind === 'room') {
      const roomSnap = snapshot as unknown as SharedRoomSnapshot
      const state = deps.getState()
      // Find existing tab holding this shared room, or use currentWorkspaceId
      const targetTabId =
        Object.keys(state.loops).find((tabId) =>
          (state.loops[tabId]?.list ?? []).some((l) => l.shareId === info.shareId),
        ) ?? state.currentWorkspaceId

      for (const ds of Array.isArray(roomSnap.datasets) ? roomSnap.datasets : []) {
        deps.hydrateDataset(ds, targetTabId)
      }

      let mappedLoopId = roomSnap.loop.id
      gate.withRemoteApply(info.shareId, info.revision, () => {
        deps.update((s) => {
          const tabGrids = s.grids[targetTabId] ?? {}
          const tabLoops = s.loops[targetTabId] ?? NO_LOOPS
          const applied = applyRoomSnapshot(tabGrids, tabLoops, info.shareId, roomSnap, globalSeq(s.loops))
          mappedLoopId = applied.loopId
          const prevShares = s.collab?.shares ?? []
          const localInfo: CollabShareInfo = { ...info, localId: `${targetTabId}/${mappedLoopId}` }
          const nextShares = prevShares.some((sh) => sh.shareId === info.shareId)
            ? prevShares.map((sh) => (sh.shareId === info.shareId ? localInfo : sh))
            : [...prevShares, localInfo]
          return {
            ...s,
            grids: { ...s.grids, [targetTabId]: applied.grids },
            loops: { ...s.loops, [targetTabId]: applied.loops },
            collab: { ...(s.collab ?? EMPTY_COLLAB), shares: nextShares },
          }
        })
      })

      if (Array.isArray(roomSnap.exchanges)) {
        const record = deps.getState().loops[targetTabId]?.list.find((l) => l.id === mappedLoopId)
        await deps.writeRoomExchanges(loopChat(targetTabId, record ?? mappedLoopId), roomSnap.exchanges)
      }
      return
    }

    if (info.kind === 'workspace' && snapshot.kind === 'workspace') {
      const wsSnap = snapshot as unknown as SharedWorkspaceSnapshot
      let mappedWorkspaceId = wsSnap.workspace.id
      gate.withRemoteApply(info.shareId, info.revision, () => {
        deps.update((s) => {
          const applied = applyWorkspaceSnapshot(s, info.shareId, wsSnap)
          mappedWorkspaceId = applied.workspaceId
          const prevShares = s.collab?.shares ?? []
          const localInfo: CollabShareInfo = { ...info, localId: mappedWorkspaceId }
          const nextShares = prevShares.some((sh) => sh.shareId === info.shareId)
            ? prevShares.map((sh) => (sh.shareId === info.shareId ? localInfo : sh))
            : [...prevShares, localInfo]
          return {
            ...s,
            workspaces: applied.workspaces,
            grids: applied.grids,
            loops: applied.loops,
            collab: { ...(s.collab ?? EMPTY_COLLAB), shares: nextShares },
          }
        })
      })
      for (const ds of Array.isArray(wsSnap.datasets) ? wsSnap.datasets : []) {
        deps.hydrateDataset(ds, mappedWorkspaceId)
      }
      if (isRecord(wsSnap.exchangesByLoop)) {
        for (const [loopId, exList] of Object.entries(wsSnap.exchangesByLoop)) {
          if (Array.isArray(exList)) {
            await deps.writeRoomExchanges(`${mappedWorkspaceId}/${loopId}`, exList as Exchange[])
          }
        }
      }
    }
  }

  const pushRoomShareSnapshot = async (
    workspaceId: string,
    loopId: string,
    memberAccountIds?: string[],
    shareId?: string,
  ): Promise<CollabShareInfo | null> => {
    const state = deps.getState()
    const grids = state.grids[workspaceId] ?? {}
    const loops = state.loops[workspaceId] ?? NO_LOOPS
    const loop = loops.list.find((l) => l.id === loopId)
    if (!loop) return null
    const chat = loopChat(workspaceId, loop)
    const exchanges = await deps.readRoomExchanges(chat)
    const datasets = deps.exportDatasets(workspaceId)
    const bundles = deps.exportBundles(collectRoomPlugins(grids, loops, loopId))
    const snapshot = buildRoomSnapshot(grids, loops, loopId, { exchanges, datasets, bundles })
    if (!snapshot) return null

    const existing = findRoomShare(state.collab ?? EMPTY_COLLAB, workspaceId, loopId, shareId ?? loop.shareId)
    const res = await deps.api.upsertShare({
      ...(existing?.shareId ? { share_id: existing.shareId } : shareId ? { share_id: shareId } : {}),
      kind: 'room',
      local_id: existing && !existing.isOwner ? existing.localId : `${workspaceId}/${loopId}`,
      title: loopTitle(loop),
      snapshot: snapshot as unknown as Record<string, unknown>,
      ...(memberAccountIds !== undefined ? { member_account_ids: memberAccountIds } : {}),
    })
    const info = mapShareInfo(res.share, state.collab?.accountId ?? null, state.jaspers.email)
    if (!info) return null
    gate.recordLocalPush(info.shareId, info.revision)
    const localInfo: CollabShareInfo = { ...info, localId: `${workspaceId}/${loopId}` }

    gate.withRemoteApply(info.shareId, info.revision, () => {
      deps.update((s) => {
        const tabLoops = s.loops[workspaceId] ?? NO_LOOPS
        const updatedList = tabLoops.list.map((l) => (l.id === loopId ? { ...l, shareId: info.shareId } : l))
        const prevShares = s.collab?.shares ?? []
        const nextShares = prevShares.some((sh) => sh.shareId === info.shareId)
          ? prevShares.map((sh) => (sh.shareId === info.shareId ? localInfo : sh))
          : [...prevShares, localInfo]
        return {
          ...s,
          loops: { ...s.loops, [workspaceId]: { ...tabLoops, list: updatedList } },
          collab: { ...(s.collab ?? EMPTY_COLLAB), shares: nextShares },
        }
      })
    })
    return localInfo
  }

  const pushWorkspaceShareSnapshot = async (
    workspaceId: string,
    memberAccountIds?: string[],
    shareId?: string,
  ): Promise<CollabShareInfo | null> => {
    const state = deps.getState()
    const workspace = state.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return null
    const grids = state.grids[workspaceId] ?? {}
    const loops = state.loops[workspaceId] ?? NO_LOOPS
    const exchangesByLoop: Record<string, Exchange[]> = {}
    for (const loop of loops.list) {
      exchangesByLoop[loop.id] = await deps.readRoomExchanges(loopChat(workspaceId, loop))
    }
    const datasets = deps.exportDatasets(workspaceId)
    const bundles = deps.exportBundles(collectWorkspacePlugins(grids, loops))
    const snapshot = buildWorkspaceSnapshot(workspace, grids, loops, {
      exchangesByLoop,
      datasets,
      bundles,
    })
    const existing = findWorkspaceShare(state.collab ?? EMPTY_COLLAB, workspaceId, shareId ?? workspace.shareId)
    const res = await deps.api.upsertShare({
      ...(existing?.shareId ? { share_id: existing.shareId } : shareId ? { share_id: shareId } : {}),
      kind: 'workspace',
      local_id: existing && !existing.isOwner ? existing.localId : workspaceId,
      title: workspace.name,
      snapshot: snapshot as unknown as Record<string, unknown>,
      ...(memberAccountIds !== undefined ? { member_account_ids: memberAccountIds } : {}),
    })
    const info = mapShareInfo(res.share, state.collab?.accountId ?? null, state.jaspers.email)
    if (!info) return null
    gate.recordLocalPush(info.shareId, info.revision)
    const localInfo: CollabShareInfo = { ...info, localId: workspaceId }

    gate.withRemoteApply(info.shareId, info.revision, () => {
      deps.update((s) => {
        const workspaces = s.workspaces.map((w) => (w.id === workspaceId ? { ...w, shareId: info.shareId } : w))
        const prevShares = s.collab?.shares ?? []
        const nextShares = prevShares.some((sh) => sh.shareId === info.shareId)
          ? prevShares.map((sh) => (sh.shareId === info.shareId ? localInfo : sh))
          : [...prevShares, localInfo]
        return {
          ...s,
          workspaces,
          collab: { ...(s.collab ?? EMPTY_COLLAB), shares: nextShares },
        }
      })
    })
    return localInfo
  }

  const processPendingCommands = async (): Promise<void> => {
    const claimed = await deps.api.claimCommands()
    for (const cmd of claimed) {
      const commandId = typeof cmd.command_id === 'string' ? cmd.command_id : ''
      const shareId = typeof cmd.share_id === 'string' ? cmd.share_id : ''
      const kind = typeof cmd.kind === 'string' ? cmd.kind : ''
      const payload = isRecord(cmd.payload) ? cmd.payload : {}
      if (!commandId || !shareId) continue

      try {
        const state = deps.getState()
        const share = state.collab?.shares.find((s) => s.shareId === shareId)
        let workspaceId = state.currentWorkspaceId
        let loopId = typeof payload.loopId === 'string' ? payload.loopId : ''
        if (share?.kind === 'room') {
          const [wId, lId] = share.localId.split('/')
          if (wId) workspaceId = wId
          if (lId) loopId = lId
        } else if (share?.kind === 'workspace') {
          workspaceId = share.localId
        }

        if (kind === 'prompt') {
          const input = typeof payload.input === 'string' ? payload.input : ''
          const reply = await deps.runRoomPrompt(workspaceId, loopId, input)
          if (share?.kind === 'room') await pushRoomShareSnapshot(workspaceId, loopId, undefined, shareId)
          else if (share?.kind === 'workspace') await pushWorkspaceShareSnapshot(workspaceId, undefined, shareId)
          await deps.api.completeCommand(commandId, { result: { reply } })
        } else if (kind === 'refresh') {
          const panelId = typeof payload.panelId === 'string' ? payload.panelId : ''
          if (panelId) deps.refreshPanel(workspaceId, panelId)
          if (share?.kind === 'room' && loopId) await pushRoomShareSnapshot(workspaceId, loopId, undefined, shareId)
          else if (share?.kind === 'workspace') await pushWorkspaceShareSnapshot(workspaceId, undefined, shareId)
          await deps.api.completeCommand(commandId, { result: { refreshed: true } })
        } else if (kind === 'source') {
          const source = typeof payload.source === 'string' ? payload.source : ''
          const run = await deps.runSource(source, payload.args, workspaceId)
          if (share?.kind === 'room' && loopId) await pushRoomShareSnapshot(workspaceId, loopId, undefined, shareId)
          else if (share?.kind === 'workspace') await pushWorkspaceShareSnapshot(workspaceId, undefined, shareId)
          await deps.api.completeCommand(commandId, { result: { run } })
        } else {
          await deps.api.completeCommand(commandId, { error: `Unknown command kind ${kind}.` })
        }
      } catch (err) {
        await deps.api.completeCommand(commandId, {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return {
    gate,
    applyRemoteShare,
    pushRoomShareSnapshot,
    pushWorkspaceShareSnapshot,
    processPendingCommands,

    async refreshState(): Promise<void> {
      const data = await deps.api.fetchState()
      const current = deps.getState()
      const myAccountId = current.collab?.accountId ?? null
      const myEmail = current.jaspers.email

      const teammates: Teammate[] = data.teammates.map((t) => ({
        accountId: t.account_id,
        email: t.email,
        since: t.since,
      }))
      const outgoingInvites = data.outgoing_invites.flatMap((raw) => mapInvite(raw) ?? [])
      const incomingInvites = data.incoming_invites.flatMap((raw) => mapInvite(raw) ?? [])
      const shares = data.shares.flatMap((raw) => mapShareInfo(raw, myAccountId, myEmail) ?? [])

      deps.update((s) => ({
        ...s,
        collab: {
          ...(s.collab ?? EMPTY_COLLAB),
          connected: true,
          teammates,
          outgoingInvites,
          incomingInvites,
          shares,
          error: null,
        },
      }))

      for (const rawShare of data.shares) {
        await applyRemoteShare(rawShare)
      }
      if (data.pending_commands.length > 0) {
        await processPendingCommands()
      }
    },

    async inviteTeammate(email: string): Promise<void> {
      await deps.api.inviteTeammate(email)
      await this.refreshState()
      deps.notice?.(`Sent teammate invitation to ${email.trim()}.`)
    },

    async acceptInvite(invite: string): Promise<void> {
      await deps.api.acceptInvite(invite)
      await this.refreshState()
      deps.notice?.('Teammate invitation accepted.')
    },

    async declineInvite(invite: string): Promise<void> {
      await deps.api.declineInvite(invite)
      await this.refreshState()
    },

    async removeTeammate(accountId: string): Promise<void> {
      await deps.api.removeTeammate(accountId)
      await this.refreshState()
    },

    async shareRoom(workspaceId: string, loopId: string, memberAccountIds: string[]): Promise<void> {
      await pushRoomShareSnapshot(workspaceId, loopId, memberAccountIds)
    },

    async unshareRoom(workspaceId: string, loopId: string): Promise<void> {
      const state = deps.getState()
      const loop = state.loops[workspaceId]?.list.find((l) => l.id === loopId)
      const share = findRoomShare(state.collab ?? EMPTY_COLLAB, workspaceId, loopId, loop?.shareId)
      if (share) {
        await deps.api.deleteShare(share.shareId)
      }
      deps.update((s) => {
        const tabLoops = s.loops[workspaceId] ?? NO_LOOPS
        const updatedList = tabLoops.list.map((l) => {
          if (l.id !== loopId) return l
          const { shareId: _removed, ...rest } = l
          return rest
        })
        return {
          ...s,
          loops: { ...s.loops, [workspaceId]: { ...tabLoops, list: updatedList } },
          collab: {
            ...(s.collab ?? EMPTY_COLLAB),
            shares: (s.collab?.shares ?? []).filter((sh) => sh.shareId !== share?.shareId),
          },
        }
      })
    },

    async shareWorkspace(workspaceId: string, memberAccountIds: string[]): Promise<void> {
      await pushWorkspaceShareSnapshot(workspaceId, memberAccountIds)
    },

    async unshareWorkspace(workspaceId: string): Promise<void> {
      const state = deps.getState()
      const workspace = state.workspaces.find((w) => w.id === workspaceId)
      const share = findWorkspaceShare(state.collab ?? EMPTY_COLLAB, workspaceId, workspace?.shareId)
      if (share) {
        await deps.api.deleteShare(share.shareId)
      }
      deps.update((s) => ({
        ...s,
        workspaces: s.workspaces.map((w) => {
          if (w.id !== workspaceId) return w
          const { shareId: _removed, ...rest } = w
          return rest
        }),
        collab: {
          ...(s.collab ?? EMPTY_COLLAB),
          shares: (s.collab?.shares ?? []).filter((sh) => sh.shareId !== share?.shareId),
        },
      }))
    },

    async runSponsoredPrompt(workspaceId: string, loopId: string, input: string): Promise<string> {
      const state = deps.getState()
      const loop = state.loops[workspaceId]?.list.find((l) => l.id === loopId)
      const ws = state.workspaces.find((w) => w.id === workspaceId)
      const { sponsored, share } = isSponsoredRoom(
        state.collab ?? EMPTY_COLLAB,
        workspaceId,
        loopId,
        loop?.shareId,
        ws?.shareId,
      )
      if (!sponsored || !share) {
        return deps.runRoomPrompt(workspaceId, loopId, input)
      }
      const res = await deps.api.enqueueCommand(share.shareId, {
        kind: 'prompt',
        payload: { loopId, input },
        wait: true,
      })
      await this.refreshState()
      if (typeof res.command.error === 'string' && res.command.error) {
        throw new Error(res.command.error)
      }
      const result = isRecord(res.command.result) ? res.command.result : {}
      return typeof result.reply === 'string' ? result.reply : 'Sent to room owner.'
    },

    async runSponsoredRefresh(workspaceId: string, panelId: string): Promise<boolean> {
      const state = deps.getState()
      const ws = state.workspaces.find((w) => w.id === workspaceId)
      const wsSponsored = isSponsoredWorkspace(state.collab ?? EMPTY_COLLAB, workspaceId, ws?.shareId)
      if (wsSponsored.sponsored && wsSponsored.share) {
        await deps.api.enqueueCommand(wsSponsored.share.shareId, {
          kind: 'refresh',
          payload: { panelId },
          wait: true,
        })
        await this.refreshState()
        return true
      }
      for (const grid of Object.values(state.grids[workspaceId] ?? {})) {
        const panel = grid.panels.find((p) => p.id === panelId || p.elementId === panelId)
        const el = panel ? grid.elements.find((e) => e.id === panel.elementId) : undefined
        if (el?.loop) {
          const loop = state.loops[workspaceId]?.list.find((l) => l.id === el.loop)
          const roomSponsored = isSponsoredRoom(
            state.collab ?? EMPTY_COLLAB,
            workspaceId,
            el.loop,
            loop?.shareId,
            ws?.shareId,
          )
          if (roomSponsored.sponsored && roomSponsored.share) {
            await deps.api.enqueueCommand(roomSponsored.share.shareId, {
              kind: 'refresh',
              payload: { panelId, loopId: el.loop },
              wait: true,
            })
            await this.refreshState()
            return true
          }
        }
      }
      return false
    },
  }
}
