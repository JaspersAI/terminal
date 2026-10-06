// Web search results, from whichever service answered, in one shape the model reads, the
// orchestrator's or the builder's. Brave's web search on the user's own key, Jaspers' account
// service, which answers in the shape below, or Amazon Bedrock's Web Search, which is a model that
// searches and is asked here to write out what it found.

export const SEARCH_COUNT = 8

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

/** Brave: `web.results[]` with `title`, `url`, and `description`. */
export function parseBrave(json: unknown): SearchResult[] {
  const web = isRecord(json) && isRecord(json['web']) ? json['web'] : null
  return results(web ? web['results'] : undefined, 'description')
}

/** Jaspers: `results[]` with `title`, `url`, and `snippet`. */
export function parseJaspers(json: unknown): SearchResult[] {
  return results(isRecord(json) ? json['results'] : undefined, 'snippet')
}

/**
 * What Bedrock's model is told, so it lists what its search found instead of answering: left to
 * itself it opens pages and writes an essay, which took two minutes where this takes a quarter of one.
 */
const RESULTS_PAGE =
  "Act as a search engine's results page, not as an assistant. Search the web once, with the user's words as the query. Then write only a list of the pages that search returned, up to eight, most relevant first, one per line: a dash, one sentence from the page's snippet saying what the page holds, then its citation. Never answer or summarize the query yourself. If the search returned nothing, write No results."

/**
 * One search on Bedrock: a Responses API request with its Web Search tool, to a model that has it.
 * The tool stays on Amazon's own index (`external_web_access` off), so the query never leaves AWS and
 * the key needs no permission beyond the search itself; `medium` is up to eleven results a search,
 * which covers the eight wanted. `store` is off because what a user searched for is not Bedrock's to keep.
 */
export function bedrockSearch(model: string, query: string): Record<string, unknown> {
  return {
    model,
    instructions: RESULTS_PAGE,
    input: query,
    tools: [{ type: 'web_search', external_web_access: false, search_context_size: 'medium' }],
    reasoning: { effort: 'low' },
    max_output_tokens: 1200,
    store: false,
  }
}

/**
 * Bedrock: the pages the answer cites, `output[].content[].annotations[]` of type `url_citation`,
 * each with a `title` and a `url`, an address once. A citation has no snippet of its own, so it is
 * what the line citing the page says of it.
 */
export function parseBedrock(json: unknown): SearchResult[] {
  const found: SearchResult[] = []
  const seen = new Set<string>()
  for (const item of list(isRecord(json) ? json['output'] : undefined)) {
    if (!isRecord(item) || item['type'] !== 'message') continue
    for (const block of list(item['content'])) {
      if (!isRecord(block)) continue
      const lines = typeof block['text'] === 'string' ? block['text'].split('\n') : []
      for (const cited of list(block['annotations'])) {
        if (!isRecord(cited) || cited['type'] !== 'url_citation') continue
        const url = cited['url']
        if (typeof url !== 'string' || !url || seen.has(url)) continue
        seen.add(url)
        const title = typeof cited['title'] === 'string' && cited['title'] ? cited['title'] : url
        found.push({ title, url, snippet: saidOf(url, lines) })
        if (found.length >= SEARCH_COUNT) return found
      }
    }
  }
  return found
}

/** A markdown link, whose address may itself hold a pair of brackets, in the brackets a citation is written in. */
const CITATION = /\(?\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)\)?/g

/** What the line linking `url` says, without its list mark and its citations; nothing when no line links it. */
function saidOf(url: string, lines: string[]): string {
  const line = lines.find((one) => one.includes(`](${url})`)) ?? ''
  return line
    .replace(CITATION, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .trim()
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function results(raw: unknown, snippetKey: string): SearchResult[] {
  if (!Array.isArray(raw)) return []
  const found: SearchResult[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry['url'] !== 'string' || !entry['url']) continue
    const url = entry['url']
    const title = typeof entry['title'] === 'string' && entry['title'] ? entry['title'] : url
    const snippet = typeof entry[snippetKey] === 'string' ? entry[snippetKey] : ''
    found.push({ title, url, snippet })
    if (found.length >= SEARCH_COUNT) break
  }
  return found
}

/** Numbered, an address on its own line, so the model can link one or fetch_page it. */
export function formatResults(list: SearchResult[]): string {
  if (list.length === 0) return 'No results. Try other words.'
  return list
    .map((result, index) =>
      [`${index + 1}. ${result.title}`, `   ${result.url}`, ...(result.snippet ? [`   ${result.snippet}`] : [])].join(
        '\n',
      ),
    )
    .join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
