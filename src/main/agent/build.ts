import { describeFolder } from '../../shared/agent/build/files'
import { builderRound, builderSystem } from '../../shared/agent/build/prompt'
import { forkOf } from '../../shared/agent/fork'
import { closeOff } from '../../shared/agent/history'
import { failedNote, STOPPED_NOTE } from '../../shared/agent/transcript'
import { isPluginId } from '../../shared/plugins/id'
import { getState } from '../state'
import { agentLoop } from './agent'
import { REFERENCE } from './build/reference'
import { pluginLine } from './build/check'
import { listFilesSync, openFolder } from './build/folder'
import { builderTools, builtPlugins, ownerOf, type BuildSession } from './build/tools'
import { conversationTools } from './tools/conversation'
import { sourceTools } from './tools/data'
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

export async function runBuild(request: string, id: string, parent: ToolContext): Promise<string> {
  if (!isPluginId(id)) {
    throw new Error(`Give the plugin an id: lower-case letters, digits, and dashes, like fred or sec-filings.`)
  }
  const folder = await openFolder(id, ownerOf(id))
  const session: BuildSession = { id, request, folder }
  const controller = new AbortController()
  const stopped = (): void => controller.abort(parent.signal?.reason)
  parent.signal?.addEventListener('abort', stopped, { once: true })
  // The parent's context, on this run's own signal, which the parent's stop reaches.
  const context: ToolContext = { ...parent, signal: controller.signal }
  const run: Live = { runId: parent.runId, origin: 'user', controller }
  const config = configured()
  // The build's conversation, on a copy as a request's is: empty, unless a build of this plugin ended
  // before it was over, which this one then carries on from, its request after what was said.
  const chat = buildChat(id)
  const thread = threadFor(chat, config)
  const era = eraOf(thread)
  const fork = forkOf(thread)
  const history = fork.turns
  const keep = (): void => keepOpen(chat, config, thread, fork, era)
  // Once, so the run's block of the prompt reads the same every round.
  const built = builtPlugins(id)
  const begun = !folder.live && listFilesSync(folder).length > 0
  emit({ kind: 'status', runId: parent.runId, line: `Building ${id}` })
  // Whether the builder used every round it gets: its end was then not its own choice.
  let ranOut = false
  let text: string
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
            live: folder.live,
            begun,
            built,
          }),
        round: () =>
          builderRound(describeFolder(listFilesSync(session.folder)), pluginLine(getState().plugins[id], id)),
      },
      tools: () => [
        ...builderTools(session, context),
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
  } catch (err) {
    // Cut off: the conversation is closed off with why.
    const byUser = isStopped(run, err)
    const message = err instanceof Error ? err.message : String(err)
    closeOff(history, byUser ? STOPPED_NOTE : failedNote(message))
    join(chat, config, thread, fork, era)
    throw byUser ? err : new Error(`${message.replace(/[.\s]+$/, '')}. ${CARRIES_ON}`)
  } finally {
    parent.signal?.removeEventListener('abort', stopped)
  }
  // The orchestrator reads the plugin's state before the builder's words: a build that is not over
  // finished nothing, whatever it said, and is told so as an error. What it wrote and said stays.
  if (!session.folder.live || ranOut) {
    join(chat, config, thread, fork, era)
    const state = session.folder.live
      ? `${id} is installed but not finished: the builder used all its rounds.`
      : `${id} was not installed: the builder stopped before install_plugin.`
    throw new Error(`${state} It said: ${text || '(nothing)'}\n${CARRIES_ON}`)
  }
  // Over: its conversation goes with it.
  startOver(chat, config, thread)
  return `${pluginLine(getState().plugins[id], id)}\n\n${text}`
}
