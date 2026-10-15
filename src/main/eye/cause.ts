import { AsyncLocalStorage } from 'node:async_hooks'

// What a change of the tree came from: the action a window dispatched, or the run of the agent at
// work. Both are async, and a change can land several awaits after either began, so the answer rides
// the async context rather than a variable someone has to remember to set and clear.

interface Cause {
  /** The id of the action being handled. */
  cause?: string
  /** The run whose loop is at work. */
  run?: string
}

const store = new AsyncLocalStorage<Cause>()

/** `fn` and whatever it starts, under an action's id. */
export function withCause<T>(cause: string, fn: () => T): T {
  return store.run({ cause }, fn)
}

/** `fn` and whatever it starts, as the run's. A run an action started is the run's from then on, not the action's. */
export function withRun<T>(run: string, fn: () => T): T {
  return store.run({ run }, fn)
}

/** Whose work this is, as far as anyone said. */
export function currentCause(): Cause {
  return store.getStore() ?? {}
}
