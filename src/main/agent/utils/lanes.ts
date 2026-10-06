import { canStart } from '../../../shared/agent/queue'

/** Background runs waiting for room, the one that has waited longest first. */
const waiting: (() => void)[] = []
let running = 0

/**
 * Runs `work` when there is room among the background runs: a scheduled task's, the welcome's. They
 * are limited so a burst of due tasks cannot fan out. The user's request does not come through here:
 * it starts as it is sent.
 */
export function inBackground<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiting.push(() => {
      running++
      void Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          running--
          pump()
        })
    })
    pump()
  })
}

/** Starts whatever can start, in the order it came. */
function pump(): void {
  while (waiting.length > 0 && canStart(running)) waiting.shift()?.()
}
