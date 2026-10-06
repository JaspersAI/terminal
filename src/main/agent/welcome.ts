import { ipcMain } from 'electron'
import { sleep } from '../../shared/abort'
import { EXAMPLE_ASK, EXAMPLE_FALLBACK, EXPLANATION, GREETING, WELCOME_NOTE } from '../../shared/agent/welcome'
import { getProviderConfig } from '../secrets'
import { getState, update } from '../state'
import { runWelcome, said } from './orchestrator'
import { threadFor } from './utils/thread'

// The welcome after setup: three messages the assistant says on its own once the workspace is on
// screen, a few seconds apart, so a new user is spoken to before they have to think of what to say.
// The renderer says when the screen is theirs (Home, after the Eye question); main says the messages
// into the workspace's thread, as a task's reply goes, and keeps the tree's `welcome` up while it
// does, which is what holds the composer open with its field showing. It is asked for over IPC, as a
// run is, rather than as an action: actions.ts is what the agent imports for unattended work, and a
// handler there for something that runs the agent would close the circle.

/** A beat before the first message: the composer is still rising. */
const FIRST_MS = 1200
/** A beat between messages, about what the one before takes to read. */
const BEAT_MS = 4000
/** How long the model gets for the example, from the start; then the fallback is said and the run stopped. */
const EXAMPLE_MAX_MS = 20_000
/** How long after the last message the composer stays up on its own, so it can be read and answered. */
const HOLD_MS = 20_000

let welcomed = false

/**
 * Starts the welcome, once a session: on the workspace on screen, and only into a conversation with
 * nothing in it yet, so a window asking twice, or asking for a user who has already talked, changes
 * nothing. The messages follow on their own; this returns as soon as it is under way.
 */
function startWelcome(): void {
  const state = getState()
  if (!state.onboardingComplete) throw new Error('Finish setup first.')
  if (welcomed) return
  const config = getProviderConfig('llm')
  const workspaceId = state.currentWorkspaceId
  if (!config || threadFor(workspaceId, config).length > 0) return
  welcomed = true
  void welcome(workspaceId).catch((err: unknown) => {
    console.error('[welcome]', err instanceof Error ? err.message : String(err))
  })
}

async function welcome(workspaceId: string): Promise<void> {
  update((state) => ({ ...state, welcome: { workspaceId, said: 0 } }))
  const control = new AbortController()
  try {
    // Asked for now, so the model's time passes while the first two are read. A model that cannot be
    // reached is asked again a few times, which could outlast the reading; the wait is capped, and the
    // run stopped then, so the third message comes either way.
    const example = runWelcome(workspaceId, EXAMPLE_ASK, control.signal).then(
      (text) => text.trim() || EXAMPLE_FALLBACK,
      (err: unknown) => {
        console.error('[welcome] example:', err instanceof Error ? err.message : String(err))
        return EXAMPLE_FALLBACK
      },
    )
    const late = sleep(EXAMPLE_MAX_MS).then(() => null)
    await sleep(FIRST_MS)
    await say(workspaceId, GREETING)
    await sleep(BEAT_MS)
    await say(workspaceId, EXPLANATION)
    const [, third] = await Promise.all([sleep(BEAT_MS), Promise.race([example, late])])
    if (third === null) {
      console.log('[welcome] the example took too long: saying the fallback')
      control.abort()
    }
    await say(workspaceId, third ?? EXAMPLE_FALLBACK)
    await sleep(HOLD_MS)
  } finally {
    control.abort()
    update((state) => (state.welcome === null ? state : { ...state, welcome: null }))
  }
}

/** One message into the thread, then the count on the tree, which is what the chat reads the thread again on. */
async function say(workspaceId: string, text: string): Promise<void> {
  if (!(await said(workspaceId, WELCOME_NOTE, text))) throw new Error('No conversation to welcome into.')
  console.log(`[welcome] ${text}`)
  update((state) =>
    state.welcome?.workspaceId === workspaceId
      ? { ...state, welcome: { workspaceId, said: state.welcome.said + 1 } }
      : state,
  )
}

export function registerWelcomeIpc(): void {
  ipcMain.handle('agent:welcome', () => startWelcome())
}
