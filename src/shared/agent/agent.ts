// What a run says about itself while it happens. The reply still comes back from `agent:run`; these
// are for showing, never for driving, so a window that misses one is only less informed.
//
// No Node and no DOM: main sends these, preload carries them, the composer reads them.

import type { Citation } from '../llm/llm'

/** Whose request a run is: the user's, a scheduled task's, or the welcome's after setup. */
export type AgentOrigin = 'user' | 'task' | 'welcome'

export type AgentEvent =
  /**
   * A run beginning. `ask` is the name the window that sent the request gave it, so that window knows
   * which of its questions this run answers. A run for a loop says which, the tile it shows on, and
   * what was asked, so a box that did not send it can show it.
   */
  | {
      kind: 'start'
      runId: string
      origin: AgentOrigin
      workspaceId: string
      label: string
      ask?: string
      loop?: string
      on?: string
      request?: string
    }
  | { kind: 'round'; runId: string; round: number }
  /** A piece of the reply as it arrives, held a moment in main so this is words rather than tokens. A run that did not stream sends the whole of it as one. */
  | { kind: 'text'; runId: string; delta: string }
  | { kind: 'tool'; runId: string; name: string; summary: string }
  /**
   * What the model said before the calls of a round, whole, told once that reply is. A box that drew
   * the words as they arrived keeps them in the run's trail from here, ahead of those calls, and
   * starts the reply over for the next round's. The thread keeps them; a run's filed steps do not.
   */
  | { kind: 'said'; runId: string; text: string }
  /** The sources the reply that just ended the run points at, which its `[^id]` marks show; none, no event. */
  | { kind: 'citations'; runId: string; citations: Citation[] }
  /**
   * Something the run has to say for itself: which call it is writing, or that it is waiting to try
   * again. `again` is the line before it said again with more to it (a call still being written, and
   * for how long now): it takes that line's place rather than following it.
   */
  | { kind: 'status'; runId: string; line: string; again?: true }
  /** What the model is thinking as it thinks, its last whole sentence: how the run stands (`thought`), never a step. */
  | { kind: 'thinking'; runId: string; line: string }
  /**
   * The run took a message the user added while it was at work: it is now a turn of the run's thread,
   * read with the results of the round that was in flight. `ask` is the name the window that sent the
   * message gave it. Every key the app holds is masked out of `text`.
   */
  | { kind: 'steered'; runId: string; text: string; ask?: string }
  | { kind: 'done'; runId: string; text: string }
  | { kind: 'failed'; runId: string; message: string }
  | { kind: 'stopped'; runId: string }

/** How a message the user added to a run at work begins, as a step of its trail. */
export const ADDED = 'Added: '

/** What a run says while it waits on its model and has heard nothing of what the model thinks. */
export const THINKING = 'Thinking'

/**
 * The step a run's trail gains from something it said: a call it made, something that happened to it,
 * a message the user added. Being asked, thinking, and answering are how it stands (`thought`), and
 * no step.
 */
export function runLine(event: AgentEvent): string | null {
  switch (event.kind) {
    case 'tool':
      return event.summary
    case 'status':
      return event.line
    case 'steered':
      // Whole: it is the log's record of what was added, and a key in it is masked when the log is
      // read, which a cut through the key would defeat.
      return `${ADDED}${event.text.trim()}`
    default:
      return null
  }
}

/**
 * What a run's model is thinking, after something the run said: that it is, from the moment a round
 * asks it, then its thoughts as they come, and nothing once it has said or done anything or the run
 * is over. Its words arriving leave it standing, since the reply is not whole yet. It is the last
 * line a working run shows and never a step: a model thinks a great deal more than it does, and the
 * trail is for what was said and done.
 */
export function thought(was: string | null, event: AgentEvent): string | null {
  switch (event.kind) {
    case 'round':
      return THINKING
    case 'thinking':
      return event.line
    case 'start':
    case 'text':
    case 'citations':
      return was
    default:
      return null
  }
}

/** A tool call as a line a person reads. The names are the model's and read as themselves once the underscores are gone. */
export function toolWords(name: string): string {
  return name.replace(/_/g, ' ')
}

/** A model's words as a line of plain text: a line draws no markdown, so its marks go. */
export function plain(words: string): string {
  return words.replace(/[*#`]/g, '').trim()
}

/** How much of a run's trail the chat keeps: a builder's run is many steps, and the newest are the ones read. */
export const STEPS_MAX = 40

/** A trail with one more step at its end, and only the newest so many kept. A new list every time, for React. */
export function addStep(steps: string[], line: string): string[] {
  const next = [...steps, line]
  return next.length > STEPS_MAX ? next.slice(next.length - STEPS_MAX) : next
}

/**
 * A run's trail after something it said: the step that adds, if any. What happened to a run (waiting
 * to try again) said twice running is one line, while what it did is a step each time: two calls of
 * one tool are two calls. The chat's live rows and main's record of a run both go by this.
 */
export function stepped(steps: string[], event: AgentEvent): string[] {
  const line = runLine(event)
  if (!line) return steps
  // The line before it, said again with more to it, is one line.
  const said = event.kind === 'status' && event.again && steps.length > 0 ? steps.slice(0, -1) : steps
  return event.kind === 'status' && said[said.length - 1] === line ? said : addStep(said, line)
}

/** The stopping message, which is not an error: the user asked. */
export const STOPPED = 'Stopped.'
