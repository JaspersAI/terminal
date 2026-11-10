// Microphone capture for hold-to-talk. `start` opens the mic and begins recording; `stop` ends it,
// releases the mic, and resolves with the audio. One recording at a time.

export interface Recording {
  audio: ArrayBuffer
  mimeType: string
  durationMs: number
}

const PREFERRED = 'audio/webm;codecs=opus'

export class Recorder {
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private audioCtx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private samples: Uint8Array<ArrayBuffer> | null = null

  get active(): boolean {
    return this.recorder !== null
  }

  /** Normalized 0..1 voice energy from the active microphone stream, or 0 when idle or unavailable. */
  level(): number {
    if (!this.analyser || !this.samples) return 0
    try {
      this.analyser.getByteTimeDomainData(this.samples)
      let sumSquares = 0
      for (let i = 0; i < this.samples.length; i++) {
        const centered = ((this.samples[i] ?? 128) - 128) / 128
        sumSquares += centered * centered
      }
      const rms = Math.sqrt(sumSquares / this.samples.length)
      return Math.min(1, rms * 4.5)
    } catch {
      return 0
    }
  }

  private closeAudio(): void {
    const ctx = this.audioCtx
    this.audioCtx = null
    this.analyser = null
    this.samples = null
    if (ctx) void ctx.close().catch(() => undefined)
  }

  async start(): Promise<void> {
    if (this.recorder) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recorder = new MediaRecorder(
      stream,
      MediaRecorder.isTypeSupported(PREFERRED) ? { mimeType: PREFERRED } : undefined,
    )
    this.chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    recorder.start()
    this.recorder = recorder
    this.startedAt = performance.now()
    try {
      const Ctx =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctx) {
        const ctx = new Ctx()
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.65
        source.connect(analyser)
        this.audioCtx = ctx
        this.analyser = analyser
        this.samples = new Uint8Array(new ArrayBuffer(analyser.fftSize))
      }
    } catch {
      // Web Audio metering is optional; recording still proceeds through MediaRecorder.
    }
  }

  /** Resolves once the last chunk has landed. */
  stop(): Promise<Recording> {
    const recorder = this.recorder
    this.closeAudio()
    if (!recorder) return Promise.reject(new Error('Not recording.'))
    this.recorder = null
    return new Promise((resolve) => {
      recorder.onstop = () => {
        for (const track of recorder.stream.getTracks()) track.stop()
        const mimeType = recorder.mimeType || 'audio/webm'
        const durationMs = performance.now() - this.startedAt
        void new Blob(this.chunks, { type: mimeType })
          .arrayBuffer()
          .then((audio) => resolve({ audio, mimeType, durationMs }))
      }
      recorder.stop()
    })
  }
}
