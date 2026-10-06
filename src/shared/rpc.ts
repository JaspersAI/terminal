// One request-and-reply wire between two processes that share nothing but postMessage: main and a
// plugin's host. Either end can ask the other and be answered, send a notification nobody answers,
// and cancel a request it made, which reaches the other end as an AbortSignal. Pure: the port is
// anything that can post a message and hear one, so the tests run both ends over an in-memory pair.

export interface RpcPort {
  postMessage(message: unknown): void
  /** Calls `listener` with the data of every message that arrives. Returns a way to stop. */
  onMessage(listener: (data: unknown) => void): () => void
}

/** Answers one method. What it returns, or throws, goes back to whoever asked. */
export type RpcHandler = (params: unknown, signal: AbortSignal) => unknown

export interface Rpc {
  /** Asks the other end. Rejects with its error's message, or with the signal's reason once aborted. */
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>
  /** Tells the other end something without waiting for an answer. */
  notify(method: string, params?: unknown): void
  handle(method: string, handler: RpcHandler): void
  onNotification(method: string, listener: (params: unknown) => void): void
  /** Ends the wire: pending requests reject and running handlers are aborted, both with `reason`. */
  close(reason: string): void
}

/** The notification that cancels a request. Reserved on both ends. */
const ABORT = 'rpc.abort'

interface Waiting {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  /** Stops listening to the request's signal. */
  done: () => void
}

export function createRpc(port: RpcPort): Rpc {
  let nextId = 1
  let closed: string | null = null
  const pending = new Map<number, Waiting>()
  const running = new Map<number, AbortController>()
  const handlers = new Map<string, RpcHandler>()
  const listeners = new Map<string, (params: unknown) => void>()

  const stop = port.onMessage((data) => {
    if (closed !== null || !isRecord(data)) return
    const { id, method } = data
    if (typeof id === 'number' && typeof method === 'string') void serve(id, method, data['params'])
    else if (typeof id === 'number') settle(id, data)
    else if (typeof method === 'string') hear(method, data['params'])
  })

  async function serve(id: number, method: string, params: unknown): Promise<void> {
    const handler = handlers.get(method)
    if (!handler) {
      port.postMessage({ id, error: { message: `Unknown method ${method}.` } })
      return
    }
    const controller = new AbortController()
    running.set(id, controller)
    try {
      const result = await handler(params, controller.signal)
      if (closed === null) port.postMessage({ id, result: result === undefined ? null : result })
    } catch (err) {
      if (closed === null) port.postMessage({ id, error: { message: messageOf(err) } })
    } finally {
      running.delete(id)
    }
  }

  function settle(id: number, reply: Record<string, unknown>): void {
    const waiting = pending.get(id)
    if (!waiting) return
    pending.delete(id)
    waiting.done()
    const error = reply['error']
    if (isRecord(error))
      waiting.reject(new Error(typeof error['message'] === 'string' ? error['message'] : 'The other end failed.'))
    else waiting.resolve(reply['result'])
  }

  function hear(method: string, params: unknown): void {
    if (method === ABORT) {
      const cancel = isRecord(params) ? params : {}
      const reason = typeof cancel['reason'] === 'string' ? cancel['reason'] : 'aborted'
      if (typeof cancel['id'] === 'number') running.get(cancel['id'])?.abort(new Error(reason))
      return
    }
    // What a listener throws is its own bug; the wire keeps carrying everyone else's messages.
    try {
      listeners.get(method)?.(params)
    } catch (err) {
      console.error(`rpc: the ${method} listener failed: ${messageOf(err)}`)
    }
  }

  return {
    request(method, params, signal) {
      if (closed !== null) return Promise.reject(new Error(closed))
      if (signal?.aborted) return Promise.reject(reasonOf(signal))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          pending.delete(id)
          const reason = reasonOf(signal!)
          port.postMessage({ method: ABORT, params: { id, reason: reason.message } })
          reject(reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        const done = (): void => signal?.removeEventListener('abort', onAbort)
        pending.set(id, { resolve, reject, done })
        try {
          port.postMessage({ id, method, params: params === undefined ? null : params })
        } catch (err) {
          // Params that cannot cross (a function, a class instance) never left; nothing waits for them.
          pending.delete(id)
          done()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },

    notify(method, params) {
      if (closed !== null) return
      port.postMessage({ method, params: params === undefined ? null : params })
    },

    handle(method, handler) {
      handlers.set(method, handler)
    },

    onNotification(method, listener) {
      listeners.set(method, listener)
    },

    close(reason) {
      if (closed !== null) return
      closed = reason
      stop()
      for (const waiting of pending.values()) {
        waiting.done()
        waiting.reject(new Error(reason))
      }
      pending.clear()
      for (const controller of running.values()) controller.abort(new Error(reason))
      running.clear()
    },
  }
}

/** An aborted signal's reason as an error, whatever the one who aborted passed. */
function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : hasMessage(reason) ? reason.message : 'aborted')
}

/**
 * An error's message. Checked by shape, not instanceof: a plugin's code runs in a vm whose Error is
 * another realm's, and String() of one would put "Error: " in front of every message it sends.
 */
function messageOf(err: unknown): string {
  return hasMessage(err) ? err.message : String(err)
}

function hasMessage(value: unknown): value is { message: string } {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
