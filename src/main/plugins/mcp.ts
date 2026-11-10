import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import path from 'node:path'
import { sleep, untilAborted } from '../../shared/abort'
import { accountBacked } from '../../shared/app/jaspers'
import { prepareMcpArguments } from '../../shared/data/arguments'
import { mapToolResult } from '../../shared/data/datasets'
import { withParameters } from '../../shared/data/tool-parameters'
import { discoverOAuthProtectedResourceMetadata, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  APP_MIME,
  APPS_EXTENSION,
  mayCall,
  pageOf,
  readTools,
  type Caller,
  type ListedTool,
  type ToolApp,
} from '../../shared/plugins/apps'
import {
  isStaleHttpSession,
  offeredTools,
  offersTool,
  resolveSecrets,
  savedBearerToken,
  shouldPublishConnecting,
  shouldReconnectOnCall,
  type Connection,
} from '../../shared/plugins/connections'
import { messageOf } from '../../shared/rpc'
import type { ConnectionInfo, ConnectionTool } from '../../shared/state'
import { connectionsOf, getConnection, missingOf, secretValues, setInfo, statusFor } from './connections'
import { oauthProvider } from './oauth'
import { refreshOnce, streamableHttpFetch, type StreamableHttpOptions } from './oauth-refresh'
import { accountAddress, asAccount, callAsAccount, jaspersWakeDelayMs, signedIn } from '../jaspers/jaspers'
import { RefusedError, SignedOutError } from '../jaspers/session'
import { wakeGraceDelayMs, WAKE_GRACE_MS } from '../../shared/tasks/tasks'
import { getState } from '../state'

// One MCP client per connection, and what it knows published into the tree. Everything that could
// carry a credential stays in this file and connections.ts: the resolved command, the headers, the
// URL. What goes out is a status, a tool list, and an error with every secret value scrubbed out of
// it, since a server's own message can quote back what it was sent.
//
// A server may ship pages of its own for its tools (MCP Apps). Every client says it can be shown
// them, and what each tool says about its page and who may call it is kept here beside the client:
// the tree carries only the tools the model may call, and a call is checked against the whole list.
//
// A server that signs its users in with the browser says whose sign-in it takes (RFC 9728). One that
// names Jaspers' Account takes the app's own sign-in as its bearer and runs no flow of its own: it
// connects while the user is signed in, and waits for them to sign in otherwise. Any other server
// signs the user in itself, through the connection's own OAuth (oauth.ts).

const CLIENT = { name: 'jaspers-terminal', version: '0.1.0' }

interface Live {
  client: Client
  transport: Transport
  /** Every tool the connection offers, the ones only its page may call included, each with its page and callers. */
  tools: Map<string, ToolApp>
  viaJaspers: boolean
  /** True when the handshake completed via `fallbackTools` after a 403 subscription refusal. */
  deferredSubscription?: boolean
}

const clients = new Map<string, Live>()
const listedTools = new Map<string, ListedTool[]>()
/** Each attempt at a connection gets a number, so a slow one cannot publish over a newer one. */
const attempts = new Map<string, number>()
/** An attempt already under way, so concurrent callers join one handshake instead of aborting each other's. */
const connecting = new Map<string, Promise<void>>()
/** A connection that failed tries again on its own, waiting longer each time, so a server that was down comes back without anyone pressing Reconnect. */
const RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000]
const retries = new Map<string, NodeJS.Timeout>()
const pendingRetries = new Map<string, number>()
const failedAt = new Map<string, number>()
let wakeGrace: NodeJS.Timeout | null = null
let sleeping = false
/** The fetch of every OAuth connection of its own. One, so a refresh under way is found by whichever client asks: the one just built, or one still finishing a call. */
const oauthFetch = refreshOnce(fetch)
/** The servers that sign their users in through Jaspers, by address, once each has said so. Not knowing is not kept: a server that could not be asked is asked again next time. */
const throughJaspers = new Set<string>()

/** How long `waitForConnections` waits for in-flight connection handshakes before letting a tool list or status check proceed with what is ready. */
const CONNECT_SETTLE_MS = 15_000

/**
 * Builds the client for one connection, or says what it is still waiting for. Safe to call again at
 * any time: whatever was connected is closed first.
 */
export function connect(id: string, retry = 0): Promise<void> {
  const run = connectOne(id, retry).finally(() => {
    if (connecting.get(id) === run) connecting.delete(id)
  })
  connecting.set(id, run)
  return run
}

/**
 * Waits for in-flight MCP connection handshakes (`connecting`) to settle: for the named connection
 * ids when a filter is given (triggering a reconnect for any errored connection eligible to retry on
 * call), or for all currently connecting servers when unfiltered.
 */
export async function waitForConnections(wanted: readonly string[] | null = null, signal?: AbortSignal): Promise<void> {
  const pending: Promise<void>[] = []
  if (wanted !== null && wanted !== undefined) {
    for (const id of wanted) {
      const inflight = connecting.get(id)
      if (inflight) {
        pending.push(inflight)
      } else if (!clients.has(id) && getState().connections[id]?.status === 'error') {
        pending.push(reconnect(id))
      }
    }
  } else {
    pending.push(...connecting.values())
  }
  if (pending.length === 0) return
  let timer: NodeJS.Timeout | null = null
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CONNECT_SETTLE_MS)
    timer.unref?.()
  })
  try {
    await untilAborted(Promise.race([Promise.allSettled(pending).then(() => undefined), cap]), signal)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Re-establishes a connection when no attempt is already under way and the stale client (if named)
 * has not already been replaced by another caller's reconnect. When called for an already-errored
 * connection (`stale` omitted), respects the sleep/wake grace window and the retry cooldown so
 * bursts of calls while offline do not cycle status or reset backoff.
 */
function reconnect(id: string, stale?: Live): Promise<void> {
  const inflight = connecting.get(id)
  if (inflight) return inflight
  const current = clients.get(id)
  if (stale) {
    if (current !== stale) return Promise.resolve()
    return connect(id, pendingRetries.get(id) ?? 0)
  }
  if (current !== undefined) return Promise.resolve()
  const nextRetry = pendingRetries.get(id)
  if (
    !shouldReconnectOnCall({
      sleeping,
      inWakeGrace: wakeGrace !== null || jaspersWakeDelayMs() > 0,
      nextRetry,
      lastFailedAt: failedAt.get(id) ?? null,
      now: Date.now(),
      cooldownMs: RETRY_MS[0]!,
    })
  ) {
    return Promise.resolve()
  }
  return connect(id, nextRetry!)
}

async function connectOne(id: string, retry = 0): Promise<void> {
  const entry = getConnection(id)
  if (!entry) return
  const { spec, plugin, dir } = entry
  const attempt = (attempts.get(id) ?? 0) + 1
  attempts.set(id, attempt)
  if (retry === 0) failedAt.delete(id)
  cancelRetry(id)
  await disconnect(id)
  const values = secretValues(plugin)
  const status = statusFor(spec, values)
  const missing = missingOf(spec, values)
  const resolved = resolveSecrets(spec, values)
  if (status !== 'connecting' || 'missing' in resolved) {
    failedAt.delete(id)
    setInfo(id, { status, error: null, tools: [], instructions: null, missing })
    return
  }
  if (shouldPublishConnecting(getState().connections[id]?.status, retry)) {
    setInfo(id, { status: 'connecting', error: null, missing })
  }
  let viaJaspers: boolean
  try {
    viaJaspers = spec.auth === 'oauth' && (await signsInThroughJaspers(resolved.connection.url!))
  } catch (err) {
    // The server could not say whose sign-in it takes: down, or out of reach. A connection that failed.
    if (attempts.get(id) === attempt) failed(id, redact(messageOf(err), values), retry)
    return
  }
  if (attempts.get(id) !== attempt) return
  const savedToken = viaJaspers ? savedBearerToken(resolved.connection, values) : null
  const waiting = waitingOn(id, spec, viaJaspers, savedToken)
  if (waiting) {
    failedAt.delete(id)
    setInfo(id, { status: waiting, error: null, tools: [], instructions: null })
    return
  }
  const client: Client = new Client(CLIENT, {
    // Said to every server: one that ships no pages has nothing to do with it.
    capabilities: { extensions: { [APPS_EXTENSION]: { mimeTypes: [APP_MIME] } } },
    listChanged: {
      tools: {
        // The list is read here rather than by the client, which reads one page of it.
        autoRefresh: false,
        // A server that gains or loses a tool while connected says so, and what it offers is published
        // again. Only for the client still held: one that was replaced has nothing to say.
        onChanged: () => {
          if (clients.get(id)?.client !== client) return
          void listAll(client)
            .then((listed) => {
              const live = clients.get(id)
              if (live?.client !== client) return
              const { tree, all } = readTools(offeredTools(spec, listed).tools)
              live.tools = all
              setInfo(id, { tools: tree })
            })
            .catch((err: unknown) => console.warn(`[mcp ${id}] tools: ${err instanceof Error ? err.message : err}`))
        },
      },
    },
  })
  try {
    let deferredSubscription = false
    const transport = build(id, resolved.connection, dir, values, viaJaspers, {
      savedToken,
      fallbackTools: () => fallbackToolsFor(id, plugin, spec),
      onSubscriptionDeferred: () => {
        deferredSubscription = true
      },
    })
    await client.connect(transport)
    const listed = await listAll(client)
    if (attempts.get(id) !== attempt) {
      await client.close()
      return
    }
    // A connection that names its tools gets only those; a name the server does not know is said, not dropped in silence.
    const offered = offeredTools(spec, listed)
    if (offered.missing.length > 0) console.warn(`[mcp ${id}] tools: the server lists no ${offered.missing.join(', ')}`)
    const { tree, all } = readTools(offered.tools)
    const instructions =
      client.getInstructions()?.trim() || (deferredSubscription ? siblingInstructionsFor(id, plugin) : null) || null
    if (!deferredSubscription) listedTools.set(id, listed)
    clients.set(id, { client, transport, tools: all, viaJaspers, deferredSubscription })
    failedAt.delete(id)
    setInfo(id, {
      status: 'ready',
      error: null,
      tools: tree,
      instructions,
    })
    if (!deferredSubscription) enrichDeferredSiblings(id, plugin, listed, instructions)
  } catch (err) {
    await client.close().catch(() => undefined)
    if (attempts.get(id) !== attempt) return
    const message = redact(messageOf(err), values)
    const unauthorized = err instanceof UnauthorizedError || /401|unauthoriz/i.test(message)
    if (err instanceof SignedOutError) {
      failedAt.delete(id)
      setInfo(id, { status: 'needs-sign-in', error: null, tools: [] })
    } else if (spec.auth === 'oauth' && !viaJaspers && unauthorized) {
      failedAt.delete(id)
      setInfo(id, { status: 'needs-auth', error: null, tools: [] })
    }
    // The account's standing at the server, in the server's words, which no retry changes: Reconnect once it has.
    else if (err instanceof RefusedError) {
      failedAt.delete(id)
      setInfo(id, { status: 'error', error: message, tools: [] })
    } else failed(id, message, retry)
  }
}

/** A connection that failed in a way that may pass: said, and tried again on its own, each time after a longer wait. */
function failed(id: string, message: string, retry: number): void {
  setInfo(id, { status: 'error', error: message, tools: [] })
  failedAt.set(id, Date.now())
  pendingRetries.set(id, retry + 1)
  if (sleeping || wakeGrace) return
  armRetry(id, retry)
}

function armRetry(id: string, retry: number): void {
  const wait = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)]!
  retries.set(
    id,
    setTimeout(() => {
      retries.delete(id)
      pendingRetries.delete(id)
      void connect(id, retry + 1).catch(() => undefined)
    }, wait),
  )
}

/** Disarms pending connection retry timers while the machine sleeps so none fire before the network is back. */
export function suspendRetries(): void {
  sleeping = true
  if (wakeGrace) clearTimeout(wakeGrace)
  wakeGrace = null
  for (const timer of retries.values()) clearTimeout(timer)
  retries.clear()
}

/** Re-arms pending connection retries after the post-wake grace window so the network has settled. */
export function wakeRetries(): void {
  sleeping = false
  if (wakeGrace) clearTimeout(wakeGrace)
  for (const timer of retries.values()) clearTimeout(timer)
  retries.clear()
  const wait = wakeGraceDelayMs(WAKE_GRACE_MS, jaspersWakeDelayMs())
  if (!Number.isFinite(wait)) return
  wakeGrace = setTimeout(() => {
    wakeGrace = null
    if (sleeping) return
    const remaining = jaspersWakeDelayMs()
    if (!Number.isFinite(remaining)) return
    if (remaining > 0) {
      wakeRetries()
      return
    }
    const due = [...pendingRetries.entries()]
    pendingRetries.clear()
    for (const [id, nextRetry] of due) {
      void connect(id, nextRetry).catch(() => undefined)
    }
  }, wait)
  wakeGrace.unref?.()
}

/**
 * Whether a server signs its users in through Jaspers: its protected resource metadata names Account.
 * Asked once per address and kept when it does. A server that publishes none signs its users in
 * itself, as every server did before Account. One that could not be asked throws: the connection
 * failed, and is tried again like any other, rather than sent to a sign-in it may not need.
 */
async function signsInThroughJaspers(url: string): Promise<boolean> {
  if (throughJaspers.has(url)) return true
  let metadata: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>>
  try {
    metadata = await discoverOAuthProtectedResourceMetadata(url, undefined, reach)
  } catch (err) {
    if (err instanceof Error && NO_METADATA.test(err.message)) return false
    throw err
  }
  if (!accountBacked(metadata, accountAddress())) return false
  throughJaspers.add(url)
  return true
}

/** What the SDK says of a server whose metadata is not there. */
const NO_METADATA = /does not implement OAuth 2\.0 Protected Resource Metadata/

/**
 * Fetch for that discovery, with a failure to reach the server thrown as itself: the SDK reads a
 * TypeError as a browser's CORS refusal and goes on as if the server published nothing.
 */
const reach: FetchLike = (url, init) =>
  fetch(url, init).catch((err: unknown) => {
    throw new Error(messageOf(err), { cause: err })
  })

/** What an OAuth connection waits on before a client is built: the app's sign-in with Jaspers (or a saved plugin bearer token), or a sign-in of its own; nothing, with either in hand. */
function waitingOn(
  id: string,
  spec: Connection,
  viaJaspers: boolean,
  savedToken: string | null = null,
): 'needs-sign-in' | 'needs-auth' | null {
  if (spec.auth !== 'oauth') return null
  if (viaJaspers) return signedIn() || savedToken !== null ? null : 'needs-sign-in'
  return getState().oauth[id]?.tokens ? null : 'needs-auth'
}

function fallbackToolsFor(id: string, plugin: string, spec: Connection): ListedTool[] {
  for (const sibling of connectionsOf(plugin)) {
    if (sibling.id === id) continue
    const siblingListed = listedTools.get(sibling.id)
    if (siblingListed && siblingListed.length > 0) return siblingListed
    const siblingTree = getState().connections[sibling.id]?.tools
    if (siblingTree && siblingTree.length > 0) {
      return siblingTree.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    }
  }
  return (spec.tools ?? []).map((name) => ({
    name,
    description: '',
    inputSchema: { type: 'object', properties: {} },
  }))
}

function siblingInstructionsFor(id: string, plugin: string): string | null {
  for (const sibling of connectionsOf(plugin)) {
    if (sibling.id === id) continue
    const instructions = getState().connections[sibling.id]?.instructions
    if (instructions) return instructions
  }
  return null
}

function enrichDeferredSiblings(id: string, plugin: string, listed: ListedTool[], instructions: string | null): void {
  for (const sibling of connectionsOf(plugin)) {
    if (sibling.id === id) continue
    const live = clients.get(sibling.id)
    if (!live?.deferredSubscription) continue
    const offered = offeredTools(sibling.spec, listed)
    const { tree, all } = readTools(offered.tools)
    live.tools = all
    setInfo(sibling.id, {
      tools: tree,
      instructions: instructions ?? getState().connections[sibling.id]?.instructions ?? null,
    })
  }
}

/**
 * The sign-in with Jaspers began or ended, whoever ended it: every connection to a server that signs
 * its users in through it is connected again, which is also how one is put to waiting when the
 * sign-in is gone.
 */
export function followSignIn(): void {
  for (const id of Object.keys(getState().connections)) {
    const entry = getConnection(id)
    if (entry?.spec.auth !== 'oauth' || !entry.spec.url) continue
    const resolved = resolveSecrets(entry.spec, secretValues(entry.plugin))
    if ('missing' in resolved || !throughJaspers.has(resolved.connection.url!)) continue
    void connect(id).catch((err: unknown) => console.warn('[mcp]', err instanceof Error ? err.message : String(err)))
  }
}

/** A server with many tools lists them a page at a time; this many pages is a server that is not going to stop. */
const PAGES_MAX = 50

/** Every tool a server lists, across however many pages it lists them in. */
async function listAll(client: Client): Promise<ListedTool[]> {
  const tools: ListedTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < PAGES_MAX; page++) {
    const listed = await client.listTools(cursor ? { cursor } : undefined)
    tools.push(...listed.tools.map(toolInfo))
    cursor = listed.nextCursor
    if (!cursor) break
  }
  return tools
}

function cancelRetry(id: string): void {
  const timer = retries.get(id)
  if (timer) clearTimeout(timer)
  retries.delete(id)
  pendingRetries.delete(id)
}

export async function disconnect(id: string): Promise<void> {
  cancelRetry(id)
  listedTools.delete(id)
  const live = clients.get(id)
  if (!live) return
  clients.delete(id)
  await live.client.close().catch(() => undefined)
}

/**
 * A connection nobody holds any more: whatever is connected, and whatever is still connecting.
 * `disconnect` alone cannot do the second half. On a first connect there is nothing in `clients` yet,
 * so it returns having done nothing, and the connect already in flight goes on to publish a client
 * for an id that has been dropped: a stdio child left running with the plugin's resolved secrets in
 * its environment, and a client `call` finds while `getConnection` no longer can, which is where the
 * `offersTool` allowlist is checked. Bumping the attempt is what stops it, at the check it makes
 * before it publishes. The bump is not inside `disconnect` because `connect` awaits `disconnect`
 * after taking its own attempt number: bumping there would make every connect supersede itself.
 */
export async function forget(id: string): Promise<void> {
  connecting.delete(id)
  failedAt.delete(id)
  attempts.set(id, (attempts.get(id) ?? 0) + 1)
  await disconnect(id)
}

/** Stdio children die with the app, so this runs on will-quit before anything else. */
export function closeAll(): void {
  connecting.clear()
  failedAt.clear()
  listedTools.clear()
  if (wakeGrace) clearTimeout(wakeGrace)
  wakeGrace = null
  for (const id of [...retries.keys(), ...pendingRetries.keys()]) cancelRetry(id)
  for (const [id, live] of clients) {
    clients.delete(id)
    void live.client.close().catch(() => undefined)
  }
}

/** Asks the user for a connection's missing key and waits. Main sets it at startup; see onMissingSecret. */
let askForMissingSecret: ((id: string) => Promise<void>) | null = null

/**
 * What a call does when its connection is missing a key: ask the user and wait. Every caller comes
 * through `call`, and most of them (a view, a plugin's model) cannot ask, so it happens here.
 */
export function onMissingSecret(ask: (id: string) => Promise<void>): void {
  askForMissingSecret = ask
}

/**
 * One tool call on one connection. A connection missing its key asks the user for it first; one that
 * is still not ready says what it needs instead.
 */
export async function call(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number; from?: Caller } = {},
): Promise<unknown> {
  if (askForMissingSecret && !clients.has(id) && getState().connections[id]?.status === 'needs-secret') {
    await untilAborted(askForMissingSecret(id), opts.signal)
  }
  if (!clients.has(id) && (connecting.has(id) || getState().connections[id]?.status === 'error')) {
    await untilAborted(reconnect(id), opts.signal)
  }
  const live = clients.get(id)
  if (!live) throw unavailable(id)
  // The declaration is the allowlist, so a call with no declaration to check against is refused
  // rather than allowed. `forget` in the removal path is what keeps a client from outliving its
  // connection; this says what happens if one ever does anyway, since the alternative reading of a
  // missing declaration — no declaration, no check — would offer every tool the server has.
  const entry = getConnection(id)
  if (!entry) throw new Error(`connection_unavailable: ${id} is no longer declared by any plugin.`)
  if (!offersTool(entry.spec, tool)) {
    throw new Error(`tool_unavailable: ${id} offers only ${entry.spec.tools!.join(', ')}; ${tool} is not one of them.`)
  }
  // A server marks a tool for its own page alone, or for the model alone. The mark is the server's
  // and the check is here, in the one place every caller comes through.
  const from = opts.from ?? 'model'
  if (!mayCall(live.tools.get(tool), from)) {
    throw new Error(
      from === 'app'
        ? `tool_unavailable: ${tool} on ${id} is not offered to its server's view.`
        : `tool_unavailable: ${tool} on ${id} is for its server's own view.`,
    )
  }
  // A model's empty value for an optional field means leave it out, and spelling mismatches are
  // repaired against the tool's schema before the server sees them.
  const declared = (): ConnectionTool | undefined => getState().connections[id]?.tools.find((t) => t.name === tool)
  // A server that reports progress is working: each report starts the wait over, so a long call is
  // held to its silences rather than to its whole length, the way a streamed reply is.
  const send = (client: Client): Promise<unknown> => {
    const schema = declared()?.inputSchema
    return client.callTool({ name: tool, arguments: schema ? prepareMcpArguments(schema, args) : args }, undefined, {
      signal: opts.signal,
      timeout: opts.timeoutMs,
      resetTimeoutOnProgress: true,
      onprogress: () => {},
    })
  }
  let result: unknown
  try {
    result = await asked(id, live, entry.spec, send, opts.signal)
  } catch (error) {
    if (from === 'model') {
      const message = messageOf(error)
      const told = withParameters(message, declared())
      if (told !== message) throw new Error(told, { cause: error })
    }
    throw error
  }
  if (from === 'model') {
    const answer = result as { content?: unknown[]; isError?: boolean } | null
    if (answer && typeof answer === 'object' && answer.isError === true) {
      const { text } = mapToolResult(answer)
      const told = withParameters(text, declared())
      if (told !== text) return { ...answer, content: [{ type: 'text', text: told }] }
    }
  }
  return result
}

/**
 * One tool of a connected server: its page and callers, and how the tree describes it when the model
 * may call it. Throws what a call would when the connection has no client.
 */
export function toolOf(id: string, tool: string): { info: ConnectionTool | undefined; app: ToolApp } | undefined {
  const live = clients.get(id)
  if (!live) throw unavailable(id)
  const app = live.tools.get(tool)
  return app && { info: getState().connections[id]?.tools.find((one) => one.name === tool), app }
}

/** One of a connection's pages, read from its server: `resources/read` on a `ui://` address. */
export async function readPage(id: string, uri: string): Promise<{ html: string; csp: unknown; border: boolean }> {
  if (!clients.has(id) && (connecting.has(id) || getState().connections[id]?.status === 'error')) {
    await reconnect(id)
  }
  const live = clients.get(id)
  if (!live) throw unavailable(id)
  const entry = getConnection(id)
  if (!entry) throw new Error(`connection_unavailable: ${id} is no longer declared by any plugin.`)
  return pageOf(await asked(id, live, entry.spec, (client) => client.readResource({ uri })), uri)
}

/**
 * One request on a connection's client, with what a connection that signs in or speaks HTTP needs
 * around it: sent once more when it was refused while another's refresh was landing or when its HTTP
 * session had expired, and the sign-in's end published when that is what it found.
 */
async function asked<T>(
  id: string,
  live: Live,
  spec: Connection,
  send: (client: Client) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let sentToClient = false
  const once = async (current: Live): Promise<T> => {
    sentToClient = false
    const callClient = (): Promise<T> => {
      sentToClient = true
      return send(current.client)
    }
    if (spec.auth !== 'oauth') return callClient()
    try {
      const attempt = () => sentAgainIfRefused(callClient)
      if (!current.viaJaspers) return await attempt()
      try {
        while (current.viaJaspers) {
          const wakeWait = jaspersWakeDelayMs()
          if (wakeWait <= 0) break
          if (!Number.isFinite(wakeWait)) {
            throw new Error('Cannot refresh Jaspers sign-in while the computer is sleeping or waking.')
          }
          await sleep(wakeWait, signal)
        }
        return await callAsAccount(attempt)
      } catch (err) {
        if (err instanceof SignedOutError) {
          const entry = getConnection(id)
          if (entry && savedBearerToken(entry.spec, secretValues(entry.plugin)) !== null) {
            return await attempt()
          }
        }
        throw err
      }
    } catch (err) {
      // The app's sign-in with Jaspers ended under the call, or the connection's own did.
      if (err instanceof SignedOutError) await signedOut(id, current, 'needs-sign-in')
      else if (err instanceof UnauthorizedError || refused(err))
        await signedOut(id, current, current.viaJaspers ? 'needs-sign-in' : 'needs-auth')
      // Cut off because another call had just found the sign-in gone: told what a call made now would be.
      else if (clients.get(id) !== current && waits(getState().connections[id]?.status)) throw unavailable(id)
      throw err
    }
  }
  try {
    return await once(live)
  } catch (err) {
    if (
      signal?.aborted ||
      waits(getState().connections[id]?.status) ||
      (!(sentToClient && isStaleHttpSession(err, spec)) &&
        !(spec.url && (connecting.has(id) || clients.get(id) !== live)))
    ) {
      throw err
    }
    await untilAborted(reconnect(id, live), signal)
    const renewed = clients.get(id)
    if (!renewed || renewed === live) throw err
    return once(renewed)
  }
}

/** Whether a status is a sign-in the connection waits for. */
function waits(status: ConnectionInfo['status'] | undefined): boolean {
  return status === 'needs-auth' || status === 'needs-sign-in'
}

/** Why a connection has no client to call, and what would give it one. */
function unavailable(id: string): Error {
  const info = getState().connections[id]
  const status = info?.status ?? 'unknown'
  const fix =
    info && status === 'needs-secret'
      ? `, it needs a key: ask the user for it with set_secret { plugin: "${info.plugin}", key: "${info.missing[0] ?? 'token'}" }.`
      : status === 'needs-auth'
        ? ', authorize it in Settings under Plugins.'
        : status === 'needs-sign-in'
          ? ', sign in with Jaspers in Settings.'
          : ''
  return new Error(`connection_unavailable: ${id} is ${status}${fix}`)
}

/** The transport's word that a server refused a token the SDK had just been issued. */
function refused(err: unknown): boolean {
  return err instanceof StreamableHTTPError && err.code === 401
}

/**
 * A call, sent once more when the transport says its server refused a token it had just issued. The
 * SDK keeps that guard as one flag for the whole transport, so of several calls refused for a token
 * that ran out, the ones answered while another's refresh was landing trip it, though the token they
 * were refused for was the old one. A refusal sends nothing to the tool, so sending again is safe;
 * it goes out with the new token, and a second refusal means the guard was right.
 */
async function sentAgainIfRefused<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send()
  } catch (err) {
    if (!refused(err)) throw err
    return send()
  }
}

/**
 * A connection whose sign-in ended under a call: its token ran out and could not be renewed. The
 * call says so, but the tree would go on reading `ready`, and Settings offers Authorize only to a
 * connection that needs it. So it is published here as `connect` publishes it, unless the client was
 * replaced meanwhile, since a newer one speaks for itself. Published before the client is closed:
 * closing cuts off the calls still on it, and each of those reads the tree to say why.
 */
async function signedOut(id: string, live: Live, status: 'needs-auth' | 'needs-sign-in'): Promise<void> {
  if (clients.get(id) !== live) return
  setInfo(id, { status, error: null, tools: [] })
  await disconnect(id)
}

function build(
  id: string,
  connection: Connection,
  dir: string,
  values: Record<string, string>,
  viaJaspers: boolean,
  httpOpts: Omit<StreamableHttpOptions, 'viaJaspers'> = {},
): Transport {
  if (connection.command) {
    const [command, ...args] = connection.command
    // "node" means the Node this app is running on, which is Electron's own, not whatever is first
    // on PATH: the app is usually started from a shell, and a shell's default Node is often older
    // than the server needs. ELECTRON_RUN_AS_NODE turns the app binary back into that Node.
    const own = command === 'node'
    const transport = new StdioClientTransport({
      command: own ? process.execPath : command!,
      args,
      env: {
        ...(process.env as Record<string, string>),
        ...(own ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ...connection.env,
      },
      // Relative to the plugin's folder, which is the default: a server beside plugin.tsx is `server/main.ts`.
      cwd: path.resolve(dir, connection.cwd ?? '.'),
      stderr: 'pipe',
    })
    // The server's own complaints are worth seeing; a value it was given is not. Every one of the
    // plugin's values, not just this connection's env: a server can print a key it learned elsewhere.
    transport.stderr?.on('data', (chunk: Buffer) => {
      const text = redact(chunk.toString().trimEnd(), values)
      if (text) console.log(`[mcp ${id}] ${text}`)
    })
    return transport
  }
  // A server that signs its users in through Jaspers is sent to as the account, with no flow of
  // the connection's own; one that signs them in itself gets the connection's OAuth.
  const baseFetch = connection.auth === 'oauth' ? (viaJaspers ? asAccount : oauthFetch) : fetch
  return new StreamableHTTPClientTransport(new URL(connection.url!), {
    requestInit: { headers: connection.headers },
    authProvider: connection.auth === 'oauth' && !viaJaspers ? oauthProvider(id) : undefined,
    fetch: streamableHttpFetch(baseFetch, { viaJaspers, ...httpOpts }),
  })
}

/** A tool as its server listed it. Its `_meta` rides along, since that is where it names its page and its callers. */
function toolInfo(tool: { name: string; description?: string; inputSchema?: unknown; _meta?: unknown }): ListedTool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    ...(tool._meta === undefined ? {} : { meta: tool._meta }),
  }
}

/** Whatever a server or a transport says, with every secret value taken back out of it. */
function redact(text: string, values: Record<string, string>): string {
  let out = text
  for (const value of Object.values(values)) {
    if (value.length >= 4) out = out.split(value).join('***')
  }
  return out
}
