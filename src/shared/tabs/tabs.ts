// Pure rules for the bottom Excel-style tab bar: fixed stepped character widths (16 -> 12 -> 8 -> 6 -> 4)
// so tabs never resize by title length and never scroll horizontally, three-dot truncation, the curated
// 32-color cool & high-contrast palette, per-window tab filtering, and tab reordering.
// Keep this file free of Node and DOM imports.

export const TAB_CHAR_DEFAULT = 16
export const TAB_CHAR_STEPS: readonly number[] = [16, 12, 8, 6, 4]
const CHAR_PX = 6
const TAB_PAD_PX = 20

/** The fixed pixel width of a tab at a given character step. */
export function tabWidthPx(charLimit: number): number {
  return charLimit * CHAR_PX + TAB_PAD_PX
}

/**
 * Picks the largest character step (16, 12, 8, 6, 4) where `tabCount` tabs fit inside
 * `availableWidthPx` without horizontal scrolling.
 */
export function tabCharLimit(availableWidthPx: number, tabCount: number): number {
  if (tabCount <= 1 || !Number.isFinite(availableWidthPx) || availableWidthPx <= 0) return TAB_CHAR_DEFAULT
  for (const step of TAB_CHAR_STEPS) {
    if (tabCount * tabWidthPx(step) <= availableWidthPx) return step
  }
  return TAB_CHAR_STEPS[TAB_CHAR_STEPS.length - 1]!
}

/**
 * Formats a tab title for the current character cap: never longer than `maxChars`, adding three
 * dots (`...`) as the last characters when the title exceeds `maxChars`.
 */
export function formatTabLabel(name: string, maxChars: number = TAB_CHAR_DEFAULT): string {
  const limit = Math.max(4, Math.floor(maxChars))
  if (name.length <= limit) return name
  return `${name.slice(0, limit - 3)}...`
}

/**
 * Curated 32-color cool & high-contrast terminal palette (4 rows × 8 columns):
 * Row 1: Cool slates, steel blues, arctic cyans, and deep navy
 * Row 2: Cobalt, sapphire, indigo, midnight violet, and cool plum
 * Row 3: Deep teal, petrol, pine, Nordic emerald, and forest
 * Row 4: High-contrast terminal accents (crimson, burgundy, copper, amber-gold, bronze, and graphite)
 */
export const TAB_PALETTE: readonly string[] = [
  // Row 1: Cool Slates & Arctic Blues
  '#334155',
  '#475569',
  '#1e3a5f',
  '#1d4ed8',
  '#0369a1',
  '#0284c7',
  '#0e7490',
  '#0891b2',
  // Row 2: Cobalt, Indigo & Cool Violet
  '#1e40af',
  '#2563eb',
  '#3730a3',
  '#4f46e5',
  '#4c1d95',
  '#6d28d9',
  '#581c87',
  '#7e22ce',
  // Row 3: Petrol, Teal & Nordic Greens
  '#115e59',
  '#0f766e',
  '#0d9488',
  '#065f46',
  '#047857',
  '#15803d',
  '#166534',
  '#3f6212',
  // Row 4: High-Contrast Signal & Graphite Tones
  '#881337',
  '#be123c',
  '#991b1b',
  '#9a3412',
  '#b45309',
  '#854d0e',
  '#3f3f46',
  '#18181b',
]

const PALETTE_SET = new Set<string>(TAB_PALETTE)

export function isTabColor(value: unknown): value is string {
  return typeof value === 'string' && PALETTE_SET.has(value.toLowerCase())
}

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  return [
    Number.parseInt(clean.slice(0, 2), 16) || 0,
    Number.parseInt(clean.slice(2, 4), 16) || 0,
    Number.parseInt(clean.slice(4, 6), 16) || 0,
  ]
}

function mixHex(a: [number, number, number], b: [number, number, number], weightA: number): string {
  const clamp = (n: number): string =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, '0')
  const wB = 1 - weightA
  return `#${clamp(a[0] * weightA + b[0] * wB)}${clamp(a[1] * weightA + b[1] * wB)}${clamp(a[2] * weightA + b[2] * wB)}`
}

/**
 * Computes background, text, and border colors for a tab:
 * - Default (no color): light grayscale on light theme (darker when selected), dark grayscale on dark theme (lighter when selected).
 * - Custom color: high-contrast selected vs. unselected shades (selected shifts darker with crisp white text on light theme, and brighter/lighter on dark theme).
 */
export function tabSwatchStyle(
  color: string | null | undefined,
  selected: boolean,
  dark: boolean,
): { backgroundColor: string; color: string; borderColor: string } {
  if (!color || !isTabColor(color)) {
    if (!dark) {
      return selected
        ? { backgroundColor: '#c8c8d0', color: '#171717', borderColor: '#e5e5e5' }
        : { backgroundColor: '#e4e4e7', color: '#52525b', borderColor: '#e5e5e5' }
    }
    return selected
      ? { backgroundColor: '#52525b', color: '#fafafa', borderColor: '#3f3f46' }
      : { backgroundColor: '#27272a', color: '#a1a1aa', borderColor: '#3f3f46' }
  }
  const rgb = parseHex(color)
  if (!dark) {
    // Light theme: darken only the fill when selected; keep the stroke/border light and unchanged.
    const lightStroke = mixHex(rgb, [229, 229, 229], 0.35)
    return selected
      ? {
          backgroundColor: mixHex(rgb, [15, 23, 42], 0.88),
          color: '#f8fafc',
          borderColor: lightStroke,
        }
      : {
          backgroundColor: mixHex(rgb, [241, 245, 249], 0.28),
          color: '#1e293b',
          borderColor: lightStroke,
        }
  }
  // Dark theme: unselected is a deep muted tone; selected is a vivid, lighter high-contrast shade.
  const darkStroke = mixHex(rgb, [39, 39, 42], 0.5)
  return selected
    ? {
        backgroundColor: mixHex(rgb, [255, 255, 255], 0.78),
        color: '#ffffff',
        borderColor: darkStroke,
      }
    : {
        backgroundColor: mixHex(rgb, [15, 23, 42], 0.52),
        color: '#cbd5e1',
        borderColor: darkStroke,
      }
}

/** Moves tab `id` to `toIndex`, returning the same array reference if nothing moved. */
export function reorderTabs<T extends { id: string }>(tabs: readonly T[], id: string, toIndex: number): T[] {
  const from = tabs.findIndex((t) => t.id === id)
  if (from < 0) return tabs as T[]
  const clamped = Math.max(0, Math.min(tabs.length - 1, Math.floor(toIndex)))
  if (from === clamped) return tabs as T[]
  const next = [...tabs]
  const [moved] = next.splice(from, 1)
  next.splice(clamped, 0, moved!)
  return next
}

/**
 * Filters tabs for a specific window:
 * - Window 1 (main window) shows tabs with `window === undefined` or `window === 1`.
 * - Window > 1 (`Terminal (copy)`) shows only tabs detached/created in that window (`window === windowNumber`).
 */
export function tabsForWindow<T extends { id: string; window?: number }>(
  workspaces: readonly T[],
  windowNumber: number,
  initialTabId?: string | null,
): T[] {
  if (windowNumber > 1) {
    const matching = workspaces.filter((w) => w.window === windowNumber)
    if (matching.length > 0) return matching
    if (initialTabId) {
      const byInitial = workspaces.filter((w) => w.id === initialTabId)
      if (byInitial.length > 0) return byInitial
    }
    return workspaces.slice(0, 1)
  }
  const mainTabs = workspaces.filter((w) => w.window === undefined || w.window === 1)
  return mainTabs.length > 0 ? mainTabs : workspaces.slice(0, 1)
}
