import { randomBytes } from 'node:crypto'
// The extension is explicit because Node's test runner resolves this import at run time.
import { pageAddress, parsePageAddress } from '../../shared/plugins/apps.ts'

// The pages read from servers, one for each panel showing one. apps.ts puts a page here when a panel
// opens it and viewhost.ts answers a frame's request from here, so a frame can only be given what a
// panel asked for: an address nothing opened reads nothing from any server.
//
// Each open is served at an address with a key made here. A frame is the server's code and can send
// itself anywhere on this scheme, and the rest of an address is the connection's id and the page's
// name, which another server's page can work out. Without the key, one connection's page could load
// another's into its own frame, where the host on the other side answers for the wrong connection.
// A panel's next open takes the place of its last, which is also how a server's new build of a page
// arrives, and a panel that is gone takes its page with it.

interface Page {
  html: string
  /** The page's Content-Security-Policy, as the header it is served with. */
  policy: string
}

interface Kept {
  workspaceId: string
  panelId: string
  /** The number of the open that read it. */
  open: number
  address: string
  page: Page
}

const pages = new Map<string, Kept>()
/** The number of each panel's latest open. */
const opens = new Map<string, number>()

const panelKey = (workspaceId: string, panelId: string): string => `${workspaceId}\n${panelId}`

/**
 * An open of a panel begins, before anything is read. Its number is what `keepPage` takes: the page
 * is read from the server in between, two opens of one panel can be answered in either order, and
 * the panel shows the one it asked for last.
 */
export function beginOpen(workspaceId: string, panelId: string): number {
  const key = panelKey(workspaceId, panelId)
  const open = (opens.get(key) ?? 0) + 1
  opens.set(key, open)
  return open
}

/**
 * Keeps the page an open read, in place of the panel's last, and answers where it is served. An open
 * that is no longer the panel's latest keeps nothing: its address is answered all the same, and
 * serves nothing.
 */
export function keepPage(
  workspaceId: string,
  panelId: string,
  open: number,
  at: { connection: string; uri: string },
  page: Page,
): string {
  const address = pageAddress(at.connection, at.uri, randomBytes(16).toString('base64url'))
  const key = panelKey(workspaceId, panelId)
  if (opens.get(key) === open) pages.set(key, { workspaceId, panelId, open, address, page })
  return address
}

/** The page a frame asked for, or null. The address is read and written back, so only the whole of one a panel was given finds a page. */
export function pageAt(url: string): Page | null {
  const named = parsePageAddress(url)
  if (!named || named.key === '') return null
  const address = pageAddress(named.connection, named.uri, named.key)
  for (const kept of pages.values()) {
    if (kept.address === address) return kept.page
  }
  return null
}

/**
 * Whether an address is the one a panel's latest open was given: what a frame says to show it is the
 * panel's own. A frame can outlive its open, by the moment it takes to be told it is going, and from
 * the moment the panel is opened again the frame that asks is no longer the panel's.
 */
export function isOpen(workspaceId: string, panelId: string, address: string): boolean {
  const key = panelKey(workspaceId, panelId)
  const kept = pages.get(key)
  return kept !== undefined && kept.address === address && opens.get(key) === kept.open
}

/** Drops the page of every panel that is gone. */
export function keepOnlyPages(live: (workspaceId: string, panelId: string) => boolean): void {
  for (const [key, kept] of pages) {
    if (live(kept.workspaceId, kept.panelId)) continue
    pages.delete(key)
    opens.delete(key)
  }
}
