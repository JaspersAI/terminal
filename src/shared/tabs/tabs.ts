// Pure rules for the bottom Excel-style tab bar: fixed stepped character widths (16 -> 12 -> 8 -> 6 -> 4)
// so tabs never resize by title length and never scroll horizontally, three-dot truncation, the 32-color
// palette with light/dark selected contrast, and tab reordering. Keep this file free of Node and DOM imports.

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

/** 32-color palette (4 rows × 8 columns) for coloring tabs. */
export const TAB_PALETTE: readonly string[] = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
  '#dc2626',
  '#ea580c',
  '#d97706',
  '#65a30d',
  '#16a34a',
  '#059669',
  '#0d9488',
  '#0891b2',
  '#0284c7',
  '#2563eb',
  '#4f46e5',
  '#7c3aed',
  '#9333ea',
  '#c026d3',
  '#db2777',
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
 * - Custom color: same contrast behavior (selected tab shifts darker on light theme, lighter on dark theme).
 */
export function tabSwatchStyle(
  color: string | null | undefined,
  selected: boolean,
  dark: boolean,
): { backgroundColor: string; color: string; borderColor: string } {
  if (!color || !isTabColor(color)) {
    if (!dark) {
      return selected
        ? { backgroundColor: '#c4c4cc', color: '#18181b', borderColor: '#a1a1aa' }
        : { backgroundColor: '#e4e4e7', color: '#52525b', borderColor: '#d4d4d8' }
    }
    return selected
      ? { backgroundColor: '#52525b', color: '#fafafa', borderColor: '#71717a' }
      : { backgroundColor: '#27272a', color: '#a1a1aa', borderColor: '#3f3f46' }
  }
  const rgb = parseHex(color)
  if (!dark) {
    // Light theme: unselected is a soft light tint, selected is a noticeably darker shade.
    return selected
      ? {
          backgroundColor: mixHex(rgb, [255, 255, 255], 0.55),
          color: '#18181b',
          borderColor: mixHex(rgb, [0, 0, 0], 0.75),
        }
      : {
          backgroundColor: mixHex(rgb, [255, 255, 255], 0.25),
          color: '#3f3f46',
          borderColor: mixHex(rgb, [255, 255, 255], 0.45),
        }
  }
  // Dark theme: unselected is a deep dark shade, selected is a noticeably lighter shade.
  return selected
    ? {
        backgroundColor: mixHex(rgb, [255, 255, 255], 0.2),
        color: '#fafafa',
        borderColor: mixHex(rgb, [255, 255, 255], 0.4),
      }
    : {
        backgroundColor: mixHex(rgb, [24, 24, 27], 0.4),
        color: '#d4d4d8',
        borderColor: mixHex(rgb, [24, 24, 27], 0.6),
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
