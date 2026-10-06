// How the app looks: light, dark, or whichever the system shows. The colors themselves are in
// src/host-runtime/theme.css; this is the setting, and the one color main needs before a page paints.

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

/** What a window shows until its page paints: the theme's background, so a dark window never flashes white. */
export const WINDOW_BACKGROUND = { light: '#ffffff', dark: '#0a0a0a' } as const
