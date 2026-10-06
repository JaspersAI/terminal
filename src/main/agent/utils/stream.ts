import { thoughtLine, writingLine, WRITING_EVERY_MS } from '../../../shared/agent/rounds'
import { emit } from './runs'

/** How long pieces of a reply are held before they go out together. */
const STREAM_MS = 50

/**
 * The reply as it arrives, in pieces a person can read rather than pieces a model emits. A delta
 * pushed the moment it lands would be thousands of messages to every window for one answer, and a
 * box repainting per token reads as jitter rather than as writing; held for a moment and sent
 * together it is smooth, and two orders of magnitude fewer messages.
 */
export function streamer(runId: string): { push: (delta: string) => void; flush: () => void } {
  let held = ''
  let timer: NodeJS.Timeout | null = null
  const send = (): void => {
    timer = null
    if (!held) return
    emit({ kind: 'text', runId, delta: held })
    held = ''
  }
  return {
    push: (delta) => {
      held += delta
      timer ??= setTimeout(send, STREAM_MS)
    },
    flush: () => {
      if (timer) clearTimeout(timer)
      send()
    },
  }
}

/** What the model is thinking, for whoever watches the run: its last whole sentence, said when it changes. */
export function thinker(runId: string): (delta: string) => void {
  let thinking = ''
  let said: string | null = null
  return (delta) => {
    // Only the end of it is read: the last sentence is there, and a long think is not read again with every piece.
    thinking = `${thinking}${delta}`.slice(-2000)
    const line = thoughtLine(thinking)
    if (line === null || line === said) return
    said = line
    emit({ kind: 'thinking', runId, line })
  }
}

/**
 * The call the model is writing, for the status line. One written in a moment says nothing here: its
 * step comes when it runs. One still being written after a while is said by its tool and how long,
 * and said again in the same line for as long as it goes on. `began` is told each call as the model
 * starts it, and `end` that the reply is over.
 */
export function writer(runId: string): { began: (name: string) => void; end: () => void } {
  let timer: NodeJS.Timeout | undefined
  const end = (): void => clearInterval(timer)
  return {
    began: (name) => {
      end()
      let said = 0
      timer = setInterval(() => {
        said++
        const line = writingLine(name, said * WRITING_EVERY_MS)
        emit({ kind: 'status', runId, line, ...(said > 1 ? { again: true } : {}) })
      }, WRITING_EVERY_MS)
    },
    end,
  }
}
