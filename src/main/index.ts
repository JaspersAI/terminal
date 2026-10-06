import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { allScreensWithNotice, askForMissingSecret, dispatch, oneScreenOrNotice } from './actions'
import { watchLoops } from './agent/loop'
import { registerAgentIpc, runTask, runTaskCall, taskSaid } from './agent/orchestrator'
import { registerWelcomeIpc } from './agent/welcome'
import { closeAll, followSignIn, onMissingSecret } from './plugins/mcp'
import { registerInstallIpc } from './plugins/install'
import { registerHubIpc } from './hub/hub-ipc'
import { registerSkillEditorIpc } from './skills/skill-editor'
import { registerSkillInstallIpc } from './skills/skill-install'
import { registerLiveIpc } from './plugins/live-ipc'
import { flush } from './persist'
import { killAllHosts, stopAllHosts } from './plugins/plugin-host'
import { startPlugins } from './plugins/plugins'
import { registerBuiltins } from './plugins/registry'
import { startSkills } from './skills/skills'
import { datasetRows, runSource } from './data/sources'
import { getState, start, toPublic } from './state'
import { registerConnectionIpc } from './plugins/connection-editor'
import { registerAppsIpc, startApps } from './plugins/apps'
import { adoptShellPath } from './app/shell-path'
import { jaspersHome } from './home'
import { registerMemoryIpc, startMemory } from './agent/memory'
import { startThreads } from './agent/thread-file'
import { startInbox } from './app/notices'
import { compact, notifications, query, startStore, stats, stopOnQuit, usageToday } from './data/store'
import { startBackground, startsHidden } from './app/background'
import { deleteRecordings, endSession, eyeFolder, startEye, startTelemetry } from './eye/eye'
import { startUploads, stopUploads } from './eye/upload'
import { startTheme } from './app/theme'
import { installUpdate, startUpdates } from './app/updates'
import { startTasks, stopTasks, wakeTasks } from './tasks/tasks'
import { findTool } from './agent/tools'
import { registerSchemes, registerViewHost } from './plugins/viewhost'
import { registerVoiceIpc } from './llm/voice'
import { anyInFront, isHttps, openAllStored, registerDragIpc, showAll, watchDisplays } from './grid/windows'
import { installMenu } from './app/menu'
import { accountPageAddress, onSignInChange } from './jaspers/jaspers'

// The schemes a plugin view's iframe loads from have to be declared before the app is ready; their
// handlers come after it, below.
registerSchemes()

// One Jaspers per user data folder, since two would write the same files. A second launch shows the
// first one's windows and leaves.
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()

app.whenReady().then(() => {
  if (!primary) return
  start()
  // Light, dark, or the system's, before the first window opens.
  startTheme()
  // What serves a plugin view's page and the runtime it borrows.
  registerViewHost()
  // The built-in views and sources go into the tree before the window opens, so the first push
  // already has them. The plugins follow, each bringing the connections it declares.
  registerBuiltins()
  // A call on a connection missing its key asks the user for it, whoever made the call.
  onMissingSecret(askForMissingSecret)
  // A server that signs its users in through Jaspers follows the app's sign-in: connected when it begins, waiting when it ends.
  onSignInChange(followSignIn)
  // The calls kept for the views that show a server's own page, less those whose panel is gone.
  startApps()
  // The user's skills; each plugin brings its own as it builds.
  startSkills()
  // What the assistant knows about the user, and what is always true.
  startMemory()
  // What was being said when the app was last closed.
  void startThreads()
  // Every source run is filed here. It is additive: a store that will not open costs the query
  // tool and the Data pane, and nothing else.
  startStore()
  stopOnQuit()
  // The badge's number, read back before anything new arrives.
  startInbox()
  // Before the plugins, since a stdio connection's command is looked up on PATH when it connects,
  // and an app opened from Finder has launchd's PATH rather than the user's.
  void adoptShellPath().finally(() => startPlugins())
  // The scheduler. A call task runs its tool the way the orchestrator would, on the task's
  // workspace; an instructions task is a request to the orchestrator, in a thread of its own, and its
  // reply joins the workspace's conversation. Neither can open the key field: nobody may be there to
  // answer it.
  startTasks({
    toolExists: (name) => findTool(name) !== undefined,
    runCall: runTaskCall,
    runAsk: runTask,
    intoChat: taskSaid,
  })
  registerConnectionIpc()
  registerAppsIpc()
  registerAgentIpc()
  // A loop that is gone stops what it was doing and is forgotten.
  watchLoops()
  registerWelcomeIpc()
  registerVoiceIpc()
  registerLiveIpc()
  registerInstallIpc()
  registerHubIpc()
  registerSkillEditorIpc()
  registerMemoryIpc()
  registerSkillInstallIpc()
  registerDragIpc()

  // The renderer reads the tree once on load and hears every change after that over
  // state:changed. It changes nothing itself: it dispatches, and the result comes back by push.
  ipcMain.handle('state:get', () => toPublic(getState()))
  ipcMain.handle('state:dispatch', (_event, action: unknown) => dispatch(action))

  // A view runs a source and then reads its rows; the orchestrator reaches the same two functions
  // through its tools. Datasets stay in main: only the rows a view asked for cross.
  ipcMain.handle('source:run', (_event, source: unknown, args: unknown, options: unknown) => {
    if (typeof source !== 'string' || !source) throw new Error('A source id is required.')
    const { fresh, workspaceId } = (typeof options === 'object' && options !== null ? options : {}) as {
      fresh?: unknown
      workspaceId?: unknown
    }
    // A view names the workspace it is on, since a plugin's code reads that one; main checks it is real.
    if (
      workspaceId !== undefined &&
      (typeof workspaceId !== 'string' || !getState().workspaces.some((w) => w.id === workspaceId))
    )
      throw new Error('Unknown workspace.')
    // Fresh skips a dataset still good for the arguments: a view refreshing asks for it.
    return runSource(source, args, {
      fresh: fresh === true,
      workspaceId: typeof workspaceId === 'string' ? workspaceId : getState().currentWorkspaceId,
    })
  })
  ipcMain.handle('store:query', (_event, sql: unknown, limit: unknown) => {
    if (typeof sql !== 'string') throw new Error('sql has to be a string.')
    return query({ sql, limit: typeof limit === 'number' ? limit : undefined })
  })
  ipcMain.handle('store:stats', () => stats())
  ipcMain.handle('store:usage', () => usageToday())
  ipcMain.handle('inbox:list', (_event, limit: unknown) => notifications(typeof limit === 'number' ? limit : 200))
  ipcMain.handle('store:compact', () => compact())
  ipcMain.handle('dataset:rows', (_event, datasetId: unknown) => {
    if (typeof datasetId !== 'string' || !datasetId) throw new Error('A dataset id is required.')
    return datasetRows(datasetId)
  })

  // Links out of the app: provider key pages, links in an answer, a view's `openLink`. https only.
  ipcMain.handle('shell:open-external', (_event, url: unknown) => {
    if (!isHttps(url)) throw new Error('Only https links can be opened.')
    return shell.openExternal(url)
  })

  // Settings' link to the signed-in account's page on Account. Takes no address: main knows where
  // Account is, and the renderer never names it.
  ipcMain.handle('shell:open-account', () => shell.openExternal(accountPageAddress()))

  // Settings > Eye's Reveal the folder, and its Delete all. Main knows the path; the renderer never
  // names one, and neither can reach a frame's contents.
  ipcMain.handle('shell:show-eye-folder', async () => {
    shell.openPath(await eyeFolder())
  })
  ipcMain.handle('eye:delete-all', () => deleteRecordings())

  // Settings > Pro mode's Show folder. Main knows the path; the renderer never names one.
  ipcMain.handle('shell:show-pro-folder', async () => {
    const folder = path.join(jaspersHome(), 'shell')
    await fsp.mkdir(folder, { recursive: true })
    shell.openPath(folder)
  })

  // A view's Copy button. Main writes the clipboard, since a plugin's sandboxed frame has none.
  ipcMain.handle('clipboard:write', (_event, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Only text can be copied.')
    clipboard.writeText(text)
  })

  // Which build this is, and the checks that keep it current where it can be.
  startUpdates()
  // The menu bar icon, notifications while the window is away, and waking the scheduler after sleep.
  // Settings lives where a Mac user looks for it. Main does not own that screen, so the menu shows
  // the windows and the front one opens it.
  installMenu({
    openSettings: () => {
      showAll()
      BrowserWindow.getFocusedWindow()?.webContents.send('menu:settings')
    },
    // With more windows open than screens, the ones left over stay open and a notice says which.
    useAllScreens: () => allScreensWithNotice(),
    // Going back refuses when a window holds something that cannot be moved into the main window's
    // grid; the message goes where the app says things, since the menu has nowhere to show one.
    useOneScreen: () => oneScreenOrNotice(),
  })

  startBackground({ showWindow: showAll, windowInFront: anyInFront, wakeTasks, installUpdate })
  // Eye, if the user has it on: a frame of the app's own windows every minute, and a line of
  // telemetry for what the app did. It records into a folder on this machine, and the uploader
  // sends each piece to Jaspers as soon as it is whole. Started here rather than with a window, so
  // recording carries on with the windows closed to the menu bar, as the tasks do.
  startEye()
  startTelemetry()
  startUploads()
  // A launch at login starts hidden: the windows load, so the views on screen keep working, and
  // stay out of the way until the menu bar icon or another launch shows them.
  openAllStored(!startsHidden())
  // Screens come and go while the app runs: a window whose display is unplugged comes back onto one
  // that exists rather than sitting off-screen. After the windows, since it moves them.
  watchDisplays()

  app.on('second-instance', showAll)
  // The dock icon on macOS.
  app.on('activate', showAll)
})

// The stdio servers are children of this process and go with it.
app.on('will-quit', closeAll)
// So are plugins' hosts. Jobs still running get to save what they have first: the quit waits for
// the hosts to stop them, once, then goes ahead.
// Eye's session is complete once nothing more can be recorded into it, and only then may its
// telemetry be sent: so it ends on the quit that goes ahead, not the one held back, while stopping
// jobs can still raise notices and record. The closing line is written on this turn, since the app
// goes on it.
// A quit asked for again while the hosts are stopping waits with the first one.
let hostsStopping = false
let hostsStopped = false
app.on('before-quit', (event) => {
  if (hostsStopping) {
    event.preventDefault()
    return
  }
  if (!hostsStopped && Object.values(getState().plugins).some((p) => p.jobs.length > 0)) {
    event.preventDefault()
    hostsStopping = true
    void stopAllHosts('the app is quitting').finally(() => {
      hostsStopping = false
      hostsStopped = true
      app.quit()
    })
    return
  }
  endSession()
})
app.on('will-quit', killAllHosts)
app.on('will-quit', stopUploads)
// Nothing scheduled starts while the app goes.
app.on('will-quit', stopTasks)
// Writes wait a moment after a change; write anything still waiting before the app goes.
app.on('will-quit', flush)

// Closing hides the window rather than closing it, so this rarely fires; when it does, the app still
// stays, in the menu bar, on every platform. Quit from there ends it.
app.on('window-all-closed', () => undefined)
