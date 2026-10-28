// What a new piece of work is set up with. The orchestrator says what the work is and what its agent
// is to do, and knows nothing of what is installed beyond the plugins' names; a call of its own, with
// the whole catalog in front of it, chooses the plugins and skills the work's agent is told of in full.
// That call is one model call, answered with one tool call, and what it chose is checked here.

import type { Effort, ToolDefinition } from '../llm/llm.ts'
import { typedWords } from './typed.ts'

export const SETUP_TOOL = 'set_up_loop'
/** One short call apart from the conversation's cache: low effort, and a shorter wait before asking again. */
export const SETUP_EFFORT: Effort = 'low'
export const SETUP_TIMEOUT_MS = 20_000

/** The one tool the setup call is offered, and the shape of its answer. */
export const SETUP_DEFINITION: ToolDefinition = {
  name: SETUP_TOOL,
  description:
    'Say which installed plugins and skills the new piece of work is told of in full. Built-in views (core/*) are already included in every piece of work, and its agent can still ask for any other installed plugin by name, so name only the installed plugins the work plainly needs.',
  parameters: {
    type: 'object',
    properties: {
      plugins: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The installed plugins it needs, by id. Empty when only built-in views (core/*) are needed or when none fits: its agent then finds or builds one.',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description: "The skills it needs beyond its plugins' own, by id. Usually empty.",
      },
    },
    required: ['plugins', 'skills'],
  },
}

/** The setup call's system prompt: what it is for, then everything installed. */
export function setupSystem(catalog: string): string {
  return `You set up a new piece of work inside Jaspers Terminal, a financial research app. Each piece of work has a tile on the user's grid and an agent of its own, which places the installed plugins' views and calls their sources. Built-in views (core/*, such as core/browser, core/table, core/chart, core/metric, core/inbox, core/tasks, and core/plugins) are already included in every piece of work with plugins: []. You are given what the work is and what its agent is to do; choose the installed plugins and skills its agent is told of in full, and answer only by calling ${SETUP_TOOL}. Choose by what each plugin's views and sources do, never by its name alone. What is installed:\n\n${catalog}`
}

/** What the setup call is asked: the work as the orchestrator described it, and the user's own words. */
export function setupRequest(desc: string, brief: string, asked: string | undefined): string {
  return [
    `The work: ${desc}`,
    `Its brief: ${brief || '(none)'}`,
    ...(asked ? [`What the user asked: ${asked}`] : []),
  ].join('\n')
}

/** What the setup call chose, once each id is one that is installed. */
export interface SetUp {
  plugins: string[]
  skills: string[]
}

/**
 * The installed plugins the setup call may choose from: external plugins only, leaving out built-in
 * entries (such as the built-in browser) whose views are already in every loop's prompt.
 */
export function selectablePlugins(plugins: Record<string, { dir: string }>): string[] {
  return Object.entries(plugins)
    .filter(([, one]) => one.dir !== 'built-in')
    .map(([id]) => id)
}

const STANDALONE_BUILTIN_VIEW = /\bcore\/(?:browser|inbox|tasks|plugins|app)\b/i
const DATA_BUILTIN_VIEW = /\bcore\/(?:table|chart|metric)\b/i
const NON_CORE_QUALIFIED =
  /\b(?!core\/|panels\/|and\/or\b|yes\/no\b|on\/off\b|true\/false\b)[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*\b/i
const EXTERNAL_WORK_TERMS =
  /\b(?:run_source|describe_source|build_plugin|find_plugin|install_plugin|use_plugin|research\s+room|deep\s+research|screener|stock\s+screen|backtest|10-[kq]|sec\s+filings?|earnings\s+calls?|earnings\s+transcripts?)\b/i
const STANDALONE_EXTRA_WORK =
  /\b(?:core\/(?:table|chart|metric)|chart|plot|graph|table|metric|fetch_page|search_web|fetch|query|sql|source|screen|research|analyze|analysis|backtest|filing|10-[kq]|earnings|quote|price\s+history|fundamentals|options|build|install)\b/i
const NATURAL_BROWSER_VIEW =
  /\b(?:browser\s+(?:view|tile|panel|window|tab|plugin)|built-in\s+browser|(?:open|launch|place|show|put|start|load|navigate|use)\s+(?:in\s+|up\s+)?(?:a\s+|the\s+)?(?:web\s+|built-in\s+)?browser)\b/i
const NATURAL_APP_VIEW =
  /\b(?:(?:open|launch|place|show|put)\s+(?:a\s+|the\s+|my\s+)?(?:notifications?\s+inbox|inbox(?:\s+view|\s+tile|\s+panel)?|scheduled\s+tasks(?:\s+view|\s+tile|\s+panel)?|tasks\s+(?:view|tile|panel)|installed\s+plugins(?:\s+view|\s+tile|\s+panel)?|plugins\s+(?:view|tile|panel))|(?:inbox|scheduled\s+tasks|tasks|installed\s+plugins|plugins)\s+(?:view|tile|panel))\b/i
const BLOOMBERG_STREAM_OR_VIEW =
  /\b(?:core\/browser|browser|bloomberg\.com|tv|television|live|stream|feed|video|watch|channel|open|launch|show|place|put)\b/i
const STORE_DATA_SOURCE =
  /\b(?:from\s+the\s+store|over\s+the\s+store|in\s+the\s+store|query\s+the\s+store|state\.sql|sql\s+over\s+the\s+store|sql\b[^.\n]*\bstore\b|store\b[^.\n]*\bsql\b|run_rows)\b/i

/**
 * Whether the work described for a new loop only needs a built-in view (`core/browser`, `core/inbox`,
 * `core/tasks`, `core/plugins`, or `core/table`, `core/chart`, `core/metric` over the local store)
 * and no external plugins or skills.
 */
export function needsOnlyBuiltInView(
  desc: string,
  brief: string,
  asked?: string,
  plugins: readonly string[] = [],
  skills: readonly string[] = [],
): boolean {
  const workText = `${desc}\n${brief}`.trim()
  if (!workText) return false
  const userText = asked ? typedWords(asked).trim() : ''
  const combined = userText ? `${workText}\n${userText}` : workText
  const strippedWork = withoutUrls(workText)

  if (NON_CORE_QUALIFIED.test(strippedWork) || EXTERNAL_WORK_TERMS.test(strippedWork)) return false
  if (mentionsAnyId(strippedWork, skills)) return false

  // An explicit standalone built-in view (core/browser, core/inbox, core/tasks, core/plugins) needs no
  // external plugin unless the brief also asks for another view, a data fetch, or a source.
  if (STANDALONE_BUILTIN_VIEW.test(workText) && !STANDALONE_EXTRA_WORK.test(strippedWork)) {
    return true
  }

  // Otherwise, any mention of an installed external plugin in the loop's work leaves selection to setUpLoop.
  if (mentionsAnyId(strippedWork, plugins)) return false

  // A built-in data view (core/table, core/chart, core/metric) reading from the local SQLite store without fetching,
  // or after setup has already determined that no external plugins are needed.
  if (
    DATA_BUILTIN_VIEW.test(workText) &&
    (STORE_DATA_SOURCE.test(workText) || plugins.length === 0) &&
    !/\b(?:fetch|run_source|state\.source)\b/i.test(strippedWork)
  ) {
    return true
  }

  if (STANDALONE_EXTRA_WORK.test(strippedWork)) return false

  if (NATURAL_BROWSER_VIEW.test(workText) || NATURAL_APP_VIEW.test(workText)) return true
  if (/\bbloomberg\b/i.test(workText) && BLOOMBERG_STREAM_OR_VIEW.test(combined)) return true
  if (
    /https?:\/\/\S+/i.test(workText) &&
    /\b(?:open|launch|place|show|put|load|navigate|stream|watch|browser|view)\b/i.test(strippedWork)
  ) {
    return true
  }
  return false
}

/**
 * Whether `setUpLoop` needs to run the catalog-selection model call: false when no external plugins
 * or model-usable skills are installed, or when the work only needs a built-in view.
 */
export function needsPluginSetup(
  desc: string,
  brief: string,
  asked: string | undefined,
  plugins: readonly string[],
  skills: readonly string[],
): boolean {
  if (plugins.length === 0 && skills.length === 0) return false
  return !needsOnlyBuiltInView(desc, brief, asked, plugins, skills)
}

function withoutUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, ' ')
}

function mentionsAnyId(text: string, ids: readonly string[]): boolean {
  for (const raw of ids) {
    const id = raw.trim()
    if (!id) continue
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?:$|[^a-z0-9_-])`, 'i').test(text)) return true
  }
  return false
}

/**
 * What the setup call chose, from its call's input, held to what is installed. An id that is not
 * there is dropped rather than refused: the call reads the same catalog the agent will, and one it
 * made up has nothing to tell the agent of.
 */
export function setUpOf(input: Record<string, unknown>, plugins: readonly string[], skills: readonly string[]): SetUp {
  return { plugins: idsIn(input.plugins, plugins), skills: idsIn(input.skills, skills) }
}

function idsIn(value: unknown, have: readonly string[]): string[] {
  const list: unknown[] = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const ids = list.filter((one): one is string => typeof one === 'string').map((one) => one.trim())
  return [...new Set(ids)].filter((id) => have.includes(id))
}
