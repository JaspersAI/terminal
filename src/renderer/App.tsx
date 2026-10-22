import { useState, type ReactElement } from 'react'
import { needsTermsAcceptance } from '../shared/app/jaspers'
import { MAIN_WINDOW } from '../shared/grid/windows'
import { useAppState } from './lib/state'
import { Extension } from './screens/Extension'
import { Home } from './screens/Home'
import { Onboarding } from './screens/Onboarding'
import { TermsDialog, Welcome } from './screens/Welcome'

/**
 * Picks the screen from app state and which window this is. The only local flag is whether the user has
 * left the welcome screen, which is also what tells Home that setup ran in this session.
 */
export function App(): ReactElement {
  const app = useAppState()
  const [setupStarted, setSetupStarted] = useState(false)
  const needsTerms = needsTermsAcceptance(app, window.app.windowNumber)
  const screen = app.onboardingComplete ? (
    window.app.windowNumber > MAIN_WINDOW ? (
      <Extension />
    ) : (
      <Home welcome={setupStarted} />
    )
  ) : setupStarted && app.termsAccepted ? (
    <Onboarding />
  ) : (
    <Welcome
      resume={app.llm !== null}
      onBegin={() => {
        if (app.termsAccepted) setSetupStarted(true)
      }}
    />
  )
  return (
    <>
      <div inert={needsTerms} className="contents">
        {screen}
      </div>
      {needsTerms && <TermsDialog />}
    </>
  )
}
