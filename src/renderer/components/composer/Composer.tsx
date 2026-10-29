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
import { Transcript } from './Transcript'

/**
 * Central's top command line:
 * - Fixed 3/4 command-line width to 1/4 LLM-answer / system-message space so the command line width never alters.
 * - "+" attach button inside the command line on the very left.
 * - Voice icon button inside the command line on the right; no Send button (Enter submits).
 * - Expand caret directly on the right of the command line; expanding shows the full session conversation in a
 *   scrollable view.
 * - Attachment errors are reported into the conversation as regular LLM responses rather than on top of the command line.
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
  const {
    draft,
    setDraft,
    phase,
    error,
    busy,
    working,
    shown,
    earlier,
    ask,
    reportResponse,
    press,
    release,
    stop,
    clear,
  } = request
  const attachments = useAttachments((msg, fileName) => {
    reportResponse(`[Attached: ${fileName}]`, msg)
  })
  const drop = useFileDrop(attachments.attach)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const notice = notices.find((one) => one.chat !== CENTRAL_CHAT && one.chat !== workspaceId) ?? null
  const told = notices.find((one) => one.chat === CENTRAL_CHAT || one.chat === workspaceId)?.id ?? null
  const more = useEarlier({ request, workspaceId, when: true, said: told, welcome })
  useNoticeTimer(notice?.id ?? null)

  const latestLive = shown[shown.length - 1]
  const latestDone = earlier[earlier.length - 1]
  const voiceStatus = phase !== 'idle' && phase !== 'thinking' ? PHASE_TEXT[phase] : null
  const latestStatus =
    error ??
    voiceStatus ??
    (latestLive
      ? latestLive.error
        ? latestLive.error
        : latestLive.working
          ? (latestLive.steps[latestLive.steps.length - 1] ?? (latestLive.answer || 'Working…'))
          : latestLive.answer
      : (notice?.text ?? latestDone?.answer ?? latestDone?.error ?? null))

  // Auto-expand when the user types multiple lines.
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

  const hasConvo = earlier.length > 0 || shown.length > 0

  return (
    <div
      id="composer"
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className="flex min-w-0 flex-1 items-start"
    >
      {secretRequest !== null ? (
        <div className="w-3/4 shrink-0">
          <SecretField key={`${secretRequest.plugin}/${secretRequest.key}`} request={secretRequest} />
        </div>
      ) : question !== null ? (
        <div className="w-3/4 shrink-0">
          <QuestionField key={question.id} question={question} />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {/* 3/4 proportional command line + expand caret directly on its right */}
          <form onSubmit={submit} data-command-line-column className="flex w-3/4 min-w-0 shrink-0 flex-col gap-1">
            <div className="flex min-w-0 items-start gap-1">
              <div
                data-command-line-box
                className="flex min-h-6 min-w-0 flex-1 items-center gap-1 border border-border bg-background px-1 focus-within:border-foreground"
              >
                <AttachButton compact onFiles={attachments.attach} disabled={busy} />
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
                  className={`min-w-0 flex-1 resize-none bg-transparent px-1 py-1 text-xs leading-4 outline-none disabled:opacity-50 ${
                    expanded ? 'max-h-24 overflow-y-auto' : 'h-6 overflow-hidden whitespace-nowrap'
                  }`}
                />
                {working && (
                  <button
                    type="button"
                    id="composer-stop"
                    aria-label="Stop"
                    title="Stop Central"
                    onClick={() => stop()}
                    className="flex h-5 w-5 shrink-0 items-center justify-center bg-primary text-primary-foreground"
                  >
                    <span aria-hidden className="h-2 w-2 bg-current" />
                  </button>
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
                  className={`flex h-5 w-5 shrink-0 touch-none select-none items-center justify-center transition-colors disabled:opacity-40 ${
                    phase === 'recording'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <svg viewBox="0 0 14 14" fill="none" aria-hidden className="h-3 w-3 stroke-current stroke-[1.4]">
                    <rect x="5" y="1.5" width="4" height="6.5" rx="2" />
                    <path d="M3 6.5a4 4 0 0 0 8 0M7 10.5v2M5 12.5h4" />
                  </svg>
                </button>
              </div>
              <button
                type="button"
                id="central-expand-button"
                aria-label={expanded ? 'Collapse command line' : 'Expand command line and session conversation'}
                aria-expanded={expanded}
                title={expanded ? 'Collapse session conversation' : 'Expand session conversation'}
                onClick={() => setExpanded((prev) => !prev)}
                className="flex h-6 w-6 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
                  {expanded ? <path d="M2 6.5 5 3.5 8 6.5" /> : <path d="M2 3.5 5 6.5 8 3.5" />}
                </svg>
              </button>
            </div>
            {attachments.hasAny && <AttachmentChips attachments={attachments} />}
            {expanded && (
              <div
                id="agent-answer"
                data-session-convo
                className="flex max-h-60 flex-col border border-border bg-muted/20 text-xs"
              >
                <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
                  <span>Session conversation</span>
                  {hasConvo && (
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
                {hasConvo ? (
                  <Transcript
                    earlier={earlier}
                    onEarlier={more}
                    live={shown}
                    onStop={stop}
                    className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5"
                  />
                ) : (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    {latestStatus ?? 'No messages in this session yet.'}
                  </p>
                )}
              </div>
            )}
          </form>

          {/* 1/4 proportional LLM answer & system message space directly on the right of the expand caret */}
          <div data-answer-space className="flex h-6 w-1/4 min-w-0 shrink-0 items-center overflow-hidden px-1">
            {latestStatus && (
              <span
                id="agent-status"
                title={latestStatus}
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              >
                {latestStatus}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
