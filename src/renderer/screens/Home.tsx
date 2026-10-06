import { useEffect, useState, type ReactElement } from 'react'
import { MAIN_WINDOW } from '../../shared/grid/windows'
import { Composer } from '../components/composer/Composer'
import { useDockedChat } from '../components/composer/dock'
import { LoopsDialog } from '../components/settings/LoopsDialog'
import { Settings } from '../components/settings/Settings'
import { EyePrompt } from '../components/workspace/EyePrompt'
import { Workspace } from '../components/workspace/Workspace'
import { errorMessage } from '../lib/errors'
import { useAppState } from '../lib/state'

interface Props {
  /** Setup ran in this session, so the assistant welcomes the user once the screen is theirs. */
  welcome: boolean
}

/**
 * The main screen: the current workspace filling the window, the composer floating at the bottom,
 * and settings over both once the menu bar's Settings… opens it, or View loops, which Settings leaves
 * for. Everything under either is inert while it is up, so neither Tab nor a press reaches the
 * workspace, its views' frames, or the composer.
 *
 * With the chat docked on this window's grid the overlay stays away: the element is the chat then,
 * and its Undock takes it off the grid and brings the overlay back. Another window's docked chat
 * changes nothing here, since docking is one grid's.
 *
 * Eye's first-run question sits over both until it is answered, once, either way. After it, a user
 * who just finished setup is welcomed: main says the assistant's first messages into the chat and
 * holds the composer up while it does, so the first thing on the canvas is the assistant speaking.
 */
export function Home({ welcome }: Props): ReactElement {
  const [settings, setSettings] = useState(false)
  const [loops, setLoops] = useState(false)
  // Settings… in the menu bar, where a Mac user looks for it, and ⌘, with it. It takes View loops' place.
  useEffect(
    () =>
      window.app.onOpenSettings(() => {
        setLoops(false)
        setSettings(true)
      }),
    [],
  )
  const workspaceId = useAppState((s) => s.currentWorkspaceId)
  const docked = useDockedChat(workspaceId, MAIN_WINDOW)
  // Eye asks once, on the first run after it existed, and remembers either answer. Only here, so one
  // window asks and the extensions never do.
  const askEye = useAppState((s) => !s.eye.asked)
  useEffect(() => {
    if (!welcome || askEye) return
    window.app.agent.welcome().catch((err: unknown) => console.error('[welcome]', errorMessage(err)))
  }, [welcome, askEye])
  return (
    <>
      <div inert={settings || loops} className="contents">
        <Workspace />
        {!docked && <Composer />}
      </div>
      {settings && (
        <Settings
          onClose={() => setSettings(false)}
          onViewLoops={() => {
            setSettings(false)
            setLoops(true)
          }}
        />
      )}
      {loops && <LoopsDialog onClose={() => setLoops(false)} />}
      {askEye && <EyePrompt />}
    </>
  )
}
