import type { Citation, Turn } from '../llm/llm'
import { stripSkillContent } from '../skills/skills.ts'
import { writtenPart } from './typed.ts'
import { WELCOME_NOTE } from './welcome.ts'

// The conversation as the user saw it, for the answer box: each question as it was typed and the reply
// that ended its run, and what a scheduled task said on its own. A thread holds more than was ever on
// screen: the tool calls and their results, what the model said before calling a tool (the box drops
// that when the next round starts), and the skill a /name loaded. None of it goes back to the box.
// What does go back with a reply is the sources it cites, which its turn has kept since it was said.
//
// An exchange is read off a thread once, when it is over, and filed in the chat's log; the chat is
// read from the log after that, since a thread holds only the last few and the log holds them all.

/**
 * A question and the reply that ended its run; or a reply nobody asked for, and no question: a
 * scheduled task's, with `task`, or a message of the welcome after setup, with `welcome`.
 */
export interface Exchange {
  /**
   * Where the chat's log holds it, which is what a reader asks for the ones before it by. One read
   * off a thread has none.
   */
  id?: number
  question: string
  answer: string
  /** The scheduled task whose run said the answer, like t3. */
  task?: string
  /** Said on its own to welcome the user after setup. */
  welcome?: true
  /** The sources the answer cites as `[^id]`, in the order it first does. Left out when it cites none. */
  citations?: Citation[]
  /** What its run did, as the status line said it, in order. Left out when the log holds none: one filed before the log kept them, or said unasked. */
  steps?: string[]
  /** Why its run failed, when it did: the answer is then empty, and the thread ends the run on why. */
  error?: string
}

/** What ends the thread of a run the user stopped, in the assistant's place: it is the whole of that exchange's answer. */
export const STOPPED_NOTE = '(Stopped by the user before this was finished.)'

/**
 * What ends the thread of a run the app closed under, in the assistant's place. A thread is kept as
 * each turn joins it, closed off with this, so it is only ever read where the run never got to its end.
 */
export const CLOSED_NOTE = '(The app closed before this was finished.)'

/** What ends the thread of a run that failed, in the assistant's place: why, as the chat said it. */
export function failedNote(error: string): string {
  return `(Failed before this was finished: ${error.replace(/[.\s]+$/, '')}.)`
}

/** How an exchange's run ended, for a timeline: it failed, the user stopped it, or it answered. */
export function endedAs(exchange: Exchange): 'answered' | 'failed' | 'stopped' {
  if (exchange.error) return 'failed'
  return exchange.answer.trim() === STOPPED_NOTE ? 'stopped' : 'answered'
}

/**
 * The turn in front of a task's reply in a workspace's thread. The reply is the assistant's own turn,
 * since the assistant said it on the task's run; this says where it came from, the way a summary's
 * note does, and is the only part in the user's place. A user's turn is what the user typed, and a
 * task's words must never pass for that.
 */
export function taskNote(task: string): string {
  return `(Scheduled task ${task} ran on its own, and the reply below is what it said in the chat.)`
}

const TASK_NOTE = /^\(Scheduled task (t\d+) ran on its own, and the reply below is what it said in the chat\.\)$/

/**
 * The last `limit` exchanges in a thread, oldest first. A question with no reply is left out: its run
 * is still going, or it answered with nothing, which the box never showed either. Every value in
 * `secrets` is masked, since a key the user pasted into the chat for `set_secret` stays in the turn
 * that carried it, and a source's words are masked by the same rule as the reply that cites them.
 */
export function transcript(turns: Turn[], limit: number, secrets: string[] = []): Exchange[] {
  const exchanges: Exchange[] = []
  for (const [at, turn] of turns.entries()) {
    // What the user added while a run was at work is read with that round's results: it belongs to
    // the exchange in progress, which its first message began and the run's reply ends.
    if (added(turns, at)) continue
    if (turn.role === 'user') {
      const task = TASK_NOTE.exec(turn.text)?.[1]
      exchanges.push(
        task
          ? { question: '', answer: '', task }
          : turn.text === WELCOME_NOTE
            ? { question: '', answer: '', welcome: true }
            : { question: typed(turn.text), answer: '' },
      )
    } else if (turn.role === 'assistant' && exchanges.length > 0) {
      // The reply that ends the run is the last one written here, and only it has sources to show.
      const exchange = exchanges[exchanges.length - 1]!
      exchange.answer = turn.text
      exchange.citations = turn.citations
    }
  }
  return exchanges
    .filter((exchange) => exchange.answer.trim() !== '')
    .slice(-limit)
    .map((exchange) => maskExchange(exchange, secrets))
}

/**
 * Whether the turn at `at` is one the user added to a run at work: a user turn after a round's
 * results. Several may be added in one round, one after another, and each is one.
 */
export function added(turns: Turn[], at: number): boolean {
  if (turns[at]!.role !== 'user') return false
  let before = at - 1
  while (before >= 0 && turns[before]!.role === 'user') before--
  return turns[before]?.role === 'tool'
}

/**
 * The exchange a thread ends on, as the chat showed it, which is what the chat's log is handed when a
 * run is over or something was said unasked. Null when the last run said nothing: the chat showed
 * nothing for it, and the exchange before it is in the log already.
 */
export function lastExchange(turns: Turn[], secrets: string[] = []): Exchange | null {
  let from = turns.length - 1
  while (from >= 0 && (turns[from]!.role !== 'user' || added(turns, from))) from--
  return from < 0 ? null : (transcript(turns.slice(from), 1, secrets)[0] ?? null)
}

/**
 * An exchange with every secret value taken out of its words and its sources' words, and nothing in
 * it that it does not have: one the log holds keeps its `id`, and a key saved since it was filed is
 * masked in it all the same.
 */
export function maskExchange(
  { id, question, answer, task, welcome, citations, steps, error }: Exchange,
  secrets: string[],
): Exchange {
  return {
    ...(id === undefined ? {} : { id }),
    question: mask(question, secrets),
    answer: mask(answer, secrets),
    ...(task ? { task } : {}),
    ...(welcome ? { welcome } : {}),
    ...(citations?.length ? { citations: citations.map((one) => maskCitation(one, secrets)) } : {}),
    ...(steps?.length ? { steps: steps.map((one) => mask(one, secrets)) } : {}),
    ...(error ? { error: mask(error, secrets) } : {}),
  }
}

/**
 * The chat on screen once its end has been read again: what was read, under whatever was already up
 * ahead of it. A reader may have gone back through pages of it, and a reply landing at the end must
 * not take those away. What was up is kept only where the two meet, at the first exchange read; with
 * nothing in common it is another chat, or this one moved on by more than a page, and what was read
 * stands alone.
 */
export function rejoin(up: Exchange[], read: Exchange[]): Exchange[] {
  const first = read[0]?.id
  if (first === undefined) return read
  const at = up.findIndex((one) => one.id === first)
  return at > 0 ? [...up.slice(0, at), ...read] : read
}

/**
 * What a turn asked, as the chat shows it. A request handed to a piece of work shows as what the
 * assistant wrote for that work; a /name turn is a line saying what was run, then the skill it loaded.
 */
function typed(text: string): string {
  // With the skills taken out first: a skill whose own text carries the handoff's line is not a handoff.
  return (
    writtenPart(stripSkillContent(text)) ?? /^The user ran (\/[\s\S]*?)\.\n\n<skill_content\b/.exec(text)?.[1] ?? text
  )
}

/** A source with every secret value taken out of what it says. Its id stays: the reply's markers name it. */
function maskCitation({ id, title, url, quote }: Citation, secrets: string[]): Citation {
  return {
    id,
    title: mask(title, secrets),
    ...(url === undefined ? {} : { url: mask(url, secrets) }),
    ...(quote === undefined ? {} : { quote: mask(quote, secrets) }),
  }
}

/** The text with every secret value taken out, by the rule a server's error is scrubbed by. */
/** Every secret's value in the text, when it is long enough to be one, replaced with three stars. */
export function mask(text: string, secrets: string[]): string {
  let out = text
  for (const value of secrets) {
    if (value.length >= 4) out = out.split(value).join('***')
  }
  return out
}
