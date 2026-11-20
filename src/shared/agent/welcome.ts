import { ABOUT_MAX, BODY_MAX } from './memory.ts'

// Onboarding in Central once setup completes and the workspace opens: Central docks at the top-center
// of the grid, greets the user with a concise overview of Jaspers Terminal's core architecture, walks
// through three skippable profiling questions, saves the resulting profile to memory, and recommends
// tailored Jaspers Hub plugins and starter rooms. Pure: no Node or DOM imports.

/**
 * The turn in front of each welcome message in a workspace's thread. The message is the assistant's own
 * turn; this says what it is, in the user's place, since a user's turn is what the user typed and the
 * welcome must never pass for that. The transcript hides it and shows the message as said unasked.
 */
export const WELCOME_NOTE =
  '(The reply below is one of the messages the assistant says on its own to welcome the user after setup, not an answer to anything the user typed.)'

export const GREETING = 'Hi, I’m Jaspers, the assistant in this terminal. Welcome.'

export function greetingFor(firstName?: string | null): string {
  const clean = typeof firstName === 'string' ? firstName.trim() : ''
  return clean ? `Hi ${clean}, I’m Jaspers, the assistant in this terminal. Welcome.` : GREETING
}

/** Concise one-paragraph summary of how to talk to the terminal and navigate tabs, rooms, Orb, and Dock. */
export const EXPLANATION = [
  'This is an open-inference terminal for public-market research: tabs along the bottom, isolated numbered rooms on a 100×100 spreadsheet grid, a local SQLite data plane, and MCP plugins.',
  'To talk, tap the microphone or press Orb to open the voice orb (or hold the orb while you speak).',
  'Typing in Central or the top command line works any time, and Dock toggles Central on the active tab.',
].join(' ')

export const EXAMPLE_ASK =
  '(The user has just finished setting up Jaspers Terminal and is looking at an empty workspace. Give them one concise example of something they could ask you for with what is installed, in quotes.)'

export const EXAMPLE_FALLBACK =
  'Try me with something small: "put a note on the grid with my watchlist". Settings > Plugins adds more to ask for.'

export const WELCOME_PREFACE =
  'This one request is the app welcoming a new user, not the user typing, and it comes with no tools: answer in text alone.'

/**
 * The opening Markdown message filed into Central's conversation on first launch: greets the user and
 * highlights the core architectural pillars of Jaspers Terminal from the README.
 */
export function welcomeIntroFor(firstName?: string | null): string {
  const clean = typeof firstName === 'string' ? firstName.trim() : ''
  const heading = clean ? `**Welcome to Jaspers Terminal, ${clean}.**` : '**Welcome to Jaspers Terminal.**'
  return [
    `${heading} I’m **Jaspers**, your central orchestrator across tabs and rooms—talk via **Orb** / mic, or type here or in the top command line (\`Dock\` toggles this pane).`,
    '',
    '- **100×100 Grid & Isolated Rooms (`room_1`, `room_2`, …):** Numbered tiles with isolated thinking agents, live `Table` / `Chart` / `Metric` / `Browser` views, searchable `Rooms` history, and cell formulas (`=`, `NPV`, `IRR`).',
    '- **Local SQLite Data Plane (`~/Jaspers/data/jaspers.db`):** Payloads and filings stay off-prompt in local SQLite + FTS5 with OS-keychain secrets, direct SQL, and cited quotes.',
    '- **MCP Hub, Coding Agent & Market Watches:** Add plugins from **Jaspers Hub**, generate custom `@jaspers-ai/sdk` plugins (`build_plugin`), and run `/skills` or NYSE delta watches (`speak: "changed"`).',
  ].join('\n')
}

export type OnboardingQuestionId = 'style' | 'coverage' | 'workflows'

export interface OnboardingChoice {
  id: string
  label: string
  detail: string
}

export interface OnboardingQuestion {
  id: OnboardingQuestionId
  title: string
  /** One concise line connecting this question to a core capability of Jaspers Terminal. */
  highlight: string
  choices: readonly OnboardingChoice[]
  focusPlaceholder?: string
}

export const ONBOARDING_QUESTIONS: readonly OnboardingQuestion[] = [
  {
    id: 'style',
    title: 'How do you work the markets?',
    highlight:
      'Two-tier model routing lets Central answer quick questions fast while spinning up isolated Grid Rooms on your thinking model—each room blind to other rooms and saved chronologically in memory.',
    choices: [
      {
        id: 'fundamental',
        label: 'Fundamental & Equities',
        detail: 'Single-name deep dives, 10-K/10-Q filings, earnings & valuation comps',
      },
      {
        id: 'macro',
        label: 'Macro & Cross-Asset',
        detail: 'Rates, yield curves, inflation/labor releases, central banks & FX',
      },
      {
        id: 'quant',
        label: 'Quant & Systematic',
        detail: 'Factor screens, SQL time-series queries over jaspers.db & scripts',
      },
      {
        id: 'trading',
        label: 'Active Trading & Flow',
        detail: 'Technical charts, futures positioning, short interest & catalysts',
      },
    ],
  },
  {
    id: 'coverage',
    title: 'What markets, data, or tickers are on your radar?',
    highlight:
      'Context offloading stores every source call in ~/Jaspers/data/jaspers.db (runs, run_rows, and FTS5 docs) so models query bounded SQL slices without overflowing context windows.',
    choices: [
      {
        id: 'us-equities',
        label: 'US Equities & SEC Filers',
        detail: '~7,100 SEC registrants, 10-K/10-Q/8-K filings, XBRL facts & Form 4s',
      },
      {
        id: 'rates-fiscal',
        label: 'US Rates, Fed & Treasury',
        detail: 'Daily H.15 yield curve, Treasury auctions, CPI/payrolls & fiscal series',
      },
      {
        id: 'global-macro',
        label: 'Global Macro & Central Banks',
        detail: 'ECB reference FX rates, IMF DataMapper forecasts & OECD indicators',
      },
      {
        id: 'positioning',
        label: 'Positioning & Short Flow',
        detail: 'Weekly CFTC Commitments of Traders, FINRA short interest & movers',
      },
    ],
    focusPlaceholder: 'Optional watchlist tickers or themes (e.g. NVDA, MSFT, semis, US10Y)',
  },
  {
    id: 'workflows',
    title: 'Which terminal capabilities do you want in play first?',
    highlight:
      'Beyond Jaspers Hub plugins and live Browser tiles, build_plugin writes custom @jaspers-ai/sdk plugins with security-envelope approval, /skills store playbooks, NYSE delta watches poll SQLite, and Pro mode runs sandboxed scripts in ~/Jaspers/shell.',
    choices: [
      {
        id: 'filings-screen',
        label: 'Qualitative Screens & Cited Filings',
        detail: 'Plain-English filing screens and verified SEC quotes',
      },
      {
        id: 'charts-browser',
        label: 'Live Charts, Feeds & Browser',
        detail: 'Interactive grid charts, market feeds & live web/Bloomberg rooms',
      },
      {
        id: 'watches-skills',
        label: 'NYSE Delta Watches & /skills',
        detail: 'Market-calendar schedules (speak: "changed") & SKILL.md workflows',
      },
      {
        id: 'builder-shell',
        label: 'Plugin Coding Agent & Pro Mode',
        detail: 'On-demand @jaspers-ai/sdk plugin builds & sandboxed Python/R/shell',
      },
    ],
  },
]

export interface OnboardingAnswers {
  style: string[]
  coverage: string[]
  workflows: string[]
  focusText: string
}

export const EMPTY_ONBOARDING_ANSWERS: OnboardingAnswers = {
  style: [],
  coverage: [],
  workflows: [],
  focusText: '',
}

export type PluginAuthBadge = 'No key' | 'Jaspers One' | 'API key'

export interface SuggestedPlugin {
  handle: string
  name: string
  title: string
  description: string
  reason: string
  auth: PluginAuthBadge
}

export interface SuggestedRoom {
  id: string
  title: string
  desc: string
  summary: string
  brief: string
  systemPrompt: string
  prompt: string
  preferredPlugins: string[]
  initialBrowserUrl?: string
}

export interface OnboardingProfile {
  headline: string
  summary: string
  answered: boolean
  tickers: string[]
  memory: {
    name: 'user-profile'
    about: string
    body: string
  } | null
  plugins: SuggestedPlugin[]
  rooms: SuggestedRoom[]
}

export type OnboardingStep = 0 | 1 | 2 | 'recommendations'

export interface WelcomeOnboarding {
  step: OnboardingStep
  answers: OnboardingAnswers
  profile: OnboardingProfile | null
  /** Starter room id -> created room display title (such as "Room 1"). */
  startedRooms: Record<string, string>
}

export type OnboardingAction =
  | { kind: 'answer'; step: 0 | 1 | 2; selected: string[]; focusText?: string }
  | { kind: 'skip-question'; step: 0 | 1 | 2; focusText?: string }
  | { kind: 'back' }
  | { kind: 'show-recommendations' }
  | { kind: 'skip-all' }
  | { kind: 'dismiss' }
  | { kind: 'start-room'; roomId: string }

const FOCUS_TEXT_MAX = 160
const TICKER_TOKEN = /^[A-Z]{1,5}(?:\.[A-Z])?$/
const NON_TICKER_WORDS = new Set([
  'US',
  'EU',
  'UK',
  'FX',
  'AI',
  'ETF',
  'ETFS',
  'GDP',
  'CPI',
  'PCE',
  'PMI',
  'NFP',
  'FED',
  'ECB',
  'IMF',
  'OECD',
  'BLS',
  'SEC',
  'CFTC',
  'FINRA',
  'NYSE',
  'SQL',
  'MCP',
  'DCF',
  'IRR',
  'NPV',
  'YOY',
  'QOQ',
  'AND',
  'OR',
  'THE',
  'FOR',
  'WITH',
  'INTO',
  'FROM',
  'TECH',
  'SEMI',
  'SEMIS',
  'SAAS',
  'RATES',
  'BONDS',
  'MACRO',
  'OIL',
  'GAS',
  'GOLD',
  'BANKS',
])

/** Extracts clean uppercase ticker symbols from free-form focus text, preserving user order. */
export function parseWatchlistTickers(focusText: string): string[] {
  const rawTokens = focusText
    .split(/[\s,;/|]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  const hasProseWord = rawTokens.some((t) => !t.startsWith('$') && t === t.toLowerCase() && t.length > 5)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of rawTokens) {
    const prefixed = raw.startsWith('$')
    const token = raw.replace(/^\$/, '')
    if (!token) continue
    const upper = token.toUpperCase()
    const isExplicitUpper = token === upper && /[A-Z]/.test(token)
    const isShortTickerListItem = !hasProseWord && token.length <= 5
    if (!prefixed && !isExplicitUpper && !isShortTickerListItem) continue
    if (!TICKER_TOKEN.test(upper) || NON_TICKER_WORDS.has(upper)) continue
    if (!seen.has(upper)) {
      seen.add(upper)
      out.push(upper)
    }
    if (out.length >= 6) break
  }
  return out
}

interface CatalogPlugin {
  handle: string
  name: string
  title: string
  description: string
  auth: PluginAuthBadge
  base: number
  reasons: Partial<Record<string, { weight: number; why: string }>>
  defaultWhy: string
}

const PLUGIN_CATALOG: readonly CatalogPlugin[] = [
  {
    handle: 'jaspers',
    name: 'yfinance',
    title: 'Yahoo Finance',
    description: 'Quotes, price history, fundamentals, analyst estimates, options, news, and market movers.',
    auth: 'No key',
    base: 5,
    defaultWhy: 'Zero-key live quotes, price series, fundamentals, and options for immediate grid views.',
    reasons: {
      fundamental: {
        weight: 8,
        why: 'Brings multi-year fundamentals, valuation multiples, and analyst estimates with no key.',
      },
      quant: {
        weight: 7,
        why: 'Feeds historical price, fundamentals, and options rows straight into jaspers.db for SQL.',
      },
      trading: { weight: 8, why: 'Live quotes, options chains, price history, and market movers with no API key.' },
      'us-equities': { weight: 7, why: 'Broad equity coverage for quotes, comps, holders, and price history.' },
      'charts-browser': { weight: 5, why: 'Pairs directly with built-in Chart, Table, and Metric grid views.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'sec',
    title: 'SEC EDGAR',
    description: '10-K, 10-Q, and 8-K filings, XBRL company facts, and Form 4 insider filings straight from EDGAR.',
    auth: 'No key',
    base: 4,
    defaultWhy: 'Direct, zero-key access to primary SEC filings, XBRL financial facts, and insider transactions.',
    reasons: {
      fundamental: {
        weight: 9,
        why: 'Primary 10-K/10-Q text and normalized XBRL company facts straight from SEC EDGAR.',
      },
      'us-equities': {
        weight: 9,
        why: 'Covers all US SEC registrants with filings, XBRL facts, and Form 4 insider forms.',
      },
      'filings-screen': { weight: 8, why: 'Indexes filing passages locally into jaspers.db FTS5 for cited retrieval.' },
      quant: { weight: 5, why: 'Structured XBRL company facts for multi-period financial ratio SQL.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'tradingview',
    title: 'TradingView',
    description: 'Interactive TradingView advanced charting view driven by room agents on the grid.',
    auth: 'No key',
    base: 4,
    defaultWhy: 'Full interactive technical and multi-timeframe charting tile with zero setup.',
    reasons: {
      trading: {
        weight: 10,
        why: 'Interactive multi-timeframe candlesticks, studies, and symbol switching on the grid.',
      },
      'charts-browser': {
        weight: 9,
        why: 'Dedicated interactive chart view alongside your live feeds and browser tiles.',
      },
      macro: { weight: 5, why: 'Quickly charts indices, FX pairs, rates proxies, and cross-asset benchmarks.' },
      fundamental: { weight: 4, why: 'Clean price and volume context next to your filing and valuation rooms.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'screener-mcp',
    title: 'Jaspers Discover',
    description: 'Quantitative + qualitative stock screener across ~7,100 SEC filers with cited filing quotes.',
    auth: 'Jaspers One',
    base: 3,
    defaultWhy: 'Screens ~7,100 SEC filers quantitatively and answers qualitative filing criteria with quotes.',
    reasons: {
      'filings-screen': {
        weight: 11,
        why: 'Screens ~7,100 SEC filers by numbers and plain-English filing questions with quotes.',
      },
      fundamental: {
        weight: 8,
        why: 'Finds companies matching fundamental filters and qualitative 10-K/10-Q disclosures.',
      },
      quant: { weight: 7, why: 'Universe-wide fundamental screening across ~7,100 US registrants.' },
      'us-equities': { weight: 7, why: 'Purpose-built discovery engine across the US public-company filing universe.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'agents',
    title: 'Research Agents',
    description: 'Parallel SEC filing research analysts that investigate companies and answer with verified citations.',
    auth: 'Jaspers One',
    base: 3,
    defaultWhy: 'Runs parallel SEC filing analysts inside a dedicated room with verified source citations.',
    reasons: {
      fundamental: {
        weight: 9,
        why: 'Parallel single-name analysts over 10 years of SEC filings with verified quotes.',
      },
      'filings-screen': { weight: 10, why: 'Deep cited filing research rooms grounded in primary SEC disclosures.' },
      'us-equities': { weight: 6, why: 'Synthesizes multi-year 10-K, 10-Q, and risk-factor history per company.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'fed',
    title: 'Federal Reserve (H.15)',
    description: 'Daily constant-maturity US Treasury yield curve from the Federal Reserve H.15 release.',
    auth: 'No key',
    base: 3,
    defaultWhy: 'Daily US Treasury yield curve across tenors with no API key required.',
    reasons: {
      macro: { weight: 10, why: 'Tracks the daily constant-maturity US yield curve and 2s10s/3m10y spreads.' },
      'rates-fiscal': {
        weight: 11,
        why: 'Official Federal Reserve H.15 constant-maturity yields with zero key setup.',
      },
      quant: { weight: 5, why: 'Clean risk-free rate and curve slope series stored locally in jaspers.db.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'bls',
    title: 'Bureau of Labor Statistics',
    description: 'US CPI inflation, nonfarm payrolls, unemployment, and custom BLS macro series by ID.',
    auth: 'No key',
    base: 2,
    defaultWhy: 'Primary US inflation and labor-market series straight from the BLS.',
    reasons: {
      macro: { weight: 9, why: 'Tracks CPI components, payrolls, and unemployment releases straight from BLS.' },
      'rates-fiscal': { weight: 9, why: 'Pairs inflation and labor releases with your Fed and Treasury rate views.' },
      'watches-skills': { weight: 4, why: 'Ideal for scheduled macro release checks and SQLite delta watches.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'treasury',
    title: 'US Treasury Fiscal Data',
    description: 'Treasury yield rates, auction results, debt to the penny, and federal spending.',
    auth: 'No key',
    base: 2,
    defaultWhy: 'Direct US Treasury auction, debt, and fiscal data with no API key.',
    reasons: {
      'rates-fiscal': { weight: 10, why: 'Monitors Treasury auction tails, bid-to-cover, debt, and fiscal flows.' },
      macro: { weight: 7, why: 'Sovereign issuance and fiscal supply data alongside the H.15 curve.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'cftc',
    title: 'CFTC Commitments of Traders',
    description: 'Weekly futures positioning across asset managers, leveraged funds, and commercials.',
    auth: 'No key',
    base: 2,
    defaultWhy: 'Weekly institutional futures positioning across rates, FX, commodities, and indices.',
    reasons: {
      positioning: { weight: 11, why: 'Tracks leveraged-fund and asset-manager futures positioning extremes.' },
      trading: { weight: 8, why: 'Spots crowded futures positioning across indices, rates, FX, and commodities.' },
      macro: { weight: 6, why: 'Cross-asset speculative positioning across rates, currencies, and commodities.' },
      quant: { weight: 6, why: 'Clean weekly CoT positioning history for systematic factor and z-score SQL.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'finra',
    title: 'FINRA Short Interest',
    description: 'Bi-monthly equity short interest and days-to-cover ratios reported to FINRA.',
    auth: 'No key',
    base: 2,
    defaultWhy: 'Official FINRA short interest and days-to-cover data with no API key.',
    reasons: {
      positioning: { weight: 10, why: 'Measures short-interest changes and days-to-cover across equities.' },
      trading: { weight: 8, why: 'Flags heavily shorted names and squeeze setups alongside price action.' },
      quant: { weight: 6, why: 'Bi-monthly short-interest series for systematic equity factor screens.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'ecb',
    title: 'European Central Bank',
    description: 'Euro reference FX rates and ECB deposit facility policy rate series.',
    auth: 'No key',
    base: 1,
    defaultWhy: 'Official ECB policy rates and G10 FX reference rates with no key.',
    reasons: {
      'global-macro': { weight: 10, why: 'Tracks ECB deposit rates and daily Euro FX reference crosses.' },
      macro: { weight: 6, why: 'Adds European central-bank policy and FX context to US macro views.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'imf',
    title: 'IMF DataMapper',
    description: 'Cross-country GDP, inflation, debt, and current-account history and IMF forecasts.',
    auth: 'No key',
    base: 1,
    defaultWhy: 'Global country macro history and multi-year IMF forecasts.',
    reasons: {
      'global-macro': { weight: 10, why: 'Compares sovereign growth, inflation, and fiscal trajectories globally.' },
      macro: { weight: 6, why: 'Multi-country macro history and forecasts for cross-market comparisons.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'oecd',
    title: 'OECD Macro',
    description: 'Cross-country CPI inflation and industrial production from the OECD SDMX service.',
    auth: 'No key',
    base: 1,
    defaultWhy: 'Standardized cross-country inflation and industrial activity series.',
    reasons: {
      'global-macro': { weight: 9, why: 'Harmonized G20/OECD CPI and industrial production releases.' },
      quant: { weight: 4, why: 'Clean cross-country macro time series for SQL comparisons.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'markdown',
    title: 'Markdown Memo',
    description: 'Structured Markdown investment memos, thesis checklists, and research notes on the grid.',
    auth: 'No key',
    base: 2,
    defaultWhy: 'Lets room agents maintain live Markdown investment memos and checklists on the grid.',
    reasons: {
      fundamental: { weight: 5, why: 'Writes structured investment memos and thesis trackers beside your data tiles.' },
      'watches-skills': { weight: 7, why: 'Great target view for /skills playbooks and morning brief summaries.' },
      'builder-shell': { weight: 5, why: 'Clean canvas for documenting custom plugin specs and pipeline outputs.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'earningscall',
    title: 'EarningsCall',
    description: 'Company earnings call transcripts and daily earnings calendar.',
    auth: 'API key',
    base: 1,
    defaultWhy: 'Brings earnings call transcripts and upcoming calendar dates into filing research.',
    reasons: {
      fundamental: { weight: 6, why: 'Pairs management Q&A transcripts with 10-K/10-Q filing research.' },
      'filings-screen': { weight: 5, why: 'Adds earnings call commentary to local FTS5 transcript search.' },
    },
  },
  {
    handle: 'jaspers',
    name: 'fmp',
    title: 'Financial Modeling Prep',
    description: 'Company stock news, technical indicators, and institutional Form 13F holdings.',
    auth: 'API key',
    base: 1,
    defaultWhy: 'Adds Form 13F institutional holdings, company news, and technical indicators.',
    reasons: {
      fundamental: { weight: 4, why: 'Tracks institutional 13F ownership alongside fundamentals.' },
      positioning: { weight: 5, why: 'Combines 13F institutional ownership with FINRA short-interest data.' },
    },
  },
]

function labelForChoice(questionId: OnboardingQuestionId, choiceId: string): string | null {
  const q = ONBOARDING_QUESTIONS.find((one) => one.id === questionId)
  return q?.choices.find((c) => c.id === choiceId)?.label ?? null
}

function sanitizeAnswers(raw: OnboardingAnswers): OnboardingAnswers {
  const validFor = (id: OnboardingQuestionId, picked: readonly string[]): string[] => {
    const allowed = new Set(ONBOARDING_QUESTIONS.find((q) => q.id === id)?.choices.map((c) => c.id) ?? [])
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of picked) {
      if (allowed.has(item) && !seen.has(item)) {
        seen.add(item)
        out.push(item)
      }
    }
    return out
  }
  return {
    style: validFor('style', raw.style),
    coverage: validFor('coverage', raw.coverage),
    workflows: validFor('workflows', raw.workflows),
    focusText: raw.focusText.replace(/\s+/g, ' ').trim().slice(0, FOCUS_TEXT_MAX),
  }
}

function rankPlugins(
  tags: ReadonlySet<string>,
  signedIn: boolean,
  installed: ReadonlySet<string>,
  limit = 4,
): SuggestedPlugin[] {
  const scored = PLUGIN_CATALOG.map((plugin) => {
    let score = plugin.base
    let bestWeight = -1
    let why = plugin.defaultWhy
    for (const tag of tags) {
      const match = plugin.reasons[tag]
      if (!match) continue
      score += match.weight
      if (match.weight > bestWeight) {
        bestWeight = match.weight
        why = match.why
      }
    }
    if (plugin.auth === 'No key') score += 2
    if (plugin.auth === 'Jaspers One' && !signedIn && !tags.has('filings-screen')) score -= 3
    if (plugin.auth === 'API key') score -= 2
    const isInstalled = installed.has(plugin.name)
    return { plugin, score, why, isInstalled }
  })

  // Surface uninstalled plugins first so every slot is actionable, then already-installed top matches if needed.
  scored.sort((a, b) => {
    if (a.isInstalled !== b.isInstalled) return a.isInstalled ? 1 : -1
    return b.score - a.score
  })

  return scored.slice(0, limit).map(({ plugin, why }) => ({
    handle: plugin.handle,
    name: plugin.name,
    title: plugin.title,
    description: plugin.description,
    reason: why,
    auth: plugin.auth,
  }))
}

interface RoomCandidate {
  score: number
  room: SuggestedRoom
}

function buildStarterRooms(tags: ReadonlySet<string>, tickers: readonly string[], focusText: string): SuggestedRoom[] {
  const primary = tickers[0] ?? 'NVDA'
  const peerList = tickers.length >= 2 ? tickers.join(', ') : `${primary}, MSFT, AAPL`
  const focusClause = focusText ? ` (with attention to ${focusText})` : ''

  const candidates: RoomCandidate[] = [
    {
      score:
        4 +
        (tags.has('fundamental') ? 10 : 0) +
        (tags.has('us-equities') ? 7 : 0) +
        (tags.has('filings-screen') ? 8 : 0),
      room: {
        id: 'filing-deep-dive',
        title: `${primary} Filing & Fundamentals`,
        desc: `Single-name SEC filing and fundamentals research on ${primary}`,
        summary: `Pulls ${primary} key financials, recent filing disclosures, and risk factors into an isolated research room.`,
        brief: `Research ${primary}${focusClause}. Use installed SEC/research/market plugins when available (such as agents, research, sec, or yfinance), or search_web and built-in core/table and core/metric views otherwise. Surface key revenue/margin trends and notable 10-K/10-Q disclosures with concise citations.`,
        systemPrompt:
          'Operate as a disciplined fundamental equity analyst. Ground every claim in primary filings or fetched market data, keep tables compact, and highlight material business drivers and risks.',
        prompt: `Set up a fundamental & SEC filing overview for ${primary}${focusClause}: place a clean summary view of key financials and summarize the most important recent filing takeaways.`,
        preferredPlugins: ['agents', 'research', 'sec', 'yfinance', 'markdown'],
      },
    },
    {
      score:
        2 +
        (tags.has('fundamental') ? 6 : 0) +
        (tags.has('quant') ? 8 : 0) +
        (tags.has('us-equities') ? 7 : 0) +
        (tags.has('filings-screen') ? 9 : 0),
      room: {
        id: 'equity-screener',
        title: 'Equity Screen & Comps',
        desc: `Comparative fundamentals and filing screen across ${peerList}`,
        summary: `Builds a sortable peer valuation & operating table (${peerList}) backed by local SQLite rows.`,
        brief: `Build a comparative screen and peer valuation table starting with ${peerList}${focusClause}. If screener-mcp is installed and ready, drive screener-mcp/screener; otherwise fetch fundamentals via yfinance/sec (or web data) and render a sortable core/table comparing valuation, growth, and margins.`,
        systemPrompt:
          'Focus on clean, comparable metrics across companies. Normalize units clearly and store fetched rows cleanly so follow-up SQL queries over jaspers.db are effortless.',
        prompt: `Create a peer comparison screen on the grid for ${peerList}${focusClause} with key valuation and operating metrics.`,
        preferredPlugins: ['screener-mcp', 'yfinance', 'sec'],
      },
    },
    {
      score:
        3 + (tags.has('macro') ? 11 : 0) + (tags.has('rates-fiscal') ? 11 : 0) + (tags.has('global-macro') ? 10 : 0),
      room: {
        id: 'macro-yield-curve',
        title: 'Yield Curve & Macro Desk',
        desc: 'US Treasury yield curve, inflation/labor pulse, and policy rates',
        summary:
          'Tracks the Treasury curve alongside inflation and central-bank policy rates in live Chart & Table views.',
        brief: `Set up a macro & rates monitor${focusClause}. Use installed macro plugins (fed, treasury, bls, ecb, imf, oecd) when present—or fetch current figures and render a core/chart or core/table of key tenors (2Y, 10Y, 30Y) and macro indicators—then summarize the curve slope and policy backdrop.`,
        systemPrompt:
          'Operate as a cross-asset macro strategist. Present tenors, basis-point moves, and release dates precisely.',
        prompt: `Set up a macro & rates room${focusClause} showing the current Treasury yield curve across key tenors and the latest inflation/policy rate snapshot.`,
        preferredPlugins: ['fed', 'treasury', 'bls', 'ecb', 'imf', 'oecd'],
      },
    },
    {
      score:
        3 + (tags.has('trading') ? 11 : 0) + (tags.has('positioning') ? 10 : 0) + (tags.has('charts-browser') ? 8 : 0),
      room: {
        id: 'trading-flow-desk',
        title: `${primary} Chart & Positioning`,
        desc: `Price chart, catalysts, and positioning monitor for ${peerList}`,
        summary: `Opens an interactive price chart and positioning/short-flow view for ${peerList}.`,
        brief: `Set up an active market & positioning room for ${peerList}${focusClause}. Place tradingview/chart if tradingview is installed (otherwise fetch price history via yfinance or available sources into core/chart), check short interest or CFTC positioning when finra/cftc are installed, and note key levels.`,
        systemPrompt:
          'Operate as a market-structure and trading desk analyst. Keep commentary concise around price structure, volume, positioning, and upcoming catalysts.',
        prompt: `Open a chart and market flow view for ${primary} (tracking ${peerList})${focusClause} and summarize current price structure and positioning.`,
        preferredPlugins: ['tradingview', 'yfinance', 'finra', 'cftc'],
      },
    },
    {
      score:
        2 + (tags.has('quant') ? 10 : 0) + (tags.has('watches-skills') ? 10 : 0) + (tags.has('builder-shell') ? 6 : 0),
      room: {
        id: 'sqlite-watch-lab',
        title: 'SQLite Factor & Watch Lab',
        desc: 'Local SQLite SQL analytics and NYSE calendar delta-watch setup',
        summary: 'Queries jaspers.db into a live SQL Table/Chart and prepares recurring market-hours delta watches.',
        brief: `Set up a quantitative SQLite & watch room for ${peerList}${focusClause}. Pull initial market or macro rows from installed sources so runs and run_rows populate jaspers.db, place a SQL-backed core/table or core/chart over run_rows, and outline an NYSE market-calendar delta watch the user can schedule.`,
        systemPrompt:
          'Operate as a quantitative research engineer. Write clean, readable SQLite queries against runs and run_rows and favor reproducible metrics.',
        prompt: `Initialize a SQLite data & watch lab for ${peerList}${focusClause}: fetch baseline rows, place a SQL-backed table on the grid, and propose a market-hours delta watch.`,
        preferredPlugins: ['yfinance', 'sec', 'fed', 'cftc', 'finra'],
      },
    },
    {
      score: 3 + (tags.has('charts-browser') ? 9 : 0) + (tags.has('trading') ? 5 : 0) + (tags.has('macro') ? 4 : 0),
      room: {
        id: 'live-market-browser',
        title: 'Live Market Browser',
        desc: 'Sandboxed live web & market video browser room on the grid',
        summary:
          'Mounts the built-in multi-tab Browser view immediately on the grid for live market pages, EDGAR, or Bloomberg TV.',
        brief:
          'Maintain a live Browser room on the grid using core/browser. Navigate, switch tabs, or extract visible page text on request.',
        systemPrompt:
          'Drive the room’s core/browser tile cleanly and summarize visible page headlines or figures whenever asked.',
        prompt: '',
        preferredPlugins: ['browser'],
        initialBrowserUrl:
          tags.has('filings-screen') && !tags.has('trading')
            ? 'https://www.sec.gov/edgar/searchedgar/companysearch'
            : 'https://www.bloomberg.com/live',
      },
    },
    {
      score: 1 + (tags.has('builder-shell') ? 12 : 0) + (tags.has('quant') ? 4 : 0),
      room: {
        id: 'custom-plugin-studio',
        title: 'Custom Plugin & Data Studio',
        desc: 'Scope a custom @jaspers-ai/sdk plugin or local data workflow',
        summary: 'Helps design and build a custom API feed or custom React grid tile using the built-in coding agent.',
        brief: `Help the user scope a custom data feed, REST/MCP connector, or bespoke React view${focusClause} that can be compiled into ~/Jaspers/plugins/ with @jaspers-ai/sdk, placing a concise core/note checklist of data endpoints and views to build.`,
        systemPrompt: 'Be practical and concrete about endpoints, authentication secrets, and grid view design.',
        prompt: `Place a concise build checklist note on the grid for custom data sources or views${focusClause} and outline two custom @jaspers-ai/sdk plugins we can generate with build_plugin.`,
        preferredPlugins: ['markdown'],
      },
    },
  ]

  candidates.sort((a, b) => b.score - a.score)
  return candidates.slice(0, 3).map((entry) => entry.room)
}

/**
 * Profiles the user from their onboarding answers (or defaults when skipped) and computes their
 * persistent memory entry, top suggested Hub plugins, and tailored starter rooms.
 */
export function buildOnboardingProfile(
  rawAnswers: OnboardingAnswers,
  options: {
    signedIn?: boolean
    installedPlugins?: readonly string[]
    firstName?: string | null
  } = {},
): OnboardingProfile {
  const answers = sanitizeAnswers(rawAnswers)
  const styleLabels = answers.style.flatMap((id) => labelForChoice('style', id) ?? [])
  const coverageLabels = answers.coverage.flatMap((id) => labelForChoice('coverage', id) ?? [])
  const workflowLabels = answers.workflows.flatMap((id) => labelForChoice('workflows', id) ?? [])
  const tickers = parseWatchlistTickers(answers.focusText)
  const answered =
    styleLabels.length > 0 || coverageLabels.length > 0 || workflowLabels.length > 0 || answers.focusText.length > 0

  const tags = new Set<string>([...answers.style, ...answers.coverage, ...answers.workflows])
  const installed = new Set<string>(options.installedPlugins ?? [])
  const plugins = rankPlugins(tags, options.signedIn === true, installed, 4)
  const rooms = buildStarterRooms(tags, tickers, answers.focusText)

  const parts = [
    styleLabels.join(' & '),
    coverageLabels.join(' & '),
    answers.focusText || (workflowLabels.length > 0 ? workflowLabels[0]! : ''),
  ].filter(Boolean)

  const headline = parts.length > 0 ? parts.join(' · ') : 'General Public-Markets Workspace'
  const summary = answered
    ? 'Saved to Memory (`user-profile`) so Central and future rooms tailor plugin routing, SQL queries, and briefs to your coverage.'
    : 'Showing a balanced starter kit across equities, macro rates, and live web research—install any plugin or open a room below.'

  let memory: OnboardingProfile['memory'] = null
  if (answered) {
    const aboutRaw = `Research profile: ${headline}`
    const about = aboutRaw.length > ABOUT_MAX ? `${aboutRaw.slice(0, ABOUT_MAX - 1).trimEnd()}…` : aboutRaw
    const lines = [
      '# User Research Profile',
      ...(styleLabels.length > 0 ? [`- **Research style:** ${styleLabels.join(', ')}`] : []),
      ...(coverageLabels.length > 0 ? [`- **Market coverage:** ${coverageLabels.join(', ')}`] : []),
      ...(answers.focusText ? [`- **Watchlist / focus:** ${answers.focusText}`] : []),
      ...(tickers.length > 0 ? [`- **Primary tickers:** ${tickers.join(', ')}`] : []),
      ...(workflowLabels.length > 0 ? [`- **Preferred terminal workflows:** ${workflowLabels.join(', ')}`] : []),
    ]
    const body = lines.join('\n').slice(0, BODY_MAX)
    memory = { name: 'user-profile', about, body }
  }

  return {
    headline,
    summary,
    answered,
    tickers,
    memory,
    plugins,
    rooms,
  }
}

/** Concise Markdown note filed into Central's conversation log when the user completes their profile. */
export function profileReplyFor(profile: OnboardingProfile): string {
  const pluginNames = profile.plugins.map((p) => `**${p.title}**`).join(', ')
  const roomNames = profile.rooms.map((r) => `**${r.title}**`).join(', ')
  return [
    `**Profile ready — ${profile.headline}.**`,
    profile.answered
      ? 'I saved your preferences to `user-profile` in **Settings > Memory** so future rooms and analyses stay aligned with your coverage.'
      : 'Here is a general starter pack to get your grid moving right away.',
    `Suggested plugins: ${pluginNames}. Starter rooms ready below: ${roomNames}.`,
  ].join(' ')
}

/** Validates an untrusted IPC payload for `agent:onboarding`. */
export function readOnboardingAction(raw: unknown): OnboardingAction {
  if (typeof raw !== 'object' || raw === null) throw new Error('Malformed onboarding action.')
  const record = raw as Record<string, unknown>
  const kind = record['kind']
  if (kind === 'back' || kind === 'show-recommendations' || kind === 'skip-all' || kind === 'dismiss') {
    return { kind }
  }
  if (kind === 'start-room') {
    const roomId = typeof record['roomId'] === 'string' ? record['roomId'].trim() : ''
    if (!roomId || roomId.length > 80) throw new Error('Choose a starter room to open.')
    return { kind: 'start-room', roomId }
  }
  if (kind === 'answer' || kind === 'skip-question') {
    const step = record['step']
    if (step !== 0 && step !== 1 && step !== 2) throw new Error('Invalid onboarding question step.')
    const focusText = typeof record['focusText'] === 'string' ? record['focusText'].slice(0, FOCUS_TEXT_MAX) : undefined
    if (kind === 'skip-question') {
      return { kind: 'skip-question', step, ...(focusText !== undefined ? { focusText } : {}) }
    }
    const allowed = new Set(ONBOARDING_QUESTIONS[step]!.choices.map((c) => c.id))
    const selected = Array.isArray(record['selected'])
      ? record['selected'].filter((x): x is string => typeof x === 'string' && allowed.has(x))
      : []
    return { kind: 'answer', step, selected, ...(focusText !== undefined ? { focusText } : {}) }
  }
  throw new Error('Unknown onboarding action.')
}
