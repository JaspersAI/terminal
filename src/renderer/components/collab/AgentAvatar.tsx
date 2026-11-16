import type { ReactElement } from 'react'

interface Props {
  /** Diameter of the circle, in pixels. */
  size?: number
  title?: string
  className?: string
}

/**
 * The room's agent in a shared conversation: a monochrome black-and-white circle bearing the tiny
 * Jaspers crossing-arcs mark and specular gloss akin to the talk orb, paired opposite user avatars.
 */
export function AgentAvatar({ size = 20, title = 'Jaspers', className = '' }: Props): ReactElement {
  return (
    <span
      data-agent-avatar
      title={title}
      style={{ width: size, height: size }}
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-foreground/25 bg-[#111111] select-none ${className}`}
    >
      <svg viewBox="0 0 1434 1416" fill="none" aria-hidden className="pointer-events-none h-full w-full">
        <path d="M 1000 390 A 604 604 0 0 1 396 994" stroke="#ffffff" strokeWidth="112" strokeLinecap="butt" />
        <path d="M 713 1222 A 508 508 0 0 1 1221 714" stroke="#ffffff" strokeWidth="112" strokeLinecap="butt" />
      </svg>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle_at_32%_26%,rgba(255,255,255,0.48),rgba(255,255,255,0.06)_42%,rgba(0,0,0,0)_70%)] shadow-[inset_0_-2px_3px_rgba(255,255,255,0.14),inset_0_2px_3px_rgba(255,255,255,0.22)]"
      />
    </span>
  )
}
