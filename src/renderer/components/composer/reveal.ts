import { useEffect, useRef, useState } from 'react'

/** How long the composer stays up on launch before it tucks itself away. */
const INTRO_MS = 3000
/** How long it lingers once nothing holds it, so crossing the gap to the orb does not drop it. */
const LINGER_MS = 600
/** How long a tap on the arrow holds it up, for a pointer that never hovers: touch, the driver. */
const POKE_MS = 4000

/**
 * Whether the composer is up. It starts up, waits out the intro, then minimizes to the arrow.
 * Anything that holds it — a hovering pointer, a run on screen, a half typed line — brings it
 * straight back and keeps it there; letting go tucks it away again after a short linger.
 */
export function useReveal(held: boolean): { open: boolean; poke: () => void } {
  const [open, setOpen] = useState(true)
  const [nonce, setNonce] = useState(0)
  // How long the next unheld stretch waits before closing. The intro is the one long one.
  const grace = useRef(INTRO_MS)

  useEffect(() => {
    if (held) {
      grace.current = LINGER_MS
      setOpen(true)
      return
    }
    const timer = setTimeout(() => {
      grace.current = LINGER_MS
      setOpen(false)
    }, grace.current)
    return () => clearTimeout(timer)
  }, [held, nonce])

  return {
    open,
    /** Bring it up for a while without a pointer resting on it. */
    poke: () => {
      grace.current = POKE_MS
      setOpen(true)
      setNonce((n) => n + 1)
    },
  }
}
