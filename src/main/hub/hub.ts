import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { refusalMessage } from '../../shared/app/jaspers.ts'
import {
  hubUrl,
  readClaimed,
  readItemInfo,
  readItemList,
  readMe,
  readPublished,
  type HubItem,
  type HubItemInfo,
  type HubMe,
  type HubPublished,
} from '../../shared/hub/hub.ts'
import { retryAfter } from '../../shared/llm/limits.ts'
import { errorReason } from '../plugins/archive-fetch.ts'

// Jaspers Hub, from main. Its listings and its items are read by anyone, so they go out plainly.
// What Hub holds of the user, a handle claimed, and a version published go out as the account,
// through the fetch the caller hands in: jaspers.ts's asAccount, which adds the bearer. Every answer
// is read through src/shared/hub/; the renderer asks over IPC (hub-ipc.ts) and gets plain data. No
// Electron here, so a test runs it against a Hub of its own.

/**
 * Hub's address: the environment's, for development against a local run, else the public one. Read
 * once, as main loads: a wrong value stops the app here rather than reaching production unasked.
 */
const HUB = hubUrl(process.env['JASPERS_HUB_URL'])
const TIMEOUT_MS = 15_000
/** An archive up to Hub's limit takes a while to send on a slow line. */
const UPLOAD_TIMEOUT_MS = 2 * 60_000

/** Hub answered, and not with what was asked for. `said` is Hub's own words. */
export class HubError extends Error {
  readonly status: number
  readonly said: string
  /** How long Hub asked to be left alone, from `retry-after`. */
  readonly retryAfterMs: number | null

  constructor(status: number, said: string, retryAfterMs: number | null = null) {
    super(`Hub answered ${status}: ${said}`)
    this.name = 'HubError'
    this.status = status
    this.said = said
    this.retryAfterMs = retryAfterMs
  }
}

export function hubAddress(): string {
  return HUB
}

/** The plugins Hub's operator features, in their order. */
export async function featuredPlugins(timeoutMs = TIMEOUT_MS): Promise<HubItem[]> {
  const { items } = readItemList(
    await read(`/items?${new URLSearchParams({ kind: 'plugin', featured: 'true' })}`, timeoutMs),
  )
  // A Hub from before featuring ignores the query and lists everything, none of it marked.
  return items.filter((item) => item.featured)
}

/** One page of every plugin, most starred first. */
export async function pluginPage(page: number, timeoutMs = TIMEOUT_MS): Promise<{ items: HubItem[]; more: boolean }> {
  return readItemList(
    await read(`/items?${new URLSearchParams({ kind: 'plugin', sort: 'stars', page: String(page) })}`, timeoutMs),
  )
}

/** The plugins a search finds, best first. */
export async function searchPlugins(q: string, timeoutMs = TIMEOUT_MS): Promise<HubItem[]> {
  return readItemList(await read(`/items?${new URLSearchParams({ kind: 'plugin', q })}`, timeoutMs)).items
}

/** Who published an item and what its archive serves. Null when Hub has no such item. */
export async function hubItem(handle: string, name: string, timeoutMs = TIMEOUT_MS): Promise<HubItemInfo | null> {
  const answered = await request(fetch, `/items/${handle}/${name}`, {}, timeoutMs)
  return answered.status === 404 ? null : readItemInfo(json(answered))
}

/** The user's handle on Hub, and what they published there. */
export async function hubMe(send: FetchLike): Promise<HubMe> {
  return readMe(json(await request(send, '/me', {}, TIMEOUT_MS)))
}

/** Claims a handle for the user, once. Answers the handle claimed. */
export async function claimHandle(handle: string, send: FetchLike): Promise<string> {
  const body = JSON.stringify({ handle })
  const init = { method: 'PUT', headers: { 'content-type': 'application/json' }, body }
  return readClaimed(json(await request(send, '/me', init, TIMEOUT_MS)))
}

/** Sends a .tar.gz as the next version of the item it holds, which waits for Hub's review. */
export async function publishArchive(body: Buffer, send: FetchLike): Promise<HubPublished> {
  // A copy: fetch takes bytes over an ArrayBuffer of their own, which a Buffer's may not be.
  const init = { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: new Uint8Array(body) }
  return readPublished(json(await request(send, '/items', init, UPLOAD_TIMEOUT_MS)))
}

interface Answered {
  status: number
  statusText: string
  headers: Headers
  text: string
}

async function read(path: string, timeoutMs: number): Promise<unknown> {
  return json(await request(fetch, path, {}, timeoutMs))
}

/**
 * One request to Hub, read to the end of its body. One that got no answer in time, or none at all,
 * could not reach Hub; anything else thrown, such as the sign-in's own refusal, goes as it came.
 */
async function request(send: FetchLike, path: string, init: RequestInit, timeoutMs: number): Promise<Answered> {
  try {
    const response = await send(`${HUB}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const { status, statusText, headers } = response
    return { status, statusText, headers, text: await response.text() }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError')
      throw new Error(`Hub could not be reached: no answer in ${timeoutMs / 1000} seconds.`)
    if (err instanceof TypeError) throw new Error(`Hub could not be reached: ${errorReason(err)}.`)
    throw err
  }
}

/** The JSON a success carries; anything else is thrown as the HubError it is. */
function json({ status, statusText, headers, text }: Answered): unknown {
  if (status < 200 || status > 299) {
    // nginx in front of Hub answers its own limits with a page of HTML, which says nothing worth quoting.
    const said = /^\s*</.test(text) ? statusText || `HTTP ${status}` : refusalMessage(status, text)
    throw new HubError(status, said, retryAfter(headers.get('retry-after'), Date.now()))
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Hub answered something that is not JSON.')
  }
}
