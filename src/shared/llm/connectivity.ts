// Identifying network and internet connectivity failures so the user gets a calm, clear explanation
// instead of a raw `fetch failed` error. Pure: no Node or DOM imports.

import { messageOf } from '../rpc.ts'

export type ConnectivityFailureKind = 'offline' | 'connectivity' | 'local-unreachable'

const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/

const NON_CONNECTIVITY_ERROR =
  /across sleep|\bwhile the computer is sleeping or waking\b|nothing arrived for \d+ s|aborted due to timeout|\breturned [1-5]\d\d\b|\b(?:CERT_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_[A-Z_]+)\b|\binvalid url\b/i

const OFFLINE_NETWORK_CODE =
  /\b(?:ERR_INTERNET_DISCONNECTED|ENETDOWN|ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL|ERR_ADDRESS_UNREACHABLE)\b/i

const CONNECTIVITY_CODE_OR_FETCH =
  /\b(?:ENOTFOUND|EAI_AGAIN|EAI_FAIL|ENODATA|ESERVFAIL|ERR_NAME_NOT_RESOLVED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|EPIPE|ERR_NETWORK_CHANGED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET)\b|Connect Timeout Error|socket hang up|\bfetch failed\b/i

const FORMATTED_CONNECTIVITY_PREFIX = /^(?:No internet connection|Connection issue) — /i
const FORMATTED_HEADLINE = /^((?:No internet connection|Connection issue) — [^.]+)\./i
const RAW_CONNECTIVITY_TEXT =
  /\b(?:ERR_INTERNET_DISCONNECTED|ENETDOWN|ENETUNREACH|EHOSTUNREACH|EADDRNOTAVAIL|ENOTFOUND|EAI_AGAIN|EAI_FAIL|UND_ERR_CONNECT_TIMEOUT)\b|^(?:[^:\n]+:\s*)?fetch failed(?:\s*\([^)]*\))?\.?$/i

/** Whether `rawUrl` targets a loopback address on the user's own machine (such as a local Ollama server). */
export function isLoopbackUrl(rawUrl: string): boolean {
  if (!rawUrl.trim()) return false
  try {
    const bare = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return (
      bare === 'localhost' ||
      bare.endsWith('.localhost') ||
      bare === '::1' ||
      bare === '0.0.0.0' ||
      LOOPBACK_IPV4.test(bare)
    )
  } catch {
    return false
  }
}

function hostLabel(rawUrl: string): string {
  try {
    return new URL(rawUrl).host || rawUrl
  } catch {
    return rawUrl
  }
}

function errorNameOf(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
    ? (err as { name: string }).name
    : ''
}

/**
 * Classifies an error thrown before an HTTP response arrived:
 * - `'offline'` when the OS reports offline or routing/interface errors prove no internet route;
 * - `'connectivity'` when DNS, connect timeout, socket drop, or `fetch failed` prevented reaching a remote host;
 * - `'local-unreachable'` when a loopback server refused a local connection;
 * - `null` for auth/billing refusals, aborts, request/stream timeouts, sleep interrupts, or TLS/URL config errors.
 */
export function classifyFetchFailure(err: unknown, url: string, online = true): ConnectivityFailureKind | null {
  const name = errorNameOf(err)
  if (name === 'SignedOutError' || name === 'RefusedError' || name === 'AbortError' || name === 'TimeoutError') {
    return null
  }
  const message = messageOf(err)
  if (NON_CONNECTIVITY_ERROR.test(message)) return null
  if (isLoopbackUrl(url)) {
    return /\bECONNREFUSED\b/i.test(message) ? 'local-unreachable' : null
  }
  if (!online || OFFLINE_NETWORK_CODE.test(message)) return 'offline'
  if (CONNECTIVITY_CODE_OR_FETCH.test(message)) return 'connectivity'
  return null
}

/**
 * Formats an error thrown by `fetch` before any HTTP response arrived into plain, reassuring words
 * when it is a network/connectivity issue, or falls back to `${who}: ${messageOf(err)}`.
 */
export function formatFetchFailure(who: string, err: unknown, url: string, online = true): string {
  const kind = classifyFetchFailure(err, url, online)
  if (kind === 'offline') {
    return `No internet connection — couldn't reach ${who}. Check your network connection and try again; your workspace is safe.`
  }
  if (kind === 'connectivity') {
    return `Connection issue — couldn't reach ${who}. Check your internet connection and try again; your workspace is safe.`
  }
  if (kind === 'local-unreachable') {
    return `Could not connect to local server for ${who} (${hostLabel(url)}) — make sure ${who} is running.`
  }
  return `${who}: ${messageOf(err)}`
}

/**
 * Formats an error thrown while reading an already-opened response body or SSE stream: explains offline
 * drops plainly when the machine went offline mid-stream, and preserves the wire error otherwise so
 * proxy stream cutoffs while online keep their turn-timeout behavior.
 */
export function formatStreamDropFailure(who: string, err: unknown, url: string, online = true): string {
  const name = errorNameOf(err)
  if (
    !online &&
    !isLoopbackUrl(url) &&
    name !== 'AbortError' &&
    name !== 'TimeoutError' &&
    !NON_CONNECTIVITY_ERROR.test(messageOf(err))
  ) {
    return `No internet connection — connection to ${who} dropped. Check your network connection and try again; your workspace is safe.`
  }
  return `${who}: ${messageOf(err)}`
}

/** Whether an error message represents an internet/network connectivity issue rather than an application or model error. */
export function isConnectivityMessage(message: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  return FORMATTED_CONNECTIVITY_PREFIX.test(trimmed) || RAW_CONNECTIVITY_TEXT.test(trimmed)
}

/** Whether an error message says a local loopback model server refused the connection. */
export function isLocalUnreachableMessage(message: string): boolean {
  return message.trim().startsWith('Could not connect to local server for ')
}

/**
 * Short single-clause headline for retry progress lines so Central's 1-line command bar shows both
 * the connectivity cause and the retry countdown without clipping.
 */
export function connectivityRetryHeadline(message: string): string | null {
  return FORMATTED_HEADLINE.exec(message.trim())?.[1] ?? null
}

/**
 * Decides what calm status banner text to show below the top command bar when the terminal detects
 * offline status or a recent internet connectivity failure, or `null` when everything is healthy or dismissed.
 */
export function connectivityBannerText(options: {
  browserOnline: boolean
  recentConnectivityIssue: boolean
  dismissed: boolean
  localLlm: boolean
}): string | null {
  if (options.dismissed) return null
  if (!options.browserOnline) {
    return options.localLlm
      ? 'Offline — internet connection lost. Cloud data sources are paused until you reconnect; your local model and workspace still work.'
      : 'Offline — internet connection lost. Central and cloud data sources will resume once you reconnect; your workspace and rooms are safe.'
  }
  if (options.recentConnectivityIssue) {
    return 'Connection issue — Terminal could not reach the internet. Check your network connection and try again; your workspace and rooms are safe.'
  }
  return null
}
