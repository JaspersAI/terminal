import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import logo from '../../assets/jaspers-logo-black.png'
import { useAppState } from '../../lib/state'
import type { Phase } from './phase'
import { useRequest } from './request'
import { Spring } from './spring'
import {
  HOLD_THRESHOLD_MS,
  orbPointerDown,
  orbPointerMove,
  orbPointerUp,
  orbStatusLine,
  type OrbDragState,
} from './voice-orb'

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
 * Supports both hold-to-talk (press and hold while speaking, release to send) and tap-to-talk
 * (tap once to start speaking, tap again to send), plus dragging anywhere on screen.
 */
export function FloatingOrb(): ReactElement {
  const hasVoice = useAppState((s) => s.voice !== null)
  const { phase, error, lastHeard, shown, press, release, keepRecording, cancel, toggleVoice } = useRequest()
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: typeof window !== 'undefined' ? Math.max(40, Math.round(window.innerWidth / 2 - 32)) : 400,
    y: typeof window !== 'undefined' ? Math.max(60, Math.round(window.innerHeight - 130)) : 500,
  }))
  const dragRef = useRef<OrbDragState | null>(null)
  const spaceDownAt = useRef<number | null>(null)

  useEffect(() => {
    if (!hasVoice) return
    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || inControl(event) || modalOpen()) return
      event.preventDefault()
      if (phase === 'opening' || phase === 'transcribing') return
      if (phase === 'recording') {
        spaceDownAt.current = null
        release()
        return
      }
      spaceDownAt.current = Date.now()
      press()
    }
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || spaceDownAt.current === null) return
      if (!inControl(event)) event.preventDefault()
      const held = Date.now() - spaceDownAt.current
      spaceDownAt.current = null
      if (held >= HOLD_THRESHOLD_MS) release()
      else keepRecording()
    }
    const blur = (): void => {
      if (spaceDownAt.current !== null) {
        spaceDownAt.current = null
        release()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [hasVoice, phase, press, release, keepRecording])

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const { drag, action } = orbPointerDown({
      phase,
      hasVoice,
      button: event.button,
      clientX: event.clientX,
      clientY: event.clientY,
      posX: pos.x,
      posY: pos.y,
      now: Date.now(),
    })
    if (!drag) return
    event.preventDefault()
    dragRef.current = drag
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // ignore synthetic pointer events
    }
    if (action === 'start') press()
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = dragRef.current
    if (!current) return
    const {
      drag,
      pos: nextPos,
      action,
    } = orbPointerMove(current, {
      clientX: event.clientX,
      clientY: event.clientY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })
    dragRef.current = drag
    if (action === 'cancel') cancel()
    if (nextPos) setPos(nextPos)
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
    const outcome = orbPointerUp(drag, { hasVoice, now: Date.now() })
    if (outcome === 'send') release()
    else if (outcome === 'keep-recording') keepRecording()
  }

  const latestLive = shown[shown.length - 1]
  const statusText = orbStatusLine({
    phase,
    hasVoice,
    error,
    lastHeard,
    latestQuestion: latestLive?.question ?? null,
  })

  return (
    <div
      id="floating-voice-orb"
      data-floating-orb
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="fixed z-40 flex cursor-grab flex-col items-center gap-1 select-none active:cursor-grabbing"
    >
      <div
        role="button"
        tabIndex={0}
        id="talk"
        aria-label={phase === 'recording' ? 'Stop and send voice' : 'Hold or tap to speak to Central'}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.repeat && hasVoice) {
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
      <span
        id="floating-orb-status"
        className="max-w-72 truncate border border-border bg-background/95 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground shadow-sm"
      >
        {statusText}
      </span>
    </div>
  )
}

function modalOpen(): boolean {
  return document.querySelector('[aria-modal=true]') !== null
}

function inControl(event: KeyboardEvent): boolean {
  return (
    event.target instanceof HTMLElement &&
    event.target.matches('input, textarea, select, button:not(#talk), [contenteditable]')
  )
}
