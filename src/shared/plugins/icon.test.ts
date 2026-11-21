import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bundledProviderId,
  detectIconMime,
  extractPublicHostname,
  ICON_MAX_BYTES,
  parentWebDomain,
  parseHtmlIconLinks,
  pluginIconOrigins,
} from './icon.ts'

test('bundledProviderId resolves exact ids, common aliases, and declared service hosts', () => {
  assert.equal(bundledProviderId('slack'), 'slack')
  assert.equal(bundledProviderId('yfinance'), 'yfinance')
  assert.equal(bundledProviderId('yahoo-finance'), 'yfinance')
  assert.equal(bundledProviderId('sec-edgar'), 'sec')
  assert.equal(bundledProviderId('discover'), 'screener-mcp')
  assert.equal(bundledProviderId('custom-macro', ['https://api.stlouisfed.org']), 'fred')
  assert.equal(bundledProviderId('my-feed', ['https://api.polygon.io/v2']), 'polygon')
  assert.equal(bundledProviderId('custom-unknown', ['https://api.kalshi.com']), null)
})

test('extractPublicHostname strips secret placeholders and rejects private or non-https inputs', () => {
  assert.equal(extractPublicHostname('https://mcp.linear.app/mcp?key=${secret:TOKEN}'), 'mcp.linear.app')
  assert.equal(extractPublicHostname('api.elections.kalshi.com'), 'api.elections.kalshi.com')
  assert.equal(extractPublicHostname('*.example.com'), 'example.com')
  assert.equal(extractPublicHostname('http://insecure.example.com'), null)
  assert.equal(extractPublicHostname('https://localhost:8080/mcp'), null)
  assert.equal(extractPublicHostname('127.0.0.1'), null)
  assert.equal(extractPublicHostname('internal.local'), null)
})

test('parentWebDomain derives primary web domains without collapsing multi-part TLDs or PaaS suffixes', () => {
  assert.equal(parentWebDomain('kalshi.com'), null)
  assert.equal(parentWebDomain('api.kalshi.com'), 'kalshi.com')
  assert.equal(parentWebDomain('api.elections.kalshi.com'), 'kalshi.com')
  assert.equal(parentWebDomain('gamma-api.polymarket.com'), 'polymarket.com')
  assert.equal(parentWebDomain('api.service.co.uk'), 'service.co.uk')
  assert.equal(parentWebDomain('service.co.uk'), null)
  assert.equal(parentWebDomain('my-mcp.vercel.app'), null)
  assert.equal(parentWebDomain('my-mcp.workers.dev'), null)
})

test('pluginIconOrigins prioritizes primary domains ahead of API subdomains and skips code hosts', () => {
  const origins = pluginIconOrigins(
    {
      frames: [],
      secrets: {},
      connections: {
        server: { url: 'https://mcp.linear.app/sse?token=${secret:API_KEY}' },
      },
      sources: {
        markets: {
          hosts: ['gamma-api.polymarket.com', 'api.jsprai.com'],
        },
      },
    },
    'https://github.com/acme/plugin-linear',
  )
  assert.deepEqual(origins, [
    'https://linear.app',
    'https://mcp.linear.app',
    'https://polymarket.com',
    'https://gamma-api.polymarket.com',
  ])
})

test('detectIconMime accepts valid images and safe static SVGs while rejecting HTML, scripts, and oversize payloads', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(detectIconMime(png), 'image/png')

  const ico = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 32, 32, 0, 0, 1, 0, 32, 0, 0, 0])
  assert.equal(detectIconMime(ico), 'image/x-icon')

  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>',
  )
  assert.equal(detectIconMime(svg), 'image/svg+xml')

  const scriptedSvg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  )
  assert.equal(detectIconMime(scriptedSvg), null)

  const html404 = new TextEncoder().encode('<!doctype html><html><body>404 Not Found</body></html>')
  assert.equal(detectIconMime(html404), null)

  const oversized = new Uint8Array(ICON_MAX_BYTES + 1)
  oversized.set(png, 0)
  assert.equal(detectIconMime(oversized), null)
})

test('parseHtmlIconLinks ranks apple-touch-icon and high-res PNG links ahead of ico fallbacks', () => {
  const html = `<!doctype html><html><head>
    <link rel="shortcut icon" href="/favicon.ico">
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
    <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
    <link rel="icon" type="image/svg+xml" href="https://cdn.kalshi.com/favicon.svg">
  </head><body></body></html>`
  const links = parseHtmlIconLinks(html, 'https://kalshi.com/')
  assert.equal(links[0], 'https://kalshi.com/icons/apple-touch-icon.png')
  assert.ok(links.includes('https://cdn.kalshi.com/favicon.svg'))
  assert.ok(links.includes('https://kalshi.com/favicon.ico'))
})
