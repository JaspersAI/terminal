import type { Place } from '../../shared/agent/asking'
import { shownQuestion } from '../../shared/agent/attachments'
import type { Handed } from '../../shared/agent/typed'
import { closedLoop } from '../../shared/loops/closed'
import { loopChat, frameOf, gone, shut } from '../../shared/loops/loops'
import type { Exchange } from '../../shared/agent/transcript'
import { findRoomTab, loopsOf, touchLoop } from '../loops/loops'
import { getGrids } from '../grid/grid'
import { expandSlash } from '../skills/skills'
import { getState, subscribe } from '../state'
import { NEW_THREAD, turnText, userRequest, type Added } from './request'
import { loopTools } from './tools'
import { loopPrompt, loopStateNow, taskPreface } from './utils/prompt'
import { stopChat } from './utils/runs'
import { exchanges, forget } from './utils/thread'
import { createTurns } from './utils/turns'

// A room's requests: a message sent in its frame's box, answered by its own agent. It is the same
// request the global box makes (`userRequest`), on the room's own chat: its thread goes on whole,
// its prompt is about its tiles, its tools change only those, and what it asks is asked in its frame.
// One run at a time. A message for a room whose agent is working joins that run after the round in
// flight; one that arrives while the run is writing its reply waits, and begins the next.

const turns = createTurns()

/** The room a tile on a tab belongs to, and which tab holds it. The docked chat has none. */
function loopOn(preferredTabId: string, on: string): { workspaceId: string; loop: string } {
  const state = getState()
  const checkTab = (tabId: string): string | null => {
    for (const grid of Object.values(state.grids[tabId] ?? {})) {
      const element = grid.elements.find((e) => e.id === on)
      if (element?.loop !== undefined) return element.loop
      if (element) return null
    }
    return null
  }
  const local = checkTab(preferredTabId)
  if (local) return { workspaceId: preferredTabId, loop: local }
  for (const tabId of Object.keys(state.grids)) {
    const found = checkTab(tabId)
    if (found) return { workspaceId: tabId, loop: found }
  }
  throw new Error(`${on} has no conversation of its own.`)
}

/** A message sent from a tile's box. */
export function runLoop(input: string, on: string, ask?: string): Promise<string> {
  const { workspaceId, loop } = loopOn(getState().currentWorkspaceId, on)
  return runOn(workspaceId, loop, on, { input, ask })
}

/**
 * Hands a loop a request from outside its tiles, the orchestrator's handoff or a message the user
 * addressed to it by name, and leaves it to go: the work is a run of its own, shown in its tile, and
 * what goes wrong in it is said there. Whoever hands it over this way does not wait for it: the
 * user's request, which must not hold the global box for the length of the work.
 */
export function handOver(workspaceId: string, loopId: string, handed: Handed): void {
  void sendToLoop(workspaceId, loopId, handed).catch((err: unknown) =>
    console.warn(`[agent] ${loopId} ${err instanceof Error ? err.message : String(err)}`),
  )
}

/**
 * A handed-over request, shown in the loop's frame and run in its turn. Resolves with its reply,
 * which a task's run waits for: nobody is at a task's box, the scheduler's one run of a task at a time
 * and its lanes then hold through the work, and what the work said is what the task says.
 */
export async function sendToLoop(workspaceId: string, loopId: string, handed: Handed): Promise<string> {
  const frame = frameOf(getGrids(workspaceId), loopId)
  if (!frame) throw new Error(`Unknown work ${loopId}.`)
  const input = handed.typed ?? ''
  if (!input && !handed.written) throw new Error('Nothing to hand over.')
  return runOn(workspaceId, loopId, frame.element.id, { input, written: handed.written, task: handed.task })
}

/** What one request of a loop's is sent with. */
interface Sent {
  /** What the user typed: in the work's own box, or in the global box when it was handed over. */
  input: string
  /** The window's name for it, when a window sent it. */
  ask?: string
  /** What the assistant wrote under the user's words, when it handed the request over. */
  written?: string
  /** The scheduled task whose run handed it over. */
  task?: string
}

/** One request of a room's, shown in its frame: its own chat, prompt, and tools, in its turn. */
function runOn(workspaceId: string, loop: string, on: string, { input, ask, written, task }: Sent): Promise<string> {
  const record = loopsOf(workspaceId).list.find((one) => one.id === loop)
  const chat = loopChat(workspaceId, record ?? loop)
  touchLoop(workspaceId, loop)
  const request = (): Promise<string> => {
    const latestRecord = loopsOf(workspaceId).list.find((one) => one.id === loop)
    // Where it shows is the work's frame, read as the run begins.
    const place: Place = { workspaceId, on: frameOf(getGrids(workspaceId), loop)?.element.id ?? on }
    return userRequest({
      workspaceId,
      chat,
      input,
      written,
      task,
      ask,
      label: `${loop} `,
      model: latestRecord?.model ?? null,
      // The whole of it goes on: a room's conversation is its memory of the work.
      goesOn: () => {},
      // Work a task's run started is told so, as the task's own run is: it answers only when there is
      // something to hear, and is given the scripts the user allowed that task.
      prompt: loopPrompt(workspaceId, loop, task === undefined ? [] : [taskPreface(task, commandsOf(task))]),
      tools: loopTools,
      state: () => loopStateNow(workspaceId, loop),
      tile: { loop, place },
      // What is sent to this room while the run is at work joins it. A run on a task's limits takes
      // nothing: what the user sends then waits, and runs as theirs.
      added: task === undefined ? () => turns.takeWaiting<Added>(chat) : undefined,
    })
  }
  // /new does not wait: it starts the conversation over under whatever is still working, as it does
  // in the global box.
  if (expandSlash(input) === null && NEW_THREAD.test(input)) return request()
  // Waiting its turn, it says what it is, so the run at work can take it rather than leave it to run
  // after. A task's handoff says nothing: it is never taken into another run, and runs on its own limits.
  const says: Added | undefined =
    task === undefined ? { text: turnText(input, written), shown: shownQuestion(written ?? input), ask } : undefined
  return turns.take(chat, ask, request, '', says)
}

/** The scripts the user allowed a task, which a run on its limits is told so it can pass one to the letter. */
function commandsOf(task: string): readonly string[] {
  return getState().tasks.find((one) => one.id === task)?.commands ?? []
}

/** Calls off a message still waiting its turn, by the name its window gave it. */
export function callOff(ask: string): boolean {
  return turns.callOff(ask)
}

/** The end of a room's chat across any tab, open or closed, as `agent:history` reads it. */
export function loopHistory(loop: string, limit: number, before?: number): Promise<Exchange[]> {
  const state = getState()
  const ownerTabId = findRoomTab(state, loop) ?? state.currentWorkspaceId
  const loops = loopsOf(ownerTabId)
  const openRecord = loops.list.find((one) => one.id === loop)
  const closedRecord = closedLoop(loops, loop)?.loop
  const record = openRecord ?? closedRecord
  if (!record) throw new Error(`Unknown work ${loop}.`)
  return exchanges(loopChat(ownerTabId, record), limit, before)
}

/**
 * A loop that closes stops what it was doing: what waited its turn, and its run. One that is gone,
 * deleted or with its workspace, is forgotten as well: its thread and its log. A closed loop keeps
 * both, so reopening it goes on with its conversation. It is seen leaving the tree, so every way one
 * goes comes through here: its frame removed, its frame's place taken, its workspace deleted. What
 * follows is done a moment after the change that removed it, not inside it: stopping a run changes
 * the tree again.
 */
export function watchLoops(): void {
  subscribe((next, prev) => {
    if (next.loops === prev.loops) return
    const stopped = shut(prev.loops, next.loops)
    const forgotten = gone(prev.loops, next.loops)
    if (stopped.length === 0 && forgotten.length === 0) return
    queueMicrotask(() => {
      for (const chat of new Set([...stopped, ...forgotten])) {
        turns.clear(chat)
        stopChat(chat)
      }
      for (const chat of forgotten) forget(chat)
    })
  })
}
