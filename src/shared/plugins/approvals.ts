// Rules for viewer-scoped, non-stored, and confirmed write sources: pure, with no Node or DOM imports.
//
// An approval is keyed by `(plugin, destination, thread)` when a write goes into a thread, and by
// `(plugin, destination)` alone for a standing approval on the whole destination. Binding a thread
// from a view approves that thread only; a standing approval for a whole destination comes only from
// an explicit "Always allow" on the confirmation prompt or from creating a scheduled task.

import type { SourceConfirmSpec, SourcePolicySpec, SourceScope } from '@jaspers-ai/sdk/define'
import { viewPlugin } from '../loops/loops.ts'

export type SourceApprovalVia = 'tile' | 'prompt' | 'task'

export interface SourceApproval {
  id: string
  plugin: string
  destination: string
  /** Present when the approval covers one thread only; omitted for a standing approval on the whole destination. */
  thread?: string
  /** Optional display label (such as #semis-desk), never used for matching. */
  label?: string
  via: SourceApprovalVia
  at: number
}

export const ALLOW_ONCE = 'Allow once'
export const ALLOW_THREAD = 'Allow this thread'
export const ALWAYS_ALLOW = 'Always allow'
export const CANCEL_APPROVAL = 'Cancel'

export const PLUGIN_NOT_INSTALLED = 'PLUGIN_NOT_INSTALLED'

export function sourceApprovalId(plugin: string, destination: string, thread?: string): string {
  return thread ? `${plugin}\u0000${destination}\u0000${thread}` : `${plugin}\u0000${destination}`
}

/** Whether a source touches the viewer's own identity, private unstored content, or external side effects. */
export function isOwnerPrivateSource(
  source: Pick<SourcePolicySpec, 'scope' | 'noStore' | 'writes'> | undefined,
): boolean {
  if (!source) return false
  return source.scope === 'viewer' || source.noStore === true || source.writes === true
}

/**
 * Exact watch rule: a plugin with no room-scoped source in the room has no watchable live keys.
 * A room-scoped source is one whose `scope` is `'room'` (the default) and that neither sets `noStore`
 * nor `writes`.
 */
export function hasRoomScopedSource(
  plugin: string,
  roomShownOrTold: boolean,
  sources: Record<string, { plugin: string | null; scope?: SourceScope; noStore?: boolean; writes?: boolean }>,
): boolean {
  if (!plugin || !roomShownOrTold) return false
  return Object.values(sources).some((s) => s.plugin === plugin && !isOwnerPrivateSource(s))
}

export type PanelSourceRoute =
  { kind: 'local' } | { kind: 'replica-owner' } | { kind: 'plugin-not-installed'; plugin: string; message: string }

/**
 * How a panel's `'source:run'` call is routed. In a replica of a shared room, a `scope: 'viewer'`
 * source never goes to the owner: it runs on the viewer's own terminal when the plugin is installed
 * locally, and fails locally with `PLUGIN_NOT_INSTALLED` when it is not.
 */
export function routePanelSourceCall(options: {
  sourceId: string
  isReplica: boolean
  localPluginInstalled: boolean
  localSourceScope?: SourceScope
  syncedViewerSources?: readonly string[]
}): PanelSourceRoute {
  const { sourceId, isReplica, localPluginInstalled, localSourceScope, syncedViewerSources } = options
  if (!isReplica) return { kind: 'local' }
  const plugin = viewPlugin(sourceId)
  if (plugin === null) return { kind: 'replica-owner' }
  if (localPluginInstalled) {
    return localSourceScope === 'viewer' ? { kind: 'local' } : { kind: 'replica-owner' }
  }
  if (syncedViewerSources?.includes(sourceId)) {
    return {
      kind: 'plugin-not-installed',
      plugin,
      message: `${PLUGIN_NOT_INSTALLED}: Install the ${plugin} plugin on this terminal to use ${sourceId}.`,
    }
  }
  return { kind: 'replica-owner' }
}

/**
 * Whether `(plugin, destination, thread)` is already covered by a stored approval: a standing
 * destination-wide approval (`thread === undefined`) covers both top-level posts and any thread in
 * that destination; a thread-scoped approval covers only that exact `(destination, thread)`.
 */
export function isDestinationApproved(
  approvals: readonly SourceApproval[],
  plugin: string,
  destination: string,
  thread?: string,
): boolean {
  const cleanDest = destination.trim()
  const cleanThread = thread?.trim() || undefined
  if (!plugin || !cleanDest) return false
  for (const entry of approvals) {
    if (entry.plugin !== plugin || entry.destination !== cleanDest) continue
    if (entry.thread === undefined) return true
    if (cleanThread !== undefined && entry.thread === cleanThread) return true
  }
  return false
}

/** Inserts or updates one approval, preserving immutability when nothing changed. */
export function withSourceApproval(
  approvals: readonly SourceApproval[],
  next: Omit<SourceApproval, 'id'>,
): SourceApproval[] {
  const plugin = next.plugin.trim()
  const destination = next.destination.trim()
  const thread = next.thread?.trim() || undefined
  const label = next.label?.trim() || undefined
  if (!plugin || !destination) return [...approvals]
  const id = sourceApprovalId(plugin, destination, thread)
  const record: SourceApproval = {
    id,
    plugin,
    destination,
    ...(thread ? { thread } : {}),
    ...(label ? { label } : {}),
    via: next.via,
    at: next.at,
  }
  const idx = approvals.findIndex((a) => a.id === id)
  if (idx >= 0) {
    const prev = approvals[idx]!
    if (prev.label === record.label && prev.via === record.via) return [...approvals]
    return approvals.map((a, i) => (i === idx ? record : a))
  }
  return [...approvals, record]
}

export function withoutSourceApproval(approvals: readonly SourceApproval[], id: string): SourceApproval[] {
  if (!approvals.some((a) => a.id === id)) return [...approvals]
  return approvals.filter((a) => a.id !== id)
}

export function withoutPluginApprovals(approvals: readonly SourceApproval[], plugin: string): SourceApproval[] {
  if (!approvals.some((a) => a.plugin === plugin)) return [...approvals]
  return approvals.filter((a) => a.plugin !== plugin)
}

/** Reads persisted `sourceApprovals` safely from `state.json`. */
export function readSourceApprovals(raw: unknown): SourceApproval[] {
  if (!Array.isArray(raw)) return []
  const out: SourceApproval[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const rec = item as Record<string, unknown>
    const plugin = typeof rec['plugin'] === 'string' ? rec['plugin'].trim() : ''
    const destination = typeof rec['destination'] === 'string' ? rec['destination'].trim() : ''
    const thread = typeof rec['thread'] === 'string' && rec['thread'].trim() ? rec['thread'].trim() : undefined
    const label = typeof rec['label'] === 'string' && rec['label'].trim() ? rec['label'].trim() : undefined
    const via = rec['via'] === 'tile' || rec['via'] === 'prompt' || rec['via'] === 'task' ? rec['via'] : null
    const at = typeof rec['at'] === 'number' && Number.isFinite(rec['at']) ? rec['at'] : 0
    if (!plugin || !destination || !via) continue
    const id = sourceApprovalId(plugin, destination, thread)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      plugin,
      destination,
      ...(thread ? { thread } : {}),
      ...(label ? { label } : {}),
      via,
      at,
    })
  }
  return out
}

/** Extracts `(destination, thread, label)` from a source call's parsed arguments. */
export function extractConfirmTarget(
  confirm: SourceConfirmSpec,
  args: unknown,
): { destination: string; thread?: string; label?: string } | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const rec = args as Record<string, unknown>
  const rawDest = rec[confirm.destinationArg]
  const destination = typeof rawDest === 'string' ? rawDest.trim() : ''
  if (!destination) return null
  const rawThread = confirm.threadArg ? rec[confirm.threadArg] : undefined
  const thread = typeof rawThread === 'string' && rawThread.trim() ? rawThread.trim() : undefined
  const rawLabel = confirm.labelArg ? rec[confirm.labelArg] : undefined
  const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : undefined
  return { destination, ...(thread ? { thread } : {}), ...(label ? { label } : {}) }
}

/**
 * Extracts a newly created or bound thread target from a panel UI call's arguments and JSON result,
 * so binding a twin from a view approves that thread only (never a whole channel).
 */
export function extractBoundThreadApproval(
  confirm: SourceConfirmSpec,
  args: unknown,
  resultText: string,
): { destination: string; thread: string; label?: string } | null {
  if (!confirm.threadArg) return null
  const fromArgs = extractConfirmTarget(confirm, args)
  let parsed: Record<string, unknown> | null = null
  if (resultText.trim().startsWith('{')) {
    try {
      const val: unknown = JSON.parse(resultText)
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) parsed = val as Record<string, unknown>
    } catch {
      // Plain text result.
    }
  }
  const destination =
    fromArgs?.destination ||
    (typeof parsed?.['channelId'] === 'string' ? parsed['channelId'].trim() : '') ||
    (typeof parsed?.['channel'] === 'string' ? parsed['channel'].trim() : '') ||
    (typeof parsed?.[confirm.destinationArg] === 'string' ? String(parsed[confirm.destinationArg]).trim() : '')
  const thread =
    fromArgs?.thread ||
    (typeof parsed?.['threadTs'] === 'string' ? parsed['threadTs'].trim() : '') ||
    (typeof parsed?.['thread_ts'] === 'string' ? parsed['thread_ts'].trim() : '') ||
    (typeof parsed?.[confirm.threadArg] === 'string' ? String(parsed[confirm.threadArg]).trim() : '')
  const label =
    fromArgs?.label ||
    (typeof parsed?.['channelName'] === 'string' ? parsed['channelName'].trim() : undefined) ||
    (typeof parsed?.['label'] === 'string' ? parsed['label'].trim() : undefined)
  if (!destination || !thread) return null
  return { destination, thread, ...(label ? { label } : {}) }
}

export function confirmPromptChoices(hasThread: boolean): string[] {
  return hasThread
    ? [ALLOW_ONCE, ALLOW_THREAD, ALWAYS_ALLOW, CANCEL_APPROVAL]
    : [ALLOW_ONCE, ALWAYS_ALLOW, CANCEL_APPROVAL]
}

export type ConfirmDecision = 'once' | 'thread' | 'always' | 'denied'

export function readConfirmDecision(answer: string | null | undefined, hasThread: boolean): ConfirmDecision {
  if (answer === ALLOW_ONCE) return 'once'
  if (hasThread && answer === ALLOW_THREAD) return 'thread'
  if (answer === ALWAYS_ALLOW) return 'always'
  return 'denied'
}

export function formatConfirmQuestion(
  sourceId: string,
  confirm: SourceConfirmSpec,
  target: { destination: string; thread?: string; label?: string },
  forTask = false,
): string {
  const verb = confirm.actionLabel?.trim() || 'send to'
  const shown = target.label ? `${target.label} (${target.destination})` : target.destination
  const where = target.thread ? `${shown}, thread ${target.thread}` : shown
  return forTask
    ? `Allow scheduled tasks using ${sourceId} to ${verb} ${shown}?`
    : `Allow ${sourceId} to ${verb} ${where}?`
}

export interface ApprovalDeps {
  read(): readonly SourceApproval[]
  write(next: SourceApproval[]): void
  now(): number
  ask(text: string, choices: string[], signal?: AbortSignal, code?: string, about?: string): Promise<string | null>
}

export function recordSourceApprovalWith(
  entry: { plugin: string; destination: string; thread?: string; label?: string; via: SourceApprovalVia },
  deps: Pick<ApprovalDeps, 'read' | 'write' | 'now'>,
): void {
  deps.write(withSourceApproval(deps.read(), { ...entry, at: deps.now() }))
}

/**
 * Records a thread-only approval when a local panel view binds or posts into a thread. A view call
 * never records a standing channel-wide approval.
 */
export function recordPanelThreadApprovalWith(
  plugin: string | null,
  confirm: SourceConfirmSpec | undefined,
  args: unknown,
  resultText: string,
  deps: Pick<ApprovalDeps, 'read' | 'write' | 'now'>,
): void {
  if (!plugin || !confirm) return
  const bound = extractBoundThreadApproval(confirm, args, resultText)
  if (!bound) return
  recordSourceApprovalWith(
    {
      plugin,
      destination: bound.destination,
      thread: bound.thread,
      ...(bound.label ? { label: bound.label } : {}),
      via: 'tile',
    },
    deps,
  )
}

/**
 * Checks or prompts for destination approval before an LLM `run_source` call executes.
 * Fails closed without prompting on unattended runs (`unattended: true`) unless already approved.
 */
export async function ensureAgentDestinationApproved(options: {
  sourceId: string
  plugin: string | null
  confirm: SourceConfirmSpec | undefined
  args: unknown
  unattended: boolean
  signal?: AbortSignal
  about?: string
  deps: ApprovalDeps
}): Promise<void> {
  const { sourceId, plugin, confirm, args, unattended, signal, about, deps } = options
  if (!plugin || !confirm) return
  const target = extractConfirmTarget(confirm, args)
  if (!target) {
    throw new Error(`${sourceId} requires ${confirm.destinationArg} before it can run.`)
  }
  if (isDestinationApproved(deps.read(), plugin, target.destination, target.thread)) return
  if (unattended) {
    const where = target.thread ? `${target.destination} (thread ${target.thread})` : target.destination
    throw new Error(`${sourceId} cannot run unattended because ${where} is not an approved destination for ${plugin}.`)
  }
  const hasThread = target.thread !== undefined
  const answer = await deps.ask(
    formatConfirmQuestion(sourceId, confirm, target, false),
    confirmPromptChoices(hasThread),
    signal,
    undefined,
    about,
  )
  const decision = readConfirmDecision(answer, hasThread)
  if (decision === 'denied') {
    throw new Error(`The user did not approve ${sourceId} for ${target.destination}.`)
  }
  if (decision === 'thread' && target.thread) {
    recordSourceApprovalWith(
      {
        plugin,
        destination: target.destination,
        thread: target.thread,
        ...(target.label ? { label: target.label } : {}),
        via: 'prompt',
      },
      deps,
    )
  } else if (decision === 'always') {
    recordSourceApprovalWith(
      {
        plugin,
        destination: target.destination,
        ...(target.label ? { label: target.label } : {}),
        via: 'prompt',
      },
      deps,
    )
  }
}

/**
 * Prompts the user while creating or updating a scheduled task to grant a standing channel approval
 * for each confirmed write destination the task declares.
 */
export async function approveDestinationsForTask(options: {
  targets: readonly {
    sourceId: string
    plugin: string
    confirm: SourceConfirmSpec
    destination: string
    label?: string
  }[]
  signal?: AbortSignal
  about?: string
  deps: ApprovalDeps
}): Promise<void> {
  const { targets, signal, about, deps } = options
  for (const item of targets) {
    const destination = item.destination.trim()
    if (!destination) continue
    if (isDestinationApproved(deps.read(), item.plugin, destination)) continue
    const answer = await deps.ask(
      formatConfirmQuestion(item.sourceId, item.confirm, { destination, label: item.label }, true),
      [ALWAYS_ALLOW, CANCEL_APPROVAL],
      signal,
      undefined,
      about,
    )
    if (answer !== ALWAYS_ALLOW) {
      throw new Error(
        `The user did not approve scheduled writes to ${destination} for ${item.sourceId}, so the task was not scheduled.`,
      )
    }
    recordSourceApprovalWith(
      {
        plugin: item.plugin,
        destination,
        ...(item.label ? { label: item.label } : {}),
        via: 'task',
      },
      deps,
    )
  }
}
