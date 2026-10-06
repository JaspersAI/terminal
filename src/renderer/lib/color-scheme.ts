import { useSyncExternalStore } from 'react'

// Which scheme is showing, for what draws its colors in code rather than CSS. Settings > Appearance
// decides it through the OS, so the media query is the one place to ask.

const DARK = '(prefers-color-scheme: dark)'

function subscribe(onChange: () => void): () => void {
  const query = matchMedia(DARK)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export function useColorScheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, () => (matchMedia(DARK).matches ? 'dark' : 'light'))
}
