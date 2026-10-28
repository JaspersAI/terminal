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
import { AttachButton, AttachmentChips, useAttachments, useFileDrop } from '../components/composer/Attachments'
import { useEarlier, useNoticeTimer } from '../components/composer/conversation'
import { useComposerMode } from '../components/composer/dock'
import { Orb } from '../components/composer/Orb'
import { pasteLinks } from '../components/composer/paste'
import { statusText } from '../components/composer/phase'
import { QuestionField } from '../components/composer/QuestionField'
import { useHoldSpace, useRequest } from '../components/composer/request'
import { SecretField } from '../components/composer/SecretField'
import { completeSlash, slashMatches } from '../components/composer/slash'
import { SlashMenu } from '../components/composer/SlashMenu'
import { Transcript } from '../components/composer/Transcript'
import { send } from '../components/grid/send'
import { useAppState } from '../lib/state'
import type { ViewProps } from './index'

// The chat on the grid: the same conversation the composer floating at the bottom of the window
// holds, in an element that stays where it is put and moves and resizes with the grid's own drag.
// One window shows one or the other, never both (`Home` reads `chatElement`), so docking is a swap
// and not a second chat; undocking removes this element and the overlay comes back.
//
// It is a built-in view, so it runs in the renderer and reads the tree with `useAppState`, and it
// asks main for a run the way the composer does, through `useRequest`. The key field and the
// assistant's questions appear here too, above the command line: with the overlay away this is the
// only place they could, and a run waiting on one would otherwise wait on nothing.
//
// Voice and text modes (`useComposerMode`) work here just as in the floating overlay: holding the
// orb or the space bar in orb mode records and transcribes, and the status bar at the bottom
// switches between `Talk instead` and `Type instead` alongside `Undock`.

export function Chat({ panel }: ViewProps): ReactElement {
  const workspaceId = panel.workspaceId
  const windowNumber = window.app.windowNumber
  // This chat's own element, so undocking removes the one the user is looking at.
  const elementId = useAppState(
    (s) => s.grids[workspaceId]?.[windowNumber]?.panels.find((p) => p.id === panel.id)?.elementId ?? null,
  )
  const hasVoice = useAppState((s) => s.voice !== null)
  const secretRequest = useAppState((s) => askedIn(s.secretRequests))
  const question = useAppState((s) => askedIn(s.questions))
  const skills = useAppState((s) => s.skills)
  const disabledSkills = useAppState((s) => s.disabledSkills)
  const notices = useAppState((s) => s.notices)
  const [mode, setMode] = useComposerMode()
  const request = useRequest()
  const { phase, error, busy, working, shown, earlier, ask, release, stop } = request
  const [draft, setDraft] = useState('')
  const attachments = useAttachments()
  const drop = useFileDrop((files) => {
    setMode('text')
    attachments.attach(files)
  })
  const [menuIndex, setMenuIndex] = useState(0)
  // The draft the skills menu was closed on with Escape; typing opens it again.
  const [menuClosedOn, setMenuClosedOn] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const matches = useMemo(
    () => (mode === 'text' && !busy ? slashMatches(draft, { skills, disabledSkills }) : []),
    [mode, busy, draft, skills, disabledSkills],
  )
  const menuOpen = matches.length > 0 && menuClosedOn !== draft
  const active = Math.min(menuIndex, Math.max(0, matches.length - 1))
  // A task's reply on this workspace is in the thread, so it arrives as history rather than as a line.
  const notice = notices.find((one) => one.chat !== workspaceId) ?? null
  const told = notices.find((one) => one.chat === workspaceId)?.id ?? null
  // The welcome after setup, while it is being said here: each message lands as history.
  const welcome = useAppState((s) => (s.welcome?.workspaceId === workspaceId ? s.welcome.said : null))

  // The conversation so far. The chat is always up, so it reads it whenever nothing is in flight; the
  // rest of it is a page further up each time the reader nears the top.
  const more = useEarlier({ request, workspaceId, when: true, said: told, welcome })
  // Nothing here fades a notice, so its wait runs and main drops it, as it does over the composer.
  useNoticeTimer(notice?.id ?? null)
  usePublish(panel, { exchanges: earlier.length, busy: working })

  useEffect(() => {
    if (welcome !== null) setMode('text')
  }, [welcome, setMode])

  function press(): void {
    if (busy) return
    if (!hasVoice) {
      setMode('text')
      return
    }
    request.press()
  }

  useHoldSpace(mode === 'orb' && secretRequest === null && question === null, press, release)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (busy || attachments.reading > 0) return
    const text = withAttachments(draft, attachments.files)
    if (!text) return
    setDraft('')
    attachments.clear()
    void ask(text)
  }

  function pickSkill(skill: { id: string }): void {
    setDraft(completeSlash(skill))
    setMenuIndex(0)
    input.current?.focus()
  }

  /** The skills menu's keys, heard on the field before the form or the window hear them. */
  function menuKey(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (!menuOpen) return
    const skill = matches[active]!
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : matches.length - 1
      setMenuIndex((active + step) % matches.length)
    } else if (event.key === 'Tab' || (event.key === 'Enter' && draft !== `/${skill.id}`)) {
      // Enter on a finished /name sends it; anything short of that picks.
      event.preventDefault()
      pickSkill(skill)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setMenuClosedOn(draft)
    }
  }

  // The key field takes the keyboard while it is up; in text mode the command line waits its turn.
  useEffect(() => {
    if (mode === 'text' && secretRequest === null && question === null) input.current?.focus()
  }, [mode, secretRequest, question])

  const status = statusText({ mode, hasVoice, phase, error })

  return (
    <div
      id="docked-chat"
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      className={`flex h-full flex-col ${drop.dropping ? 'outline-2 -outline-offset-2 outline-foreground outline-dashed' : ''}`}
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
      {mode === 'orb' ? (
        <div className="flex shrink-0 justify-center border-t border-border py-3">
          <Orb phase={phase} label={hasVoice ? 'Hold to talk' : 'Type a request'} onPress={press} onRelease={release} />
        </div>
      ) : (
        <form onSubmit={submit} className="relative shrink-0 border-t border-border p-2">
          {menuOpen && <SlashMenu skills={matches} active={active} onPick={pickSkill} />}
          <AttachmentChips attachments={attachments} className="mb-1.5" />
          <div className="flex items-center border border-border bg-background pr-1 focus-within:border-foreground">
            <AttachButton disabled={busy} onFiles={attachments.attach} />
            <input
              ref={input}
              name="prompt"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              value={draft}
              placeholder="Ask anything, or / for a skill"
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
              className="min-w-0 flex-1 bg-transparent py-1.5 pr-2 pl-1 text-sm outline-none disabled:opacity-50"
            />
            {attachments.files.length > 0 && (
              <button
                type="submit"
                aria-label="Send"
                disabled={busy || attachments.reading > 0}
                className="flex h-6 w-6 shrink-0 items-center justify-center bg-primary text-primary-foreground disabled:opacity-30"
              >
                <svg viewBox="0 0 10 10" fill="none" aria-hidden className="h-2.5 w-2.5 stroke-current stroke-[1.5]">
                  <path d="M5 9V1.5M1.5 5 5 1.5 8.5 5" />
                </svg>
              </button>
            )}
          </div>
        </form>
      )}
      <p
        id="agent-status"
        className={`flex shrink-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 border-t border-border px-3 py-1 text-xs ${
          error ? 'text-destructive' : 'text-muted-foreground'
        }`}
      >
        {status && (
          <>
            <span>{status}</span>
            <span className="text-muted-foreground">·</span>
          </>
        )}
        {!hasVoice ? (
          <span className="text-muted-foreground">Add a voice provider to talk</span>
        ) : mode === 'orb' ? (
          <button
            type="button"
            disabled={busy}
            onClick={(event) => {
              event.currentTarget.blur()
              setMode('text')
            }}
            className="text-muted-foreground underline hover:text-foreground disabled:opacity-50"
          >
            Type instead
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={(event) => {
              event.currentTarget.blur()
              setMode('orb')
            }}
            className="text-muted-foreground underline hover:text-foreground disabled:opacity-50"
          >
            Talk instead
          </button>
        )}
        <span className="text-muted-foreground">·</span>
        <button
          type="button"
          id="docked-chat-undock"
          disabled={elementId === null || busy}
          onClick={() => elementId !== null && send({ type: 'element.remove', workspaceId, elementId })}
          className="text-muted-foreground underline hover:text-foreground disabled:opacity-50"
        >
          Undock
        </button>
      </p>
    </div>
  )
}
