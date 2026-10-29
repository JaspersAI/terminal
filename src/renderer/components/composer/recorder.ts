// Microphone capture for voice input. `start` opens the mic and begins recording; `stop` ends it
// and resolves with the audio while keeping the stream warm across brief pauses; `close` releases
// the hardware stream immediately.

export interface Recording {
  audio: ArrayBuffer
  mimeType: string
  durationMs: number
}

const PREFERRED = 'audio/webm;codecs=opus'
/** How long the microphone stream stays warm after a segment stops, so speaking across pauses starts at once. */
const WARM_MS = 15_000

export class Recorder {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private warmTimer: ReturnType<typeof setTimeout> | null = null
  private chunks: Blob[] = []
  private startedAt = 0

  get active(): boolean {
    return this.recorder !== null
  }

  elapsedMs(): number {
    return this.recorder ? performance.now() - this.startedAt : 0
  }

  private clearWarmTimer(): void {
    if (this.warmTimer !== null) {
      clearTimeout(this.warmTimer)
      this.warmTimer = null
    }
  }

  private releaseStream(): void {
    this.clearWarmTimer()
    if (!this.stream) return
    for (const track of this.stream.getTracks()) track.stop()
    this.stream = null
  }

  private async acquireStream(): Promise<MediaStream> {
    this.clearWarmTimer()
    if (this.stream && this.stream.getTracks().some((track) => track.readyState === 'live')) {
      return this.stream
    }
    this.releaseStream()
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    return this.stream
  }

  async start(): Promise<void> {
    if (this.recorder) return
    const stream = await this.acquireStream()
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
  }

  /** Resolves once the last chunk has landed. */
  stop(): Promise<Recording> {
    const recorder = this.recorder
    if (!recorder) return Promise.reject(new Error('Not recording.'))
    this.recorder = null
    const startedAt = this.startedAt
    const chunks = this.chunks
    this.chunks = []
    return new Promise((resolve) => {
      recorder.onstop = () => {
        this.clearWarmTimer()
        if (!this.recorder) {
          this.warmTimer = setTimeout(() => this.releaseStream(), WARM_MS)
        }
        const mimeType = recorder.mimeType || 'audio/webm'
        const durationMs = performance.now() - startedAt
        void new Blob(chunks, { type: mimeType })
          .arrayBuffer()
          .then((audio) => resolve({ audio, mimeType, durationMs }))
      }
      recorder.stop()
    })
  }

  /** Stops any active recording and releases the microphone stream immediately. */
  close(): void {
    const recorder = this.recorder
    this.recorder = null
    this.chunks = []
    if (recorder) {
      recorder.onstop = () => this.releaseStream()
      try {
        recorder.stop()
      } catch {
        this.releaseStream()
      }
    } else {
      this.releaseStream()
    }
  }
}
