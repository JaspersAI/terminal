// What a new piece of work is set up with. The orchestrator says what the work is and what its agent
// is to do, and knows nothing of what is installed beyond the plugins' names; a call of its own, with
// the whole catalog in front of it, chooses the plugins and skills the work's agent is told of in full.
// That call is one model call, answered with one tool call, and what it chose is checked here.

import type { Effort, ToolDefinition } from '../llm/llm.ts'
import { shownQuestion } from './attachments.ts'

export const SETUP_TOOL = 'set_up_loop'
/** One short call apart from the conversation's cache: low effort, and a shorter wait before asking again. */
export const SETUP_EFFORT: Effort = 'low'
export const SETUP_TIMEOUT_MS = 20_000

/** The one tool the setup call is offered, and the shape of its answer. */
export const SETUP_DEFINITION: ToolDefinition = {
  name: SETUP_TOOL,
  description:
    'Say which installed plugins and skills the new piece of work is told of in full. Its agent can still ask for any other installed plugin by name, so name only the ones the work plainly needs.',
  parameters: {
    type: 'object',
    properties: {
      plugins: {
        type: 'array',
        items: { type: 'string' },
        description: 'The installed plugins it needs, by id. Empty when none fits: its agent then finds or builds one.',
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
  return `You set up a new piece of work inside Jaspers Terminal, a financial research app. Each piece of work has a tile on the user's grid and an agent of its own, which places the installed plugins' views and calls their sources. You are given what the work is and what its agent is to do; choose the installed plugins and skills its agent is told of in full, and answer only by calling ${SETUP_TOOL}. Choose by what each plugin's views and sources do, never by its name alone. Do not choose a chart-only plugin when the user asked for a watchlist, screen, or table without charts, even if they asked for technical indicators that a chart view can plot as studies. What is installed:\n\n${catalog}`
}

/** What the setup call is asked: the work as the orchestrator described it, and the user's own words. */
export function setupRequest(desc: string, brief: string, asked: string | undefined): string {
  return [
    `The work: ${desc}`,
    `Its brief: ${brief || '(none)'}`,
    ...(asked ? [`What the user asked: ${shownQuestion(asked)}`] : []),
  ].join('\n')
}

/** What the setup call chose, once each id is one that is installed. */
export interface SetUp {
  plugins: string[]
  skills: string[]
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
