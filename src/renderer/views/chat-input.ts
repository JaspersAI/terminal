// Sizing and keyboard rules for Docked Central's multi-line command field (`views/Chat.tsx`).
// Pure, with no DOM or React imports, so tests exercise them directly.

/** Single-line height in px at 100% zoom (16 px line height + 2 px vertical padding on each side). */
export const CHAT_INPUT_MIN_HEIGHT = 20

/** Upper bound in px at 100% zoom (~12 lines) before the field scrolls inside itself. */
export const CHAT_INPUT_MAX_HEIGHT = 200

/** Minimum multi-line cap in px at 100% zoom (~2 lines) even when the docked tile is resized short. */
const CHAT_INPUT_MIN_CAPPED_HEIGHT = 36

/** Maximum share of the docked Central panel's height the command field may take before scrolling. */
export const CHAT_INPUT_MAX_PANEL_SHARE = 0.45

export interface ChatInputSize {
  height: number
  overflowY: 'hidden' | 'auto'
}

export interface ChatKeyInput {
  key: string
  shiftKey: boolean
  isComposing: boolean
  draft: string
  menuOpen: boolean
  activeMatchId: string | null
  matchCount: number
  activeIndex: number
}

export type ChatKeyAction =
  | { kind: 'none' }
  | { kind: 'submit' }
  | { kind: 'move-menu'; nextIndex: number }
  | { kind: 'pick-skill' }
  | { kind: 'close-menu' }

function normalizedZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

/**
 * Maximum height in px for Docked Central's command field given the docked panel's height and zoom,
 * keeping the conversation transcript above it visible even in shorter tiles.
 */
export function chatInputMaxHeight(panelHeight: number, zoom = 1): number {
  const scale = normalizedZoom(zoom)
  const cap = Math.round(CHAT_INPUT_MAX_HEIGHT * scale)
  const floor = Math.round(CHAT_INPUT_MIN_CAPPED_HEIGHT * scale)
  if (!Number.isFinite(panelHeight) || panelHeight <= 0) return cap
  return Math.max(floor, Math.min(cap, Math.floor(panelHeight * CHAT_INPUT_MAX_PANEL_SHARE)))
}

/**
 * Computes the rendered height and vertical overflow mode for Docked Central's auto-expanding
 * textarea from its measured `scrollHeight`, the docked panel's height, and the tile's zoom.
 */
export function measureChatInput(scrollHeight: number, panelHeight: number, zoom = 1): ChatInputSize {
  const scale = normalizedZoom(zoom)
  const min = Math.round(CHAT_INPUT_MIN_HEIGHT * scale)
  const max = chatInputMaxHeight(panelHeight, scale)
  const content = Number.isFinite(scrollHeight) && scrollHeight > 0 ? Math.ceil(scrollHeight) : min
  const height = Math.max(min, Math.min(max, content))
  return {
    height,
    overflowY: content > max ? 'auto' : 'hidden',
  }
}

/**
 * Maps a key press in Docked Central's textarea to its composer action:
 * - `Enter` without `Shift` submits the request (or completes the highlighted `/skill` when the
 *   slash menu is open and the draft does not yet match `/skill` verbatim).
 * - `Shift+Enter` is left to the textarea so it inserts a newline and expands the field.
 * - Arrow keys navigate the `/skill` menu while open, and otherwise move the caret across lines.
 * - IME composition keys are never intercepted.
 */
export function dockedChatKeyAction(input: ChatKeyInput): ChatKeyAction {
  if (input.isComposing) return { kind: 'none' }
  if (input.menuOpen && input.matchCount > 0 && input.activeMatchId !== null) {
    if (input.key === 'ArrowDown' || input.key === 'ArrowUp') {
      const step = input.key === 'ArrowDown' ? 1 : input.matchCount - 1
      return { kind: 'move-menu', nextIndex: (input.activeIndex + step) % input.matchCount }
    }
    if (input.key === 'Tab') {
      return { kind: 'pick-skill' }
    }
    if (input.key === 'Enter' && !input.shiftKey) {
      return input.draft !== `/${input.activeMatchId}` ? { kind: 'pick-skill' } : { kind: 'submit' }
    }
    if (input.key === 'Escape') {
      return { kind: 'close-menu' }
    }
    return { kind: 'none' }
  }
  if (input.key === 'Enter' && !input.shiftKey) {
    return { kind: 'submit' }
  }
  return { kind: 'none' }
}
