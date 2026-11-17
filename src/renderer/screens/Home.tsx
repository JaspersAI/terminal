import { useEffect, useState, type ReactElement } from 'react'
import { isSettingsPane, type SettingsPane } from '../../shared/agent/settings'
import { needsJaspersSignIn } from '../../shared/app/jaspers'
import { MAIN_WINDOW } from '../../shared/grid/windows'
import { LoopsDialog } from '../components/settings/LoopsDialog'
import { Settings } from '../components/settings/Settings'
import { EyePrompt } from '../components/workspace/EyePrompt'
import { SignInPrompt } from '../components/workspace/SignInPrompt'
import { Workspace } from '../components/workspace/Workspace'
import { errorMessage } from '../lib/errors'
import { useAppState } from '../lib/state'

interface Props {
  /** Setup ran in this session, so the assistant welcomes the user once the screen is theirs. */
  welcome: boolean
}

/**
 * The main screen: the current tab filling the window with Central's command line at the top and
 * the TabBar at the bottom, and Settings or Rooms over it when opened.
 */
export function Home({ welcome }: Props): ReactElement {
  // Settings as it was last asked for, null while it is closed: the pane is part of the request, so
  // there is no pane without Settings open.
  const [settings, setSettings] = useState<{ pane?: SettingsPane } | null>(null)
  const [loops, setLoops] = useState(false)
  const [openedSettingsFromPrompt, setOpenedSettingsFromPrompt] = useState(false)
  const [dismissedSignIn, setDismissedSignIn] = useState(false)
  useEffect(
    () =>
      window.app.onOpenSettings((pane) => {
        setLoops(false)
        setSettings(isSettingsPane(pane) ? { pane } : {})
      }),
    [],
  )
  const termsAccepted = useAppState((s) => s.termsAccepted)
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  const [wasSignedIn, setWasSignedIn] = useState(signedIn)
  useEffect(() => {
    if (signedIn) {
      setOpenedSettingsFromPrompt(false)
      setDismissedSignIn(false)
      setWasSignedIn(true)
    }
  }, [signedIn])
  const askSignIn = useAppState((s) =>
    needsJaspersSignIn(s, window.app.windowNumber, {
      openedSettings: openedSettingsFromPrompt,
      dismissed: dismissedSignIn,
      wasSignedIn,
    }),
  )
  const askEye = useAppState(
    (s) => window.app.windowNumber === MAIN_WINDOW && s.termsAccepted && !askSignIn && !s.eye.asked,
  )
  useEffect(() => {
    if (!welcome || !termsAccepted || askSignIn || askEye) return
    window.app.agent.welcome().catch((err: unknown) => console.error('[welcome]', errorMessage(err)))
  }, [welcome, termsAccepted, askSignIn, askEye])
  return (
    <>
      <div inert={!termsAccepted || settings !== null || loops || askSignIn || askEye} className="contents">
        <Workspace onOpenRooms={() => setLoops(true)} />
      </div>
      {settings && (
        <Settings
          asked={settings}
          onClose={() => setSettings(null)}
          onViewLoops={() => {
            setSettings(null)
            setLoops(true)
          }}
        />
      )}
      {loops && <LoopsDialog onClose={() => setLoops(false)} />}
      {!settings && !loops && askSignIn && (
        <SignInPrompt
          onDismiss={() => setDismissedSignIn(true)}
          onOpenSettings={() => {
            setOpenedSettingsFromPrompt(true)
            setLoops(false)
            setSettings({})
          }}
        />
      )}
      {!settings && !loops && askEye && <EyePrompt />}
    </>
  )
}
