// A request's own copy of its workspace's thread. The user's requests run side by side, and a thread
// only makes sense written by one run at a time, so each works on a copy taken as it starts and puts
// what it added back when it ends. The thread itself is then only ever changed in one step, between
// runs' rounds and never during them. What is kept of it while a run works is another copy: the
// thread as it would stand were the run to end there (`standing`).
//
// Pure, so what goes back, and in what state, is read in a test. No Node and no DOM.

import type { Turn } from '../llm/llm'
// The extension is explicit because Node's test runner resolves this import at run time.
import { closeOff, withoutThinking } from './history.ts'

export interface Fork {
  /** The run's own conversation: the thread as it stood, then everything the run adds. */
  turns: Turn[]
  /** Where what the run added begins in `turns`. */
  own: number
  /** The thread as it stood when the copy was taken: how long it was and what it ended on. */
  length: number
  tail: Turn | null
}

/** A copy of a thread for one run to work on. The turns themselves are shared: nothing rewrites one in place, and a run that clears one puts another in its place in the copy. */
export function forkOf(thread: Turn[]): Fork {
  return { turns: [...thread], own: thread.length, length: thread.length, tail: thread[thread.length - 1] ?? null }
}

/** Whether the thread has changed since the copy was taken: another run joined it, or it was cut. */
export function moved(thread: Turn[], fork: Fork): boolean {
  return thread.length !== fork.length || (thread[thread.length - 1] ?? null) !== fork.tail
}

/**
 * Puts a run's work back on its thread, in place. Onto a thread that has not changed since the copy
 * was taken, the copy is the thread: what the run added, and whatever it withheld or cut of what
 * came before to make room, which the next request should not have to do again. Onto one that has
 * changed, only what the run added goes, and without its thinking: a provider ties a thinking block
 * to everything before it, and what is before it now is not what it was written after.
 */
export function putBack(thread: Turn[], fork: Fork): void {
  if (moved(thread, fork)) thread.push(...withoutThinking(fork.turns.slice(fork.own)))
  else thread.splice(0, thread.length, ...fork.turns)
}

/**
 * A thread as it would stand were a run at work on it to end now: what the run has added so far put
 * back, closed off with `note`. It is what is kept while the run works, so whatever becomes of the
 * run or the app, the conversation is there as far as it got, in a shape a provider takes. Neither
 * the thread nor the run's copy is changed: the run goes on.
 */
export function standing(thread: Turn[], fork: Fork, note: string): Turn[] {
  const turns = [...fork.turns]
  closeOff(turns, note)
  const now = [...thread]
  putBack(now, { ...fork, turns })
  return now
}
