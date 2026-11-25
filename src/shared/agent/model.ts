// Which model class a piece of work runs on, and how hard it thinks. Routing separates two
// orthogonal axes so changing effort on the same model class never strips provider signatures in
// `threads.ts`, and keeps `(modelClass, effort)` sticky within an active sitting so warm prefix
// caches on Vertex AI and Anthropic are preserved across turns.

import { splitAttachments } from './attachments.ts'
import type { Effort, LlmEffort, LlmSurface, ModelClass } from '../llm/llm.ts'
import { signsIn, takesModel, type LlmApi, type Provider } from '../llm/providers.ts'
import { CENTRAL_CHAT } from './history.ts'

export type { LlmEffort as RoutingEffort, ModelClass }

export const MODEL_CLASSES: readonly ModelClass[] = ['fast', 'main', 'code']
export const ROUTING_EFFORTS: readonly LlmEffort[] = ['low', 'medium', 'high']

/**
 * Default reasoning effort for general room and task work (`medium`). Kept at `medium` rather than
 * `high` so serializing `reasoning_effort` on Chat Completions matches gateway defaults without
 * inflating thinking token spend on standard runs.
 */
export const EFFORT: Effort = 'medium'

/** Reasoning effort for latency-sensitive turns (`fast` rooms, routine watches, and Central's default). */
export const FAST_EFFORT: Effort = 'low'

/** Idle gap (1 hour) after which a room's prefix cache is cold and its sitting-sticky tier may step down. */
export const SITTING_IDLE_MS = 60 * 60 * 1000

/** Tool-round count at which a `fast` room is judged multi-step and promoted to `main`. */
export const FAST_ESCALATION_ROUNDS = 5

/** Tool-error count within one run at which a `fast` room promotes to `main`. */
export const FAST_ESCALATION_ERRORS = 2

export function isModelClass(value: unknown): value is ModelClass {
  return typeof value === 'string' && (MODEL_CLASSES as readonly string[]).includes(value)
}

export function isRoutingEffort(value: unknown): value is LlmEffort {
  return typeof value === 'string' && (ROUTING_EFFORTS as readonly string[]).includes(value)
}

export function effortRank(effort: Effort): number {
  switch (effort) {
    case 'low':
      return 0
    case 'medium':
      return 1
    case 'high':
    case 'xhigh':
    case 'max':
      return 2
  }
}

export function maxEffort(a: Effort, b: Effort): Effort {
  return effortRank(b) > effortRank(a) ? b : a
}

export function classRank(modelClass: ModelClass): number {
  return modelClass === 'fast' ? 0 : 1
}

/** What a piece of work runs on: the wire `model` string, its `effort`, its semantic `modelClass`, and `surface`. */
export interface RunsOn {
  model: string
  effort: Effort
  modelClass: ModelClass
  surface?: LlmSurface
}

/** What is configured, as much of it as says which model: the provider, and the models set for it. */
export interface Configured {
  provider: Provider<LlmApi>
  /** The main/thinking model: what standard work runs on. */
  model: string
  /** The fast model. Absent or blank, the provider has none. */
  fastModel?: string
}

/** Optional routing metadata saved on a room or scheduled task. */
export interface WorkRouting {
  model?: string | null
  modelClass?: ModelClass | null
  effort?: LlmEffort | null
  surface?: LlmSurface
}

/** Resolves the wire `model` name for a semantic `modelClass` on `configured`. */
export function wireModelForClass(configured: Configured, modelClass: ModelClass, ownModel?: string | null): string {
  if (signsIn(configured.provider)) return modelClass
  const named = ownModel?.trim()
  if (named && takesModel('llm', configured.provider)) return named
  const fast = configured.fastModel?.trim()
  if (modelClass === 'fast' && fast) return fast
  return configured.model
}

/** Default effort for a semantic `modelClass` when none was explicitly chosen. */
export function defaultEffortForClass(modelClass: ModelClass): LlmEffort {
  return modelClass === 'fast' ? 'low' : 'medium'
}

/**
 * Resolves what a non-Central piece of work runs on (`workRunsOn`), supporting legacy string `own`
 * (for BYOK model overrides) or structured `WorkRouting` (`modelClass`, `effort`, `model`, `surface`).
 */
export function workRunsOn(configured: Configured, own?: string | null | WorkRouting): RunsOn {
  const spec: WorkRouting = typeof own === 'string' || own === null || own === undefined ? { model: own } : own
  const modelClass: ModelClass = isModelClass(spec.modelClass) ? spec.modelClass : 'main'
  const effort: Effort = isRoutingEffort(spec.effort) ? spec.effort : defaultEffortForClass(modelClass)
  return {
    model: wireModelForClass(configured, modelClass, spec.model),
    effort,
    modelClass,
    ...(spec.surface ? { surface: spec.surface } : {}),
  }
}

/**
 * Resolves what a chat runs on (`chatRunsOn`):
 * - `CENTRAL_CHAT`: under Jaspers One, runs on the flagship `main` model at `low` effort with
 *   `surface: 'central'` (Vertex Priority PayGo); on BYOK providers, uses `fastModel` at `low` effort
 *   when configured, else `model` at `EFFORT`.
 * - `build/*` (`build_plugin`): runs on `code` class at `medium` effort (`surface: 'build'`).
 * - Room chats (`<tab>/f<n>`): runs on the room's `modelClass` + `effort` (or BYOK `model`), `surface: 'room'`.
 */
export function chatRunsOn(chat: string, configured: Configured, own?: string | null | WorkRouting): RunsOn {
  if (chat === CENTRAL_CHAT) {
    const spec: WorkRouting = typeof own === 'object' && own !== null ? own : {}
    if (signsIn(configured.provider)) {
      const modelClass: ModelClass = isModelClass(spec.modelClass) ? spec.modelClass : 'main'
      const effort: Effort = isRoutingEffort(spec.effort) ? spec.effort : FAST_EFFORT
      return {
        model: wireModelForClass(configured, modelClass),
        effort,
        modelClass,
        surface: 'central',
      }
    }
    const fast = configured.fastModel?.trim()
    const explicitEffort = isRoutingEffort(spec.effort) ? spec.effort : undefined
    if (spec.modelClass === 'main') {
      return {
        model: configured.model,
        effort: explicitEffort ?? EFFORT,
        modelClass: 'main',
        surface: 'central',
      }
    }
    if (fast) {
      return {
        model: fast,
        effort: explicitEffort ?? FAST_EFFORT,
        modelClass: 'fast',
        surface: 'central',
      }
    }
    return {
      model: configured.model,
      effort: explicitEffort ?? EFFORT,
      modelClass: 'main',
      surface: 'central',
    }
  }
  if (chat.startsWith('build/')) {
    const spec: WorkRouting = typeof own === 'object' && own !== null ? own : {}
    const effort: Effort = isRoutingEffort(spec.effort) ? spec.effort : EFFORT
    return {
      model: wireModelForClass(configured, 'code', spec.model),
      effort,
      modelClass: 'code',
      surface: 'build',
    }
  }
  const baseSpec: WorkRouting =
    typeof own === 'string' || own === null || own === undefined
      ? { model: own, surface: 'room' }
      : { surface: 'room', ...own }
  return workRunsOn(configured, baseSpec)
}

/** Parsed prompt-level routing directive (`/deep`, `/fast`, composer toggle, or file-attachment floor). */
export interface PromptRoutingDirective {
  /** Cleaned user input with leading `/deep` or `/fast` directive stripped when applicable. */
  cleanedInput: string
  /** Explicit model class requested by `/deep` or `/fast` (or promoted by `high` effort toggle). */
  modelClass?: ModelClass
  /** Explicit effort requested by `/deep`, `/fast`, or composer toggle. */
  effort?: LlmEffort
  /** Minimum effort floor implied by attached documents/images on cold/new runs. */
  attachmentFloor?: LlmEffort
  /** True when the user explicitly asked to override tier/effort (`/deep`, `/fast`, or non-auto toggle). */
  explicit: boolean
}

const DEEP_DIRECTIVE = /^\/deep(?:\s+([\s\S]*))?$/i
const FAST_DIRECTIVE = /^\/fast(?:\s+([\s\S]*))?$/i

/**
 * Extracts explicit `/deep` or `/fast` slash directives (unless shadowed by a user skill of the same
 * name), applies an optional composer effort toggle (`low | medium | high`), and detects file
 * attachments as a `medium` effort floor.
 */
export function parsePromptRouting(
  input: string,
  options: {
    composerEffort?: LlmEffort | null
    hasSkill?: (name: string) => boolean
  } = {},
): PromptRoutingDirective {
  const trimmed = input.trim()
  const { text, attachments } = splitAttachments(trimmed)
  const attachmentFloor: LlmEffort | undefined = attachments.length > 0 ? 'medium' : undefined

  const deepMatch = !options.hasSkill?.('deep') ? DEEP_DIRECTIVE.exec(text.trim()) : null
  if (deepMatch) {
    const body = (deepMatch[1] ?? '').trim()
    const rebuilt = [body || 'Analyze thoroughly.', ...attachments].filter(Boolean).join('\n\n')
    return {
      cleanedInput: rebuilt,
      modelClass: 'main',
      effort: 'high',
      ...(attachmentFloor ? { attachmentFloor } : {}),
      explicit: true,
    }
  }

  const fastMatch = !options.hasSkill?.('fast') ? FAST_DIRECTIVE.exec(text.trim()) : null
  if (fastMatch) {
    const body = (fastMatch[1] ?? '').trim()
    const rebuilt = [body, ...attachments].filter(Boolean).join('\n\n')
    return {
      cleanedInput: rebuilt || trimmed,
      modelClass: 'fast',
      effort: 'low',
      explicit: true,
    }
  }

  if (isRoutingEffort(options.composerEffort)) {
    return {
      cleanedInput: input,
      ...(options.composerEffort === 'high' ? { modelClass: 'main' as const } : {}),
      effort: options.composerEffort,
      ...(attachmentFloor ? { attachmentFloor } : {}),
      explicit: true,
    }
  }

  return {
    cleanedInput: input,
    ...(attachmentFloor ? { attachmentFloor } : {}),
    explicit: false,
  }
}

/**
 * Sitting-sticky room tier update rule:
 * - While a room is warm (`now - lastActiveAt < SITTING_IDLE_MS`), `(modelClass, effort)` can promote
 *   upward (`fast -> main`, or effort upward ONLY when `modelClass` promotes or `explicit` is true —
 *   never flipping effort back and forth on a warm Argon thread, which Step 1 proved busts Vertex's
 *   implicit prefix cache).
 * - After an idle gap `>= SITTING_IDLE_MS` (or when `explicit` `/fast` or `/deep` is given), the room
 *   may freely re-tier up or down.
 */
export function resolveStickyRoomTier(
  current: { modelClass?: ModelClass | null; effort?: LlmEffort | null; lastActiveAt?: number; createdAt: number },
  proposed: { modelClass?: ModelClass | null; effort?: LlmEffort | null },
  options: { now: number; explicit?: boolean } = { now: Date.now() },
): { modelClass: ModelClass; effort: LlmEffort; changed: boolean } {
  const curClass: ModelClass = isModelClass(current.modelClass) ? current.modelClass : 'main'
  const curEffort: LlmEffort = isRoutingEffort(current.effort) ? current.effort : defaultEffortForClass(curClass)
  const wantClass = isModelClass(proposed.modelClass) ? proposed.modelClass : undefined
  const wantEffort = isRoutingEffort(proposed.effort) ? proposed.effort : undefined

  if (!wantClass && !wantEffort) {
    return { modelClass: curClass, effort: curEffort, changed: false }
  }

  const lastAt = current.lastActiveAt ?? current.createdAt
  const cold = options.now - lastAt >= SITTING_IDLE_MS

  if (options.explicit || cold) {
    const nextClass = wantClass ?? curClass
    const nextEffort =
      wantEffort ?? (wantClass && wantClass !== curClass ? defaultEffortForClass(nextClass) : curEffort)
    return {
      modelClass: nextClass,
      effort: nextEffort,
      changed: nextClass !== curClass || nextEffort !== curEffort,
    }
  }

  // Warm sitting: promote `fast -> main`, never downgrade `main -> fast`, and keep effort steady on an
  // already-warm `main` thread unless the room is promoting from `fast` right now.
  const promotedClass: ModelClass = wantClass && classRank(wantClass) > classRank(curClass) ? wantClass : curClass
  const classPromoted = promotedClass !== curClass
  const nextEffort: LlmEffort = classPromoted ? (wantEffort ?? defaultEffortForClass(promotedClass)) : curEffort
  return {
    modelClass: promotedClass,
    effort: nextEffort,
    changed: promotedClass !== curClass || nextEffort !== curEffort,
  }
}

/**
 * Deterministic runtime triggers that escalate a `fast` room to `main` (`medium` effort) without
 * relying on the small model to judge its own limits.
 */
export function shouldEscalateFastRun(state: {
  modelClass: ModelClass
  round: number
  toolErrors: number
  refused?: boolean
  timedOut?: boolean
  priorFailures?: number
}): boolean {
  if (state.modelClass !== 'fast') return false
  if (state.refused || state.timedOut) return true
  if ((state.priorFailures ?? 0) >= 1) return true
  if (state.toolErrors >= FAST_ESCALATION_ERRORS) return true
  if (state.round >= FAST_ESCALATION_ROUNDS) return true
  return false
}

/** Human-readable label for a room's routing tier, shown in inline `Start` confirmation prompts and digests. */
export function formatRoutingLabel(modelClass?: ModelClass | null, effort?: LlmEffort | null): string {
  const cls: ModelClass = isModelClass(modelClass) ? modelClass : 'main'
  const eff: LlmEffort = isRoutingEffort(effort) ? effort : defaultEffortForClass(cls)
  return `${cls} · ${eff}`
}
