import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import logo from '../../assets/jaspers-logo-black.png'
import { useAppState } from '../../lib/state'
import type { Phase } from './phase'
import { PHASE_TEXT } from './phase'
import { useRequest } from './request'
import { Spring } from './spring'

/** How far the orb drifts toward a hovering pointer, in px. */
const PULL = 6

interface Props {
  phase: Phase
  label: string
  onPress: () => void
  onRelease: () => void
}

/**
 * The logo clipped to a circle and shaded like a sphere.
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
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // synthetic events have no capturable pointer
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
      <span
        ref={gloss}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_var(--gloss,32%_26%),rgba(255,255,255,0.5),rgba(255,255,255,0.06)_42%,rgba(0,0,0,0)_70%)] shadow-[inset_0_-6px_10px_rgba(255,255,255,0.14),inset_0_6px_10px_rgba(255,255,255,0.2)]"
      />
    </button>
  )
}

/**
 * Draggable Voice Orb overlay on top of the tab surface (Regime 2.2).
 * User can drag it anywhere around the screen, or tap it to start/stop voice input, which feeds
 * directly into Central (replicated in the top command line and Central Dock).
 */
export function FloatingOrb(): ReactElement {
  const hasVoice = useAppState((s) => s.voice !== null)
  const { phase, error, toggleVoice } = useRequest()
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: typeof window !== 'undefined' ? Math.max(40, Math.round(window.innerWidth / 2 - 32)) : 400,
    y: typeof window !== 'undefined' ? Math.max(60, Math.round(window.innerHeight - 130)) : 500,
  }))
  const dragRef = useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: pos.x,
      originY: pos.y,
      moved: false,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // ignore synthetic pointer events
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    drag.moved = true
    const maxX = Math.max(0, window.innerWidth - 72)
    const maxY = Math.max(0, window.innerHeight - 96)
    setPos({
      x: Math.max(8, Math.min(maxX, drag.originX + dx)),
      y: Math.max(40, Math.min(maxY, drag.originY + dy)),
    })
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    dragRef.current = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // ignore
    }
    if (!drag || drag.moved) return
    if (hasVoice) toggleVoice()
  }

  const statusText =
    error ??
    (phase === 'recording'
      ? 'Listening — tap to send'
      : phase === 'idle'
        ? hasVoice
          ? 'Tap to speak · drag to move'
          : 'Add voice provider in Settings'
        : PHASE_TEXT[phase])

  return (
    <div
      id="floating-voice-orb"
      data-floating-orb
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="fixed z-40 flex cursor-grab flex-col items-center gap-1 select-none active:cursor-grabbing"
    >
      <div
        role="button"
        tabIndex={0}
        id="talk"
        aria-label={phase === 'recording' ? 'Stop and send voice' : 'Tap to speak to Central'}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && hasVoice) {
            event.preventDefault()
            toggleVoice()
          }
        }}
        className={`relative h-14 w-14 overflow-hidden rounded-full bg-primary shadow-[0_14px_24px_-10px_rgba(0,0,0,0.6)] transition-transform ${
          phase === 'recording' ? 'scale-110 ring-8 ring-primary/20' : 'hover:scale-105'
        }`}
      >
        <img src={logo} alt="" draggable={false} className="pointer-events-none h-full w-full object-cover" />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_32%_26%,rgba(255,255,255,0.5),rgba(255,255,255,0.06)_42%,rgba(0,0,0,0)_70%)] shadow-[inset_0_-6px_10px_rgba(255,255,255,0.14),inset_0_6px_10px_rgba(255,255,255,0.2)]"
        />
      </div>
      <span className="border border-border bg-background/95 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground shadow-sm">
        {statusText}
      </span>
    </div>
  )
}
