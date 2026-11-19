import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyFetchFailure,
  connectivityBannerText,
  connectivityRetryHeadline,
  formatFetchFailure,
  formatStreamDropFailure,
  isConnectivityMessage,
  isLocalUnreachableMessage,
  isLoopbackUrl,
} from './connectivity.ts'

test('isLoopbackUrl distinguishes local model servers from cloud endpoints', () => {
  for (const url of [
    'http://localhost:11434/v1/chat/completions',
    'http://ollama.localhost:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://127.0.1.1:8080/v1',
    'http://[::1]:11434/v1',
    'http://0.0.0.0:11434/v1',
  ]) {
    assert.equal(isLoopbackUrl(url), true, url)
  }
  for (const url of [
    'https://account.jsprai.com/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
    'https://openrouter.ai/api/v1/chat/completions',
    '',
    'not a url',
  ]) {
    assert.equal(isLoopbackUrl(url), false, url)
  }
})

test('classifyFetchFailure and formatFetchFailure turn raw fetch/DNS/offline errors into calm connectivity guidance', () => {
  const cloudUrl = 'https://account.jsprai.com/v1/chat/completions'

  // Bare undici fetch failure (no cause) or nested OAuth discovery wrapper.
  const bareFetch = new TypeError('fetch failed')
  assert.equal(classifyFetchFailure(bareFetch, cloudUrl, true), 'connectivity')
  assert.equal(
    formatFetchFailure('Jaspers', bareFetch, cloudUrl, true),
    "Connection issue — couldn't reach Jaspers. Check your internet connection and try again; your workspace is safe.",
  )

  const nestedDns = new Error('fetch failed', {
    cause: new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND account.jsprai.com'), { code: 'ENOTFOUND' }),
    }),
  })
  assert.equal(classifyFetchFailure(nestedDns, cloudUrl, true), 'connectivity')
  assert.equal(
    formatFetchFailure('Jaspers', nestedDns, cloudUrl, true),
    "Connection issue — couldn't reach Jaspers. Check your internet connection and try again; your workspace is safe.",
  )

  // Happy Eyeballs AggregateError with empty top-level message and ENETUNREACH causes.
  const unreachableAggregate = new TypeError('fetch failed', {
    cause: new AggregateError([
      Object.assign(new Error('connect ENETUNREACH 3.19.30.251:443'), { code: 'ENETUNREACH' }),
      Object.assign(new Error('connect EHOSTUNREACH 2600::1:443'), { code: 'EHOSTUNREACH' }),
    ]),
  })
  assert.equal(classifyFetchFailure(unreachableAggregate, cloudUrl, true), 'offline')
  assert.equal(
    formatFetchFailure('Jaspers', unreachableAggregate, cloudUrl, true),
    "No internet connection — couldn't reach Jaspers. Check your network connection and try again; your workspace is safe.",
  )

  // OS explicitly reports offline (`net.isOnline() === false`).
  assert.equal(classifyFetchFailure(bareFetch, cloudUrl, false), 'offline')
  assert.equal(
    formatFetchFailure('Anthropic', bareFetch, 'https://api.anthropic.com/v1/messages', false),
    "No internet connection — couldn't reach Anthropic. Check your network connection and try again; your workspace is safe.",
  )

  // Local loopback server refused connection while offline: blames the local server, not internet access.
  const localRefused = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),
  })
  assert.equal(
    classifyFetchFailure(localRefused, 'http://localhost:11434/v1/chat/completions', false),
    'local-unreachable',
  )
  const localMsg = formatFetchFailure('Ollama', localRefused, 'http://localhost:11434/v1/chat/completions', false)
  assert.equal(
    localMsg,
    'Could not connect to local server for Ollama (localhost:11434) — make sure Ollama is running.',
  )
  assert.equal(isLocalUnreachableMessage(localMsg), true)
  assert.equal(isConnectivityMessage(localMsg), false)
})

test('classifyFetchFailure leaves auth refusals, timeouts, sleep interrupts, and TLS errors untouched', () => {
  const cloudUrl = 'https://account.jsprai.com/v1/chat/completions'
  const refused = Object.assign(new Error('Your monthly allowance is used up.'), { name: 'RefusedError' })
  const signedOut = Object.assign(new Error('Not signed in to Jaspers.'), { name: 'SignedOutError' })
  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
  const timedOut = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const sleepAbort = new Error('connection dropped across sleep')
  const tlsCert = new TypeError('fetch failed', {
    cause: Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    }),
  })

  for (const err of [refused, signedOut, aborted, timedOut, sleepAbort, tlsCert]) {
    assert.equal(classifyFetchFailure(err, cloudUrl, false), null, String(err))
  }
  assert.equal(formatFetchFailure('Jaspers', refused, cloudUrl, false), 'Jaspers: Your monthly allowance is used up.')
  assert.match(formatFetchFailure('Custom', tlsCert, cloudUrl, true), /UNABLE_TO_VERIFY_LEAF_SIGNATURE/)
})

test('formatStreamDropFailure explains mid-stream drops when offline and preserves online stream cutoffs', () => {
  const cloudUrl = 'https://account.jsprai.com/v1/chat/completions'
  const terminated = new TypeError('terminated', { cause: new Error('other side closed') })
  assert.equal(
    formatStreamDropFailure('Jaspers', terminated, cloudUrl, true),
    'Jaspers: terminated (other side closed)',
  )
  assert.equal(
    formatStreamDropFailure('Jaspers', terminated, cloudUrl, false),
    'No internet connection — connection to Jaspers dropped. Check your network connection and try again; your workspace is safe.',
  )
})

test('connectivityRetryHeadline, isConnectivityMessage, and connectivityBannerText cover banner and retry states', () => {
  const offlineMsg =
    "No internet connection — couldn't reach Jaspers. Check your network connection and try again; your workspace is safe."
  const issueMsg =
    "Connection issue — couldn't reach Jaspers. Check your internet connection and try again; your workspace is safe."

  assert.equal(isConnectivityMessage(offlineMsg), true)
  assert.equal(isConnectivityMessage(issueMsg), true)
  assert.equal(isConnectivityMessage('Jaspers: fetch failed'), true)
  assert.equal(isConnectivityMessage('Anthropic returned 401: invalid x-api-key'), false)

  assert.equal(connectivityRetryHeadline(offlineMsg), "No internet connection — couldn't reach Jaspers")
  assert.equal(connectivityRetryHeadline(issueMsg), "Connection issue — couldn't reach Jaspers")
  assert.equal(connectivityRetryHeadline('Amazon Bedrock returned 529: Overloaded'), null)

  assert.equal(
    connectivityBannerText({ browserOnline: true, recentConnectivityIssue: false, dismissed: false, localLlm: false }),
    null,
  )
  assert.match(
    connectivityBannerText({
      browserOnline: false,
      recentConnectivityIssue: false,
      dismissed: false,
      localLlm: false,
    }) ?? '',
    /Offline — internet connection lost.*workspace and rooms are safe/,
  )
  assert.match(
    connectivityBannerText({
      browserOnline: false,
      recentConnectivityIssue: false,
      dismissed: false,
      localLlm: true,
    }) ?? '',
    /local model and workspace still work/,
  )
  assert.match(
    connectivityBannerText({ browserOnline: true, recentConnectivityIssue: true, dismissed: false, localLlm: false }) ??
      '',
    /Connection issue — Terminal could not reach the internet/,
  )
  assert.equal(
    connectivityBannerText({ browserOnline: false, recentConnectivityIssue: true, dismissed: true, localLlm: false }),
    null,
  )
})
