import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { usePublish } from '@jaspers-ai/sdk'
import { askedIn } from '../../shared/agent/asking'
import { withAttachments } from '../../shared/agent/attachments'
import { elementZoom } from '../../shared/grid/grid'
import { AttachButton, useAttachments, useFileDrop } from '../components/composer/Attachments'
import { useEarlier, useNoticeTimer } from '../components/composer/conversation'
import { OnboardingCard } from '../components/composer/OnboardingCard'
import { pasteLinks } from '../components/composer/paste'
import { QuestionField } from '../components/composer/QuestionField'
import { useRequest } from '../components/composer/request'
import { SecretField } from '../components/composer/SecretField'
import { completeSlash, slashMatches } from '../components/composer/slash'
import { SlashMenu } from '../components/composer/SlashMenu'
import { Transcript } from '../components/composer/Transcript'
import { currentWorkspace, useAppState } from '../lib/state'
import { dockedChatKeyAction, measureChatInput } from './chat-input'
import type { ViewProps } from './index'

/**
 * Docked Central room on the current tab (`core/chat`, titled "Central").
 * Shares the same Central store (`draft`, `voice`, `live`, `earlier`) with the top command line and
 * the floating Voice Orb, so typing or speaking in either replicates context in both, with an
 * auto-expanding multi-line prompt field and voice button along the bottom.
 */
export function Chat({ panel }: ViewProps): ReactElement {
  const workspaceId = panel.workspaceId
  const tabActive = useAppState((s) => currentWorkspace(s).id === workspaceId)
  const zoom = useAppState((s) => {
    const grids = s.grids[workspaceId]
    if (!grids) return 1
    for (const grid of Object.values(grids)) {
      const found = grid.panels.find((one) => one.id === panel.id)
      if (!found) continue
      const el = grid.elements.find((one) => one.id === found.elementId)
      if (el) return elementZoom(el)
    }
    return 1
  })
  const hasVoice = useAppState((s) => s.voice !== null)
  const secretRequest = useAppState((s) => askedIn(s.secretRequests))
  const question = useAppState((s) => askedIn(s.questions))
  const skills = useAppState((s) => s.skills)
  const disabledSkills = useAppState((s) => s.disabledSkills)
  const notices = useAppState((s) => s.notices)
  const request = useRequest()
  const {
    draft,
    setDraft,
    phase,
    busy,
    working,
    shown,
    earlier,
    effortOverride,
    cycleEffort,
    ask,
    reportResponse,
    toggleVoice,
    stop,
    clear,
  } = request
  const attachments = useAttachments((msg, fileName) => {
    reportResponse(`[Attached: ${fileName}]`, msg)
  })
  const drop = useFileDrop(attachments.attach)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosedOn, setMenuClosedOn] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const matches = useMemo(
    () => (busy ? [] : slashMatches(draft, { skills, disabledSkills })),
    [busy, draft, skills, disabledSkills],
  )
  const menuOpen = matches.length > 0 && menuClosedOn !== draft
  const active = Math.min(menuIndex, Math.max(0, matches.length - 1))
  const notice = notices.find((one) => one.chat !== workspaceId) ?? null
  const told = notices.find((one) => one.chat === workspaceId)?.id ?? null
  const welcome = useAppState((s) => (s.welcome?.workspaceId === workspaceId ? s.welcome.said : null))
  const onboarding = useAppState((s) => s.welcome?.onboarding ?? null)
  const anchorTop =
    onboarding !== null && onboarding.step === 0 && shown.length === 0 && earlier.every((one) => one.welcome === true)

  const more = useEarlier({ request, workspaceId, when: tabActive, said: told, welcome })
  useNoticeTimer(tabActive ? (notice?.id ?? null) : null)
  usePublish(panel, { exchanges: earlier.length, busy: working })

  const syncInputHeight = useCallback((): void => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.overflowY = 'hidden'
    const panelHeight = containerRef.current?.clientHeight ?? 0
    const sized = measureChatInput(el.scrollHeight, panelHeight, zoom)
    el.style.height = `${sized.height}px`
    el.style.overflowY = sized.overflowY
  }, [zoom])

  useLayoutEffect(() => {
    syncInputHeight()
  }, [draft, tabActive, secretRequest, question, attachments.files.length, working, syncInputHeight])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => syncInputHeight())
    observer.observe(container)
    return () => observer.disconnect()
  }, [syncInputHeight])

  function submit(event?: FormEvent<HTMLFormElement>): void {
    event?.preventDefault()
    const text = withAttachments(draft.trim(), attachments.files)
    if (!text || busy || attachments.reading > 0) return
    setDraft('')
    attachments.clear()
    void ask(text)
  }

  function pickSkill(skill: { id: string }): void {
    const next = completeSlash(skill)
    setDraft(next)
    setMenuIndex(0)
    const el = input.current
    if (el) {
      el.focus()
      requestAnimationFrame(() => {
        el.setSelectionRange(next.length, next.length)
      })
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    const skill = menuOpen ? (matches[active] ?? null) : null
    const action = dockedChatKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      draft,
      menuOpen,
      activeMatchId: skill?.id ?? null,
      matchCount: matches.length,
      activeIndex: active,
    })
    if (action.kind === 'move-menu') {
      event.preventDefault()
      setMenuIndex(action.nextIndex)
    } else if (action.kind === 'pick-skill' && skill) {
      event.preventDefault()
      pickSkill(skill)
    } else if (action.kind === 'close-menu') {
      event.preventDefault()
      event.stopPropagation()
      setMenuClosedOn(draft)
    } else if (action.kind === 'submit') {
      event.preventDefault()
      submit()
    }
  }

  useEffect(() => {
    if (!tabActive || secretRequest !== null || question !== null) return
    const el = input.current
    if (!el || document.activeElement === el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [tabActive, secretRequest, question])

  return (
    <div
      ref={containerRef}
      id={tabActive ? 'docked-chat' : undefined}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className="flex h-full flex-col"
    >
      <Transcript
        earlier={earlier}
        onEarlier={more}
        live={shown}
        onStop={stop}
        anchorTop={anchorTop}
        className="min-h-0 flex-1 px-4 py-2.5"
      >
        {onboarding !== null && <OnboardingCard onboarding={onboarding} />}
      </Transcript>
      {notice && (
        <div className="shrink-0 border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">{notice.plugin}</p>
          <p className="text-sm break-words">{notice.text}</p>
        </div>
      )}
      {secretRequest !== null ? (
        <SecretField
          key={`${secretRequest.plugin}/${secretRequest.key}`}
          request={secretRequest}
          idSuffix="docked"
          active={tabActive}
        />
      ) : question !== null ? (
        <QuestionField key={question.id} question={question} idSuffix="docked" shown={tabActive} active={tabActive} />
      ) : (
        <form onSubmit={submit} className="relative shrink-0 border-t border-border p-2">
          {tabActive && menuOpen && <SlashMenu skills={matches} active={active} onPick={pickSkill} />}
          <div
            data-docked-composer-box
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest('button, input')) return
              input.current?.focus()
            }}
            className="flex flex-col border border-border bg-background focus-within:border-foreground"
          >
            {(attachments.files.length > 0 || attachments.reading > 0) && (
              <div className="flex flex-wrap items-center gap-1 px-1.5 pt-1">
                {attachments.files.map((file) => (
                  <span
                    key={file.name}
                    data-attachment={file.name}
                    className="inline-flex h-4 max-w-40 shrink-0 items-center gap-1 border border-border bg-muted px-1 text-[10px] leading-none"
                  >
                    <span className="truncate">{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => attachments.remove(file.name)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {attachments.reading > 0 && <span className="text-[10px] text-muted-foreground">Reading file…</span>}
              </div>
            )}
            <div className="flex items-end gap-1 px-1 py-px">
              <AttachButton compact onFiles={attachments.attach} disabled={busy} />
              <textarea
                ref={input}
                id={tabActive ? 'docked-chat-input' : undefined}
                name="prompt"
                rows={1}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={draft}
                placeholder="command the terminal from here"
                aria-label="Command the terminal from here"
                role="combobox"
                aria-multiline="true"
                aria-expanded={tabActive && menuOpen}
                aria-controls={tabActive && menuOpen ? 'slash-menu' : undefined}
                aria-activedescendant={tabActive && menuOpen ? `slash-option-${active}` : undefined}
                aria-autocomplete="list"
                onKeyDown={onKeyDown}
                onPaste={(event) => pasteLinks(event, attachments.attach)}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setMenuIndex(0)
                }}
                className="block min-w-0 flex-1 resize-none bg-transparent px-1 py-[2px] text-xs leading-[1.3333] outline-none disabled:opacity-50"
              />
              {working && (
                <button
                  type="button"
                  aria-label="Stop"
                  title="Working — click to stop"
                  onClick={() => stop()}
                  className="progress-square my-[2px] flex h-4 w-4 shrink-0 items-center justify-center p-[2px]"
                >
                  <span aria-hidden className="relative z-10 h-2.5 w-2.5 bg-background" />
                </button>
              )}
              <button
                type="button"
                id={tabActive ? 'docked-chat-effort' : undefined}
                aria-label={`Thinking effort: ${effortOverride ?? 'auto'}`}
                title={`Thinking effort: ${effortOverride ?? 'auto'} — click to cycle (Auto → Low → Med → High), or prefix /deep or /fast`}
                onClick={cycleEffort}
                className={`my-[2px] flex h-4 shrink-0 items-center justify-center px-1 text-[10px] leading-none transition-colors ${
                  effortOverride
                    ? 'border border-foreground text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {effortOverride === 'high'
                  ? 'Deep'
                  : effortOverride === 'medium'
                    ? 'Med'
                    : effortOverride === 'low'
                      ? 'Low'
                      : 'Auto'}
              </button>
              <button
                type="button"
                id={tabActive ? 'docked-chat-voice' : undefined}
                aria-label={phase === 'recording' ? 'Stop listening' : 'Voice input'}
                title={
                  !hasVoice
                    ? 'Add a voice provider in Settings to talk'
                    : phase === 'recording'
                      ? 'Listening — press again to transcribe into command line'
                      : 'Press to talk (press Enter to send)'
                }
                disabled={!hasVoice || phase === 'transcribing'}
                onClick={() => toggleVoice('command')}
                className={`my-[2px] flex h-4 w-4 shrink-0 items-center justify-center transition-colors disabled:opacity-40 ${
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
        </form>
      )}
      {onboarding === null && (earlier.length > 0 || shown.length > 0) && (
        <p className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-1 text-xs text-muted-foreground">
          <button
            type="button"
            id={tabActive ? 'docked-chat-clear' : undefined}
            onClick={clear}
            className="underline hover:text-foreground"
          >
            Clear
          </button>
        </p>
      )}
    </div>
  )
}
