// One at a time. A loop's agent works on one request while the next waits its turn, in the order
// they were sent. One still waiting can be called off, by the name its window gave it, or taken by
// the one at work: a job may say something as it joins the line, and the run in flight takes what
// the waiting ones say and acts on it, so they never begin.
//
// A job that waited begins when the one before it ends, and would otherwise begin inside that one's
// async context: what a task's run may not do (ask for a key) would follow the line into the user's
// own request behind it. So each job is bound to the context it was sent in.

import { AsyncLocalStorage } from 'node:async_hooks'

export interface Turns {
  /**
   * Runs `job` once every job taken before it under the same key is over. One called off before its
   * turn answers `off` and never runs. `says` is what it has for the one at work, should that one
   * take it while it waits.
   */
  take<T>(key: string, name: string | undefined, job: () => Promise<T>, off: T, says?: unknown): Promise<T>
  /** Calls off the job waiting under this name. False when none is: it has begun, or was never taken. */
  callOff(name: string): boolean
  /**
   * Takes, in the order they were sent, what every job still waiting under a key says, for the one
   * running to act on: each is called off, and answers `off`. One that says nothing keeps its place.
   */
  takeWaiting<P>(key: string): P[]
  /** Calls off every job still waiting under a key. The one running is not this module's to stop. */
  clear(key: string): void
}

interface Waiting {
  name: string | undefined
  begin: () => void
  off: () => void
  /** What it has for the one at work; undefined when it says nothing. */
  says: unknown
}

export function createTurns(): Turns {
  /** By key, the jobs waiting behind the one that is running. A key is here for as long as one is. */
  const lines = new Map<string, Waiting[]>()
  const next = (key: string): void => {
    const entry = lines.get(key)?.shift()
    if (entry) entry.begin()
    else lines.delete(key)
  }
  return {
    take<T>(key: string, name: string | undefined, job: () => Promise<T>, off: T, says?: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const begin = (): void => {
          // A job that throws before it has a promise to give ends its turn like one that rejects.
          let running: Promise<T>
          try {
            running = job()
          } catch (error) {
            running = Promise.reject(error)
          }
          running.then(resolve, reject).finally(() => next(key))
        }
        const line = lines.get(key)
        if (line) line.push({ name, begin: AsyncLocalStorage.bind(begin), off: () => resolve(off), says })
        else {
          lines.set(key, [])
          begin()
        }
      })
    },
    callOff(name) {
      for (const line of lines.values()) {
        const at = line.findIndex((one) => one.name === name)
        if (at === -1) continue
        line.splice(at, 1)[0]!.off()
        return true
      }
      return false
    },
    takeWaiting<P>(key: string): P[] {
      const line = lines.get(key)
      if (!line) return []
      const taken = line.filter((one) => one.says !== undefined)
      // In place: the line is the one `next` reads.
      for (const one of taken) line.splice(line.indexOf(one), 1)
      for (const one of taken) one.off()
      return taken.map((one) => one.says as P)
    },
    clear(key) {
      for (const one of lines.get(key)?.splice(0) ?? []) one.off()
    },
  }
}
