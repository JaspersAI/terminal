import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ZodError } from 'zod'
import {
  NO_ROOM_TO_RESTORE,
  layoutOf,
  panelOf,
  placeFramed,
  placeView,
  publishOutput,
  publishText,
  refreshPanel,
  removeElement,
  setIn,
  setPanelState,
  setRect,
  sizeProblem,
  writeCells,
  swapElements,
  type ElementMode,
  type GridElement,
  type GridSize,
  type Panel,
  type PanelContent,
  type Placement,
  type Rect,
  type Resolved,
} from '../shared/grid/grid'
import { askedIn, samePlace, type Place } from '../shared/agent/asking'
import {
  LOOP_ID,
  frameOf,
  isTile,
  loopName,
  NO_LOOPS,
  withLoopFor,
  withLoopAsked,
  type Loop,
  type LoopSpec,
} from '../shared/loops/loops'
import { closedLoop, reopened, withoutLoop } from '../shared/loops/closed'
import { readBudget } from '../shared/agent/budget'
import { isTheme } from '../shared/app/theme'
import { EYE_CONSENT, readEye, readFeedbackText } from '../shared/app/eye'
import { sendFeedback } from './eye/eye'
import { createQuestions } from './agent/utils/questions'
import { knownSecrets } from './agent/utils/settings'
import { readProMode } from '../shared/app/pro-mode'
import { addNotice, setUnread } from './app/notices'
import { markRead } from './data/store'
import { parseClockRule } from '../shared/tasks/clock-rule'
import {
  findProvider,
  normalizeBaseUrl,
  signsIn,
  validateProviderInput,
  voiceWith,
  searchWith,
  withJaspersWhereNone,
} from '../shared/llm/providers'
import {
  WORKSPACE_NAME_MAX,
  type Action,
  type ProviderInput,
  type ProviderKind,
  type Workspace,
  type SecretRequest,
} from '../shared/state'
import type { TaskCall, TaskInput } from '../shared/tasks/tasks'
import { connectionsOf } from './plugins/connections'
import { secretProgress, secretRefs, type SecretProgress } from '../shared/plugins/connections'
import { isOpenWindow, MAIN_WINDOW, WINDOWS_MAX, withWindows } from '../shared/grid/windows'
import { loopsOf, tidied, withLoops } from './loops/loops'
import {
  changeGrid,
  changeGridOf,
  changeInside,
  changeMode,
  changeWindow,
  findElement,
  focus,
  getGrid,
  getGrids,
  moveElementAcross,
  setGridSize,
} from './grid/grid'
import { openWindow, surplusNote, useAllScreens, useOneScreen } from './grid/windows'
import { installDefaultsForSignUp, removeInstalled } from './plugins/install'
import { connect } from './plugins/mcp'
import { dismissNotice } from './app/notices'
import { authorize } from './plugins/oauth'
import { signIn, signOut, signedIn } from './jaspers/jaspers'
import { allowApps } from './plugins/app-consent'
import { getView } from './plugins/registry'
import { seal } from './secrets'
import { getState, update, subscribe } from './state'
import { setOpenAtLogin } from './app/background'
import { checkForUpdates, installUpdate } from './app/updates'
import { removeSkill, setSkillEnabled } from './skills/skills'
import { cancelTask, runTaskNow, scheduleTask, setTaskEnabled } from './tasks/tasks'

// Every way the tree changes, by name. `dispatch` is the renderer's door: what comes over IPC is
// not trusted, so each handler checks the shape of its arguments before calling the mutation.
// Main's own callers, the tools, call the mutations directly.

type Handler = (raw: Record<string, unknown>) => void | Promise<void>

/** One handler per action. The type makes the table exhaustive: an `Action` without a handler fails typecheck. */
const HANDLERS: Record<Action['type'], Handler> = {
  'provider.set': (raw) => setProvider(asKind(raw.kind), asInput(raw.input)),
  // The browser flow, waited for: the screen that asked moves on once the sign-in is in.
  'jaspers.signIn': () => signInWithJaspers(),
  'jaspers.signOut': () => signOut(),
  'onboarding.complete': () => completeOnboarding(),
  'workspace.create': () => createWorkspace(),
  'workspace.rename': (raw) => renameWorkspace(asString(raw.id), asString(raw.name)),
  'workspace.select': (raw) => selectWorkspace(asString(raw.id)),
  'workspace.delete': (raw) => deleteWorkspace(asString(raw.id)),
  // An element is addressed by id alone: ids are unique across a workspace's windows, and main finds the grid.
  'element.focus': (raw) => focus(asString(raw.workspaceId), asString(raw.elementId)),
  'element.remove': (raw) => {
    const elementId = asString(raw.elementId)
    removeChecked(asString(raw.workspaceId), elementId)
  },
  'loop.delete': (raw) => {
    const loop = asString(raw.loop)
    if (!LOOP_ID.test(loop)) throw new Error('loop.delete names a piece of work by its id.')
    // One that is already gone is nothing to do: another window may have deleted it a moment ago.
    deleteLoop(asString(raw.workspaceId), loop)
  },
  'loop.close': (raw) => {
    const loop = asString(raw.loop)
    if (!LOOP_ID.test(loop)) throw new Error('loop.close names a loop by its id.')
    closeLoop(asString(raw.workspaceId), loop)
  },
  'loop.reopen': (raw) => {
    const loop = asString(raw.loop)
    if (!LOOP_ID.test(loop)) throw new Error('loop.reopen names a loop by its id.')
    reopenLoop(asString(raw.workspaceId), loop, raw.window === undefined ? undefined : asWindow(raw.window))
  },
  'element.setMode': (raw) => {
    const workspaceId = asString(raw.workspaceId)
    const elementId = asString(raw.elementId)
    const mode = asMode(raw.mode)
    try {
      changeMode(workspaceId, elementId, mode)
    } catch (err) {
      // A tile restored by hand with no room left for it stays minimized, and its bar has nowhere of
      // its own to say why: it is said where the app says things. Any other refusal is the caller's.
      if (!message(err).startsWith(NO_ROOM_TO_RESTORE)) throw err
      const work = loopsOf(workspaceId).list.find((one) => one.id === tileLoop(workspaceId, elementId))
      addNotice(
        'grid',
        `No room to bring ${work ? loopName(work.id) : elementId} back: free some cells on the grid, then restore it again.`,
      )
    }
  },
  'element.setRect': (raw) => {
    const elementId = asString(raw.elementId)
    const rect = asRect(raw.rect)
    changeGridOf(asString(raw.workspaceId), elementId, (grid) => setRect(grid, elementId, rect))
  },
  'element.swap': (raw) => {
    const elementId = asString(raw.elementId)
    const otherId = asString(raw.otherId)
    changeGridOf(asString(raw.workspaceId), elementId, (grid) => swapElements(grid, elementId, otherId))
  },
  'element.moveAcross': (raw) => {
    const elementId = asString(raw.elementId)
    moveElementAcross(asString(raw.workspaceId), elementId, asWindow(raw.window), { rect: asRect(raw.rect) })
  },
  'element.place': (raw) => {
    placeChecked(
      asString(raw.workspaceId),
      asWindow(raw.window),
      asContent(raw.content),
      optionalRecord(raw.state),
      asPlacement(raw.placement),
    )
  },
  'cells.write': (raw) => {
    const cells = asCells(raw.cells)
    changeGrid(asString(raw.workspaceId), asWindow(raw.window), (grid) => writeCells(grid, cells))
  },
  'grid.setSize': (raw) => {
    setGridSize(asString(raw.workspaceId), asGridSize(raw.size))
  },
  'panel.setState': (raw) => {
    setPanelStateChecked(asString(raw.workspaceId), asString(raw.panelId), asPath(raw.path), raw.value)
  },
  'panel.publish': (raw) => {
    publishChecked(asString(raw.workspaceId), asString(raw.panelId), asRecord(raw.output))
  },
  'panel.publishText': (raw) => {
    publishTextChecked(asString(raw.workspaceId), asString(raw.panelId), asTextOrNull(raw.text))
  },
  'panel.refresh': (raw) => {
    refreshChecked(asString(raw.workspaceId), asString(raw.panelId))
  },
  'plugin.setSecret': (raw) => setSecret(asString(raw.plugin), asString(raw.key), asString(raw.value)),
  'plugin.remove': (raw) => removeInstalled(asString(raw.id)),
  'proMode.set': (raw) => setProMode(raw['proMode']),
  'eye.set': (raw) => setEye(raw['eye']),
  // A frame of every window and a file written, so it is waited for: the popover says when it is sent.
  'eye.feedback': async (raw) => {
    await sendFeedback(readFeedbackText(raw['text']), knownSecrets())
  },
  'skill.setEnabled': (raw) => setSkillEnabled(asString(raw.id), asBoolean(raw.enabled)),
  'skill.remove': (raw) => removeSkill(asString(raw.id)),
  // Both of these take as long as a server does to answer, so they are started, not waited for.
  'connection.authorize': (raw) => {
    const id = asString(raw.id)
    void authorize(id).catch((err: unknown) => console.warn('[oauth]', message(err)))
  },
  'connection.allowApps': (raw) => allowApps(asString(raw.id)),
  'connection.reconnect': (raw) => {
    const id = asString(raw.id)
    void connect(id).catch((err: unknown) => console.warn('[mcp]', message(err)))
  },
  'secret.request': (raw) => {
    requestSecret(asString(raw.plugin), asString(raw.key))
  },
  'secret.dismiss': (raw) => dismissSecretRequest(asPlace(raw['place'])),
  'inbox.read': (raw) =>
    readInbox(Array.isArray(raw['ids']) ? raw['ids'].filter((id): id is number => typeof id === 'number') : []),
  'notice.dismiss': (raw) => dismissNotice(asString(raw.id)),
  'task.schedule': (raw) => {
    scheduleTask(asTaskInput(raw.input))
  },
  'task.setEnabled': (raw) => {
    setTaskEnabled(asString(raw.id), asBoolean(raw.enabled))
  },
  'task.remove': (raw) => cancelTask(asString(raw.id)),
  // A run takes as long as its tool or the orchestrator does, so it is started, not waited for.
  'task.run': (raw) => runTaskNow(asString(raw.id)),
  'background.setOpenAtLogin': (raw) => setOpenAtLogin(asBoolean(raw.enabled)),
  'updates.check': () => checkForUpdates(),
  'updates.install': () => installUpdate(),
  'budget.set': (raw) => setBudget(raw),
  'theme.set': (raw) => setTheme(raw),
  'question.answer': (raw) => questions.answer(String(raw['id'] ?? ''), String(raw['answer'] ?? '')),
  'question.seen': (raw) => seenQuestion(String(raw['id'] ?? '')),
  'window.open': () => {
    openWindow()
  },
  'window.allScreens': () => allScreensWithNotice(),
  'window.oneScreen': () => oneScreenOrNotice(),
}

/** Applies an action from the renderer. Anything malformed throws, with a message for the user. */
/** Most actions apply at once; the few that take longer (removing a plugin) resolve when done. */
export function dispatch(raw: unknown): void | Promise<void> {
  if (!isRecord(raw) || typeof raw.type !== 'string') throw new Error('Malformed action.')
  if (!Object.hasOwn(HANDLERS, raw.type)) throw new Error(`Unknown action "${raw.type}".`)
  return HANDLERS[raw.type as Action['type']](raw)
}

/**
 * All the screens, saying so when windows were left over: with more windows open than displays, the
 * ones without a display stay open rather than closing with their grids, and the menu has nowhere of
 * its own to say that.
 */
export function allScreensWithNotice(): void {
  const note = surplusNote(useAllScreens().surplus)
  if (note) addNotice('windows', note)
}

/**
 * Back to one window, with a refusal said where the app says things. Going back moves the other
 * windows' elements into the main window's grid and throws instead when something cannot be moved, and
 * neither the menu bar nor the workspace menu has anywhere of its own to show that message; the
 * assistant's tool calls `useOneScreen` directly, so the model still gets the error it can act on.
 */
export function oneScreenOrNotice(): void {
  try {
    useOneScreen()
  } catch (error) {
    addNotice('windows', message(error))
  }
}

// Secrets. The value arrives once, is sealed at once under its plugin, and is never read back out to
// anyone but the transport that needs it. Nothing here, and nothing it throws, may quote the value.

export function setSecret(plugin: string, key: string, value: string): void {
  const info = getState().plugins[plugin]
  if (!info) throw new Error(`Unknown plugin ${plugin}.`)
  if (!info.secrets.some((s) => s.key === key)) throw new Error(`${plugin} does not ask for a secret named ${key}.`)
  if (!value.trim()) throw new Error('Paste the value first.')
  const sealed = seal(value.trim())
  update((state) => {
    const current = state.plugins[plugin]
    return {
      ...state,
      secrets: { ...state.secrets, [plugin]: { ...state.secrets[plugin], [key]: sealed } },
      plugins: current
        ? {
            ...state.plugins,
            [plugin]: { ...current, secrets: current.secrets.map((s) => (s.key === key ? { ...s, set: true } : s)) },
          }
        : state.plugins,
      // The fields that asked for this value close with it.
      secretRequests: state.secretRequests.filter((one) => one.plugin !== plugin || one.key !== key),
    }
  })
  for (const { id } of referring(plugin, key))
    void connect(id).catch((err: unknown) => console.warn('[mcp]', message(err)))
}

/** The plugin's connections that carry ${secret:KEY} for this key: the ones a value for it changes. */
function referring(plugin: string, key: string): { id: string }[] {
  return connectionsOf(plugin).filter(({ spec }) => secretRefs(spec).includes(key))
}

/**
 * Opens the secure field for one secret: the standard way a credential is collected. The assistant
 * calls this through set_secret when a connection is needs-secret, and askForMissingSecret calls it
 * for a view's source run, a plugin's model, or a task that reached one without its key, which is how
 * the user is asked when nothing thought to, as askForUnsetKey does for a plugin's own source the
 * assistant is about to run; either way the value goes from the field straight to setSecret, never
 * through the model.
 */
export function requestSecret(plugin: string, key: string): SecretRequest {
  const info = getState().plugins[plugin]
  if (!info) throw new Error(`Unknown plugin ${plugin}.`)
  const secret = info.secrets.find((s) => s.key === key)
  if (!secret) throw new Error(`${plugin} does not ask for a secret named ${key}.`)
  const place = here()
  const request: SecretRequest = { plugin, key, label: secret.label, ...(place ? { place } : {}) }
  // A place asks for one key at a time: this takes the place of whatever it was asking for.
  update((state) => ({
    ...state,
    secretRequests: [...state.secretRequests.filter((one) => !samePlace(one.place, place)), request],
  }))
  return request
}

/** Closes a place's key field unanswered: the tile's named, or the global box's. */
export function dismissSecretRequest(place?: Place): void {
  update((state) =>
    askedIn(state.secretRequests, place)
      ? { ...state, secretRequests: state.secretRequests.filter((one) => !samePlace(one.place, place)) }
      : state,
  )
}

/** How long a set_secret call waits for the user before handing the turn back. */
const SECRET_WAIT_MS = 10 * 60_000

/**
 * Resolves once the user has answered a secret request and every connection that refers to the key
 * has settled, or has cancelled, or the wait ran out. The assistant's run stays in flight meanwhile,
 * so it picks the request back up as soon as the key is in instead of ending on "fill in the field".
 */
export function waitForSecret(
  plugin: string,
  key: string,
  timeoutMs = SECRET_WAIT_MS,
): Promise<SecretProgress | { kind: 'timeout' }> {
  const ids = referring(plugin, key).map((c) => c.id)
  // The field this call opened is the one in its own place.
  const place = askingIn.getStore()
  return new Promise((resolve) => {
    const check = (): boolean => {
      const state = getState()
      const open = askedIn(state.secretRequests, place)
      const progress = secretProgress(
        {
          requestOpen: open?.plugin === plugin && open.key === key,
          saved: typeof state.secrets[plugin]?.[key] === 'string',
          connections: state.plugins[plugin]
            ? ids.flatMap((id) => (state.connections[id] ? [state.connections[id]!] : []))
            : null,
        },
        key,
      )
      if (progress.kind === 'waiting') return false
      finish(progress)
      return true
    }
    const finish = (outcome: SecretProgress | { kind: 'timeout' }): void => {
      clearTimeout(timer)
      stop()
      resolve(outcome)
    }
    const stop = subscribe(() => void check())
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
    check()
  })
}

/** Set for the length of work nobody is there to answer a key field for: a scheduled task's run. */
const unattended = new AsyncLocalStorage<true>()

/** Set for the length of a loop's run: what it asks is asked in its frame. Unset, the global box asks. */
const askingIn = new AsyncLocalStorage<Place>()

/** Runs work whose questions and key asks belong in a tile: a loop's own run. */
export function asksFor<T>(place: Place, work: () => Promise<T>): Promise<T> {
  return askingIn.run(place, work)
}

/** The tile the caller's asks show in, or none for the global box. */
function here(): Place | undefined {
  return askingIn.getStore()
}

/**
 * Runs work nobody is there to answer a key field for, a scheduled task's run: a call anywhere under it
 * on a connection missing its key fails at once instead of opening the field and waiting ten minutes.
 * It holds for the work's own calls only, so a view the user has open still asks meanwhile.
 */
export function withoutSecretPrompts<T>(work: () => Promise<T>): Promise<T> {
  return unattended.run(true, work)
}

/** How long a closed key field keeps calls from opening it again, so a run of calls cannot reopen it at once. */
const DECLINED_HOLD_MS = 60_000
const declined = new Map<string, number>()

/**
 * Before a call on a connection that is missing a key: opens the secure field and waits, as set_secret
 * does, so the user is asked whoever made the call, a view or a plugin's model as much as the
 * assistant. Returns when nothing is missing or once the key is saved, and the call then says for
 * itself whether the connection came up; throws, in words for the user, when the field was closed or
 * went unanswered. A field closed in the last minute is not opened again by a call.
 */
export async function askForMissingSecret(id: string): Promise<void> {
  const info = getState().connections[id]
  const key = info?.status === 'needs-secret' ? info.missing[0] : undefined
  if (!info || !key) return
  const label = getState().plugins[info.plugin]?.secrets.find((s) => s.key === key)?.label ?? key
  const unmet = whyUnmet(`connection_unavailable: ${id}`, label, await askForKey(info.plugin, key))
  if (unmet) throw new Error(unmet)
}

/**
 * Before the assistant runs a plugin's own source: a key the plugin declares and has not been given is
 * asked for first, where the run is, and the run waits for it, as a call on a connection does. Run
 * without it the source fails on its first request, in words written for the assistant, and what it
 * began fails with it: a job, and the record of one that its view then shows. So the source is not run
 * until the key is in, and the call says why in the words a connection's does: the field was closed,
 * it went unanswered, or nobody was there to answer one.
 */
export async function askForUnsetKey(plugin: string): Promise<void> {
  const unset = getState().plugins[plugin]?.secrets.find((secret) => !secret.set)
  if (!unset) return
  const unmet = whyUnmet(plugin, unset.label, await askForKey(plugin, unset.key))
  if (unmet) throw new Error(unmet)
}

/** Why a call that waited on a key does not go ahead, in words for whoever made it, or nothing once the key is saved. */
function whyUnmet(what: string, label: string, asked: Asked): string | null {
  if (asked === 'unattended')
    return `${what} needs its ${label}; a scheduled task cannot ask for it. Add it in Settings under Plugins.`
  if (asked === 'closed')
    return `${what} needs its ${label}, and the field asking for it was closed. Add it in Settings under Plugins.`
  if (asked === 'unanswered') return `${what} is still waiting for its ${label}; the field asking for it is open.`
  return null
}

/** How asking for a key ended: saved, its field closed, still open when the wait ran out, or never asked, with nobody there to answer. */
type Asked = 'saved' | 'closed' | 'unanswered' | 'unattended'

/**
 * Asks for one key of a plugin where the caller is, and waits: the secure field is opened there unless
 * it is already up for this key. Work nobody is there for opens none, and a field closed in the last
 * minute is not opened again.
 */
async function askForKey(plugin: string, key: string): Promise<Asked> {
  if (unattended.getStore()) return 'unattended'
  const name = `${plugin}/${key}`
  if (Date.now() - (declined.get(name) ?? Number.NEGATIVE_INFINITY) < DECLINED_HOLD_MS) return 'closed'
  const open = askedIn(getState().secretRequests, here())
  if (open?.plugin !== plugin || open.key !== key) requestSecret(plugin, key)
  const outcome = await waitForSecret(plugin, key)
  if (outcome.kind === 'cancelled') {
    declined.set(name, Date.now())
    return 'closed'
  }
  return outcome.kind === 'timeout' ? 'unanswered' : 'saved'
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Providers and onboarding.

/** The questions the assistant is waiting on, and what of them is on screen, which the tree shows. */
const questions = createQuestions((heads) => update((state) => ({ ...state, questions: heads })))

/** A tile's box says it has drawn a question: its ten minutes begin, and the log says the user had it in front of them. */
function seenQuestion(id: string): void {
  if (questions.seen(id)) console.log(`[ask] ${id} drawn in its tile`)
}

/**
 * Asks the user something and waits. The same shape as a key being asked for: main puts the
 * question in the tree, the composer shows it where the key field appears, and the tool call sits
 * here until it is answered, dismissed, or ten minutes pass. A task's run has no tool for asking a
 * question of its own, `TASK_EXCLUDED_TOOLS` leaves it out, and reaches this only for a command
 * nobody allowed the task: with nobody there the ten minutes pass, which is a refusal.
 *
 * The user's requests run side by side, and that task's run can ask while one of them has a question
 * up. The user reads one at a time in a place, so a question asked while another is up there waits
 * behind it, and its ten minutes start when it is shown: at once in the global box, and in a tile
 * when its box says it has drawn it (`utils/questions.ts`). `about` is the
 * request it came from, for the user to tell whose it is; whoever asks says so when it needs saying.
 *
 * `code` is text the question is about, shown as written and in full: a shell script to approve goes
 * there rather than into `text`, which is one sentence and is shortened by the tool that asks it.
 */
export function askUser(
  text: string,
  choices: string[],
  signal?: AbortSignal,
  code?: string,
  about?: string,
): Promise<string | null> {
  const place = here()
  console.log(`[ask] ${text}`)
  return questions.ask(
    { text, choices, ...(code ? { code } : {}), ...(about ? { about } : {}), ...(place ? { place } : {}) },
    signal,
    // A run on a task's limits has nobody at it: its question does not wait to be looked at.
    unattended.getStore() === true,
  )
}

/** Marks notifications read; no ids means all of them. The badge follows from what the store says. */
function readInbox(ids: number[]): Promise<void> {
  return markRead(ids).then(setUnread)
}

/** The day's cap on work that runs on its own. Checked here, since the renderer only suggests it. */
function setTheme(raw: Record<string, unknown>): void {
  const theme = raw['theme']
  if (!isTheme(theme)) throw new Error('A theme is system, light, or dark.')
  update((state) => (state.theme === theme ? state : { ...state, theme }))
}

/**
 * Pro mode, or one of its limits. What arrives is merged into what is there and read through the
 * shared reader, so a malformed value falls back to the safe one rather than becoming permissive.
 * Only the renderer's own Settings pane dispatches this: no tool can reach it.
 */
function setProMode(raw: unknown): void {
  if (!isRecord(raw)) throw new Error('proMode is an object of the settings to change.')
  update((state) => ({ ...state, proMode: readProMode({ ...state.proMode, ...raw }) }))
}

/**
 * Eye's settings: recording, the interval, the endpoint, and whether the first-run question has been
 * answered. Read through the shared reader, as pro mode is, so nothing malformed can turn recording
 * on. `asked` only ever goes true: the question is asked once, and
 * a later change must not bring the modal back. Nothing here is reachable from a tool.
 */
function setEye(raw: unknown): void {
  if (!isRecord(raw)) throw new Error('eye is an object of the settings to change.')
  update((state) => {
    // Only the switch and the answer can come from a window: the install id is main's alone. An
    // answer, either way, is to the wording asked now; recording waits for one, whatever is asked.
    const consent = raw['asked'] === true ? EYE_CONSENT : state.eye.consent
    const recording = 'recording' in raw ? raw['recording'] === true : state.eye.recording
    const stored = readEye({ recording, consent, install: state.eye.install })
    return { ...state, eye: { ...state.eye, recording: stored.recording, consent } }
  })
}

function setBudget(raw: Record<string, unknown>): void {
  const dailyTokens = readBudget(raw['dailyTokens'])
  update((state) => ({ ...state, budgets: { ...state.budgets, dailyTokens } }))
}

export function setProvider(kind: ProviderKind, raw: ProviderInput): void {
  const input = {
    providerId: raw.providerId,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    model: raw.model.trim(),
    token: raw.token.trim(),
  }
  const previous = getState()[kind]
  const kept = previous && previous.providerId === input.providerId ? previous.token : null
  const error = validateProviderInput(kind, input, { savedToken: kept !== null, signedIn: signedIn() })
  if (error) throw new Error(error)
  // The Jaspers provider's credential is the sign-in: no key is kept for it, pasted or saved.
  const token = signsIn(findProvider(kind, input.providerId)!) ? null : input.token ? seal(input.token) : kept
  const stored = { providerId: input.providerId, baseUrl: input.baseUrl, model: input.model, token }
  update((state) =>
    kind === 'llm'
      ? { ...state, llm: stored, voice: voiceWith(stored, state.voice), search: searchWith(stored, state.search) }
      : { ...state, [kind]: stored },
  )
}

/**
 * Signs in with Jaspers, then sets Jaspers up as the provider for every kind the user has none for:
 * the model, voice, and web search in one step for a new user, and nothing for a user whose
 * providers are already chosen, whose choices stay. During setup it also installs the Jaspers
 * Screener and Jaspers Research, in the background, as setup's sign-in box says it will.
 */
export async function signInWithJaspers(): Promise<void> {
  await signIn()
  update((state) => {
    const { llm, voice, search } = withJaspersWhereNone(state)
    if (llm === state.llm && voice === state.voice && search === state.search) return state
    return { ...state, llm, voice, search }
  })
  // Signing in later, from Settings, installs nothing.
  if (!getState().onboardingComplete) void installDefaultsForSignUp()
}

export function completeOnboarding(): void {
  if (!getState().llm) throw new Error('Pick a language model provider first.')
  update((state) => ({ ...state, onboardingComplete: true }))
}

// Workspaces.

/** "Workspace N", N the lowest no workspace is named after, since a deleted one leaves a gap. */
function newWorkspace(workspaces: Workspace[]): Workspace {
  const names = new Set(workspaces.map((w) => w.name))
  let n = 1
  while (names.has(`Workspace ${n}`)) n++
  return { id: randomUUID(), name: `Workspace ${n}` }
}

/** Adds "Workspace N" with an empty grid per open window and makes it current. */
export function createWorkspace(): void {
  update((state) => {
    const workspace = newWorkspace(state.workspaces)
    return {
      ...state,
      workspaces: [...state.workspaces, workspace],
      currentWorkspaceId: workspace.id,
      grids: { ...state.grids, [workspace.id]: withWindows({}, state.windows) },
      loops: { ...state.loops, [workspace.id]: NO_LOOPS },
    }
  })
}

export function renameWorkspace(id: string, rawName: string): void {
  const name = rawName.trim()
  if (!name || name.length > WORKSPACE_NAME_MAX) {
    throw new Error(`Workspace names are 1 to ${WORKSPACE_NAME_MAX} characters.`)
  }
  update((state) => {
    if (!state.workspaces.some((w) => w.id === id)) throw new Error('Unknown workspace.')
    return { ...state, workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, name } : w)) }
  })
}

export function selectWorkspace(id: string): void {
  update((state) => {
    if (!state.workspaces.some((w) => w.id === id)) throw new Error('Unknown workspace.')
    return state.currentWorkspaceId === id ? state : { ...state, currentWorkspaceId: id }
  })
}

/**
 * Drops a workspace with its grids, its loops, and its tasks; persist removes its folder. The last one stays.
 * Deleting the current one makes its neighbor current, the one after it or else the one before.
 */
export function deleteWorkspace(id: string): void {
  update((state) => {
    const index = state.workspaces.findIndex((w) => w.id === id)
    if (index < 0) throw new Error('Unknown workspace.')
    if (state.workspaces.length === 1) throw new Error('The last workspace cannot be deleted.')
    if (state.tasks.some((t) => t.workspaceId === id && t.running))
      throw new Error('A task of this workspace is running.')
    const workspaces = state.workspaces.filter((w) => w.id !== id)
    const grids = { ...state.grids }
    delete grids[id]
    const loops = { ...state.loops }
    delete loops[id]
    return {
      ...state,
      workspaces,
      currentWorkspaceId:
        state.currentWorkspaceId === id
          ? workspaces[Math.min(index, workspaces.length - 1)]!.id
          : state.currentWorkspaceId,
      grids,
      loops,
      tasks: state.tasks.filter((t) => t.workspaceId !== id),
    }
  })
}

// Panels. The orchestrator's get and set and the views' bridge come through the same three
// functions, so a view's state is checked against its schema wherever the write came from.

/** A view's output is what the model reads; cap it so one cannot fill the context window. */
const OUTPUT_MAX = 4096

/** How much of a window a piece of work's frame takes when nobody says: it holds every view the work shows. */
const FRAME_SIZE = 'half'

/**
 * Puts a view on a workspace's grid. The view has to be installed and to accept the state. Every tile
 * belongs to a loop, and this is where that is kept. What a loop shows is inside its frame: a tile
 * placed for a loop, or in the place of one of a loop's tiles, is laid out there, on the frame's own
 * cells, whichever window that is in. A tile nobody named a loop for gets one made here, in the same
 * change as the grid's, with a frame on the window's cells where the placement says, which it fills.
 * The docked chat is no loop's, and sits on the window's cells itself.
 */
export function placeChecked(
  workspaceId: string,
  window: number,
  content: PanelContent,
  state: Record<string, unknown> | undefined,
  placement: Placement & { replace?: string },
  loop?: string,
): { element: GridElement; panel: Panel; resolved: Resolved } {
  const view = content.kind === 'view' ? getView(content.view) : undefined
  if (content.kind === 'view' && !view) {
    const installed = Object.keys(getState().views).join(', ') || 'none'
    throw new Error(`Unknown view ${content.view}. Installed: ${installed}.`)
  }
  if (state) checkState(content, state)
  const had = loopsOf(workspaceId)
  if (loop !== undefined && !had.list.some((one) => one.id === loop)) throw new Error(`Unknown work ${loop}.`)
  if (!isTile(content)) {
    const before = getGrids(workspaceId)
    const placed = changeGrid(
      workspaceId,
      window,
      (grid) => placeView(grid, { ...placement, content, state }),
      // A frame whose place was taken closes its loop, which View loops can reopen.
      (next) => tidied(next, workspaceId, before),
    )
    // The key asked for in the box of a frame whose place it took went with the frame.
    if (placement.replace !== undefined) dismissSecretRequest({ workspaceId, on: placement.replace })
    return placed
  }
  const owner = loop ?? (placement.replace === undefined ? undefined : tileLoop(workspaceId, placement.replace))
  if (owner === undefined) {
    const made = withLoopFor(had, content, { title: view?.title, plugin: view?.plugin ?? null }, Date.now())
    return changeWindow(
      workspaceId,
      window,
      (grid) => placeFramed(grid, { ...placement, content, state, loop: made.loop.id }),
      (next) => withLoops(next, workspaceId, made.loops),
    )
  }
  const frame = frameOf(getGrids(workspaceId), owner)?.element.id
  if (frame === undefined) throw new Error(`Unknown work ${owner}.`)
  if (placement.replace === frame) {
    throw new Error(
      `${frame} is the work's own tile, which holds its views: a view goes inside it. Leave replace out, or name one of the views in it.`,
    )
  }
  return changeInside(workspaceId, frame, (grid) => placeView(grid, { ...placement, content, state, loop: owner }))
}

/**
 * Makes a loop as specified, with its frame, in one change. Its agent puts its views inside the
 * frame; until the first one the frame shows what the agent is doing.
 */
export function createLoop(
  workspaceId: string,
  window: number,
  spec: LoopSpec,
  placement: Placement,
): { loop: Loop; element: GridElement } {
  const made = withLoopAsked(loopsOf(workspaceId), spec, Date.now())
  const { element } = changeGrid(
    workspaceId,
    window,
    (grid) => placeView(grid, frameRequest(placement, made.loop.id)),
    (next) => withLoops(next, workspaceId, made.loops),
  )
  return { loop: made.loop, element }
}

/** A loop's frame as it is placed: where the orchestrator said, half a window when it did not. */
function frameRequest(placement: Placement, loop?: string) {
  return { ...placement, size: placement.size ?? FRAME_SIZE, content: { kind: 'frame' } as const, loop }
}

/**
 * Refuses, as `createLoop` would, a loop whose frame has no room on the window as it is now. Asked
 * before the user is asked to start the work, so they are not asked to start what cannot be placed.
 */
export function roomForLoop(workspaceId: string, window: number, placement: Placement): void {
  placeView(getGrid(workspaceId, window), frameRequest(placement))
}

/** The loop an element on the workspace's grids belongs to, when it is there and has one. */
function tileLoop(workspaceId: string, elementId: string): string | undefined {
  for (const grid of Object.values(getState().grids[workspaceId] ?? {})) {
    const element = grid.elements.find((e) => e.id === elementId)
    if (element) return element.loop
  }
  return undefined
}

/**
 * Takes an element off its grid, and the panel in it. Both ways an element is closed come through
 * here, a tile's cross and the assistant's tool. A frame takes what is inside it, and its loop is
 * closed with it, in the same change: kept whole, so View loops can reopen it. A tile inside a
 * frame goes alone, and its work stays.
 */
export function removeChecked(workspaceId: string, elementId: string): void {
  const before = getGrids(workspaceId)
  changeGridOf(
    workspaceId,
    elementId,
    (grid) => removeElement(grid, elementId),
    (next) => tidied(next, workspaceId, before),
  )
  // The key asked for in a frame's box goes with the frame. A question asked there ends with the run
  // that asked it, which stops when its work closes (`watchLoops`).
  dismissSecretRequest({ workspaceId, on: elementId })
}

/** Closes a loop: its frame goes, with every tile inside it, and the loop is kept for View loops to reopen. One that is not open is nothing to do. */
export function closeLoop(workspaceId: string, loopId: string): void {
  const frame = frameOf(getGrids(workspaceId), loopId)
  if (frame) removeChecked(workspaceId, frame.element.id)
}

/**
 * Reopens a closed loop in a window: the one its frame was in when that is open, else the main
 * window. Its frame comes back with the tiles that were inside it, and its conversation goes on.
 */
export function reopenLoop(workspaceId: string, loopId: string, window?: number): GridElement {
  const shut = closedLoop(loopsOf(workspaceId), loopId)
  if (!shut) throw new Error(`${loopName(loopId)} is not closed.`)
  const where = window ?? (isOpenWindow(getState().windows, shut.window) ? shut.window : MAIN_WINDOW)
  getGrid(workspaceId, where)
  let frame: GridElement | undefined
  update((state) => {
    const back = reopened(
      state.grids[workspaceId] ?? {},
      state.loops[workspaceId] ?? NO_LOOPS,
      loopId,
      where,
      Date.now(),
    )
    frame = back.frame
    return withLoops({ ...state, grids: { ...state.grids, [workspaceId]: back.grids } }, workspaceId, back.loops)
  })
  return frame!
}

/**
 * Deletes a loop for good, open or closed: an open one's frame goes, with every tile inside it, and
 * its record. What follows a loop leaving the tree, its run stopped and its conversation forgotten,
 * is done where every way one goes is seen (`watchLoops`).
 */
export function deleteLoop(workspaceId: string, loopId: string): void {
  const frame = frameOf(getGrids(workspaceId), loopId)
  if (frame) {
    changeGridOf(
      workspaceId,
      frame.element.id,
      (grid) => removeElement(grid, frame.element.id),
      (next) => withLoops(next, workspaceId, withoutLoop(next.loops[workspaceId] ?? NO_LOOPS, loopId)),
    )
    dismissSecretRequest({ workspaceId, on: frame.element.id })
    return
  }
  update((state) => withLoops(state, workspaceId, withoutLoop(state.loops[workspaceId] ?? NO_LOOPS, loopId)))
}

/**
 * Writes one value inside a panel's state, once the whole result passes the view's schema. A frame
 * holds no view of its own, so it has no state to write: the views inside it have.
 */
export function setPanelStateChecked(workspaceId: string, panelId: string, path: string[], value: unknown): Panel {
  const { grid } = findElement(workspaceId, panelId)
  const panel = panelOf(grid, panelId)
  if (panel.content.kind === 'frame') {
    const inside = layoutOf(grid, panel.elementId).elements.map((e) => e.id)
    throw new Error(
      `${panel.elementId} is a piece of work's tile, which holds no view of its own: set the state of a view inside it (${inside.join(', ') || 'none yet'}).`,
    )
  }
  checkState(panel.content, setIn(panel.state, path, value))
  return changeGridOf(workspaceId, panel.id, (grid) => setPanelState(grid, panel.id, path, value)).panel
}

/** What the view is showing now. The summary comes from the view's own summarize. */
export function publishChecked(workspaceId: string, panelId: string, output: Record<string, unknown>): Panel {
  const panel = panelOf(findElement(workspaceId, panelId).grid, panelId)
  const bytes = Buffer.byteLength(JSON.stringify(output))
  if (bytes > OUTPUT_MAX) throw new Error(`Output is too large (${bytes} bytes, max ${OUTPUT_MAX}).`)
  const def = panel.content.kind === 'view' ? getView(panel.content.view) : undefined
  if (def) {
    const result = def.output.safeParse(output)
    if (!result.success) throw new Error(`Invalid output for ${def.id}: ${issues(result.error)}`)
  }
  const summary = def?.summarize?.(panel.state, output) ?? null
  return changeGridOf(workspaceId, panel.id, (grid) => publishOutput(grid, panel.id, output, summary)).panel
}

/** The whole of what the view shows as text, for a model to read at length. The engine cuts what is past its cap. */
export function publishTextChecked(workspaceId: string, panelId: string, text: string | null): Panel {
  return changeGridOf(workspaceId, panelId, (grid) => publishText(grid, panelId, text)).panel
}

/**
 * Stamps the panel so its view fetches its data again. Takes a panel id or its element's, like the
 * other panel writes. A frame's stamp is every view's inside it: refreshing a piece of work's tile
 * refreshes what the work shows.
 */
export function refreshChecked(workspaceId: string, panelId: string, at = Date.now()): Panel {
  const { grid } = findElement(workspaceId, panelId)
  const panel = panelOf(grid, panelId)
  if (panel.content.kind === 'frame') {
    changeInside(workspaceId, panel.elementId, (inside) => ({
      grid: inside.panels.reduce((next, one) => refreshPanel(next, one.id, at).grid, inside),
    }))
  }
  return changeGridOf(workspaceId, panelId, (layout) => refreshPanel(layout, panelId, at)).panel
}

/** A view whose plugin is not installed takes any state: it keeps what it had. */
function checkState(content: PanelContent, state: Record<string, unknown>): void {
  if (content.kind !== 'view') return
  const def = getView(content.view)
  if (!def) return
  const result = def.state.safeParse(state)
  if (!result.success) throw new Error(`Invalid state for ${content.view}: ${issues(result.error)}`)
}

/** Zod issues as one line, since this goes to the model as an error and to the user as a message. */
function issues(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

// Arguments come from the renderer. Check each shape before trusting it, and say what was wrong.

function asKind(value: unknown): ProviderKind {
  if (value === 'llm' || value === 'voice' || value === 'search') return value
  throw new Error('Unknown provider kind.')
}

function asInput(value: unknown): ProviderInput {
  if (
    isRecord(value) &&
    typeof value.providerId === 'string' &&
    typeof value.baseUrl === 'string' &&
    typeof value.model === 'string' &&
    typeof value.token === 'string'
  ) {
    return { providerId: value.providerId, baseUrl: value.baseUrl, model: value.model, token: value.token }
  }
  throw new Error('Malformed provider input.')
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  throw new Error('Malformed argument.')
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  throw new Error('Expected true or false.')
}

/** The shape only; scheduleTask checks the meaning. */
function asTaskInput(value: unknown): TaskInput {
  if (
    isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    typeof value.instructions === 'string' &&
    typeof value.executeAt === 'number' &&
    (value.every === null || typeof value.every === 'number')
  ) {
    return {
      workspaceId: value.workspaceId,
      instructions: value.instructions,
      executeAt: value.executeAt,
      every: value.every,
      at: parseClockRule(value.at),
      speak: value.speak === 'changed' ? 'changed' : 'always',
      call: asTaskCall(value.call),
      // Bounded and trimmed by checkTaskInput; anything that is not a string is the app's model.
      model: typeof value.model === 'string' ? value.model : null,
    }
  }
  throw new Error('A task is { workspaceId, instructions, executeAt, every, at, call, model }.')
}

function asTaskCall(value: unknown): TaskCall | null {
  if (value === null || value === undefined) return null
  if (isRecord(value) && typeof value.tool === 'string')
    return { tool: value.tool, input: isRecord(value.input) ? value.input : {} }
  throw new Error('call is { tool, input } or null.')
}

function asTextOrNull(value: unknown): string | null {
  if (typeof value === 'string' || value === null) return value
  throw new Error('Text must be a string, or null for none.')
}

/**
 * A grid size from the renderer. Only the shape is checked here; whether the grid may become that
 * size, with what is on it, is the engine's rule in `resizeGrid`.
 */
function asGridSize(value: unknown): GridSize {
  if (isRecord(value)) {
    const { cols, rows } = value
    const size = { cols: asWholeNumber(cols), rows: asWholeNumber(rows) }
    const problem = sizeProblem(size)
    if (problem) throw new Error(`${size.cols} × ${size.rows} is not a grid size: ${problem}.`)
    return size
  }
  throw new Error('size is {"cols", "rows"} in cells.')
}

function asWholeNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n === 'number' && Number.isInteger(n)) return n
  throw new Error('columns and rows are whole numbers.')
}

/** A window number from the renderer or the model; none means the main window. */
export function asWindow(value: unknown): number {
  if (value === undefined || value === null || value === '') return MAIN_WINDOW
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n === 'number' && Number.isInteger(n) && n >= MAIN_WINDOW && n <= WINDOWS_MAX) return n
  throw new Error(`window is a number from 1 to ${WINDOWS_MAX}.`)
}

function asMode(value: unknown): ElementMode {
  if (value === 'tiled' || value === 'floating' || value === 'maximized' || value === 'minimized') return value
  throw new Error('Unknown element mode.')
}

/** A tile named by a window as the place of an ask, or none for the global box. Anything else is refused. */
function asPlace(value: unknown): Place | undefined {
  if (value === undefined || value === null) return undefined
  const { workspaceId, on } = value as Partial<Place>
  if (typeof workspaceId !== 'string' || typeof on !== 'string')
    throw new Error('A place is a workspace and an element.')
  return { workspaceId, on }
}

function asContent(value: unknown): PanelContent {
  if (isRecord(value) && value.kind === 'view' && typeof value.view === 'string') {
    return { kind: 'view', view: value.view }
  }
  throw new Error('Content is {"kind": "view", "view"}.')
}

/** The engine checks the cells: whole, at least 2×2, inside the grid, and free for a tiled element. */
/** What a cell may be given: text, as long as a formula plausibly is, for cells the engine then checks are real. */
const CELL_INPUT_MAX = 1000
const CELLS_PER_WRITE = 500

function asCells(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error('cells is an object of cell names and what each one holds.')
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > CELLS_PER_WRITE) {
    throw new Error(`Write between 1 and ${CELLS_PER_WRITE} cells at a time.`)
  }
  const cells: Record<string, string> = {}
  for (const [name, input] of entries) {
    if (typeof input !== 'string') throw new Error(`${name} holds text, a number, or a formula starting with =.`)
    if (input.length > CELL_INPUT_MAX) throw new Error(`${name} is longer than ${CELL_INPUT_MAX} characters.`)
    cells[name] = input
  }
  return cells
}

function asRect(value: unknown): Rect {
  if (isRecord(value)) {
    const { x, y, w, h } = value
    if (typeof x === 'number' && typeof y === 'number' && typeof w === 'number' && typeof h === 'number') {
      return { x, y, w, h }
    }
  }
  throw new Error('rect is {"x", "y", "w", "h"} in cells.')
}

/** The engine checks what is inside a placement, and names what was wrong with it. */
function asPlacement(value: unknown): Placement {
  if (value === undefined || value === null) return {}
  if (isRecord(value)) return value as Placement
  throw new Error('Malformed placement.')
}

function asPath(value: unknown): string[] {
  if (Array.isArray(value) && value.every((k) => typeof k === 'string' && k !== '')) return value
  throw new Error('path is an array of keys, like ["filters", "sector"].')
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new Error('Expected an object.')
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : asRecord(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
