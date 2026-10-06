import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import logo from '../../assets/jaspers-logo-black.png'
import type { Phase } from './phase'
import { Spring } from './spring'

/** How far the orb drifts toward a hovering pointer, in px. */
const PULL = 6

interface Props {
  phase: Phase
  /** What pressing it does: hold to talk, or, with no voice provider, type a request. */
  label: string
  onPress: () => void
  onRelease: () => void
}

/**
 * The logo clipped to a circle and shaded like a sphere: the one round thing in the app, on purpose.
 * Hovering lifts it and pulls it a few px toward the pointer, with the gloss sliding the same way so
 * the light seems to follow the cursor. Pressing squashes it, listening pops it out, release lets it
 * settle. Every change of target overshoots a little: the spring. Motion is written straight to the
 * DOM, so nothing re-renders while it moves.
 */
export function Orb({ phase, label, onPress, onRelease }: Props): ReactElement {
  const [hovering, setHovering] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const gloss = useRef<HTMLSpanElement>(null)
  const springRef = useRef<Spring | null>(null)
  const spring = (springRef.current ??= new Spring((v) => {
    if (button.current) {
      button.current.style.transform = `translate(${v.x.toFixed(2)}px, ${v.y.toFixed(2)}px) scale(${v.scale.toFixed(4)})`
    }
    if (gloss.current) {
      gloss.current.style.setProperty('--gloss', `${(32 + v.x * 3).toFixed(1)}% ${(26 + v.y * 3).toFixed(1)}%`)
    }
  }))
  const scale = phase === 'recording' ? 1.18 : phase === 'opening' ? 0.92 : phase === 'idle' && hovering ? 1.08 : 1
  useEffect(() => spring.set({ scale }), [spring, scale])
  useEffect(() => () => spring.stop(), [spring])

  /** Pull toward the pointer, at most `PULL` px, from where the pointer sits relative to the center. */
  function follow(event: ReactPointerEvent<HTMLButtonElement>): void {
    const rect = event.currentTarget.getBoundingClientRect()
    const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)
    const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)
    spring.set({ x: PULL * Math.max(-1, Math.min(1, dx)), y: PULL * Math.max(-1, Math.min(1, dy)) })
  }

  const look = phase === 'recording' ? 'ring-8 ring-primary/15' : phase === 'idle' ? '' : 'animate-pulse'

  return (
    <button
      ref={button}
      type="button"
      id="talk"
      aria-label={label}
      disabled={phase === 'transcribing'}
      onPointerDown={(event) => {
        event.preventDefault()
        // Keep receiving the pointer while held, so drifting off the orb does not end the recording.
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // synthetic events (the driver skill) have no capturable pointer
        }
        onPress()
      }}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onPointerEnter={() => setHovering(true)}
      onPointerMove={follow}
      onPointerLeave={() => {
        setHovering(false)
        spring.set({ x: 0, y: 0 })
      }}
      className={`relative h-14 w-14 touch-none select-none overflow-hidden rounded-full bg-primary shadow-[0_14px_24px_-10px_rgba(0,0,0,0.6)] transition-shadow duration-300 hover:shadow-[0_22px_34px_-12px_rgba(0,0,0,0.55)] ${look}`}
    >
      <img src={logo} alt="" draggable={false} className="pointer-events-none h-full w-full object-cover" />
      {/* Gloss: a highlight up and to the left that follows the pull, a faint rim light along the bottom. */}
      <span
        ref={gloss}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_var(--gloss,32%_26%),rgba(255,255,255,0.5),rgba(255,255,255,0.06)_42%,rgba(0,0,0,0)_70%)] shadow-[inset_0_-6px_10px_rgba(255,255,255,0.14),inset_0_6px_10px_rgba(255,255,255,0.2)]"
      />
    </button>
  )
}
