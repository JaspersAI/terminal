import { useCallback, useEffect, useRef, useState } from 'react'
import type { HubItem } from '../../shared/hub/hub'
import { describeSource } from '../../shared/plugins/install.ts'
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
  return fromHere && plugin.install?.version !== item.version ? 'update' : 'installed'
}

/** Everything else: the pages without the featured plugins, which are shown above them. */
export function rest(featured: HubItem[], pages: HubItem[]): HubItem[] {
  const names = new Set(featured.map((item) => item.name))
  return pages.filter((item) => !names.has(item.name))
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
    setFound((was) => was ?? LOADING)
    const timer = setTimeout(() => {
      void loadPart(() => window.app.hub.search(q)).then((part) => {
        if (latest.current.found === asked) setFound(part)
      })
    }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [search, query, searches])

  return {
    featured,
    others: found
      ? { ...found, more: false }
      : {
          items: rest(featured.items, pages.items),
          loading: pages.loading,
          error: pages.error,
          more: pages.more,
        },
    query,
    setQuery,
    more: () => loadPage(pages.page + 1),
    retryFeatured: loadFeatured,
    retryOthers: () => {
      if (!found) return loadPage(pages.page + 1)
      setFound(LOADING)
      setSearches((n) => n + 1)
    },
  }
}
