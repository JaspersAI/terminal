import {
  useEffect,
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
import { MAIN_WINDOW } from '../../shared/grid/windows'
import { AttachButton, AttachmentChips, useAttachments, useFileDrop } from '../components/composer/Attachments'
import { useEarlier, useNoticeTimer } from '../components/composer/conversation'
import { pasteLinks } from '../components/composer/paste'
import { QuestionField } from '../components/composer/QuestionField'
import { useRequest } from '../components/composer/request'
import { SecretField } from '../components/composer/SecretField'
import { completeSlash, slashMatches } from '../components/composer/slash'
import { SlashMenu } from '../components/composer/SlashMenu'
import { Transcript } from '../components/composer/Transcript'
import { send } from '../components/grid/send'
import { useAppState } from '../lib/state'
import type { ViewProps } from './index'

/**
 * Docked Central room on the current tab (`core/chat`, titled "Central").
 * Shares the same Central store (`draft`, `voice`, `live`, `earlier`) with the top command line and
 * the floating Voice Orb, so typing or speaking in either replicates context in both, and has its
 * own small voice button alongside the text input.
 */
export function Chat({ panel }: ViewProps): ReactElement {
  const workspaceId = panel.workspaceId
  const elementId = useAppState(
    (s) => s.grids[workspaceId]?.[MAIN_WINDOW]?.panels.find((p) => p.id === panel.id)?.elementId ?? null,
  )
  const hasVoice = useAppState((s) => s.voice !== null)
  const secretRequest = useAppState((s) => askedIn(s.secretRequests))
  const question = useAppState((s) => askedIn(s.questions))
  const skills = useAppState((s) => s.skills)
  const disabledSkills = useAppState((s) => s.disabledSkills)
  const notices = useAppState((s) => s.notices)
  const request = useRequest()
  const { draft, setDraft, phase, busy, working, shown, earlier, ask, toggleVoice, stop, clear } = request
  const attachments = useAttachments()
  const drop = useFileDrop(attachments.attach)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosedOn, setMenuClosedOn] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const matches = useMemo(
    () => (busy ? [] : slashMatches(draft, { skills, disabledSkills })),
    [busy, draft, skills, disabledSkills],
  )
  const menuOpen = matches.length > 0 && menuClosedOn !== draft
  const active = Math.min(menuIndex, Math.max(0, matches.length - 1))
  const notice = notices.find((one) => one.chat !== workspaceId) ?? null
  const told = notices.find((one) => one.chat === workspaceId)?.id ?? null
  const welcome = useAppState((s) => (s.welcome?.workspaceId === workspaceId ? s.welcome.said : null))

  const more = useEarlier({ request, workspaceId, when: true, said: told, welcome })
  useNoticeTimer(notice?.id ?? null)
  usePublish(panel, { exchanges: earlier.length, busy: working })

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = withAttachments(draft.trim(), attachments.files)
    if (!text || busy || attachments.reading > 0) return
    setDraft('')
    attachments.clear()
    void ask(text)
  }

  function pickSkill(skill: { id: string }): void {
    setDraft(completeSlash(skill))
    setMenuIndex(0)
    input.current?.focus()
  }

  function menuKey(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (!menuOpen) return
    const skill = matches[active]!
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : matches.length - 1
      setMenuIndex((active + step) % matches.length)
    } else if (event.key === 'Tab' || (event.key === 'Enter' && draft !== `/${skill.id}`)) {
      event.preventDefault()
      pickSkill(skill)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setMenuClosedOn(draft)
    }
  }

  useEffect(() => {
    if (secretRequest === null && question === null) input.current?.focus()
  }, [secretRequest, question])

  return (
    <div
      id="docked-chat"
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className="flex h-full flex-col"
    >
      <Transcript earlier={earlier} onEarlier={more} live={shown} onStop={stop} className="min-h-0 flex-1 px-3 py-3" />
      {notice && (
        <div className="shrink-0 border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">{notice.plugin}</p>
          <p className="text-sm break-words">{notice.text}</p>
        </div>
      )}
      {secretRequest !== null ? (
        <SecretField key={`${secretRequest.plugin}/${secretRequest.key}`} request={secretRequest} />
      ) : (
        question !== null && <QuestionField key={question.id} question={question} />
      )}
      <form onSubmit={submit} className="relative shrink-0 border-t border-border p-2">
        {menuOpen && <SlashMenu skills={matches} active={active} onPick={pickSkill} />}
        {attachments.hasAny && <AttachmentChips attachments={attachments} className="mb-1.5" />}
        <div className="flex items-center gap-1.5">
          <AttachButton onFiles={attachments.attach} disabled={busy} />
          <input
            ref={input}
            name="prompt"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={draft}
            placeholder="command the terminal from here"
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? 'slash-menu' : undefined}
            aria-activedescendant={menuOpen ? `slash-option-${active}` : undefined}
            aria-autocomplete="list"
            onKeyDown={menuKey}
            onPaste={(event) => pasteLinks(event, attachments.attach)}
            onChange={(event) => {
              setDraft(event.target.value)
              setMenuIndex(0)
            }}
            className="min-w-0 flex-1 border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground disabled:opacity-50"
          />
          <button
            type="button"
            id="docked-chat-voice"
            aria-label={phase === 'recording' ? 'Stop voice recording' : 'Voice input'}
            title={
              !hasVoice
                ? 'Add a voice provider in Settings to talk'
                : phase === 'recording'
                  ? 'Listening — click to send'
                  : 'Voice input'
            }
            disabled={!hasVoice || phase === 'transcribing' || phase === 'opening'}
            onClick={() => toggleVoice()}
            className={`flex h-7 w-7 shrink-0 items-center justify-center border border-border transition-colors disabled:opacity-40 ${
              phase === 'recording'
                ? 'bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <svg viewBox="0 0 14 14" fill="none" aria-hidden className="h-3.5 w-3.5 stroke-current stroke-[1.4]">
              <rect x="5" y="1.5" width="4" height="6.5" rx="2" />
              <path d="M3 6.5a4 4 0 0 0 8 0M7 10.5v2M5 12.5h4" />
            </svg>
          </button>
        </div>
      </form>
      <p className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-1 text-xs text-muted-foreground">
        {(earlier.length > 0 || shown.length > 0) && (
          <button type="button" id="docked-chat-clear" onClick={clear} className="underline hover:text-foreground">
            Clear
          </button>
        )}
        <button
          type="button"
          id="docked-chat-undock"
          disabled={elementId === null}
          onClick={() => elementId !== null && send({ type: 'element.remove', workspaceId, elementId })}
          className="underline hover:text-foreground disabled:opacity-50"
        >
          Undock
        </button>
      </p>
    </div>
  )
}
