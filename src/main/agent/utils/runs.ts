import { BrowserWindow } from 'electron'
import { stepped, STOPPED, type AgentEvent, type AgentOrigin } from '../../../shared/agent/agent'
import { mask } from '../../../shared/agent/transcript'
import type { Place } from '../../../shared/agent/asking'
import { noteRequest, noteRun } from './record'
import { knownSecrets } from './settings'

// The runs in flight: each can be stopped, and what each does is told to every window and kept while
// it runs, so its exchange can be filed with what it did.

/** What a run can be told, and what it tells: one entry per run in flight. */
export interface Live {
  runId: string
  origin: AgentOrigin
  controller: AbortController
  /** The name the window that sent it gave it. */
  ask?: string
  /** For a loop's own run: the chat it is on, the loop, and the tile its events and its asks show on. */
  tile?: Tile
}

/** What a run for a loop is on. The place moves when its tile goes and its loop has another. */
export interface Tile {
  chat: string
  loop: string
  place: Place
}

const live = new Map<string, Live>()
/** What each run in flight was asked, by run: what a question of its is said to be about. */
const requests = new Map<string, string>()
/** What each run in flight has done so far, as its status said it: what its exchange is filed with. */
const trails = new Map<string, string[]>()
let runSeq = 0
/** How much of a request a question carries to say whose it is. */
const ABOUT_MAX = 120

/** Sends one event to every window. Showing only: a window that misses one is less informed, nothing more. */
export function emit(event: AgentEvent): void {
  if (live.has(event.runId)) trails.set(event.runId, stepped(trails.get(event.runId) ?? [], event))
  noteRun(event)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('agent:event', event)
  }
}

/**
 * What happens to a run, said as it happens: in the log and on the status line of whoever watches,
 * in the same words. A run that is waited out, cut off, made shorter, or waiting on a build says so,
 * rather than standing still while only the log knows why.
 */
export function telling(runId: string, log: (line: string) => void): (line: string) => void {
  return (line) => {
    log(line)
    emit({ kind: 'status', runId, line })
  }
}

/** Raised when the user asked the run to stop. Not an error: nothing went wrong. */
export class Stopped extends Error {
  constructor() {
    super(STOPPED)
  }
}

/**
 * Registers a run, so it can be stopped and so what it does can be watched. `request` is what it was
 * asked, for Eye and for a question of its to name. `ask` is the name the window that sent it gave it,
 * said back as it begins. `tile` is what a loop's own run is on, said as it begins too.
 */
export function begin(
  origin: AgentOrigin,
  workspaceId: string,
  label: string,
  request: string,
  ask?: string,
  tile?: Tile,
): Live {
  const runId = `run${++runSeq}`
  const entry: Live = {
    runId,
    origin,
    controller: new AbortController(),
    ...(ask === undefined ? {} : { ask }),
    ...(tile ? { tile } : {}),
  }
  live.set(runId, entry)
  requests.set(runId, request)
  // Before the start event, which is what tells Eye a run began.
  noteRequest(runId, origin, request)
  emit({
    kind: 'start',
    runId,
    origin,
    workspaceId,
    label,
    ...(ask === undefined ? {} : { ask }),
    ...(tile ? shownOn(tile, request) : {}),
  })
  return entry
}

export function end(entry: Live): void {
  live.delete(entry.runId)
  requests.delete(entry.runId)
  trails.delete(entry.runId)
}

/** What a run in flight has done so far, a line a step, as the chat showed them. */
export function stepsOf(runId: string): string[] {
  return trails.get(runId) ?? []
}

/**
 * What a question from this run is about: the user's request it is working on, its first line, any
 * key the app holds masked out of it. Only in the global box, and only while another of the user's
 * requests works there beside it, since the user reads one question at a time in a place and has to
 * tell whose it is; alone there, nothing. A tile's run asks in its tile, which says whose it is.
 */
export function askedBy(runId: string): string | undefined {
  const entry = live.get(runId)
  if (entry?.origin !== 'user' || entry.tile) return undefined
  const beside = [...live.values()].some((one) => one !== entry && one.origin === 'user' && !one.tile)
  if (!beside) return undefined
  const asked = mask(requests.get(runId) ?? '', knownSecrets()).trim()
  const line = asked.split('\n')[0] ?? ''
  return line.length > ABOUT_MAX ? `${line.slice(0, ABOUT_MAX)}…` : line || undefined
}

/**
 * A run's end, told the way every run's is: done with its reply, stopped when the user stopped it,
 * failed with its message; and struck off the runs in flight either way. A stop is rethrown as the
 * plain stopping message, so whoever asked shows that rather than the provider's aborted fetch.
 */
export function ended(entry: Live, work: Promise<string>): Promise<string> {
  return work
    .then((reply) => {
      emit({ kind: 'done', runId: entry.runId, text: reply })
      return reply
    })
    .catch((err: unknown) => {
      if (isStopped(entry, err)) {
        emit({ kind: 'stopped', runId: entry.runId })
        throw new Error(STOPPED)
      }
      emit({ kind: 'failed', runId: entry.runId, message: err instanceof Error ? err.message : String(err) })
      throw err
    })
    .finally(() => end(entry))
}

/**
 * Whether this ended because the user stopped it. The signal is what says so: an aborted fetch is
 * reported with the provider's name in front of it ("Custom: Stopped."), and a tool may fail in its
 * own words, so matching on the message would miss both.
 */
export function isStopped(entry: Live, error: unknown): boolean {
  return entry.controller.signal.aborted || error instanceof Stopped
}

/** Stops one run, or every run, as the user asks. Answers whether anything was running. */
export function stop(runId?: string): boolean {
  const entries = runId ? [live.get(runId)].filter((one) => one !== undefined) : [...live.values()]
  for (const entry of entries) entry.controller.abort(new Stopped())
  return entries.length > 0
}

/** Stops the run begun under the name a window gave its request. Answers whether there was one. */
export function stopAsked(ask: string): boolean {
  const entry = [...live.values()].find((one) => one.ask === ask)
  entry?.controller.abort(new Stopped())
  return entry !== undefined
}

/**
 * The runs in flight, for a window that opened partway through one: each with the name it was sent
 * under, and a loop's with where it shows and what was asked.
 */
export function running(): {
  runId: string
  origin: AgentOrigin
  ask?: string
  workspaceId?: string
  loop?: string
  on?: string
  request?: string
}[] {
  return [...live.values()].map(({ runId, origin, ask, tile }) => ({
    runId,
    origin,
    ...(ask === undefined ? {} : { ask }),
    ...(tile ? shownOn(tile, requests.get(runId) ?? '') : {}),
  }))
}

/** Where a loop's run shows and what it was asked, any key the app holds masked out of it. */
function shownOn(tile: Tile, request: string): { workspaceId: string; loop: string; on: string; request: string } {
  return { ...tile.place, loop: tile.loop, request: mask(request, knownSecrets()) }
}

/** Whether a loop has a run in flight: what its status is read off. */
export function workingOn(workspaceId: string, loop: string): boolean {
  return [...live.values()].some((one) => one.tile?.loop === loop && one.tile.place.workspaceId === workspaceId)
}

/** Stops every run in flight on one chat: a loop's, when the loop is gone. */
export function stopChat(chat: string): void {
  for (const entry of live.values()) if (entry.tile?.chat === chat) entry.controller.abort(new Stopped())
}
