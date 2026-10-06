import {
  bedrockSearch,
  parseBedrock,
  parseBrave,
  parseJaspers,
  SEARCH_COUNT,
  type SearchResult,
} from '../../../shared/agent/web/search'
import { getProviderConfig, hasCredential, type ProviderConfig } from '../../secrets'

// Web search, for the orchestrator and the builder: the user's own Brave key, Jaspers' service on
// their Jaspers sign-in, or Amazon Bedrock's Web Search on their AWS account, answering in one shape. It
// says what happened and no more; what to do instead is each caller's to say in its tool's
// description, since only the builder may read an address it was not given. Reading a page is
// page-fetch.ts, which imports nothing of the app.

const SEARCH_TIMEOUT_MS = 15_000
/** Bedrock's search is a model searching and then writing out what it found: twelve to eighteen seconds, measured, where an engine takes one or two. */
const BEDROCK_TIMEOUT_MS = 60_000

export function searchAvailable(): boolean {
  const config = getProviderConfig('search')
  return config !== null && hasCredential(config)
}

/** The results as they came, so the tool can note their addresses before it writes them out. */
export async function searchWeb(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const config = getProviderConfig('search')
  if (!config || !hasCredential(config)) throw new Error('No search provider is set.')
  switch (config.provider.api) {
    case 'brave':
      return brave(config, query, signal)
    case 'jaspers':
      return jaspers(config, query, signal)
    case 'bedrock':
      return bedrock(config, query, signal)
  }
}

async function brave(config: ProviderConfig<'search'>, query: string, signal?: AbortSignal) {
  const url = `${config.baseUrl}/web/search?${new URLSearchParams({ q: query, count: String(SEARCH_COUNT) })}`
  const response = await config.fetch(url, {
    headers: { accept: 'application/json', 'x-subscription-token': config.token ?? '' },
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Brave Search answered ${response.status}${await reason(response)}`)
  return parseBrave(await response.json())
}

async function jaspers(config: ProviderConfig<'search'>, query: string, signal?: AbortSignal) {
  const url = `${config.baseUrl}/search?${new URLSearchParams({ q: query, count: String(SEARCH_COUNT) })}`
  // Sent as the account: the sign-in is the credential, and the request goes out with it.
  const response = await config.fetch(url, {
    headers: { accept: 'application/json' },
    signal: withTimeout(signal, SEARCH_TIMEOUT_MS),
  })
  if (response.status === 404) throw new Error('Search is not available on this account yet.')
  if (!response.ok) throw new Error(`Jaspers search answered ${response.status}${await reason(response)}`)
  return parseJaspers(await response.json())
}

/** A key whose IAM identity may not search is refused with a 401 that says so, which is passed on in Bedrock's words. */
async function bedrock(config: ProviderConfig<'search'>, query: string, signal?: AbortSignal) {
  const response = await config.fetch(`${config.baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token ?? ''}` },
    body: JSON.stringify(bedrockSearch(config.model, query)),
    signal: withTimeout(signal, BEDROCK_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Amazon Bedrock answered ${response.status}${await reason(response)}`)
  return parseBedrock(await response.json())
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
}

async function reason(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).split('\n')[0]?.slice(0, 200) ?? ''
  return text ? `: ${text}` : '.'
}
