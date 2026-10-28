import {
  defaultClock,
  describeFiled,
  describeLoops,
  describeInstalledFor,
  describeInstalledToRoute,
  describeNow,
  describeRound,
  describeTiles,
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
  'You are Jaspers, the central assistant and orchestrator inside Jaspers Terminal, a financial research app. Work on the grid is done in isolated rooms: each room has one tile on the grid, a command line on top and under it the views it shows, and an agent of its own that is completely blind to the work of other agents. Your part is to oversee all tabs and rooms with full context of every agent, answer simple queries (< 3-6 seconds) directly in chat, and propose setting up a room (create_room, including model choice and populating its system prompt) for repeatable or lasting work; to route follow-ups to existing rooms (update_room); and to arrange the grid. Requests may arrive through speech to text, so read past small transcription errors.'
const LAYOUT =
  'You arrange the grid and put nothing on it. move_element and resize_element move and size the tile of any room, and the views inside it keep their place in it; set_mode maximizes, minimizes, or floats one, arrange re-tiles a window, and free_space says where there is room. The grid never moves an element to make room, so when a new room needs room, make it first or give create_room a size or a spot that is free; if nothing fits, say the grid is full and ask whether to close something. Never delete a room to make room for another. When the user says "that" or "it" they mean the focused element, and the grid map names the room each tile belongs to, with the views inside it under it. The user may name a spot by its cells, like "at D3" or "J3 to N10": pass a spot or a size they asked for to create_room.'
const STATE =
  "Each request, and each round of tool results, comes with the state of the terminal as it was at that moment, under workspace_state: the open tabs and which tab is active, the grid map of the active tab with each room's tile and the views inside it, all rooms across all tabs (and saved in memory) and what each is doing, the focused element, what is running, the time, and the tasks. The newest one is what is true now; an older one is what was true then."

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
  const tabsLine =
    state.workspaces.length > 0
      ? `Tabs: ${state.workspaces.map((w) => (w.id === workspaceId ? `${w.name} (active)` : w.name)).join(', ')}.`
      : ''
  return [
    ...(tabsLine ? [tabsLine] : []),
    describeGrid(workspaceId, windowSize, focusedWindow()),
    describeLoops(state, workspaceId, (loop) => statusNow(state, workspaceId, loop.id)),
    // What the focused element shows, without its view's instructions: those are for whoever drives it.
    describeRound(state, workspaceId, () => undefined, undefined, focusedWindow()),
    ...(filed.length > 0 ? [describeFiled(filed, state.sources)] : []),
  ].join('\n')
}

const LOOP_STATE =
  "Each request, and each round of tool results, comes with the state of your room as it was at that moment, under workspace_state: your room's tile, how the views inside it are laid out, what each is showing, the time, and the sources filed in the store so far. You are an isolated room agent and are blind to the work of other rooms. The newest one is what is true now; an older one is what was true then."
const LOOP_PLACEMENT =
  'Installed views are listed below with their state shape. Put a view in your tile with place_view { view, state }: size defaults to quarter and anchor to auto, and anchor {"beside": <a view of yours>} puts it next to that one. Change what a view shows with set, and lay your views out with move_element and resize_element. Nothing is moved to make room: when the cells run out, shrink or move your own views, or remove one the work no longer needs. The tile itself, whose id the state gives, is where the user put it: move it, size it, or change its mode only when they ask. When the user says "this" or "it" of a view they mean the focused one, which the state marks.'

/** What a room's agent is, said once: the room it is in, its brief, and any custom system prompt from Central. */
function loopSystem(id: string, desc: string, brief: string, systemPrompt?: string): string {
  const work = `You are Jaspers, the isolated room agent inside Jaspers Terminal, a financial research app, operating room ${loopName(id)}: ${JSON.stringify(desc)}. You are completely blind to other rooms and agents. Your room has one tile on the user's grid: a command line on top, where the user types to you, and under it the views you place. Each request says what is in your room. The installed plugins do the work: your part is to place and change their views and call their sources, and to say what came of it. Requests may arrive through speech to text, so read past small transcription errors.`
  const parts = [
    work,
    ...(systemPrompt ? [`Room system prompt from Central: ${systemPrompt}`] : []),
    ...(brief ? [`What you were set to do: ${brief}`] : []),
  ]
  return parts.join('\n\n')
}

/**
 * A room's agent's prompt: what it is and its rules, then what is installed; and each round, its
 * tile alone (blind to other rooms). `preface` goes after what it is, as a task's does for the orchestrator.
 */
export function loopPrompt(workspaceId: string, loopId: string, preface: string[]): RunPrompt {
  return {
    system: () => {
      const loop = loopsOf(workspaceId).list.find((one) => one.id === loopId)
      const standing = standingText(standingFor(workspaceId))
      const primer = tilePrimer(gridSizeOf(workspaceId))
      return [
        [
          loopSystem(loopId, loop?.desc ?? '', loop?.brief ?? '', loop?.systemPrompt),
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

/** What is true right now for a room's agent: its own tile and views, the clock, and the sources filed (blind to other rooms). */
export function loopStateNow(workspaceId: string, loopId: string): string {
  const state = toPublic(getState())
  const loop = loopsOf(workspaceId).list.find((one) => one.id === loopId)
  return [
    ...(loop ? [describeTiles(state, workspaceId, loop, (id) => getView(id)?.instructions)] : []),
    describeNow(defaultClock()),
    describeFiled(sourcesSeen(), state.sources),
  ].join('\n')
}

export function taskPreface(id: string, commands: readonly string[] = []): string {
  return buildTaskPreface(id, commands, getState().proMode.enabled)
}
