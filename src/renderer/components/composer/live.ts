// The requests this window has sent that are still on its screen as it sent them: each a question,
// the trail of the run answering it, and the reply as it is written. Several can be working at once,
// since a request starts as it is sent. They stand in the order they were sent while they work, and
// one that ends goes under the ones that ended before it, so what is over reads in the order it ended,
// which is the order the chat's log keeps. Once one is over it is in that log, and the next read of
// the log takes its place here.
//
// Pure, so what an event or a reply does to the list is read in a test. A function that changes
// nothing hands back the list it was given, so React has nothing to draw.

// The extension is explicit because Node's test runner resolves this import at run time.
import { addStep, plain, stepped, thought, type AgentEvent } from '../../../shared/agent/agent.ts'
import type { Citation } from '../../../shared/agent/citations'

export interface LiveExchange {
  /** This window's own name for the request, given as it is sent. */
  ask: string
  /** Main's run of it, once main has said it began. */
  runId: string | null
  /** The workspace it was sent on, which is the one its run acts on. */
  workspaceId: string
  question: string
  /** The reply so far, or null while there is none. */
  answer: string | null
  /** The sources the reply cites, which main says once the reply is whole. */
  citations: Citation[]
  /**
   * What the run has done so far, as the status line would have said it, newest last, and among those
   * lines what its model said before each round of calls, which stays for as long as the run works.
   */
  steps: string[]
  /**
   * What its model is thinking, while the run waits on it: the last line the run shows, under its
   * steps. Null once the model has said or done anything, and before a round has asked it.
   */
  thinking: string | null
  /** Whether its run is still in flight. This says a run is over, never the text on screen. */
  working: boolean
  /** Why it failed. */
  error: string | null
  /**
   * Its box was dismissed from over it while it worked: it works on out of sight, where it does not
   * hold the composer up, and is in the conversation when that is brought up. It is back for good
   * when its reply lands, or when a request is sent beside it.
   */
  hidden: boolean
}

/**
 * The list with a request just sent at its end. Sending brings the box up, so whatever was working
 * on its workspace out of sight is back in the box beside it.
 */
export function sent(list: LiveExchange[], ask: string, workspaceId: string, question: string): LiveExchange[] {
  return [
    ...list.map((one) => (one.workspaceId === workspaceId && one.hidden ? { ...one, hidden: false } : one)),
    {
      ask,
      runId: null,
      workspaceId,
      question,
      answer: null,
      citations: [],
      steps: [],
      thinking: null,
      working: true,
      error: null,
      hidden: false,
    },
  ]
}

/** The list after something main said about a run. Another window's run, or a task's, changes nothing here. */
export function heard(list: LiveExchange[], event: AgentEvent): LiveExchange[] {
  if (event.kind === 'start') {
    if (event.ask === undefined) return list
    return change(
      list,
      (one) => one.ask === event.ask,
      (one) => ({ ...one, runId: event.runId }),
    )
  }
  // How a run ended comes back from the request itself.
  if (event.kind === 'done' || event.kind === 'failed' || event.kind === 'stopped') return list
  return change(
    list,
    (one) => one.runId === event.runId,
    (one) => {
      const thinking = thought(one.thinking, event)
      // The reply ended in calls: its words stay, as a step ahead of them, and the next round's reply
      // starts from nothing.
      if (event.kind === 'said') {
        const words = plain(event.text)
        return same(one, { answer: null, steps: words ? addStep(one.steps, words) : one.steps, thinking })
      }
      const steps = stepped(one.steps, event)
      // A round asked again starts its reply over: what got out of it is about to be said again.
      if (event.kind === 'round') return same(one, { answer: null, steps, thinking })
      if (event.kind === 'text') return { ...one, answer: (one.answer ?? '') + event.delta }
      if (event.kind === 'citations') return { ...one, citations: event.citations }
      return same(one, { answer: one.answer, steps, thinking })
    },
  )
}

/**
 * The list once a request's run has ended with its reply. A run that ends with nothing to say was
 * stopped: it goes, and the chat's log has what it got done.
 */
export function answered(list: LiveExchange[], ask: string, reply: string): LiveExchange[] {
  if (!reply) return list.filter((one) => one.ask !== ask)
  return ended(list, ask, (one) => ({ ...one, answer: reply, thinking: null, working: false, hidden: false }))
}

/** The list once a request's run has failed: the message sits under its question, with the trail above it. */
export function failed(list: LiveExchange[], ask: string, message: string): LiveExchange[] {
  return ended(list, ask, (one) => ({ ...one, thinking: null, working: false, error: message, hidden: false }))
}

/**
 * The list with one request over, under the ones that were over before it. How a run ended is the
 * newest thing said, whenever it was asked: a long run answered after shorter ones sent later lands
 * under them, where the reader is, and not above them out of sight. One with nothing over under it
 * stays where it is, and so does everything still working.
 */
function ended(list: LiveExchange[], ask: string, to: (one: LiveExchange) => LiveExchange): LiveExchange[] {
  const at = list.findIndex((one) => one.ask === ask)
  if (at === -1) return list
  const done = to(list[at]!)
  let under = list.length - 1
  while (under > at && list[under]!.working) under--
  return [...list.slice(0, at), ...list.slice(at + 1, under + 1), done, ...list.slice(under + 1)]
}

/**
 * The list once the box over a workspace's conversation is dismissed. What is over goes; what is still
 * working goes on out of sight, and comes back with its reply.
 */
export function dismissed(list: LiveExchange[], workspaceId: string): LiveExchange[] {
  const next = list
    .filter((one) => one.workspaceId !== workspaceId || one.working)
    .map((one) => (one.workspaceId === workspaceId && !one.hidden ? { ...one, hidden: true } : one))
  return next.length === list.length && next.every((one, index) => one === list[index]) ? list : next
}

/** The requests that are over, by name: what a read of the chat's log made now will hold, or what failed and has nothing to keep. */
export function over(list: LiveExchange[]): Set<string> {
  return new Set(list.filter((one) => !one.working).map((one) => one.ask))
}

/** The list without the requests named. */
export function without(list: LiveExchange[], asks: ReadonlySet<string>): LiveExchange[] {
  return list.some((one) => asks.has(one.ask)) ? list.filter((one) => !asks.has(one.ask)) : list
}

/** A workspace's requests as its conversation shows them. */
export function shownOn(list: LiveExchange[], workspaceId: string): LiveExchange[] {
  return list.filter((one) => one.workspaceId === workspaceId && !one.hidden)
}

/**
 * A workspace's requests working out of sight, their box dismissed from over them: what its
 * conversation shows under what was said, when the composer brings it up.
 */
export function awayOn(list: LiveExchange[], workspaceId: string): LiveExchange[] {
  return list.filter((one) => one.workspaceId === workspaceId && one.hidden)
}

/** Whether a workspace has a request still in flight, shown or not. */
export function workingOn(list: LiveExchange[], workspaceId: string): boolean {
  return list.some((one) => one.workspaceId === workspaceId && one.working)
}

/** An exchange with what a run's event left of its reply, its steps, and its thinking, or the exchange itself when that is what it had. */
function same(one: LiveExchange, to: Pick<LiveExchange, 'answer' | 'steps' | 'thinking'>): LiveExchange {
  const unchanged = to.answer === one.answer && to.steps === one.steps && to.thinking === one.thinking
  return unchanged ? one : { ...one, ...to }
}

/** The list with the first exchange that matches changed, or the list itself when nothing matches or nothing changes. */
function change(
  list: LiveExchange[],
  match: (one: LiveExchange) => boolean,
  to: (one: LiveExchange) => LiveExchange,
): LiveExchange[] {
  const at = list.findIndex(match)
  if (at === -1) return list
  const next = to(list[at]!)
  return next === list[at] ? list : list.map((one, index) => (index === at ? next : one))
}
