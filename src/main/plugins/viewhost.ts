import { protocol } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { APP_SCHEME } from '../../shared/plugins/apps'
import { viewPolicy } from '../../shared/plugins/plugins'
import { pageAt } from './app-pages'
import { bundlePath } from './plugins'
import { getState } from '../state'

// Where a plugin's view runs: an iframe on two schemes of our own. jaspers-plugin://<id>/ is the
// page, generated below, with the plugin's built bundle beside it; jaspers-host://runtime/ is what
// the page borrows from the app, the one runtime bundle of React, zod, and the SDK that
// scripts/build-host-runtime.mjs writes into out/host-runtime. Both are privileged so the page is a
// secure origin with modules and fetch, and the page itself is sandboxed with no network: whatever
// the view reads or writes goes over the bridge to the renderer instead. The page's policy is
// viewPolicy's, with the sites the plugin declared it frames.
//
// A third scheme, jaspers-app://<connection>/, is where a server's own page for one of its tools
// runs (MCP Apps). That page is the server's code, not a plugin's: it is served as its server wrote
// it, from what apps.ts read, on an origin of its connection's own, with the policy the page declared
// as a response header, which holds before any of the page runs.

/** The five names the host provides, the ones the plugin build leaves external. */
const IMPORT_MAP = {
  imports: {
    react: 'jaspers-host://runtime/react.js',
    'react/jsx-runtime': 'jaspers-host://runtime/jsx-runtime.js',
    'react-dom': 'jaspers-host://runtime/react-dom.js',
    'react-dom/client': 'jaspers-host://runtime/react-dom-client.js',
    zod: 'jaspers-host://runtime/zod.js',
    '@jaspers-ai/sdk': 'jaspers-host://runtime/sdk.js',
  },
}

/** Everything a plugin's folder serves. The page is generated, so only the build's output is read. */
const PLUGIN_FILES = new Set(['/bundle.js', '/bundle.css'])

/** A plugin id is a folder name; anything else cannot name one and is not looked up. */
const PLUGIN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

/** Schemes have to be declared before the app is ready, which is why this is not in the handler file's. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    ...['jaspers-plugin', 'jaspers-host'].map((scheme) => ({
      // corsEnabled because a module script is fetched with CORS and the sandboxed page's origin is
      // opaque, so every load from these schemes is a cross-origin one.
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
      scheme,
    })),
    // Standard so each connection's host is an origin, secure so a page gets what a secure context does.
    // Nothing fetches from it: the page is the one thing served there.
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

/** The handlers, once the app is ready. */
export function registerViewHost(): void {
  protocol.handle('jaspers-host', async (request) => {
    const url = new URL(request.url)
    if (url.hostname !== 'runtime') return notFound()
    return serve(inside(runtimeDir(), url.pathname))
  })

  protocol.handle('jaspers-plugin', async (request) => {
    const url = new URL(request.url)
    const id = url.hostname
    if (!PLUGIN_ID.test(id)) return notFound()
    if (url.pathname === '/index.html') {
      return new Response(indexHtml(getState().plugins[id]?.frames ?? []), { headers: headers(TYPES['.html']!) })
    }
    if (!PLUGIN_FILES.has(url.pathname)) return notFound()
    return serve(inside(path.dirname(bundlePath(id)), url.pathname))
  })

  protocol.handle(APP_SCHEME, (request) => {
    const page = request.method === 'GET' ? pageAt(request.url) : null
    if (!page) return notFound()
    return new Response(page.html, {
      headers: {
        'cache-control': 'no-store',
        'content-security-policy': page.policy,
        'content-type': TYPES['.html']!,
        'x-content-type-options': 'nosniff',
      },
    })
  })
}

/** Main runs from out/main, and the runtime is built beside it. */
function runtimeDir(): string {
  return path.join(__dirname, '../host-runtime')
}

/**
 * The page every plugin view gets. The import map is what makes the plugin's bare imports resolve to
 * the host's runtime, so there is one React in the frame; boot.js reads the query and mounts the view.
 * The theme comes first, so the plugin's own CSS can read its variables.
 */
function indexHtml(frames: readonly string[]): string {
  const nonce = randomBytes(16).toString('base64')
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${viewPolicy(nonce, frames)}">
<script type="importmap" nonce="${nonce}">${JSON.stringify(IMPORT_MAP)}</script>
<link rel="stylesheet" href="jaspers-host://runtime/theme.css">
<link rel="stylesheet" href="./bundle.css">
<style>html,body,#root{margin:0;height:100%;overflow:hidden}body{font:14px var(--jaspers-font-sans);color:var(--jaspers-foreground);background:var(--jaspers-background)}*{box-sizing:border-box}button,input,select,textarea{font:inherit;border-radius:0}</style>
</head><body><div id="root"></div><script type="module" src="jaspers-host://runtime/boot.js"></script></body></html>
`
}

/** The file a path names, or null when it would leave the folder it is served from. */
function inside(dir: string, pathname: string): string | null {
  const file = path.join(dir, decodeURIComponent(pathname))
  const relative = path.relative(dir, file)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return file
}

async function serve(file: string | null): Promise<Response> {
  if (!file) return notFound()
  try {
    return new Response(await fs.readFile(file), {
      headers: headers(TYPES[path.extname(file)] ?? 'application/octet-stream'),
    })
  } catch {
    // A plugin that imports no CSS has no bundle.css, and the page's link tag is harmless without it.
    return notFound()
  }
}

/**
 * A module is fetched with CORS and the sandboxed page's origin is opaque, so the answer has to say
 * anyone may read it. Nothing served here is secret: it is the user's own plugin and the app's own
 * runtime. Nothing is cached either, since a rebuild writes the same paths.
 */
function headers(type: string): Record<string, string> {
  return { 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-type': type }
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
