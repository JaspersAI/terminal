import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { askedIn } from '../../../shared/agent/asking'
import { withAttachments } from '../../../shared/agent/attachments'
import { CENTRAL_CHAT } from '../../../shared/agent/history'
import { currentWorkspace, useAppState } from '../../lib/state'
import { AttachButton, AttachmentChips, useAttachments, useFileDrop } from './Attachments'
import { useEarlier, useNoticeTimer } from './conversation'
import { pasteLinks } from './paste'
import { PHASE_TEXT } from './phase'
import { QuestionField } from './QuestionField'
import { useRequest } from './request'
import { SecretField } from './SecretField'

/**
 * Central's default space: a command line at the top of the terminal.
 * - Default clue text: "command the terminal from here".
 * - Expand button expands the command line up to 5 lines of text with vertical scroll (no dropdowns ever).
 * - Small voice button inside the command line (separate from the floating Voice Orb).
 * - Synchronized with Docked Central ("Central" room on the tab) and the Voice Orb via the shared Central store.
 */
export function Composer(): ReactElement {
  const workspaceId = useAppState((s) => currentWorkspace(s).id)
  const hasVoice = useAppState((s) => s.voice !== null)
  const secretRequest = useAppState((s) => askedIn(s.secretRequests))
  const question = useAppState((s) => askedIn(s.questions))
  const notices = useAppState((s) => s.notices)
  const welcome = useAppState((s) => (s.welcome?.workspaceId === workspaceId ? s.welcome.said : null))
  const [expanded, setExpanded] = useState(false)
  const request = useRequest()
  const { draft, setDraft, phase, error, busy, working, shown, earlier, ask, press, release, stop, clear } = request
  const attachments = useAttachments()
  const drop = useFileDrop(attachments.attach)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const notice = notices.find((one) => one.chat !== CENTRAL_CHAT && one.chat !== workspaceId) ?? null
  const told = notices.find((one) => one.chat === CENTRAL_CHAT || one.chat === workspaceId)?.id ?? null
  useEarlier({ request, workspaceId, when: true, said: told, welcome })
  useNoticeTimer(notice?.id ?? null)

  const latestLive = shown[shown.length - 1]
  const latestDone = earlier[earlier.length - 1]
  const voiceStatus = phase !== 'idle' && phase !== 'thinking' ? PHASE_TEXT[phase] : null
  const latestStatus =
    error ??
    voiceStatus ??
    (latestLive
      ? latestLive.error
        ? `Error: ${latestLive.error}`
        : latestLive.working
          ? (latestLive.steps[latestLive.steps.length - 1] ?? (latestLive.answer || 'Working…'))
          : latestLive.answer
      : (notice?.text ?? latestDone?.answer ?? null))

  // Auto-expand to 5 lines when a multi-line reply arrives or the user types multiple lines.
  useEffect(() => {
    if (draft.includes('\n')) setExpanded(true)
  }, [draft])

  function submit(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault()
    const text = withAttachments(draft.trim(), attachments.files)
    if (!text || busy || attachments.reading > 0) return
    setDraft('')
    attachments.clear()
    void ask(text)
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      if (working) {
        event.preventDefault()
        stop()
      } else if (expanded) {
        event.preventDefault()
        setExpanded(false)
      }
    }
  }

  return (
    <div
      id="composer"
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className="flex min-w-0 flex-1 flex-col justify-center"
    >
      {secretRequest !== null ? (
        <SecretField key={`${secretRequest.plugin}/${secretRequest.key}`} request={secretRequest} />
      ) : question !== null ? (
        <QuestionField key={question.id} question={question} />
      ) : (
        <form onSubmit={submit} className="flex min-w-0 flex-1 flex-col gap-1">
          {attachments.hasAny && <AttachmentChips attachments={attachments} />}
          <div className="flex min-w-0 items-start gap-1.5">
            <AttachButton compact onFiles={attachments.attach} disabled={busy} />
            <div className="flex min-w-0 flex-1 flex-col border border-border bg-background focus-within:border-foreground">
              <textarea
                ref={textareaRef}
                id="central-command-input"
                name="prompt"
                rows={expanded ? 5 : 1}
                disabled={busy}
                value={draft}
                placeholder="command the terminal from here"
                aria-label="Command the terminal from here"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={onKeyDown}
                onPaste={(event) => pasteLinks(event, attachments.attach)}
                onChange={(event) => setDraft(event.target.value)}
                className={`w-full resize-none bg-transparent px-2 py-1 text-xs leading-4 outline-none disabled:opacity-50 ${
                  expanded ? 'max-h-24 overflow-y-auto' : 'h-6 overflow-hidden whitespace-nowrap'
                }`}
              />
              {expanded && latestStatus && (
                <div
                  id="agent-answer"
                  className="max-h-20 overflow-y-auto border-t border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="whitespace-pre-wrap break-words">{latestStatus}</span>
                    {(earlier.length > 0 || shown.length > 0) && (
                      <button
                        type="button"
                        id="central-clear-button"
                        onClick={clear}
                        className="shrink-0 text-[10px] underline hover:text-foreground"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            {!expanded && latestStatus && (
              <span
                id="agent-status"
                title={latestStatus}
                className={`max-w-64 shrink truncate self-center text-xs ${
                  error || latestLive?.error ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                {latestStatus}
              </span>
            )}
            <button
              type="button"
              id="central-voice-button"
              aria-label="Hold to talk"
              title={
                !hasVoice
                  ? 'Add a voice provider in Settings to talk'
                  : phase === 'recording'
                    ? 'Listening — release to send'
                    : 'Hold to talk'
              }
              disabled={!hasVoice || phase === 'transcribing'}
              onPointerDown={(event) => {
                event.preventDefault()
                try {
                  event.currentTarget.setPointerCapture(event.pointerId)
                } catch {
                  // ignore
                }
                press()
              }}
              onPointerUp={release}
              onPointerCancel={release}
              className={`flex h-6 w-6 shrink-0 touch-none select-none items-center justify-center border border-border transition-colors disabled:opacity-40 ${
                phase === 'recording'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <svg viewBox="0 0 14 14" fill="none" aria-hidden className="h-3 w-3 stroke-current stroke-[1.4]">
                <rect x="5" y="1.5" width="4" height="6.5" rx="2" />
                <path d="M3 6.5a4 4 0 0 0 8 0M7 10.5v2M5 12.5h4" />
              </svg>
            </button>
            {working ? (
              <button
                type="button"
                id="composer-stop"
                aria-label="Stop"
                title="Stop Central"
                onClick={() => stop()}
                className="flex h-6 w-6 shrink-0 items-center justify-center border border-border bg-primary text-primary-foreground"
              >
                <span aria-hidden className="h-2 w-2 bg-current" />
              </button>
            ) : (
              <button
                type="submit"
                id="central-send-button"
                aria-label="Send"
                title="Send command"
                disabled={busy || attachments.reading > 0 || (!draft.trim() && attachments.files.length === 0)}
                className="flex h-6 w-6 shrink-0 items-center justify-center border border-border bg-primary text-primary-foreground disabled:opacity-30"
              >
                <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
                  <path d="M5 9V1.5M1.5 5 5 1.5 8.5 5" />
                </svg>
              </button>
            )}
            <button
              type="button"
              id="central-expand-button"
              aria-label={expanded ? 'Collapse command line' : 'Expand command line to 5 lines'}
              aria-expanded={expanded}
              title={expanded ? 'Collapse to 1 line' : 'Expand up to 5 lines'}
              onClick={() => setExpanded((prev) => !prev)}
              className="flex h-6 w-6 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
                {expanded ? <path d="M2 6.5 5 3.5 8 6.5" /> : <path d="M2 3.5 5 6.5 8 3.5" />}
              </svg>
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
