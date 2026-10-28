import { describeCatalog } from '../../shared/agent/prompt'
import {
  needsPluginSetup,
  selectablePlugins,
  SETUP_DEFINITION,
  SETUP_EFFORT,
  SETUP_TIMEOUT_MS,
  SETUP_TOOL,
  setUpOf,
  setupRequest,
  setupSystem,
  type SetUp,
} from '../../shared/agent/setup'
import { usableSkills } from '../../shared/skills/skills'
import { getState, toPublic } from '../state'
import type { ToolContext } from './tools/types'
import { request } from './utils/request'
import { emit, telling, type Live } from './utils/runs'
import { configured } from './utils/settings'

// The call that sets up a new piece of work: one model call, apart from the orchestrator's thread,
// with everything installed in front of it, answered by one tool call naming the plugins and skills
// the work's agent is told of. It runs under the orchestrator's run, so its stop stops this too and
// Eye files it with that run.

export async function setUpLoop(desc: string, brief: string, context: ToolContext): Promise<SetUp> {
  const state = toPublic(getState())
  const plugins = selectablePlugins(state.plugins)
  const skills = usableSkills(state, 'model').map((one) => one.id)
  const log = (line: string): void => console.log(`[agent] setup ${line}`)
  if (!needsPluginSetup(desc, brief, context.asked, plugins, skills)) {
    log('plugins none; skills none (built-in view or no external catalog)')
    return { plugins: [], skills: [] }
  }
  const controller = new AbortController()
  const stopped = (): void => controller.abort(context.signal?.reason)
  if (context.signal?.aborted) stopped()
  else context.signal?.addEventListener('abort', stopped, { once: true })
  const run: Live = { runId: context.runId, origin: context.task === undefined ? 'user' : 'task', controller }
  emit({ kind: 'status', runId: context.runId, line: 'Choosing plugins for the work' })
  const config = configured()
  try {
    const reply = await request({
      round: 1,
      label: 'setup ',
      config,
      system: [setupSystem(describeCatalog(state))],
      history: [{ role: 'user', text: setupRequest(desc, brief, context.asked) }],
      tools: [SETUP_DEFINITION],
      run,
      tell: telling(context.runId, log),
      shown: false,
      effort: SETUP_EFFORT,
      timeoutMs: SETUP_TIMEOUT_MS,
    })
    const call = reply.toolCalls.find((one) => one.name === SETUP_TOOL)
    if (!call) throw new Error(`Setting up the work chose nothing${reply.text ? `: ${reply.text}` : '.'}`)
    const chosen = setUpOf(call.input, plugins, skills)
    log(`plugins ${chosen.plugins.join(', ') || 'none'}; skills ${chosen.skills.join(', ') || 'none'}`)
    return chosen
  } finally {
    context.signal?.removeEventListener('abort', stopped)
  }
}
