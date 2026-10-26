// The extension is explicit because Node's test runner resolves this import at run time.
import { onScreen, type Asking } from '../../../shared/agent/asking.ts'
import type { Question } from '../../../shared/state'

export type { Asking }

/** How long an unattended question (from a scheduled task's run) waits before the assistant carries on without an answer. */
export const QUESTION_WAIT_MS = 10 * 60 * 1000

/** Runs in flight in which the user has already answered a question without refusing. */
const answeredRuns = new Set<string>()
const REFUSAL_ANSWER = /^(?:no|nope|cancel|stop|don'?t|do\s+not|never\s*mind)\.?$/i

/** Records that the user answered a question in this run, so a follow-up create_loop does not ask again. */
export function noteAnswered(runId: string, answer = 'Start'): void {
  const trimmed = answer.trim()
  if (!trimmed || REFUSAL_ANSWER.test(trimmed)) answeredRuns.delete(runId)
  else answeredRuns.add(runId)
}

/** Whether the user has already answered a question in this run. */
export function answeredIn(runId: string): boolean {
  return answeredRuns.has(runId)
}

/** Clears the run's answered state when the run ends. */
export function clearAnswered(runId: string): void {
  answeredRuns.delete(runId)
}

/** What ask_user says when there is no answer. Ten minutes with nobody answering is not the user closing it. */
export function unanswered(ended: Extract<Asking, { answer: null }>['ended']): string {
  switch (ended) {
    case 'closed':
      return 'The user closed the question without answering. Carry on with what you have, or say what you need.'
    case 'timeout':
      return 'Nobody answered within ten minutes; the user may be away, and did not close it. Carry on with what you have, and in your reply say what you assumed, as the question still open, never as something the user chose.'
    case 'stopped':
      return 'The run was stopped while the question was up.'
  }
}

/**
 * What a tool says when what it asked to go ahead with was not approved: a no is final for the
 * request, and a question nobody answered in ten minutes is not a no, so it says to tell the user
 * it is waiting on them rather than that they refused.
 */
export function notApproved(what: string, outcome: string, asked: Asking): string {
  if (asked.answer === null && asked.ended === 'timeout') {
    return `Nobody answered the question about ${what} within ten minutes, so ${outcome}. The user did not refuse; they may be away. Say it is waiting on their approval and that they can ask for it again.`
  }
  return `The user did not approve ${what}, so ${outcome}. Leave it; do not ask again in other words.`
}

/**
 * The questions the assistant is waiting on. A question is asked in a place, a tile's box or the
 * global box, and the user reads one at a time in a place: the one that has waited longest there is
 * on screen and the rest wait behind it. A question in the user's own run waits until it is
 * answered, closed with nothing said, or its run is stopped; one from a scheduled task's run
 * (`unattended`), where nobody may be at the computer, waits ten minutes and no longer.
 *
 * `show` is told what is on screen whenever that changes; main puts it in the tree. Nothing here
 * reads the tree or the clock but through `setTimeout`, so the whole of it is read in a test.
 */
export function createQuestions(show: (heads: Question[]) => void, waitMs = QUESTION_WAIT_MS) {
  /** Answers waiting on a question, by its id. */
  const answering = new Map<string, (asked: Asking) => void>()
  /** The questions not yet answered, in the order asked, and which have been drawn in their tile. */
  const asking: { question: Question; seen: boolean }[] = []
  /** What is on screen now. */
  let heads: Question[] = []
  let seq = 0

  /** Puts on screen the question that has waited longest in each place. */
  function showNext(): void {
    const next = onScreen(asking.map((one) => one.question))
    const was = heads
    if (next.length === was.length && next.every((one, at) => one.id === was[at]!.id)) return
    heads = next
    show(next)
  }

  /** As `ask`, and says why there is no answer when there is none. */
  function askFor(asked: Omit<Question, 'id'>, signal?: AbortSignal, unattended = false): Promise<Asking> {
    const id = `q${++seq}`
    const question: Question = { id, ...asked }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const finish = (ended: Asking): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', stopped)
        answering.delete(id)
        const at = asking.findIndex((one) => one.question.id === id)
        if (at !== -1) asking.splice(at, 1)
        showNext()
        resolve(ended)
      }
      // A run the user stopped takes its question with it, rather than leaving it for nobody.
      const stopped = (): void => finish({ answer: null, ended: 'stopped' })
      signal?.addEventListener('abort', stopped, { once: true })
      answering.set(id, finish)
      asking.push({ question, seen: false })
      if (unattended) {
        timer = setTimeout(() => finish({ answer: null, ended: 'timeout' }), waitMs)
      }
      showNext()
    })
  }

  return {
    /**
     * Asks one and waits: its answer, or null when it was closed, its time ran out, or its run was
     * stopped. `unattended` is a run nobody is at, a task's: its wait is bounded, since a tile
     * nobody looks at would otherwise hold the task's run, and whatever waits behind it, for good.
     */
    ask(asked: Omit<Question, 'id'>, signal?: AbortSignal, unattended = false): Promise<string | null> {
      return askFor(asked, signal, unattended).then((one) => one.answer)
    },

    askFor,

    /** The user's answer to the one with that id, or nothing when they closed it. */
    answer(id: string, text: string): void {
      const waiting = answering.get(id)
      if (!waiting) return
      const said = text.trim()
      waiting(said ? { answer: said } : { answer: null, ended: 'closed' })
    },

    /** A tile's box has drawn the question with that id. Answers whether it was drawn for the first time. */
    seen(id: string): boolean {
      const entry = asking.find((one) => one.question.id === id)
      if (!entry || entry.seen) return false
      entry.seen = true
      return true
    },
  }
}
