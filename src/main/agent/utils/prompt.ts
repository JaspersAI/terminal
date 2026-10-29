import {
  describeFiled,
  describeLoops,
  describeInstalledFor,
  describeInstalledToRoute,
  describeRound,
  describeOtherWork,
  describeTiles,
  describeWork,
  LOOP_PLACEMENT,
  loopRules,
  gridPrimer,
  ROUTER_RULES,
  taskPreface as buildTaskPreface,
  tilePrimer,
} from '../../../shared/agent/prompt'
import { standingText } from '../../../shared/agent/standing'
import { sourcesSeen } from '../../data/store'
import { loopsOf } from '../../loops/loops'
import { loopName, showsChat } from '../../../shared/loops/loops'
import { describeGrid, gridSizeOf } from '../../grid/grid'
import { focusedWindow, windowSize } from '../../grid/windows'
import { getView } from '../../plugins/registry'
import { getState, toPublic } from '../../state'
import type { RunPrompt } from '../agent'
import { standingFor } from '../memory'
import { statusNow } from './status'

// What the model is told: the system prompt, which holds still, and the state, which rides on each turn.

/** The orchestrator's prompt: the system prompt with a preface after SYSTEM, and the grid and the work on it each round. */
export function orchestratorPrompt(workspaceId: string, preface: string[]): RunPrompt {
  return { system: () => systemFor(workspaceId, preface), round: () => stateNow(workspaceId) }
}

const SYSTEM =
  'You are Jaspers, the central assistant and orchestrator inside Jaspers Terminal, a financial research app. Work on the grid is done in pieces, called loops: each has one tile on the grid, a command line on top and under it the views it shows, and an agent of its own, which places those views, calls the plugins, and keeps the conversation about that work. Your part is to oversee the workspace, reason over what is going on in the loops, views, tasks, and store, and converse with the user; to route work that needs new plugin data or changes a tile by handing it to the piece of work it belongs to or starting a new piece for it; and to arrange the grid. Requests may arrive through speech to text, so read past small transcription errors.'
const LAYOUT =
  'You arrange the grid and put nothing on it. move_element and resize_element move and size the tile of any piece of work, and the views inside it keep their place in it; set_mode maximizes, minimizes, or floats one, arrange re-tiles a window, and free_space says where there is room. The grid never moves an element to make room, so when new work needs room, make it first or give create_loop a size or a spot that is free; if nothing fits, say the grid is full and ask whether to close something. Never delete work to make room for other work. When the user says "that" or "it" they mean the focused element, and the grid map names the work each tile belongs to, with the views inside it under it. The user may name a spot by its cells, like "at D3" or "J3 to N10": pass a spot or a size they asked for to create_loop.'
const STATE =
  "Each request, and each round of tool results, comes with the state of the workspace as it was at that moment, under workspace_state: the grid map of every window with each piece of work's tile and the views inside it, the pieces of work and what each is doing, the focused element, what is running, the time, and this workspace's tasks. The newest one is what is true now; an older one is what was true then."

/**
 * The system prompt, in two blocks, neither of which changes from round to round: what never changes,
 * then what changes when a plugin is built or a memory written. Standing instructions ride the first:
 * they are the same every round, so they are part of what a provider caches.
 */
function systemFor(workspaceId: string, preface: string[]): string[] {
  const standing = standingText(standingFor(workspaceId))
  const primer = gridPrimer(gridSizeOf(workspaceId))
  return [
    [SYSTEM, ...preface, STATE, primer, LAYOUT, ROUTER_RULES, ...(standing ? [standing] : [])].join('\n\n'),
    describeInstalledToRoute(toPublic(getState())),
  ]
}

/**
 * What is true right now, which rides on the turn being sent: the grid, the work on it, the focused
 * element, the clock, the tasks. It used to be the end of the system prompt, rebuilt every
 * round, and a system prompt sits in front of the whole conversation: nothing after a change in it
 * can be reused, so every round paid full price for the whole thread again.
 */
export function stateNow(workspaceId: string): string {
  const state = toPublic(getState())
  const filed = sourcesSeen().filter((id) => id in state.sources)
  return [
    describeGrid(workspaceId, windowSize, focusedWindow()),
    describeLoops(state, workspaceId, (loop) => statusNow(state, workspaceId, loop.id)),
    // What the focused element shows, without its view's instructions: those are for whoever drives it.
    describeRound(state, workspaceId, () => undefined, undefined, focusedWindow()),
    ...(filed.length > 0 ? [describeFiled(filed, state.sources)] : []),
  ].join('\n')
}

const LOOP_STATE =
  "Each request, and each round of tool results, comes with the state as it was at that moment, under workspace_state: your tile, how the views inside it are laid out, what each is showing, the other work on the workspace by name with its views' ids, what is running, the time, this workspace's tasks, and the sources filed in the store so far. The newest one is what is true now; an older one is what was true then."

/** What a loop's agent is, said once: the work it is on, and that its tile and the views in it are its own. */
function loopSystem(id: string, desc: string, brief: string): string {
  const work = `You are Jaspers, at work on one piece of work inside Jaspers Terminal, a financial research app: ${JSON.stringify(desc)}, known as ${loopName(id)}. It has one tile on the user's grid: a command line on top, where the user types to you, and under it the views you place. Each request says what is in it. The installed plugins do the work: your part is to place and change their views and call their sources, and to say what came of it. Requests may arrive through speech to text, so read past small transcription errors.`
  return brief ? `${work}\n\nWhat you were set to do: ${brief}` : work
}

/**
 * A loop's agent's prompt: what it is and its rules, then what is installed; and each round, its
 * tile first. `preface` goes after what it is, as a task's does for the orchestrator.
 */
export function loopPrompt(workspaceId: string, loopId: string, preface: string[]): RunPrompt {
  return {
    system: () => {
      const loop = loopsOf(workspaceId).list.find((one) => one.id === loopId)
      const standing = standingText(standingFor(workspaceId))
      const primer = tilePrimer(gridSizeOf(workspaceId))
      return [
        [
          loopSystem(loopId, loop?.desc ?? '', loop?.brief ?? ''),
          ...preface,
          LOOP_STATE,
          primer,
          LOOP_PLACEMENT,
          loopRules(loop === undefined || showsChat(loop)),
          ...(standing ? [standing] : []),
        ].join('\n\n'),
        // Its own plugins' and the built-ins in full, and the rest by name: it asks for one with use_plugin.
        describeInstalledFor(toPublic(getState()), loop?.plugins ?? [], loop?.skills ?? []),
      ]
    },
    round: () => loopStateNow(workspaceId, loopId),
  }
}

/** What is true right now for a loop's agent: its tile and the views inside it, then what is running, the clock, the tasks, the sources filed. */
export function loopStateNow(workspaceId: string, loopId: string): string {
  const state = toPublic(getState())
  const loop = loopsOf(workspaceId).list.find((one) => one.id === loopId)
  return [
    ...(loop ? [describeTiles(state, workspaceId, loop, (id) => getView(id)?.instructions)] : []),
    ...describeOtherWork(state, workspaceId, loopId),
    describeWork(state, workspaceId),
    describeFiled(sourcesSeen(), state.sources),
  ].join('\n')
}

export function taskPreface(id: string, commands: readonly string[] = []): string {
  return buildTaskPreface(id, commands, getState().proMode.enabled)
}
