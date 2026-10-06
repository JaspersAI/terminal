// Jaspers Hub, where plugins and skills are published: what its answers are, and what a link to it
// names. Its contract is jaspers-hub's docs/api.md. Main asks Hub (src/main/hub/) and the renderer
// shows what main read, so both read it through here. No Node or DOM imports.

import { serviceUrl } from '../app/jaspers.ts'
import { isPluginId } from '../plugins/id.ts'

/** Hub's API, unless `JASPERS_HUB_URL` says otherwise. */
export const HUB_API = 'https://hub-api.jsprai.com/v1'
/** Hub's web pages: an item's is `<handle>/<name>` under it. */
export const HUB_WEB = 'https://hub.jsprai.com'
/** The most Hub takes in one upload's body (its docs/api.md, What an upload may hold). */
export const UPLOAD_BYTES = 50 * 1024 * 1024

const HANDLE_MAX = 39
/** Hub's rule for a handle, in words. */
export const HANDLE_RULE = `A handle is lower-case letters, digits, and hyphens, starting with a letter or a digit, at most ${HANDLE_MAX}.`
const WEB_HOST = new URL(HUB_WEB).host
const API = new URL(HUB_API)
/** An item's page: `/<handle>/<name>`. */
const PAGE_PATH = /^\/([^/]+)\/([^/]+)\/?$/
/** An item's archive: `/v1/items/<handle>/<name>/archive`. */
const ARCHIVE_PATH = new RegExp(`^${API.pathname}/items/([^/]+)/([^/]+)/archive/?$`)

/** An item as Hub lists it (its `ItemSummary`), as far as the terminal reads one. */
export interface HubItem {
  handle: string
  name: string
  kind: 'plugin' | 'skill'
  /** Published by Jaspers. */
  official: boolean
  /** Placed among the featured by Hub's operator, which a listing shows first. */
  featured: boolean
  /** The shown version: the listed one. */
  version: string
  /** Whether the shown version is approved. */
  reviewed: boolean
  title: string
  description: string
  tags: string[]
  stars: number
  downloads: number
  /** The item's web page. */
  page: string
}

/** An item's own answer (`GET /items/:handle/:name`), as far as an install reads it. */
export interface HubItemInfo {
  official: boolean
  /** What its archive serves: the listed version, else, while none is approved, the highest pending one. Null when there is neither. */
  shown: { version: string; state: 'pending' | 'approved' } | null
  page: string
}

/** A version published (`POST /items`): it waits for Hub's review, and the item's page is where to see it. */
export interface HubPublished {
  handle: string
  name: string
  version: string
  page: string
}

/** What publishing answers the renderer: the version published, or that a handle has to be claimed first. */
export type PublishAnswer = { published: HubPublished } | { needsHandle: true }

/** What Hub holds of the signed-in caller (`GET /me`): their handle, if they claimed one, and what they published. */
export interface HubMe {
  handle: string | null
  items: {
    handle: string
    name: string
    kind: 'plugin' | 'skill'
    /** The listed version, when one is approved. */
    listed: string | null
    /** Highest first, withdrawn and rejected included. */
    versions: { version: string; state: string; note: string | null; analysis: string; createdAt: string }[]
  }[]
}

/** Hub's address: `JASPERS_HUB_URL`'s, else the public one. */
export function hubUrl(env: string | undefined): string {
  return serviceUrl('JASPERS_HUB_URL', env, HUB_API)
}

/** Whether a handle keeps Hub's rule (`HANDLE_RULE`). Hub also keeps some names back, which it says when one is claimed. */
export function isHandle(text: string): boolean {
  return isPluginId(text) && text.length <= HANDLE_MAX
}

/** A page of a listing (`GET /items`). An item that is not the shape is left out; an answer that is no listing is an error. */
export function readItemList(json: unknown): { items: HubItem[]; more: boolean } {
  if (!isRecord(json) || !Array.isArray(json.items))
    throw new Error('Hub answered something that is not a list of items.')
  return { items: json.items.flatMap((raw) => readItem(raw) ?? []), more: json.more === true }
}

/** An item's own answer. One of another shape is an error. */
export function readItemInfo(json: unknown): HubItemInfo {
  const shown = isRecord(json) ? json.shown : undefined
  if (!isRecord(json) || typeof json.official !== 'boolean' || typeof json.page !== 'string' || !isShown(shown))
    throw new Error('Hub answered something that is not an item.')
  return {
    official: json.official,
    shown: shown && { version: shown.version, state: shown.state },
    page: json.page,
  }
}

/** What `POST /items` answered. One of another shape is an error. */
export function readPublished(json: unknown): HubPublished {
  if (!isRecord(json)) throw new Error('Hub answered something that is not a version published.')
  const { handle, name, version, page } = json
  if (!isHandleText(handle) || typeof name !== 'string' || typeof version !== 'string' || typeof page !== 'string')
    throw new Error('Hub answered something that is not a version published.')
  return { handle, name, version, page }
}

/** What `PUT /me` answered: the handle claimed. */
export function readClaimed(json: unknown): string {
  const handle = isRecord(json) ? json.handle : undefined
  if (!isHandleText(handle)) throw new Error('Hub answered something that is not a handle.')
  return handle
}

/**
 * What a search of Hub found, in words for the assistant's model: each plugin by name and title, who
 * published it, whether Hub reviewed it, and what it says it does, so the model can tell the user of
 * one before building its own. `installed` are the ids of the plugins already in the app.
 */
export function hubFindings(query: string, items: readonly HubItem[], installed: readonly string[] = []): string {
  const plugins = items.filter((item) => item.kind === 'plugin')
  if (plugins.length === 0) return `Jaspers Hub has no plugin for "${query}".`
  const have = new Set(installed)
  const lines = plugins.map((item) => {
    const marks = [
      `by ${item.handle}${item.official ? ', official' : ''}`,
      item.reviewed ? `v${item.version}, reviewed` : `v${item.version}, not reviewed yet`,
      ...(have.has(item.name) ? ['already installed'] : []),
    ]
    const said = item.description.trim().replace(/\s+/g, ' ')
    return `- ${item.name}: ${item.title} (${marks.join('; ')}). ${said} ${item.page}`.trimEnd()
  })
  return [`Jaspers Hub's plugins for "${query}", best first:`, ...lines].join('\n')
}

/** What an item's archive is fetched from: the shown version's, at a stable address. */
export function archiveAddress(base: string, handle: string, name: string): string {
  return `${base}/items/${handle}/${name}/archive`
}

/**
 * The item a link names: its page on Hub's web, with or without a trailing slash, a query, or a
 * fragment, or its archive on the API. Null for any other link, and for an item that could not be
 * installed as a plugin by its name.
 */
export function hubSource(url: URL): { handle: string; name: string } | null {
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const path = url.host === WEB_HOST ? PAGE_PATH : url.host === API.host ? ARCHIVE_PATH : null
  const [, handle, name] = path?.exec(url.pathname) ?? []
  return handle && name && isHandle(handle) && isPluginId(name) ? { handle, name } : null
}

/** What `GET /me` answered. Items and versions that are not the shape are left out; an answer of another shape is an error. */
export function readMe(json: unknown): HubMe {
  if (!isRecord(json) || !Array.isArray(json.items) || !(json.handle === null || isHandleText(json.handle)))
    throw new Error('Hub answered something that is not your handle and items.')
  return { handle: json.handle, items: json.items.flatMap((raw) => readMyItem(raw) ?? []) }
}

function readItem(raw: unknown): HubItem | null {
  if (!isRecord(raw)) return null
  const {
    handle,
    name,
    kind,
    official,
    featured,
    version,
    reviewed,
    title,
    description,
    tags,
    stars,
    downloads,
    page,
  } = raw
  if (!isHandleText(handle) || typeof name !== 'string' || !isPluginId(name) || !isKind(kind)) return null
  if (typeof official !== 'boolean' || typeof reviewed !== 'boolean' || !isCount(stars) || !isCount(downloads))
    return null
  if (typeof version !== 'string' || typeof title !== 'string' || typeof description !== 'string') return null
  if (typeof page !== 'string' || !Array.isArray(tags)) return null
  return {
    handle,
    name,
    kind,
    official,
    // A Hub from before featuring sends no mark: nothing is featured there.
    featured: featured === true,
    version,
    reviewed,
    title,
    description,
    tags: tags.filter((tag) => typeof tag === 'string'),
    stars,
    downloads,
    page,
  }
}

function readMyItem(raw: unknown): HubMe['items'][number] | null {
  if (!isRecord(raw) || !Array.isArray(raw.versions)) return null
  const { handle, name, kind, listed } = raw
  if (!isHandleText(handle) || typeof name !== 'string' || !isPluginId(name) || !isKind(kind)) return null
  if (listed !== null && typeof listed !== 'string') return null
  return { handle, name, kind, listed, versions: raw.versions.flatMap((one) => readVersion(one) ?? []) }
}

function readVersion(raw: unknown): HubMe['items'][number]['versions'][number] | null {
  if (!isRecord(raw)) return null
  const { version, state, note, analysis, createdAt } = raw
  if (typeof version !== 'string' || typeof state !== 'string' || typeof analysis !== 'string') return null
  if (typeof createdAt !== 'string' || (note !== null && typeof note !== 'string')) return null
  return { version, state, note, analysis, createdAt }
}

function isShown(value: unknown): value is HubItemInfo['shown'] {
  if (value === null) return true
  return (
    isRecord(value) && typeof value.version === 'string' && (value.state === 'pending' || value.state === 'approved')
  )
}

function isHandleText(value: unknown): value is string {
  return typeof value === 'string' && isHandle(value)
}

function isKind(value: unknown): value is HubItem['kind'] {
  return value === 'plugin' || value === 'skill'
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
