import { StrictMode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { watchUse } from './lib/eye'
import * as state from './lib/state'

// Load app state before the first render so every component can read it synchronously. The first
// render is forced through rather than scheduled, so the window can be told once its first screen
// is in the DOM; it is told from the next frame, the one that paints the screen, and shows itself
// then and not before.
void state
  .load()
  .then(() => {
    // What this window tells Eye, while it records: read off the tree, so it waits for the tree.
    watchUse()
    const root = createRoot(document.getElementById('root')!)
    flushSync(() =>
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      ),
    )
    requestAnimationFrame(() => window.app.rendered())
  })
  .catch((err: unknown) => {
    console.error('[boot]', err)
    window.app.rendered()
  })
