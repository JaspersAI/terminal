// The extension is explicit because Node's test runner resolves this import at run time.
import { onScreen, type Asking } from '../../../shared/agent/asking.ts'
import type { Question } from '../../../shared/state'

export type { Asking }

/** How long a question waits before the assistant carries on without an answer. */
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
 * on screen and the rest wait behind it, each starting its ten minutes when it is shown. It ends
 * answered, closed with nothing said, timed out, or with its run when the user stops that.
 *
 * The global box draws what is on screen at once, so its question's wait is from then. A tile may be
 * on a workspace that is not on screen, in a window that is closed, or under a maximized element, and
 * only the window knows: a tile's question begins its wait when its box says it has drawn it (`seen`),
 * and until then waits for as long as it takes to be looked at.
 *
 * `show` is told what is on screen whenever that changes; main puts it in the tree. Nothing here
 * reads the tree or the clock but through `setTimeout`, so the whole of it is read in a test.
 */
export function createQuestions(show: (heads: Question[]) => void, waitMs = QUESTION_WAIT_MS) {
  /** Answers waiting on a question, by its id. */
  const answering = new Map<string, (asked: Asking) => void>()
  /** The questions not yet answered, in the order asked, each with what begins its wait: once, whoever says so again. */
  const asking: { question: Question; wait: () => boolean }[] = []
  /** What is on screen now. */
  let heads: Question[] = []
  let seq = 0

  /** Puts on screen the question that has waited longest in each place, and starts the wait of one that was not there before. */
  function showNext(): void {
    const next = onScreen(asking.map((one) => one.question))
    const was = heads
    if (next.length === was.length && next.every((one, at) => one.id === was[at]!.id)) return
    heads = next
    show(next)
    for (const one of asking) {
      const shown = next.includes(one.question) && !was.some((had) => had.id === one.question.id)
      if (shown && one.question.place === undefined) one.wait()
    }
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
      const wait = (): boolean => {
        if (timer !== undefined) return false
        timer = setTimeout(() => finish({ answer: null, ended: 'timeout' }), waitMs)
        return true
      }
      asking.push({ question, wait })
      if (unattended) wait()
      showNext()
    })
  }

  return {
    /**
     * Asks one and waits: its answer, or null when it was closed, its time ran out, or its run was
     * stopped. `unattended` is a run nobody is at, a task's: its wait begins as it is asked, since a
     * tile nobody looks at would otherwise hold the run, and whatever waits behind it, for good.
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

    /** A tile's box has drawn the question with that id: its wait begins. Answers whether it began now. */
    seen(id: string): boolean {
      return asking.find((one) => one.question.id === id)?.wait() ?? false
    },
  }
}
