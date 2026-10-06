// A damped spring for the orb: translate x/y in px and scale, each with its own stiffness and
// damping, integrated together in one requestAnimationFrame loop. Underdamped on purpose, so a
// change of target overshoots a little and settles: the bounce. Values go straight to the DOM
// through `apply`, so animating costs no React re-renders. Unit mass; critical damping is
// 2 * sqrt(stiffness).

export interface Motion {
  x: number
  y: number
  scale: number
}

type Key = keyof Motion
const KEYS: Key[] = ['x', 'y', 'scale']

interface Tuning {
  stiffness: number
  damping: number
}

const DEFAULT_TUNING: Record<Key, Tuning> = {
  x: { stiffness: 200, damping: 18 },
  y: { stiffness: 200, damping: 18 },
  scale: { stiffness: 380, damping: 20 },
}

export class Spring {
  private readonly value: Motion = { x: 0, y: 0, scale: 1 }
  private readonly velocity: Motion = { x: 0, y: 0, scale: 0 }
  private readonly target: Motion = { x: 0, y: 0, scale: 1 }
  private frame = 0
  private last = 0

  constructor(
    private readonly apply: (value: Motion) => void,
    private readonly tuning: Record<Key, Tuning> = DEFAULT_TUNING,
  ) {}

  /** Moves the target. The loop starts if it is not already running. */
  set(next: Partial<Motion>): void {
    Object.assign(this.target, next)
    if (!this.frame) {
      this.last = performance.now()
      this.frame = requestAnimationFrame(this.step)
    }
  }

  stop(): void {
    cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  private readonly step = (now: number): void => {
    const dt = Math.min((now - this.last) / 1000, 1 / 30) // cap so a background tab cannot explode the sim
    this.last = now
    let settled = true
    for (const key of KEYS) {
      const { stiffness, damping } = this.tuning[key]
      const acceleration = -stiffness * (this.value[key] - this.target[key]) - damping * this.velocity[key]
      this.velocity[key] += acceleration * dt
      this.value[key] += this.velocity[key] * dt
      if (Math.abs(this.velocity[key]) < 0.002 && Math.abs(this.value[key] - this.target[key]) < 0.002) {
        this.value[key] = this.target[key]
        this.velocity[key] = 0
      } else {
        settled = false
      }
    }
    this.apply(this.value)
    this.frame = settled ? 0 : requestAnimationFrame(this.step)
  }
}
