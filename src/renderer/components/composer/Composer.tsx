import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { askedIn } from '../../../shared/agent/asking'
import { CENTRAL_CHAT } from '../../../shared/agent/history'
import { currentWorkspace, useAppState } from '../../lib/state'
import { useEarlier, useNoticeTimer } from './conversation'
import { PHASE_TEXT } from './phase'
import { QuestionField } from './QuestionField'
import { firstLineOf, useRequest } from './request'
import { SecretField } from './SecretField'

/**
 * Central's top command line:
 * - Takes the full 4/4 width of the composer area (no 1/4 right-hand answer column, no "+" attach button,
 *   and never renders anything above or below the command line).
 * - Collapsed (1-line, exact 24px / h-6 height): shows "command the terminal from here" when idle,
 *   shows the user's query while typing or speaking via Orb, and after a query is processed displays the
 *   first line of Central's response in an alternating italic/muted font appearance that clears as soon
 *   as the user clicks or types.
 * - Expanded (5-line mode, 4/4 width with up-down scrollbar): shows the last 5 lines of interaction
 *   (both user queries and LLM responses in distinct font styles) with vertical scroll through the session.
 * - Inside on the right: clockwise-gradient progress/stop square while working, plus the voice button
 *   (press once to listen, press again to populate the command line, press Enter to send).
 * - Directly to the right of the command line: a borderless expand caret (h-6) aligned to the command line.
 */
export function Composer(): ReactElement {
  const workspaceId = useAppState((s) => currentWorkspace(s).id)
  const hasVoice = useAppState((s) => s.voice !== null)
  const secretRequest = useAppState((s) => askedIn(s.secretRequests))
  const question = useAppState((s) => askedIn(s.questions))
  const notices = useAppState((s) => s.notices)
  const welcome = useAppState((s) => (s.welcome?.workspaceId === workspaceId ? s.welcome.said : null))
  const [expanded, setExpanded] = useState(false)
  const [focused, setFocused] = useState(false)
  const request = useRequest()
  const {
    draft,
    setDraft,
    responsePreview,
    clearResponsePreview,
    phase,
    error,
    busy,
    working,
    shown,
    earlier,
    ask,
    toggleVoice,
    stop,
  } = request
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  const notice = notices.find((one) => one.chat !== CENTRAL_CHAT && one.chat !== workspaceId) ?? null
  const told = notices.find((one) => one.chat === CENTRAL_CHAT || one.chat === workspaceId)?.id ?? null
  const more = useEarlier({ request, workspaceId, when: true, said: told, welcome })
  useNoticeTimer(notice?.id ?? null)

  const latestLive = shown[shown.length - 1]
  const voiceStatus = phase !== 'idle' && phase !== 'thinking' ? PHASE_TEXT[phase] : null
  const liveStep = latestLive?.working
    ? (latestLive.steps[latestLive.steps.length - 1] ?? (latestLive.answer ? firstLineOf(latestLive.answer) : null))
    : null

  // In 1-line collapsed mode, when the user is not typing (`draft === ''`) and the input is not focused,
  // display the first line of the processed response (or active status/notice) in alternating response style.
  const previewText =
    draft === '' && !focused
      ? (voiceStatus ??
        liveStep ??
        responsePreview ??
        (error ? firstLineOf(error) : null) ??
        (notice?.text ? firstLineOf(notice.text) : null))
      : null
  const showingPreview = previewText !== null && draft === ''

  // Keep the 5-line expanded interaction scroller anchored to the latest 5 lines when expanded or updated.
  useLayoutEffect(() => {
    if (!expanded) return
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [expanded, earlier.length, shown.length, latestLive?.answer, latestLive?.steps.length])

  // Load older session exchanges when scrolling near the top of the 5-line view.
  useEffect(() => {
    if (!expanded) return
    const el = scrollerRef.current
    if (!el) return
    const onScroll = (): void => {
      if (el.scrollTop < 32) more()
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [expanded, more])

  function submit(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    void ask(text)
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
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

  const interactions = [
    ...earlier.map((ex, i) => ({
      key: `e-${ex.id ?? i}`,
      question: ex.welcome ? '' : ex.question,
      answer: ex.answer || ex.error || '',
      working: false,
    })),
    ...shown.map((ex) => ({
      key: `l-${ex.ask}`,
      question: ex.question,
      answer: ex.answer || ex.error || (ex.working ? (ex.steps[ex.steps.length - 1] ?? 'Working…') : ''),
      working: ex.working,
    })),
  ]

  return (
    <div id="composer" className="flex min-w-0 flex-1 items-start">
      {secretRequest !== null ? (
        <div className="w-full">
          <SecretField key={`${secretRequest.plugin}/${secretRequest.key}`} request={secretRequest} />
        </div>
      ) : question !== null ? (
        <div className="w-full">
          <QuestionField key={question.id} question={question} />
        </div>
      ) : (
        <form onSubmit={submit} data-command-line-column className="flex w-full min-w-0 flex-1 items-start gap-1">
          <div
            data-command-line-box
            onClick={() => {
              if (showingPreview) clearResponsePreview()
              inputRef.current?.focus()
            }}
            className={`flex min-w-0 flex-1 border border-border bg-background px-2 focus-within:border-foreground ${
              expanded ? 'h-20 flex-col py-1' : 'h-6 items-center gap-1.5'
            }`}
          >
            {expanded ? (
              <div
                ref={scrollerRef}
                id="agent-answer"
                data-session-convo
                className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-1 text-xs leading-4"
              >
                {interactions.map((item) => (
                  <div key={item.key} className="flex flex-col gap-0.5">
                    {item.question && (
                      <p className="font-medium text-foreground whitespace-pre-wrap break-words">
                        &gt; {item.question}
                      </p>
                    )}
                    {item.answer && (
                      <p data-response-line className="italic text-muted-foreground whitespace-pre-wrap break-words">
                        {item.answer}
                      </p>
                    )}
                  </div>
                ))}
                <div className="mt-auto flex h-4 shrink-0 items-center gap-1.5">
                  <input
                    ref={inputRef}
                    id="central-command-input"
                    name="prompt"
                    disabled={busy}
                    value={draft}
                    placeholder="command the terminal from here"
                    aria-label="Command the terminal from here"
                    autoComplete="off"
                    spellCheck={false}
                    onFocus={() => {
                      setFocused(true)
                      clearResponsePreview()
                    }}
                    onBlur={() => setFocused(false)}
                    onKeyDown={onKeyDown}
                    onChange={(event) => setDraft(event.target.value)}
                    className="h-4 min-w-0 flex-1 bg-transparent text-xs leading-4 text-foreground outline-none disabled:opacity-50"
                  />
                  {working && (
                    <button
                      type="button"
                      id="composer-stop"
                      aria-label="Stop"
                      title="Working — click to stop"
                      onClick={(event) => {
                        event.stopPropagation()
                        stop()
                      }}
                      className="progress-square flex h-4 w-4 shrink-0 items-center justify-center p-[2px]"
                    >
                      <span aria-hidden className="relative z-10 h-2.5 w-2.5 bg-background" />
                    </button>
                  )}
                  <button
                    type="button"
                    id="central-voice-button"
                    aria-label={phase === 'recording' ? 'Stop listening' : 'Voice input'}
                    title={
                      !hasVoice
                        ? 'Add a voice provider in Settings to talk'
                        : phase === 'recording'
                          ? 'Listening — press again to transcribe into command line'
                          : 'Press to talk (press Enter to send)'
                    }
                    disabled={!hasVoice || phase === 'transcribing'}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleVoice('command')
                    }}
                    className={`flex h-4 w-4 shrink-0 items-center justify-center transition-colors disabled:opacity-40 ${
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
              </div>
            ) : (
              <>
                <input
                  ref={inputRef}
                  id="central-command-input"
                  name="prompt"
                  disabled={busy}
                  value={showingPreview ? previewText : draft}
                  placeholder="command the terminal from here"
                  aria-label="Command the terminal from here"
                  autoComplete="off"
                  spellCheck={false}
                  onFocus={() => {
                    setFocused(true)
                    if (showingPreview) clearResponsePreview()
                  }}
                  onBlur={() => setFocused(false)}
                  onKeyDown={onKeyDown}
                  onChange={(event) => {
                    if (showingPreview) {
                      clearResponsePreview()
                      const typed = event.target.value.startsWith(previewText ?? '')
                        ? event.target.value.slice((previewText ?? '').length)
                        : event.target.value
                      setDraft(typed)
                    } else {
                      setDraft(event.target.value)
                    }
                  }}
                  className={`h-full min-w-0 flex-1 truncate bg-transparent text-xs leading-none outline-none disabled:opacity-50 ${
                    showingPreview ? 'italic text-muted-foreground' : 'font-normal text-foreground'
                  }`}
                />
                {working && (
                  <button
                    type="button"
                    id="composer-stop"
                    aria-label="Stop"
                    title="Working — click to stop"
                    onClick={(event) => {
                      event.stopPropagation()
                      stop()
                    }}
                    className="progress-square flex h-4 w-4 shrink-0 items-center justify-center p-[2px]"
                  >
                    <span aria-hidden className="relative z-10 h-2.5 w-2.5 bg-background" />
                  </button>
                )}
                <button
                  type="button"
                  id="central-voice-button"
                  aria-label={phase === 'recording' ? 'Stop listening' : 'Voice input'}
                  title={
                    !hasVoice
                      ? 'Add a voice provider in Settings to talk'
                      : phase === 'recording'
                        ? 'Listening — press again to transcribe into command line'
                        : 'Press to talk (press Enter to send)'
                  }
                  disabled={!hasVoice || phase === 'transcribing'}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleVoice('command')
                  }}
                  className={`flex h-4 w-4 shrink-0 items-center justify-center transition-colors disabled:opacity-40 ${
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
              </>
            )}
          </div>
          <button
            type="button"
            id="central-expand-button"
            aria-label={expanded ? 'Collapse command line' : 'Expand command line to 5 lines'}
            aria-expanded={expanded}
            title={expanded ? 'Collapse to 1 line' : 'Expand to 5 lines'}
            onClick={() => setExpanded((prev) => !prev)}
            className="flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          >
            <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
              {expanded ? <path d="M2 6.5 5 3.5 8 6.5" /> : <path d="M2 3.5 5 6.5 8 3.5" />}
            </svg>
          </button>
        </form>
      )}
    </div>
  )
}
