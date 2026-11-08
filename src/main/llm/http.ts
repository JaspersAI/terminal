import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { retryAfter, SLEEP_INTERRUPTED_MESSAGE } from '../../shared/llm/limits.ts'
import type { Provider } from '../../shared/llm/providers'
import { SSE_DONE, sseFrames, sseTail } from '../../shared/llm/sse.ts'
import { WAKE_GRACE_MS } from '../../shared/tasks/tasks.ts'

/**
 * Who a request is to and how it leaves: the provider, for the words of an error, and the fetch it
 * goes out through, which sends as the Jaspers account for the Jaspers provider and plainly for
 * every other. A provider's config is one.
 */
export interface Wire {
  provider: Provider
  fetch: FetchLike
}

/**
 * A request to a provider that failed. The message is what the user reads; the status and the wait
 * are for a caller deciding whether to try again, which should not have to read them back out of words.
 */
export class ProviderError extends Error {
  /** The HTTP status, or null when the request never got an answer. */
  readonly status: number | null
  /** How long the provider asked to be left alone, from `retry-after`. */
  readonly retryAfterMs: number | null

  constructor(message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** POST to a provider and parse the JSON reply. Errors name the provider and carry whatever detail the response gave. */
export async function post<T>(
  { provider, fetch }: Wire,
  url: string,
  headers: Record<string, string>,
  body: string | Blob | FormData,
  timeoutMs = QUIET_MS,
  signal?: AbortSignal,
): Promise<T> {
  const sleep = new AbortController()
  const onSleep = (): void => sleep.abort(new Error(SLEEP_INTERRUPTED_MESSAGE))
  inFlight.add(onSleep)
  const limit = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any(signal ? [limit, sleep.signal, signal] : [limit, sleep.signal])
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: combined,
      })
    } catch (err) {
      throw new ProviderError(`${provider.name}: ${describe(err)}`)
    }
    if (!response.ok) throw await refused(provider, response)
    let text: string
    try {
      text = await response.text()
    } catch (err) {
      throw new ProviderError(`${provider.name}: ${describe(err)}`)
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ProviderError(`${provider.name} returned something other than JSON.`, response.status)
    }
  } finally {
    inFlight.delete(onSleep)
  }
}

/** A response that was not a success, as the error it is thrown as. */
async function refused(provider: Provider, response: Response): Promise<ProviderError> {
  const text = await response.text().catch(() => '')
  return new ProviderError(
    `${provider.name} returned ${response.status}: ${detail(text, response.status, response.statusText)}`,
    response.status,
    retryAfter(response.headers.get('retry-after'), Date.now()),
  )
}

/** "fetch failed" alone says nothing; the cause (ECONNREFUSED, timeout) is what the user needs. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message
}

const STATUS_DETAIL: Readonly<Record<number, string>> = {
  408: 'timed out',
  429: 'rate limited',
  500: 'server error',
  502: 'bad gateway',
  503: 'unavailable',
  504: 'timed out',
  520: 'unreachable',
  521: 'unreachable',
  522: 'timed out',
  523: 'unreachable',
  524: 'timed out',
  525: 'unreachable',
  526: 'unreachable',
  529: 'overloaded',
  530: 'unreachable',
}

function detail(text: string, status: number, statusText = ''): string {
  try {
    const raw: unknown = JSON.parse(text)
    const parsed = (Array.isArray(raw) ? raw[0] : raw) as
      { error?: { message?: string } | string; message?: string } | undefined
    const message = typeof parsed?.error === 'string' ? parsed.error : (parsed?.error?.message ?? parsed?.message)
    if (typeof message === 'string' && message.trim() && !/^\s*</.test(message)) return message.trim()
  } catch {
    // not JSON; fall through to the raw text
  }
  const trimmed = text.trim()
  // Cloudflare and nginx answer their own timeouts and limits with an HTML error page, which is not worth quoting.
  if (trimmed && !trimmed.startsWith('<') && !/<(!doctype|html|head|body)\b/i.test(trimmed)) {
    return trimmed.slice(0, 200)
  }
  if (STATUS_DETAIL[status]) return STATUS_DETAIL[status]
  const phrase = statusText.trim()
  if (phrase && phrase.toLowerCase() !== 'unknown') return phrase.toLowerCase()
  return status >= 500 ? 'server error' : 'no details'
}

/** How long a stream may go without its first `data:` frame before it is given up on. */
export const QUIET_MS = 300_000
/** How long a stream that has already sent `data:` frames may go silent between frames before it is given up on. */
export const STREAM_QUIET_MS = 90_000

const inFlight = new Set<() => void>()
const wakeListeners = new Set<() => void>()
let sleeping = false
let wakeUntil = 0

function abortInFlight(): void {
  for (const abort of [...inFlight]) abort()
}

function notifyWakeListeners(): void {
  for (const listener of [...wakeListeners]) listener()
}

/** Aborts in-flight provider streams when the machine suspends so dead sockets do not hang across sleep. */
export function suspendLlm(): void {
  sleeping = true
  abortInFlight()
  notifyWakeListeners()
}

/** Aborts pre-sleep provider streams on wake and holds off retries until `graceMs` has elapsed. */
export function wakeLlm(graceMs = WAKE_GRACE_MS): void {
  sleeping = false
  wakeUntil = Date.now() + Math.max(0, graceMs)
  abortInFlight()
  notifyWakeListeners()
}

export function isLlmSleeping(): boolean {
  return sleeping
}

/** Waits while the machine is sleeping or inside the post-wake network grace window. */
export function waitUntilLlmAwake(signal?: AbortSignal): Promise<void> {
  if (!sleeping && Date.now() >= wakeUntil) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'))
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      clearTimeout(timer)
      wakeListeners.delete(check)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(signal?.reason ?? new Error('Aborted'))
    }
    const check = (): void => {
      clearTimeout(timer)
      if (sleeping) return
      const remaining = wakeUntil - Date.now()
      if (remaining <= 0) {
        cleanup()
        resolve()
        return
      }
      timer = setTimeout(check, remaining)
    }
    wakeListeners.add(check)
    signal?.addEventListener('abort', onAbort, { once: true })
    check()
  })
}

/**
 * POST to a provider and read back a server-sent event stream, one payload at a time. The errors are
 * the same shape as `post`'s, since the failure a caller has to explain is the same one: a provider
 * that refused, with whatever it said about why.
 *
 * The limit is on the silence between `data:` pieces, not on the whole stream, which is the point of
 * streaming a long reply: a model that thinks for ten minutes and says so as it goes is working, and
 * one that has sent no `data:` frame for five minutes before starting (or ninety seconds mid-stream,
 * even if a proxy sends keep-alive comments) is not. A caller that stops reading (a `break`, or an
 * error thrown at it) cancels the body.
 */
export async function* sse(
  { provider, fetch }: Wire,
  url: string,
  headers: Record<string, string>,
  body: string,
  quietMs = QUIET_MS,
  signal?: AbortSignal,
  streamQuietMs = STREAM_QUIET_MS,
): AsyncGenerator<string> {
  const quiet = new AbortController()
  const onSleep = (): void => quiet.abort(new Error(SLEEP_INTERRUPTED_MESSAGE))
  inFlight.add(onSleep)
  let timer: NodeJS.Timeout | undefined
  let currentLimit = quietMs
  let heardAt = Date.now()
  let lastTick = heardAt
  const heard = (limitMs = currentLimit): void => {
    currentLimit = limitMs
    heardAt = Date.now()
    lastTick = heardAt
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (Date.now() - heardAt >= currentLimit + WAKE_GRACE_MS) {
        wakeLlm()
        quiet.abort(new Error(SLEEP_INTERRUPTED_MESSAGE))
        return
      }
      quiet.abort(new Error(`nothing arrived for ${Math.round(currentLimit / 1000)} s`))
    }, currentLimit)
  }
  heard(quietMs)
  const watch =
    quietMs > WAKE_GRACE_MS
      ? setInterval(() => {
          const now = Date.now()
          if (now - lastTick >= WAKE_GRACE_MS || now - heardAt >= currentLimit + WAKE_GRACE_MS) {
            wakeLlm()
            quiet.abort(new Error(SLEEP_INTERRUPTED_MESSAGE))
            return
          }
          lastTick = now
        }, 2_000).unref()
      : undefined
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, accept: 'text/event-stream' },
        body,
        signal: signal ? AbortSignal.any([quiet.signal, signal]) : quiet.signal,
      })
    } catch (err) {
      throw new ProviderError(`${provider.name}: ${describe(err)}`)
    }
    if (!response.ok) throw await refused(provider, response)
    if (!response.body) throw new ProviderError(`${provider.name} returned no body to read.`, response.status)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<string>
        try {
          if (quiet.signal.aborted) throw quiet.signal.reason
          chunk = await reader.read()
        } catch (err) {
          throw new ProviderError(`${provider.name}: ${describe(err)}`)
        }
        if (chunk.done) break
        buffer += chunk.value
        const { data, rest } = sseFrames(buffer)
        buffer = rest
        if (data.length > 0) heard(Math.min(quietMs, streamQuietMs))
        for (const payload of data) {
          if (payload === SSE_DONE) return
          yield payload
        }
      }
      const last = sseTail(buffer)
      if (last !== null && last !== SSE_DONE) yield last
    } finally {
      await reader.cancel().catch(() => {})
    }
  } finally {
    inFlight.delete(onSleep)
    clearTimeout(timer)
    clearInterval(watch)
  }
}
