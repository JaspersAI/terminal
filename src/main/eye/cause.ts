import { AsyncLocalStorage } from 'node:async_hooks'

// What a change of the tree came from: the action a window dispatched, or the run of the agent at
// work. Both are async, and a change can land several awaits after either began, so the answer rides
// the async context rather than a variable someone has to remember to set and clear.
//
// The context also rides whatever the work starts and leaves behind: a timer it armed, a connection
// it opened. What those change long after is not the work's doing, so a cause counts only while its
// work is in flight, and is nothing once it has ended.

interface Cause {
  /** The id of the action being handled. */
  cause?: string
  /** The run whose loop is at work. */
  run?: string
}

const store = new AsyncLocalStorage<Cause>()
/** The actions and runs in flight, each with how many pieces of work are under it: the builder's loop runs under its user's run. */
const working = new Map<string, number>()

/** `fn` and whatever it starts, under an action's id, while it is handled. */
export function withCause<T>(cause: string, fn: () => T): T {
  return under({ cause }, cause, fn)
}

/** `fn` and whatever it starts, as the run's while it runs. A run an action started is the run's from then on, not the action's. */
export function withRun<T>(run: string, fn: () => T): T {
  return under({ run }, run, fn)
}

function under<T>(cause: Cause, id: string, fn: () => T): T {
  working.set(id, (working.get(id) ?? 0) + 1)
  const done = (): void => {
    const left = (working.get(id) ?? 1) - 1
    if (left > 0) working.set(id, left)
    else working.delete(id)
  }
  let result: T
  try {
    result = store.run(cause, fn)
  } catch (err) {
    done()
    throw err
  }
  if (result instanceof Promise) return result.finally(done) as T
  done()
  return result
}

/** Whose work this is, as long as that work is still in flight; nothing once it has ended. */
export function currentCause(): Cause {
  const cause = store.getStore()
  const id = cause?.run ?? cause?.cause
  return cause && id !== undefined && working.has(id) ? cause : {}
}
