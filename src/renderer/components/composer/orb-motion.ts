import type { Phase } from './phase.ts'

export interface OrbVibration {
  active: boolean
  scaleOffset: number
  glossX: number
  glossY: number
  haloScale: number
  haloOpacity: number
  waveScale: number
  waveOpacity: number
  rimGlow: number
}

const IDLE_VIBRATION: OrbVibration = {
  active: false,
  scaleOffset: 0,
  glossX: 32,
  glossY: 26,
  haloScale: 1,
  haloOpacity: 0,
  waveScale: 1,
  waveOpacity: 0,
  rimGlow: 0.2,
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function orbBaseScale(phase: Phase, hovering: boolean): number {
  if (phase === 'recording') return 1.14
  if (phase === 'opening') return 0.94
  if (phase === 'transcribing' || phase === 'thinking') return 1.04
  return hovering ? 1.08 : 1
}

/**
 * Computes the Orb's luminous light vibration for a given frame (`elapsedMs`) and microphone energy
 * (`audioLevel` in `0..1`). Even when silent (`audioLevel === 0`), `recording` and `opening` produce
 * a continuous multi-harmonic light vibration across the outer aura waves, sphere scale, and inner
 * specular highlight; speaking amplifies the vibration in real time.
 */
export function orbVibration(phase: Phase, elapsedMs: number, audioLevel = 0): OrbVibration {
  if (phase === 'idle') return IDLE_VIBRATION

  const t = Math.max(0, elapsedMs) / 1000
  const level = clamp01(audioLevel)

  if (phase === 'recording' || phase === 'opening') {
    // Three incommensurate harmonics create a living, non-mechanical light vibration.
    const primary = 0.5 + 0.5 * Math.sin(t * 7.2)
    const shimmer = 0.5 + 0.5 * Math.sin(t * 13.5 + 1.1)
    const ripple = 0.5 + 0.5 * Math.cos(t * 4.6 + 0.6)
    const energy = Math.min(1, 0.34 + 0.26 * primary + 0.16 * shimmer + 0.65 * level)

    return {
      active: true,
      scaleOffset: Number(
        ((0.025 * primary + 0.015 * shimmer + 0.08 * level) * (phase === 'opening' ? 0.5 : 1)).toFixed(4),
      ),
      glossX: Number((32 + Math.sin(t * 4.8) * (7 + level * 6) + Math.cos(t * 9.3) * 2.5).toFixed(2)),
      glossY: Number((26 + Math.cos(t * 3.9) * (6 + level * 5) + Math.sin(t * 8.1) * 2).toFixed(2)),
      haloScale: Number((1.08 + 0.12 * energy + 0.05 * primary + 0.1 * level).toFixed(4)),
      haloOpacity: Number(Math.min(0.92, 0.42 + 0.34 * energy + 0.16 * level).toFixed(3)),
      waveScale: Number((1.16 + 0.18 * ripple + 0.08 * shimmer + 0.14 * level).toFixed(4)),
      waveOpacity: Number(Math.min(0.78, 0.22 + 0.28 * (1 - ripple * 0.5) + 0.22 * level).toFixed(3)),
      rimGlow: Number(Math.min(0.85, 0.34 + 0.26 * energy + 0.2 * level).toFixed(3)),
    }
  }

  // `transcribing` and `thinking`: a calm, continuous luminous breath while keeping the sphere opaque.
  const breath = 0.5 + 0.5 * Math.sin(t * 3.6)
  const drift = Math.cos(t * 2.4)
  return {
    active: true,
    scaleOffset: Number((0.02 * breath).toFixed(4)),
    glossX: Number((32 + Math.sin(t * 2.4) * 5).toFixed(2)),
    glossY: Number((26 + drift * 4).toFixed(2)),
    haloScale: Number((1.06 + 0.08 * breath).toFixed(4)),
    haloOpacity: Number((0.28 + 0.24 * breath).toFixed(3)),
    waveScale: Number((1.12 + 0.12 * (1 - breath)).toFixed(4)),
    waveOpacity: Number((0.16 + 0.18 * breath).toFixed(3)),
    rimGlow: Number((0.28 + 0.18 * breath).toFixed(3)),
  }
}
