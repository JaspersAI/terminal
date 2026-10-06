import { useEffect, useRef, useState, type ReactElement } from 'react'
import { FEEDBACK_TEXT_MAX } from '../../../shared/app/eye'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { BUTTON } from '../settings/Row'

/**
 * The eye: a dot at the right end of the workspace bar that says whether Eye is recording. Recording,
 * it is filled and breathes slowly; off, it is a hollow ring and still. The label says which it is,
 * since the two must not be told apart by color alone.
 *
 * Pressed, it opens a popover under it: the switch for recording, and a box to write feedback in.
 * Send closes the popover first, so the picture main takes of every open window is of the screen
 * the user was writing about and not of the box they wrote in, then sends the note with it. A
 * moment of "Feedback sent" beside the dot says it went; a failure opens the popover again with the
 * note still in it and the reason under it.
 *
 * Round, which nothing else in the app is but the talk orb: an eye is the shape it is, and the
 * exception is what makes it read as one rather than as another button in the bar.
 */
export function EyeDot(): ReactElement {
  const recording = useAppState((s) => s.eye.recording)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    box.current?.focus()
    const pointerDown = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', pointerDown)
    document.addEventListener('keydown', keyDown)
    return () => {
      document.removeEventListener('pointerdown', pointerDown)
      document.removeEventListener('keydown', keyDown)
    }
  }, [open])

  useEffect(() => {
    if (!sent) return
    const timer = setTimeout(() => setSent(false), 2500)
    return () => clearTimeout(timer)
  }, [sent])

  const label = `${recording ? 'Eye is recording' : 'Eye is off'}. Recording and feedback`

  const toggle = (): void => {
    dispatch({ type: 'eye.set', eye: { recording: !recording } }).catch((err: unknown) => setFailed(errorMessage(err)))
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setFailed(null)
    // Off the screen before the picture: two frames, so the closed popover has been painted.
    setOpen(false)
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    try {
      await dispatch({ type: 'eye.feedback', text })
      setDraft('')
      setSent(true)
    } catch (err) {
      setFailed(errorMessage(err))
      setOpen(true)
    } finally {
      setSending(false)
    }
  }

  return (
    <div ref={root} data-owns-escape className="relative ml-auto flex shrink-0 items-center gap-2">
      {sent && (
        <span role="status" className="text-xs text-muted-foreground">
          Feedback sent
        </span>
      )}
      <button
        type="button"
        id="eye-dot"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
        className={`flex h-6 w-6 items-center justify-center ${open ? 'bg-muted' : 'hover:bg-muted'}`}
      >
        {/* The iris, with the pupil inside it. Recording fills both; off leaves the ring alone. */}
        <span
          className={`flex h-3 w-3 items-center justify-center rounded-full border ${
            recording
              ? 'animate-watch border-destructive bg-destructive/25 motion-reduce:animate-none'
              : 'border-muted-foreground'
          }`}
        >
          <span className={`h-1 w-1 rounded-full ${recording ? 'bg-destructive' : 'bg-transparent'}`} />
        </span>
      </button>
      {open && (
        <div
          id="eye-popover"
          role="dialog"
          aria-label="Eye"
          className="absolute top-full right-0 z-20 mt-1 w-80 border border-border bg-background p-3 shadow-lg"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{recording ? 'Recording' : 'Not recording'}</span>
            <button type="button" id="eye-toggle" aria-pressed={recording} onClick={toggle} className={BUTTON}>
              {recording ? 'Stop recording' : 'Start recording'}
            </button>
          </div>
          <div className="my-3 border-t border-border" />
          <label htmlFor="eye-feedback" className="text-sm font-medium">
            Feedback
          </label>
          <textarea
            ref={box}
            id="eye-feedback"
            value={draft}
            maxLength={FEEDBACK_TEXT_MAX}
            placeholder="What worked, what didn't, what you expected…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void send()
              }
            }}
            className="mt-1.5 h-24 w-full resize-none border border-border p-2 text-sm outline-none focus:border-foreground"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Goes to the Jaspers team with a picture of the Jaspers windows as they are when you press Send.
          </p>
          {failed && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {failed}
            </p>
          )}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              id="eye-feedback-send"
              disabled={!draft.trim() || sending}
              onClick={() => void send()}
              className="shrink-0 border border-foreground bg-foreground px-2.5 py-1 text-sm text-background disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
