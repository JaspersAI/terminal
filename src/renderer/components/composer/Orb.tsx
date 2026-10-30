import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import logo from '../../assets/jaspers-logo-black.png'
import { useAppState } from '../../lib/state'
import { useRequest } from './request'
import { Spring } from './spring'

/** How far the orb drifts toward a hovering pointer, in px. */
const PULL = 6
/** 1.5x of the original 56px (3.5rem) diameter = 84px. */
const ORB_DIAMETER_PX = 84
/** Distance past which holding and moving the pointer drags the orb across the screen. */
const DRAG_THRESHOLD_PX = 10

/**
 * Draggable Voice Orb overlay on top of the tab surface (Regime 2.2), 1.5x larger in diameter (84px)
 * with no text underneath.
 * - Press once: starts listening (`recording`).
 * - Press again: stops listening, transcribes into the command line (`draft`), and auto-submits to Central.
 * - Dragging the orb beyond 10px moves the orb smoothly to any spot on screen without toggling recording.
 */
export function FloatingOrb(): ReactElement {
  const hasVoice = useAppState((s) => s.voice !== null)
  const { phase, toggleVoice } = useRequest()
  const [hovering, setHovering] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: typeof window !== 'undefined' ? Math.max(40, Math.round(window.innerWidth / 2 - ORB_DIAMETER_PX / 2)) : 400,
    y: typeof window !== 'undefined' ? Math.max(60, Math.round(window.innerHeight - ORB_DIAMETER_PX - 64)) : 500,
  }))
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

  const stateRef = useRef({ hasVoice, toggleVoice })
  stateRef.current = { hasVoice, toggleVoice }

  // Keep the native top-layer Orb overlay synchronized so the Orb stays in front of native core/browser views.
  useEffect(() => {
    window.app.browser?.syncOrb?.({
      visible: true,
      x: pos.x,
      y: pos.y,
      size: ORB_DIAMETER_PX,
      phase,
      logoSrc: logo,
    })
  }, [pos.x, pos.y, phase])

  useEffect(() => {
    const off = window.app.browser?.onOrbPointer?.((event) => {
      if (event.kind === 'move' && typeof event.x === 'number' && typeof event.y === 'number') {
        setPos({ x: event.x, y: event.y })
      } else if (event.kind === 'click') {
        if (stateRef.current.hasVoice) stateRef.current.toggleVoice('orb')
      }
    })
    return () => {
      off?.()
      window.app.browser?.syncOrb?.({
        visible: false,
        x: 0,
        y: 0,
        size: ORB_DIAMETER_PX,
        phase: 'idle',
        logoSrc: '',
      })
    }
  }, [])

  const dragRef = useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
    dragging: boolean
  } | null>(null)

  function follow(event: ReactPointerEvent<HTMLButtonElement>): void {
    const rect = event.currentTarget.getBoundingClientRect()
    const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)
    const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)
    spring.set({ x: PULL * Math.max(-1, Math.min(1, dx)), y: PULL * Math.max(-1, Math.min(1, dy)) })
  }

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: pos.x,
      originY: pos.y,
      dragging: false,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // synthetic events have no capturable pointer
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current
    if (!drag) {
      follow(event)
      return
    }
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
        follow(event)
        return
      }
      drag.dragging = true
      spring.set({ x: 0, y: 0 })
    }
    const maxX = Math.max(16, window.innerWidth - ORB_DIAMETER_PX - 16)
    const maxY = Math.max(40, window.innerHeight - ORB_DIAMETER_PX - 32)
    setPos({
      x: Math.max(16, Math.min(maxX, drag.originX + dx)),
      y: Math.max(40, Math.min(maxY, drag.originY + dy)),
    })
  }

  function finishPointer(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current
    dragRef.current = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // ignore
    }
    if (!drag || drag.dragging) return
    if (hasVoice) toggleVoice('orb')
  }

  const look = phase === 'recording' ? 'ring-8 ring-primary/15' : phase === 'idle' ? '' : 'animate-pulse'

  return (
    <div
      id="floating-voice-orb"
      data-floating-orb
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      className="fixed z-50 select-none"
    >
      <button
        ref={button}
        type="button"
        id="talk"
        aria-label={phase === 'recording' ? 'Stop listening and send' : 'Press to talk'}
        title={
          !hasVoice
            ? 'Add a voice provider in Settings to talk'
            : phase === 'recording'
              ? 'Listening — press again to send'
              : 'Press to talk'
        }
        disabled={phase === 'transcribing'}
        style={{ width: `${ORB_DIAMETER_PX}px`, height: `${ORB_DIAMETER_PX}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={() => {
          dragRef.current = null
        }}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => {
          setHovering(false)
          spring.set({ x: 0, y: 0 })
        }}
        className={`relative touch-none select-none overflow-hidden rounded-full bg-primary shadow-[0_14px_24px_-10px_rgba(0,0,0,0.6)] transition-shadow duration-300 hover:shadow-[0_22px_34px_-12px_rgba(0,0,0,0.55)] ${look}`}
      >
        <img src={logo} alt="" draggable={false} className="pointer-events-none h-full w-full object-cover" />
        <span
          ref={gloss}
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_var(--gloss,32%_26%),rgba(255,255,255,0.5),rgba(255,255,255,0.06)_42%,rgba(0,0,0,0)_70%)] shadow-[inset_0_-6px_10px_rgba(255,255,255,0.14),inset_0_6px_10px_rgba(255,255,255,0.2)]"
        />
      </button>
    </div>
  )
}
