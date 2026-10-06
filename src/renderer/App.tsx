import { useState, type ReactElement } from 'react'
import { MAIN_WINDOW } from '../shared/grid/windows'
import { useAppState } from './lib/state'
import { Extension } from './screens/Extension'
import { Home } from './screens/Home'
import { Onboarding } from './screens/Onboarding'
import { Welcome } from './screens/Welcome'

/**
 * Picks the screen from app state and which window this is. The only local flag is whether the user has
 * left the welcome screen, which is also what tells Home that setup ran in this session.
 */
export function App(): ReactElement {
  const app = useAppState()
  const [setupStarted, setSetupStarted] = useState(false)
  if (app.onboardingComplete)
    return window.app.windowNumber > MAIN_WINDOW ? <Extension /> : <Home welcome={setupStarted} />
  if (setupStarted) return <Onboarding />
  return <Welcome resume={app.llm !== null} onBegin={() => setSetupStarted(true)} />
}
