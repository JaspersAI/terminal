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
// Voice stays with the overlay. Holding the orb or the space bar is what starts a recording, and
// neither reads as a gesture inside an element whose command line has the keyboard.

export function Chat({ panel }: ViewProps): ReactElement {
  const workspaceId = panel.workspaceId
  const windowNumber = window.app.windowNumber
  // This chat's own element, so undocking removes the one the user is looking at.
  const elementId = useAppState(
    (s) => s.grids[workspaceId]?.[windowNumber]?.panels.find((p) => p.id === panel.id)?.elementId ?? null,
  )
  const secretRequest = useAppState((s) => askedIn(s.secretRequests))
  const question = useAppState((s) => askedIn(s.questions))
  const skills = useAppState((s) => s.skills)
  const disabledSkills = useAppState((s) => s.disabledSkills)
  const notices = useAppState((s) => s.notices)
  const request = useRequest()
  const { busy, working, shown, earlier, ask, stop } = request
  const [draft, setDraft] = useState('')
  const [menuIndex, setMenuIndex] = useState(0)
  // The draft the skills menu was closed on with Escape; typing opens it again.
  const [menuClosedOn, setMenuClosedOn] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const matches = useMemo(
    () => (busy ? [] : slashMatches(draft, { skills, disabledSkills })),
    [busy, draft, skills, disabledSkills],
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

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
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

  // The key field takes the keyboard while it is up; the command line waits its turn.
  useEffect(() => {
    if (secretRequest === null && question === null) input.current?.focus()
  }, [secretRequest, question])

  return (
    <div id="docked-chat" className="flex h-full flex-col">
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
          onPaste={pasteLinks}
          onChange={(event) => {
            setDraft(event.target.value)
            setMenuIndex(0)
          }}
          className="w-full border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground disabled:opacity-50"
        />
      </form>
      <p className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-1 text-xs text-muted-foreground">
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
