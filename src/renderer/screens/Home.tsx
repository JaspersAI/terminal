import { useEffect, useState, type ReactElement } from 'react'
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
  const [settings, setSettings] = useState(false)
  const [loops, setLoops] = useState(false)
  const [dismissedSignIn, setDismissedSignIn] = useState(false)
  useEffect(
    () =>
      window.app.onOpenSettings(() => {
        setLoops(false)
        setSettings(true)
      }),
    [],
  )
  const termsAccepted = useAppState((s) => s.termsAccepted)
  const signedIn = useAppState((s) => s.jaspers.signedIn)
  useEffect(() => {
    if (signedIn) setDismissedSignIn(false)
  }, [signedIn])
  const askSignIn = useAppState((s) => needsJaspersSignIn(s, window.app.windowNumber, dismissedSignIn))
  const askEye = useAppState(
    (s) => window.app.windowNumber === MAIN_WINDOW && s.termsAccepted && !askSignIn && !s.eye.asked,
  )
  useEffect(() => {
    if (!welcome || !termsAccepted || askSignIn || askEye) return
    window.app.agent.welcome().catch((err: unknown) => console.error('[welcome]', errorMessage(err)))
  }, [welcome, termsAccepted, askSignIn, askEye])
  return (
    <>
      <div inert={!termsAccepted || settings || loops || askSignIn || askEye} className="contents">
        <Workspace onOpenRooms={() => setLoops(true)} />
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
      {!settings && !loops && askSignIn && (
        <SignInPrompt
          onOpenSettings={() => {
            setDismissedSignIn(true)
            setLoops(false)
            setSettings(true)
          }}
        />
      )}
      {!settings && !loops && askEye && <EyePrompt />}
    </>
  )
}
