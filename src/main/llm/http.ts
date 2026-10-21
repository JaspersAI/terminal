import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { retryAfter } from '../../shared/llm/limits.ts'
import type { Provider } from '../../shared/llm/providers'
import { SSE_DONE, sseFrames, sseTail } from '../../shared/llm/sse.ts'

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
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response
  const limit = AbortSignal.timeout(timeoutMs)
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: signal ? AbortSignal.any([limit, signal]) : limit,
    })
  } catch (err) {
    throw new ProviderError(`${provider.name}: ${describe(err)}`)
  }
  if (!response.ok) throw await refused(provider, response)
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ProviderError(`${provider.name} returned something other than JSON.`, response.status)
  }
}

/** A response that was not a success, as the error it is thrown as. */
async function refused(provider: Provider, response: Response): Promise<ProviderError> {
  const text = await response.text().catch(() => '')
  return new ProviderError(
    `${provider.name} returned ${response.status}: ${detail(text)}`,
    response.status,
    retryAfter(response.headers.get('retry-after'), Date.now()),
  )
}

/** "fetch failed" alone says nothing; the cause (ECONNREFUSED, timeout) is what the user needs. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message
}

function detail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    const message = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message)
    if (message) return message
  } catch {
    // not JSON; fall through to the raw text
  }
  return text.slice(0, 200) || 'no details'
}

/** How long a stream may say nothing before it is given up on. */
const QUIET_MS = 5 * 60_000

/**
 * The same for a model on this computer (Ollama, LM Studio, a server of one's own on localhost). It
 * streams nothing while it loads and reads the request, and on a laptop a long request takes minutes
 * to read: a 27B model under Ollama took four minutes over 35k tokens, and the next, longer request
 * passed five before a word came. The machine is the user's own, and nothing is billed while it works.
 */
const LOCAL_QUIET_MS = 20 * 60_000

/** Whether a request goes to this computer itself. */
export function onThisComputer(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/** How long a stream to this address may say nothing. */
export function quietLimit(url: string): number {
  return onThisComputer(url) ? LOCAL_QUIET_MS : QUIET_MS
}

/**
 * POST to a provider and read back a server-sent event stream, one payload at a time. The errors are
 * the same shape as `post`'s, since the failure a caller has to explain is the same one: a provider
 * that refused, with whatever it said about why.
 *
 * The limit is on the silence between pieces, not on the whole stream, which is the point of
 * streaming a long reply: a model that thinks for ten minutes and says so as it goes is working, and
 * one that has sent nothing for five is not (twenty, for a model on this computer). A caller that stops reading (a `break`, or an error
 * thrown at it) cancels the body.
 */
export async function* sse(
  { provider, fetch }: Wire,
  url: string,
  headers: Record<string, string>,
  body: string,
  quietMs = quietLimit(url),
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const quiet = new AbortController()
  let timer: NodeJS.Timeout | undefined
  // On this computer, silence is most often the model still reading a long request, so the error
  // says what would make it answer sooner.
  const why = onThisComputer(url)
    ? '; a model on this computer says nothing while it reads the request, so a smaller model or a shorter conversation answers sooner'
    : ''
  const heard = (): void => {
    clearTimeout(timer)
    timer = setTimeout(
      () => quiet.abort(new Error(`nothing arrived for ${Math.round(quietMs / 1000)} s${why}`)),
      quietMs,
    )
  }
  heard()
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
          chunk = await reader.read()
        } catch (err) {
          throw new ProviderError(`${provider.name}: ${describe(err)}`)
        }
        if (chunk.done) break
        heard()
        buffer += chunk.value
        const { data, rest } = sseFrames(buffer)
        buffer = rest
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
    clearTimeout(timer)
  }
}
