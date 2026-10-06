// The extension is explicit because Node's test runner resolves this import at run time.
import { onScreen } from '../../../shared/agent/asking.ts'
import type { Question } from '../../../shared/state'

/** How long a question waits before the assistant carries on without an answer. */
export const QUESTION_WAIT_MS = 10 * 60 * 1000

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
  const answering = new Map<string, (answer: string | null) => void>()
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

  return {
    /**
     * Asks one and waits: its answer, or null when it was closed, its time ran out, or its run was
     * stopped. `unattended` is a run nobody is at, a task's: its wait begins as it is asked, since a
     * tile nobody looks at would otherwise hold the run, and whatever waits behind it, for good.
     */
    ask(asked: Omit<Question, 'id'>, signal?: AbortSignal, unattended = false): Promise<string | null> {
      const id = `q${++seq}`
      const question: Question = { id, ...asked }
      return new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined
        const finish = (answer: string | null): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', stopped)
          answering.delete(id)
          const at = asking.findIndex((one) => one.question.id === id)
          if (at !== -1) asking.splice(at, 1)
          showNext()
          resolve(answer)
        }
        // A run the user stopped takes its question with it, rather than leaving it for nobody.
        const stopped = (): void => finish(null)
        signal?.addEventListener('abort', stopped, { once: true })
        answering.set(id, finish)
        const wait = (): boolean => {
          if (timer !== undefined) return false
          timer = setTimeout(() => finish(null), waitMs)
          return true
        }
        asking.push({ question, wait })
        if (unattended) wait()
        showNext()
      })
    },

    /** The user's answer to the one with that id, or nothing when they closed it. */
    answer(id: string, text: string): void {
      const waiting = answering.get(id)
      if (!waiting) return
      waiting(text.trim() || null)
    },

    /** A tile's box has drawn the question with that id: its wait begins. Answers whether it began now. */
    seen(id: string): boolean {
      return asking.find((one) => one.question.id === id)?.wait() ?? false
    },
  }
}
