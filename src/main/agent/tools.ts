import { LOOP_EXCLUDED_TOOLS, ORCHESTRATOR_EXCLUDED_TOOLS } from '../../shared/loops/loops'
import { askForUnsetKey } from '../actions'
import { buildTools } from './tools/build'
import { cellsTools } from './tools/cells'
import { conversationTools } from './tools/conversation'
import { storeTools, sourceTools } from './tools/data'
import { loopsTools } from './tools/loops'
import { gridTools } from './tools/grid'
import { installTools } from './tools/installs'
import { memoryTools } from './tools/memory'
import { shellTools } from './tools/shell'
import { skillTools } from './tools/skills'
import { stateTools } from './tools/state'
import { tasksTools } from './tools/tasks'
import type { Tool, ToolContext } from './tools/types'
import { webTools } from './tools/web'

/** The fixed tools, composed by responsibility. Dynamic catalogs are read again each round. */
const TOOLS: Tool[] = [...cellsTools, ...memoryTools, ...conversationTools, ...stateTools, ...installTools]

/**
 * Rebuilt each round because plugins, connections, and skills can change between calls, because the
 * shell is there only while pro mode is on, as is what a task says of its commands, and web search
 * only while a search provider is set — otherwise the model is never told they exist — and because
 * the grid tools carry the workspace's own grid size in their schemas.
 */
export function allTools(context?: ToolContext): Tool[] {
  return [
    ...gridTools(context),
    ...TOOLS,
    ...tasksTools(),
    ...skillTools(context),
    ...storeTools(),
    ...sourceTools(askForUnsetKey),
    ...webTools(),
    ...shellTools(context),
    ...buildTools(context),
    ...loopsTools(context),
  ]
}

const NOT_A_LOOPS = new Set<string>(LOOP_EXCLUDED_TOOLS)

/** What a loop's agent may call: every tool of the families, less what is the window's. Its tools refuse another loop's tiles themselves. */
export function loopTools(context: ToolContext): Tool[] {
  return allTools(context).filter((tool) => !NOT_A_LOOPS.has(tool.name))
}

const NOT_THE_ORCHESTRATORS = new Set<string>(ORCHESTRATOR_EXCLUDED_TOOLS)

/**
 * What the orchestrator may call of the tool families: everything but what drives a view, which a
 * loop's agent does. The tools that hold loops are added where it is run (`router.ts`).
 */
export function orchestratorTools(context: ToolContext): Tool[] {
  return allTools(context).filter((tool) => !NOT_THE_ORCHESTRATORS.has(tool.name))
}

/** A tool by name, among both agents' tools: what a task's one call is made with. */
export function findTool(name: string): Tool | undefined {
  return allTools().find((tool) => tool.name === name)
}
