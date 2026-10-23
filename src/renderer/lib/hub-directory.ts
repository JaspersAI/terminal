import { useCallback, useEffect, useRef, useState } from 'react'
import { BROWSER_PLUGIN_DESCRIPTION, BROWSER_PLUGIN_ID, BROWSER_PLUGIN_TITLE } from '../../shared/grid/browser.ts'
import type { HubItem } from '../../shared/hub/hub'
import { describeSource } from '../../shared/plugins/install.ts'
import { isNewerVersion } from '../../shared/plugins/semver.ts'
import type { AppState } from '../../shared/state'
import { errorMessage } from './errors.ts'

// The plugin directory's lists, from Jaspers Hub through main: the featured plugins, and every other
// plugin by stars, a page at a time, or what a search finds. Each part loads and fails on its own, and
// a part Hub could not give says why and waits for Retry. The rules are plain functions, so a test
// reads them; the hook is what the directory renders from.

/** Where an item stands here: installed, installed from it and behind Hub's version, or not here. */
export type Standing = 'installed' | 'update' | 'available'

/** One part of the directory as it loads: its items, or why Hub could not give them. */
export interface Part {
  items: HubItem[]
  loading: boolean
  error: string | null
}

export interface HubDirectory {
  featured: Part
  /** Everything else, a page at a time, or, while the search holds text, what it found. */
  others: Part & { more: boolean }
  query: string
  setQuery: (text: string) => void
  /** The next page of everything else. */
  more: () => void
  retryFeatured: () => void
  retryOthers: () => void
}

const SEARCH_DELAY_MS = 300
const LOADING: Part = { items: [], loading: true, error: null }

/**
 * Update when the plugin of this id was installed from this very item and Hub shows another version;
 * installed when any plugin has the id; else available. A plugin of the id from anywhere else is
 * never updated from Hub, since Update fetches from where it came.
 */
export function standing(item: HubItem, plugins: AppState['plugins']): Standing {
  const plugin = plugins[item.name]
  if (!plugin) return 'available'
  const fromHere = plugin.install?.source === describeSource({ kind: 'hub', handle: item.handle, name: item.name })
  return fromHere && plugin.install !== null && isNewerVersion(item.version, plugin.install.version)
    ? 'update'
    : 'installed'
}

/** Everything else: the pages without the featured plugins, which are shown above them. */
export function rest(featured: HubItem[], pages: HubItem[]): HubItem[] {
  const names = new Set(featured.map((item) => item.name))
  return pages.filter((item) => !names.has(item.name))
}

/** Built-in Browser entry shown among the Hub plugin list for every version with browser support. */
export const CORE_BROWSER_ITEM: HubItem = {
  handle: 'jaspers',
  name: BROWSER_PLUGIN_ID,
  kind: 'plugin',
  title: BROWSER_PLUGIN_TITLE,
  description: BROWSER_PLUGIN_DESCRIPTION,
  version: '1.0.0',
  tags: ['bloomberg', 'browser', 'video'],
  stars: 0,
  downloads: 0,
  official: true,
  reviewed: true,
  featured: false,
  page: '',
}

function wordForms(word: string): string[] {
  const forms = new Set([word])
  if (word.endsWith('ies') && word.length > 4 && word !== 'series') {
    forms.add(`${word.slice(0, -3)}y`)
  } else if (/(?:s|x|z|ch|sh)es$/.test(word) && word.length > 4) {
    forms.add(word.slice(0, -2))
  } else if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
    forms.add(word.slice(0, -1))
  }
  if (word.endsWith('y') && word.length > 3) {
    forms.add(`${word.slice(0, -1)}ies`)
  }
  if (word.endsWith('ing') && word.length > 5) {
    const base = word.slice(0, -3)
    forms.add(base)
    forms.add(`${base}e`)
  }
  return [...forms]
}

function fieldHas(text: string, word: string): boolean {
  return wordForms(word).some((form) => text.includes(form))
}

function itemTier(item: HubItem, query: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const words = q.split(/[^a-z0-9]+/).filter(Boolean)
  if (words.length === 0) return null
  const name = item.name.toLowerCase()
  const title = item.title.toLowerCase()
  const handle = item.handle.toLowerCase()
  const tags = item.tags.join(' ').toLowerCase()
  const description = item.description.toLowerCase()
  const full = [name, title, description, handle, tags, item.official ? 'official' : ''].join(' ')
  if (!words.every((w) => fieldHas(full, w))) return null
  if (name === q || title === q) return 0
  if (name.startsWith(q) || title.startsWith(q)) return 1
  if (words.every((w) => fieldHas(`${name} ${title}`, w))) return 2
  if (words.every((w) => fieldHas(`${name} ${title} ${handle} ${tags}`, w))) return 3
  if (description.includes(q)) return 4
  return 5
}

/** Includes the built-in Browser entry in the Hub plugin list when not searching or when the query matches it. */
export function withBrowserItem(items: HubItem[], query = ''): HubItem[] {
  const without = items.filter((one) => one.name !== BROWSER_PLUGIN_ID)
  return itemTier(CORE_BROWSER_ITEM, query) !== null ? [...without, CORE_BROWSER_ITEM] : without
}

/** Filters and ranks Hub plugins by matching every query word against their name, title, description, publisher, and tags. */
export function searchItems(items: HubItem[], query: string): HubItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items
    .map((item, index) => ({ item, tier: itemTier(item, q), index }))
    .filter((entry): entry is { item: HubItem; tier: number; index: number } => entry.tier !== null)
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((entry) => entry.item)
}

/** The directory's non-featured list, or what a search finds across loaded and searched items. */
export function othersPart(
  featured: Part,
  pages: Part & { more: boolean },
  found: Part | null,
  query = '',
): Part & { more: boolean } {
  const q = query.trim()
  if (!q) {
    return {
      items: rest(featured.items, pages.items),
      loading: pages.loading,
      error: pages.error,
      more: pages.more,
    }
  }
  const loaded = appendPage(featured.items, pages.items)
  const candidates = found ? appendPage(found.items, loaded) : loaded
  const items = searchItems(candidates, q)
  const hasMatch = items.length > 0 || itemTier(CORE_BROWSER_ITEM, q) !== null
  const waiting = found === null || found.loading
  const loading = waiting && (!hasMatch || pages.loading || pages.more)
  const error = found?.error ?? (!hasMatch ? pages.error : null)
  return { items, loading, error, more: false }
}

/** The items shown so far with the next page after them. Stars change between requests, so an item already shown is not shown again. */
export function appendPage(shown: HubItem[], next: HubItem[]): HubItem[] {
  const seen = new Set(shown.map(itemKey))
  return [...shown, ...next.filter((item) => !seen.has(itemKey(item)))]
}

/** The first letters of a title's first two words, for an item with no logo bundled. */
export function initials(title: string): string {
  return title
    .split(/\s+/)
    .flatMap((word) => /[A-Za-z0-9]/.exec(word)?.[0] ?? [])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/** What a part says when Hub could not give it: that, and why, without saying it twice. */
export function failure(err: unknown): string {
  const reason = errorMessage(err).replace(/^Hub could not be reached: /, '')
  return `Jaspers Hub could not be reached. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}`
}

/** One part from Hub. A refusal, or no answer by main's time limit, is the part's error; it never throws. */
export async function loadPart(load: () => Promise<HubItem[]>): Promise<Part> {
  try {
    return { items: await load(), loading: false, error: null }
  } catch (err) {
    return { items: [], loading: false, error: failure(err) }
  }
}

export function itemKey(item: HubItem): string {
  return `${item.handle}/${item.name}`
}

/** The directory's lists, loaded once it mounts. Only Settings searches. */
export function useHubDirectory({ search }: { search: boolean }): HubDirectory {
  const [featured, setFeatured] = useState<Part>(LOADING)
  const [pages, setPages] = useState<Part & { page: number; more: boolean }>({ ...LOADING, page: 0, more: false })
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Part | null>(null)
  const [searches, setSearches] = useState(0)
  // The latest request of each part: an answer to an earlier one arrives too late to show.
  const latest = useRef({ featured: 0, pages: 0, found: 0 })

  const loadFeatured = useCallback((): void => {
    const asked = ++latest.current.featured
    setFeatured(LOADING)
    void loadPart(() => window.app.hub.featured()).then((part) => {
      if (latest.current.featured === asked) setFeatured(part)
    })
  }, [])

  const loadPage = useCallback((page: number): void => {
    const asked = ++latest.current.pages
    setPages((was) => ({ ...was, loading: true, error: null }))
    let more = false
    void loadPart(async () => {
      const answer = await window.app.hub.page(page)
      more = answer.more
      return answer.items
    }).then((part) => {
      if (latest.current.pages !== asked) return
      setPages((was) =>
        part.error
          ? { ...was, loading: false, error: part.error }
          : { items: appendPage(was.items, part.items), loading: false, error: null, page, more },
      )
    })
  }, [])

  useEffect(() => {
    loadFeatured()
    loadPage(1)
  }, [loadFeatured, loadPage])

  useEffect(() => {
    const q = query.trim()
    const asked = ++latest.current.found
    if (!search || !q) {
      setFound(null)
      return
    }
    // What was found for the last text stays while the next search is on its way.
    setFound((was) => (was ? { ...was, loading: true, error: null } : LOADING))
    const timer = setTimeout(() => {
      void loadPart(() => window.app.hub.search(q)).then((part) => {
        if (latest.current.found === asked) setFound(part)
      })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [search, query, searches])

  return {
    featured,
    others: othersPart(featured, pages, found, search ? query : ''),
    query,
    setQuery,
    more: () => loadPage(pages.page + 1),
    retryFeatured: loadFeatured,
    retryOthers: () => {
      if (!search || !query.trim()) return loadPage(pages.page + 1)
      setFound(LOADING)
      setSearches((n) => n + 1)
    },
  }
}
