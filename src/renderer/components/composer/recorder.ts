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

  get active(): boolean {
    return this.recorder !== null
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
  }

  /** Resolves once the last chunk has landed. */
  stop(): Promise<Recording> {
    const recorder = this.recorder
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
