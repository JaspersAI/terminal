// Unsaved edits ask before they are left behind. The skill editor holds a guard while it has any;
// whatever would take the user away from it (closing Settings, another pane) goes through
// requestLeave, and the editor asks, in place, whether to discard them.

type Guard = (proceed: () => void) => void

let guard: Guard | null = null

/** Held while there is something to lose. Returns the way to let go. */
export function holdLeave(next: Guard): () => void {
  guard = next
  return () => {
    if (guard === next) guard = null
  }
}

/** Runs `proceed` now, or once whoever holds the guard agrees. */
export function requestLeave(proceed: () => void): void {
  if (guard) guard(proceed)
  else proceed()
}
