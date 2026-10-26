import fs from 'node:fs'
import path from 'node:path'
import { describeFolder } from '../../shared/agent/build/files'
import { builderRound, builderSystem } from '../../shared/agent/build/prompt'
import { forkOf } from '../../shared/agent/fork'
import { closeOff } from '../../shared/agent/history'
import { failedNote, STOPPED_NOTE } from '../../shared/agent/transcript'
import { isPluginId } from '../../shared/plugins/id'
import { buildRoot } from '../home'
import { loopsOf, usePlugin } from '../loops/loops'
import type { ProviderConfig } from '../secrets'
import { getState, subscribe } from '../state'
import { agentLoop } from './agent'
import { REFERENCE } from './build/reference'
import {
  approvalEndedMessage,
  pluginLine,
  resolveBuildId,
  unfinishedBuild,
  waitForBuild,
  type ApprovalEnd,
} from './build/check'
import { listFilesSync, openFolder } from './build/folder'
import { builderTools, builtPlugins, ownerOf, type BuildSession } from './build/tools'
import { readCodingMemories } from './memory'
import { conversationTools } from './tools/conversation'
import { sourceTools } from './tools/data'
import { codingMemoryTools } from './tools/memory'
import type { ToolContext } from './tools/types'
import { emit, isStopped, type Live } from './utils/runs'
import { configured } from './utils/settings'
import { eraOf, join, keepOpen, startOver, threadFor } from './utils/thread'
import { searchAvailable } from './web/search'

// The builder: a run of the agent loop inside the user's run, with its own prompt and its own tools, that
// writes one plugin and reports. It runs quiet, on the parent's run id, so its tool calls show on the
// status line under the request they serve and Stop stops it, while its words go to the orchestrator
// rather than the answer box.
//
// A build has a folder and a conversation of its own, kept under the plugin's id as it grows. The
// plugin is installed as a shell and filled in after, so installed is not finished: a build is over
// when its plugin is installed and its builder ended the run of its own accord. Until then both stay,
// however the build ended: a failure, a stop, the app closing, the user's No or a question nobody
// answered, the builder out of rounds. The next build of that plugin carries on from them. Once it
// is over the conversation goes: what was built is in its folder, and a later build reads it there.

/** A build is many short steps: a shell, a file a round, the install, the fixes, the runs. */
const BUILD_ROUNDS = 40

/** What the caller is told of a build that is not over: nothing of it is lost, and how it goes on. */
const CARRIES_ON =
  'What this build wrote and said is kept: call build_plugin again with the same id to carry on from there.'

/** The chat a plugin's build is kept under. No workspace's is: theirs are named by their ids. */
function buildChat(id: string): string {
  return `build/${id}`
}

const RUN_MEMORY_MAX = 64
const endedInRun = new Map<string, { id: string; ended: ApprovalEnd; widened?: string[] }>()
const buildsInRun = new Map<string, string[]>()

function rememberEnded(runId: string, entry: { id: string; ended: ApprovalEnd; widened?: string[] }): void {
  if (!runId) return
  if (endedInRun.size >= RUN_MEMORY_MAX) {
    const oldest = endedInRun.keys().next().value
    if (oldest !== undefined) endedInRun.delete(oldest)
  }
  endedInRun.set(runId, entry)
}

function rememberBuildInRun(runId: string, id: string): void {
  if (!runId) return
  const prev = buildsInRun.get(runId) ?? []
  if (!prev.includes(id)) {
    if (!buildsInRun.has(runId) && buildsInRun.size >= RUN_MEMORY_MAX) {
      const oldest = buildsInRun.keys().next().value
      if (oldest !== undefined) buildsInRun.delete(oldest)
    }
    buildsInRun.set(runId, [...prev, id])
  }
}

function hasOpenBuildThread(id: string, config: ProviderConfig<'llm'>): boolean {
  return threadFor(buildChat(id), config).length > 0
}

function hasStagedFiles(id: string): boolean {
  const dir = path.join(buildRoot(), id)
  return fs.existsSync(dir) && listFilesSync({ id, live: false, dir }).length > 0
}

function isUnfinishedBuild(id: string, config: ProviderConfig<'llm'>): boolean {
  if (!isPluginId(id)) return false
  const owner = ownerOf(id)
  if (owner === 'other') return false
  const openThread = hasOpenBuildThread(id, config)
  if (getState().plugins[id]?.status === 'ready' && !openThread) return false
  return owner === 'built' || openThread || hasStagedFiles(id)
}

function resolveLoopBuildId(rawId: string, parent: ToolContext, config: ProviderConfig<'llm'>): string {
  const loopPlugins =
    parent.loop !== undefined
      ? (loopsOf(parent.workspaceId).list.find((one) => one.id === parent.loop)?.plugins ?? [])
      : []
  const runPlugins = buildsInRun.get(parent.runId) ?? []
  const candidates = [...new Set([...loopPlugins, ...runPlugins])]
  const unfinished = candidates.filter((candidate) => isUnfinishedBuild(candidate, config))
  const taken = new Set(Object.keys(getState().plugins))
  if (isPluginId(rawId) && (ownerOf(rawId) !== 'free' || hasOpenBuildThread(rawId, config) || hasStagedFiles(rawId))) {
    taken.add(rawId)
  }
  return resolveBuildId(rawId, unfinished, taken)
}

/** Runs or resumes a plugin's builder, keeping unfinished work and returning its status and reply on completion. */
export async function runBuild(request: string, rawId: string, parent: ToolContext): Promise<string> {
  const priorEnd = endedInRun.get(parent.runId)
  if (priorEnd) return approvalEndedMessage(priorEnd.id, priorEnd.ended, priorEnd.widened)

  const config = configured()
  const id = resolveLoopBuildId(rawId, parent, config)
  if (!isPluginId(id)) {
    throw new Error(`Give the plugin an id: lower-case letters, digits, and dashes, like fred or sec-filings.`)
  }
  const folder = await openFolder(id, ownerOf(id))
  const session: BuildSession = { id, request, folder, guard: {} }
  const controller = new AbortController()
  const stopped = (): void => controller.abort(parent.signal?.reason)
  parent.signal?.addEventListener('abort', stopped, { once: true })
  // The parent's context, on this run's own signal, which the parent's stop reaches.
  const context: ToolContext = { ...parent, signal: controller.signal }
  const run: Live = { runId: parent.runId, origin: 'user', controller }
  // The build's conversation, on a copy as a request's is: empty, unless a build of this plugin ended
  // before it was over, which this one then carries on from, its request after what was said.
  const chat = buildChat(id)
  const thread = threadFor(chat, config)
  const era = eraOf(thread)
  const fork = forkOf(thread)
  const history = fork.turns
  const keep = (): void => {
    keepOpen(chat, config, thread, fork, era)
    if (session.guard?.ended) controller.abort()
  }
  // Once, so the run's block of the prompt reads the same every round.
  const built = builtPlugins(id)
  const memories = await readCodingMemories()
  const begun = !folder.live && listFilesSync(folder).length > 0
  const keepForLoop = (): void => {
    rememberBuildInRun(parent.runId, id)
    if (parent.loop !== undefined) usePlugin(parent.workspaceId, parent.loop, id)
  }
  emit({ kind: 'status', runId: parent.runId, line: `Building ${id}` })
  // Whether the builder used every round it gets: its end was then not its own choice.
  let ranOut = false
  let text: string
  let builtPlugin = getState().plugins[id]
  try {
    history.push({ role: 'user', text: request })
    keep()
    text = await agentLoop({
      label: `build ${id} `,
      config,
      history,
      context,
      prompt: {
        system: () =>
          builderSystem(REFERENCE, {
            request,
            id,
            taken: Object.keys(getState().plugins).filter((other) => other !== id),
            search: searchAvailable(),
            platform: process.platform,
            live: session.folder.live,
            begun: !session.folder.live && begun,
            built,
            memories,
          }),
        round: () =>
          builderRound(
            describeFolder(listFilesSync(session.folder)),
            pluginLine(getState().plugins[id], id, session.folder.live),
          ),
      },
      tools: () => [
        ...builderTools(session, context),
        ...codingMemoryTools,
        ...sourceTools(),
        ...conversationTools.filter((tool) => tool.name === 'ask_user'),
      ],
      run,
      quiet: true,
      // A reply that carries a whole file is long: a provider's default limit has cut one off before
      // a single call. This is the least it needs; a provider that gives more room keeps it.
      maxTokens: 16_000,
      rounds: BUILD_ROUNDS,
      outOfRounds: () => {
        ranOut = true
      },
      keep,
    })
    const current = getState().plugins[id]
    builtPlugin =
      current?.status === 'building'
        ? await waitForBuild(id, { read: getState, subscribe: (listener) => subscribe(listener) }, context.signal)
        : current
  } catch (err) {
    if (session.guard?.ended && !parent.signal?.aborted) {
      if (session.guard.ended === 'declined' && !session.folder.live && !begun) {
        startOver(chat, config, thread)
      } else {
        join(chat, config, thread, fork, era)
        keepForLoop()
      }
      rememberEnded(parent.runId, { id, ended: session.guard.ended })
      return approvalEndedMessage(id, session.guard.ended)
    }
    // Cut off: the conversation is closed off with why.
    const byUser = isStopped(run, err)
    const message = err instanceof Error ? err.message : String(err)
    closeOff(history, byUser ? STOPPED_NOTE : failedNote(message))
    join(chat, config, thread, fork, era)
    keepForLoop()
    throw byUser ? err : new Error(`${message.replace(/[.\s]+$/, '')}. ${CARRIES_ON}`)
  } finally {
    parent.signal?.removeEventListener('abort', stopped)
  }
  keepForLoop()
  const widened = session.guard?.declinedWidening ? [...session.guard.declinedWidening] : []
  if (widened.length > 0 && builtPlugin?.status !== 'ready') {
    join(chat, config, thread, fork, era)
    rememberEnded(parent.runId, { id, ended: 'declined', widened })
    return approvalEndedMessage(id, 'declined', widened)
  }
  // The orchestrator reads the plugin's state before the builder's words: a build that is not over
  // finished nothing, whatever it said, and is told so as an error. What it wrote and said stays.
  const unfinished = unfinishedBuild(id, session.folder.live, builtPlugin, ranOut)
  if (unfinished !== null || !builtPlugin) {
    join(chat, config, thread, fork, era)
    throw new Error(`${unfinished ?? `${id} is not finished.`} It said: ${text || '(nothing)'}\n${CARRIES_ON}`)
  }
  // Over: its conversation goes with it.
  startOver(chat, config, thread)
  return `${pluginLine(builtPlugin, id, true)}\n\n${text}`
}
