import { ipcMain } from 'electron'
import { CENTRAL_CHAT } from '../../shared/agent/history'
import {
  buildOnboardingProfile,
  EMPTY_ONBOARDING_ANSWERS,
  profileReplyFor,
  readOnboardingAction,
  WELCOME_NOTE,
  welcomeIntroFor,
  type OnboardingAnswers,
  type WelcomeOnboarding,
} from '../../shared/agent/welcome'
import { BROWSER_VIEW } from '../../shared/grid/browser'
import {
  CHAT_VIEW,
  chatElement,
  chatPlacementFor,
  layoutOf,
  resolvePlacement,
  starterRoomPlacements,
  type Placement,
} from '../../shared/grid/grid'
import { MAIN_WINDOW } from '../../shared/grid/windows'
import { loopTitle } from '../../shared/loops/loops'
import { createLoop, placeChecked, renameLoop, selectWorkspace } from '../actions'
import { getGrid } from '../grid/grid'
import { signedIn } from '../jaspers/jaspers'
import { getState, update } from '../state'
import { handOver } from './loop'
import { writeMemory } from './memory'
import { said } from './orchestrator'
import { waitForThreads } from './thread-file'
import { modelFor } from './utils/settings'
import { threadFor } from './utils/thread'

// Workspace onboarding in Central once setup finishes and the main screen is the user's:
// 1. Docks Central (`core/chat`) at the top-central space of the main window's grid.
// 2. Files a crisp welcome overview into Central's conversation highlighting the core architecture
//    from the README (isolated Grid Rooms, local SQLite + FTS5 data plane, MCP Hub + coding agent +
//    market-calendar delta watches).
// 3. Drives the skippable 3-question profiling flow, persists `user-profile` to ~/Jaspers/memory/,
//    and launches tailored starter rooms around Central on demand.

let welcomed = false
let profileNoteFiled = false

function hasExistingWorkspaceActivity(): boolean {
  const state = getState()
  for (const loops of Object.values(state.loops)) {
    if (loops.list.length > 0 || (loops.closed?.length ?? 0) > 0) return true
  }
  for (const windows of Object.values(state.grids)) {
    for (const grid of Object.values(windows)) {
      if (grid.elements.some((e) => e.loop !== undefined) || Object.keys(grid.cells).length > 0) return true
    }
  }
  return false
}

/**
 * Starts workspace onboarding once per install on a fresh conversation: docks Central at the
 * top-center of the active tab's grid, files the opening overview, and opens Question 1 of 3.
 */
function startWelcome(): void {
  const state = getState()
  if (!state.onboardingComplete) throw new Error('Finish setup first.')
  if (welcomed || state.workspaceOnboarded) return
  welcomed = true
  void beginOnboarding().catch((err: unknown) => {
    welcomed = false
    console.error('[welcome]', err instanceof Error ? err.message : String(err))
  })
}

async function beginOnboarding(): Promise<void> {
  await waitForThreads()
  const state = getState()
  if (state.workspaceOnboarded) return
  const config = modelFor(CENTRAL_CHAT)
  if (!config) return
  if (threadFor(CENTRAL_CHAT, config).length > 0 || hasExistingWorkspaceActivity()) {
    update((s) => (s.workspaceOnboarded ? s : { ...s, workspaceOnboarded: true }))
    return
  }
  const workspaceId = state.currentWorkspaceId
  const grid = getGrid(workspaceId, MAIN_WINDOW)
  if (!chatElement(grid)) {
    placeChecked(workspaceId, MAIN_WINDOW, { kind: 'view', view: CHAT_VIEW }, undefined, chatPlacementFor(grid))
  }
  const onboarding: WelcomeOnboarding = {
    step: 0,
    answers: { ...EMPTY_ONBOARDING_ANSWERS },
    profile: null,
    startedRooms: {},
  }
  update((s) => ({
    ...s,
    welcome: { workspaceId, said: 0, onboarding },
  }))
  await say(workspaceId, welcomeIntroFor(getState().collab.firstName))
}

async function handleOnboarding(raw: unknown): Promise<void> {
  const action = readOnboardingAction(raw)
  if (action.kind === 'skip-all' || action.kind === 'dismiss') {
    update((state) =>
      state.welcome === null && state.workspaceOnboarded
        ? state
        : { ...state, workspaceOnboarded: true, welcome: null },
    )
    return
  }

  const state = getState()
  const current = state.welcome?.onboarding
  if (!state.welcome || !current) return
  const { workspaceId } = state.welcome

  if (action.kind === 'back') {
    const prevStep =
      current.step === 'recommendations' ? 2 : current.step === 2 ? 1 : current.step === 1 ? 0 : current.step
    setOnboarding({ ...current, step: prevStep })
    return
  }

  if (action.kind === 'show-recommendations') {
    await finalizeProfile(workspaceId, current.answers, current.startedRooms)
    return
  }

  if (action.kind === 'answer' || action.kind === 'skip-question') {
    const nextAnswers: OnboardingAnswers = {
      ...current.answers,
      ...(action.focusText !== undefined ? { focusText: action.focusText.trim() } : {}),
    }
    if (action.kind === 'answer') {
      if (action.step === 0) nextAnswers.style = action.selected
      else if (action.step === 1) nextAnswers.coverage = action.selected
      else nextAnswers.workflows = action.selected
    }
    if (action.step < 2) {
      const nextStep = (action.step + 1) as 0 | 1 | 2
      setOnboarding({ ...current, step: nextStep, answers: nextAnswers })
      return
    }
    await finalizeProfile(workspaceId, nextAnswers, current.startedRooms)
    return
  }

  if (action.kind === 'start-room') {
    const profile =
      current.profile ??
      buildOnboardingProfile(current.answers, {
        signedIn: signedIn(),
        installedPlugins: Object.keys(state.plugins),
        firstName: state.collab.firstName,
      })
    const room = profile.rooms.find((one) => one.id === action.roomId)
    if (!room) throw new Error('Unknown starter room.')
    if (current.startedRooms[room.id]) return

    const targetTab =
      state.workspaces.find((w) => w.id === state.currentWorkspaceId && !w.replica) ??
      state.workspaces.find((w) => w.id === workspaceId && !w.replica) ??
      state.workspaces.find((w) => !w.replica)
    if (!targetTab) throw new Error('No owned tab is open for a starter room.')
    if (state.currentWorkspaceId !== targetTab.id) selectWorkspace(targetTab.id)

    const grid = getGrid(targetTab.id, MAIN_WINDOW)
    const placement = nextStarterPlacement(targetTab.id)
    const latestState = getState()
    const equippedPlugins = room.preferredPlugins.filter((id) => Boolean(latestState.plugins[id]))
    const { loop } = createLoop(
      targetTab.id,
      MAIN_WINDOW,
      {
        desc: room.desc,
        brief: room.brief,
        systemPrompt: room.systemPrompt,
        plugins: equippedPlugins,
        skills: [],
      },
      placement ?? { size: layoutOf(grid).elements.length === 0 ? 'quarter' : undefined },
    )
    renameLoop(targetTab.id, loop.id, room.title, room.desc)

    if (room.initialBrowserUrl) {
      placeChecked(
        targetTab.id,
        MAIN_WINDOW,
        { kind: 'view', view: BROWSER_VIEW },
        { url: room.initialBrowserUrl },
        { size: 'full' },
        loop.id,
      )
    }

    if (room.prompt.trim()) {
      handOver(targetTab.id, loop.id, { typed: room.prompt, written: room.brief })
    }

    const label = `${loopTitle(loop.id)}`
    update((s) => {
      if (!s.welcome?.onboarding) return s
      return {
        ...s,
        welcome: {
          ...s.welcome,
          onboarding: {
            ...s.welcome.onboarding,
            profile,
            startedRooms: { ...s.welcome.onboarding.startedRooms, [room.id]: label },
          },
        },
      }
    })
  }
}

function nextStarterPlacement(workspaceId: string): Placement | null {
  const grid = getGrid(workspaceId, MAIN_WINDOW)
  const elements = layoutOf(grid).elements
  for (const candidate of starterRoomPlacements(grid.size)) {
    const resolved = resolvePlacement(elements, grid.size, candidate)
    if (resolved?.resolved === 'exact') return candidate
  }
  return null
}

async function finalizeProfile(
  workspaceId: string,
  answers: OnboardingAnswers,
  startedRooms: Record<string, string>,
): Promise<void> {
  const state = getState()
  const profile = buildOnboardingProfile(answers, {
    signedIn: signedIn(),
    installedPlugins: Object.keys(state.plugins),
    firstName: state.collab.firstName,
  })
  if (profile.memory) {
    const refusal = await writeMemory(profile.memory.name, profile.memory.about, profile.memory.body)
    if (refusal) console.warn('[welcome] memory:', refusal)
  }
  setOnboarding({
    step: 'recommendations',
    answers,
    profile,
    startedRooms,
  })
  update((s) => (s.workspaceOnboarded ? s : { ...s, workspaceOnboarded: true }))
  if (!profileNoteFiled) {
    profileNoteFiled = true
    await say(workspaceId, profileReplyFor(profile))
  }
}

function setOnboarding(onboarding: WelcomeOnboarding): void {
  update((state) => (state.welcome === null ? state : { ...state, welcome: { ...state.welcome, onboarding } }))
}

/** One message into Central's thread, bumping `said` so open chat surfaces re-read history. */
async function say(workspaceId: string, text: string): Promise<void> {
  if (!(await said(workspaceId, WELCOME_NOTE, text))) return
  console.log(`[welcome] ${text.split('\n')[0] ?? text}`)
  update((state) => (state.welcome ? { ...state, welcome: { ...state.welcome, said: state.welcome.said + 1 } } : state))
}

export function registerWelcomeIpc(): void {
  ipcMain.handle('agent:welcome', () => startWelcome())
  ipcMain.handle('agent:onboarding', (_event, raw: unknown) => handleOnboarding(raw))
}
