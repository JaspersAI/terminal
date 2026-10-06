// Waiting on something the user may stop. Pure.

/** The work's result, or the abort's reason as soon as the caller gives up; the work itself runs on for anyone else waiting on it. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** Waits out `ms`, or ends with the abort's reason the moment the caller gives up. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return untilAborted(waited, signal).finally(() => clearTimeout(timer))
}
