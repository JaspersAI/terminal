import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { askedIn } from '../../../shared/agent/asking'
import { MAIN_WINDOW } from '../../../shared/grid/windows'
import { errorMessage } from '../../lib/errors'
import { useAppState } from '../../lib/state'
import { Answer } from './Answer'
import { dockChat } from './dock'
import { hears } from './hears'
import { Orb } from './Orb'
import { Peek } from './Peek'
import { PHASE_TEXT } from './phase'
import { useRequest } from './request'
import { useConversation } from './conversation'
import { useReveal } from './reveal'
import { QuestionField } from './QuestionField'
import { SecretField } from './SecretField'
import { completeSlash, slashMatches } from './slash'
import { SlashMenu } from './SlashMenu'
import { Spring } from './spring'

/** The orb, whether or not there is a voice provider to hold it for, or the text field. */
type Mode = 'orb' | 'text'

/** How far below its resting place the panel parks once it has dropped out of frame, in px. */
const CLEARANCE = 56
/** How much the panel shrinks on the way down, and how small the arrow starts before it grows. */
const SQUASH = 0.62
const ARROW_MIN = 0.45
/**
 * How far the answer slides as the panel drops: from just above the orb (`bottom-39`, 156 px, in
 * Answer and SecretField) to 28 px off the bottom edge, just above the arrow.
 */
const ANSWER_DROP = 128
/** Underdamped, so the panel overshoots its resting place on the way up and settles into it. */
const TUNING = {
  x: { stiffness: 160, damping: 15 },
  y: { stiffness: 160, damping: 15 },
  scale: { stiffness: 160, damping: 15 },
}

/**
 * The orb floating at the bottom of the home screen, over the workspace. Hold it or the space bar to
 * talk, release to send. One line under it carries the hint, the current step, or the last error,
 * plus a link that swaps to a text field. Without a voice provider the orb is still there, and a
 * click on it or the space bar swaps it for the field. Either way the words go to the orchestrator
 * in main and into the box above as a bubble, and its answer lands under them there (`Answer`). A
 * request starts as it is sent, so the field and the orb stay free while one works, and the next
 * joins it in the box.
 *
 * It does not sit there taking up the workspace. A few seconds after launch it drops out of frame
 * and leaves a small arrow on the bottom edge (`Peek`); bringing the pointer down to it, tabbing to
 * it, or starting a recording with the space bar brings it back, and it tucks away again once
 * nothing needs it.
 *
 * Dock puts the same conversation on the grid instead, as a `core/chat` element that stays where it
 * is put (`dock.ts`, `views/Chat`); `Home` then leaves this overlay out of the window, and the
 * element's Undock brings it back. Voice belongs to this overlay: holding the orb or the space bar is
 * what starts a recording, and neither is a gesture a docked element can own.
 */
export function Composer(): ReactElement {
  const hasVoice = useAppState((s) => s.voice !== null)
  // A key being asked for takes the answer's place and holds the composer up until it is answered.
  const secretRequest = useAppState((s) => askedIn(s.secretRequests))
  // The assistant waiting to be told something, in the place a key is asked for.
  const question = useAppState((s) => askedIn(s.questions))
  const [mode, setMode] = useState<Mode>('orb')
  // Why the last dock did not happen, shown on the status line in place of the hint.
  const [dockProblem, setDockProblem] = useState<string | null>(null)
  const request = useRequest()
  const { phase, error, busy, working, shown, away, earlier, ask, release, stop } = request
  // A request on screen still working. One whose box was dismissed from over it works on out of
  // sight and is not counted: it lets the composer go, and is in the conversation when that comes up.
  const watching = shown.some((one) => one.working)
  const [draft, setDraft] = useState('')
  const skills = useAppState((s) => s.skills)
  const disabledSkills = useAppState((s) => s.disabledSkills)
  const [menuIndex, setMenuIndex] = useState(0)
  // The draft the skills menu was closed on with Escape; typing opens it again.
  const [menuClosedOn, setMenuClosedOn] = useState<string | null>(null)
  const workspaceId = useAppState((s) => s.currentWorkspaceId)
  // The welcome after setup, while it is being said in this workspace's chat: how many of its messages
  // are there so far. It holds the composer up with the field showing, so the user sees where to answer.
  const welcome = useAppState((s) => (s.welcome?.workspaceId === workspaceId ? s.welcome.said : null))
  const welcoming = welcome !== null
  const notices = useAppState((s) => s.notices)
  const notice = notices[0] ?? null
  // Every push brings new objects, so effects follow the notice by its id, not by the object.
  const noticeId = notice?.id ?? null
  const input = useRef<HTMLInputElement>(null)
  const shell = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const arrow = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [nearby, setNearby] = useState(false)
  const [peekFocused, setPeekFocused] = useState(false)
  // A draft that is one /word lists the skills it could mean, over the field.
  const matches = useMemo(
    () => (mode === 'text' && !busy ? slashMatches(draft, { skills, disabledSkills }) : []),
    [mode, busy, draft, skills, disabledSkills],
  )
  const menuOpen = matches.length > 0 && menuClosedOn !== draft
  const active = Math.min(menuIndex, Math.max(0, matches.length - 1))
  const showNotice = notice !== null && shown.length === 0 && !busy && !working && secretRequest === null
  // A task's reply on the workspace on screen is in its chat, and shows there rather than as a line.
  const noticeInChat = notice?.chat === workspaceId
  // What holds the composer up: a pointer on it, a run on screen, a line already started.
  const { open, poke } = useReveal(
    busy ||
      watching ||
      nearby ||
      peekFocused ||
      draft !== '' ||
      secretRequest !== null ||
      question !== null ||
      welcoming,
  )
  const { browsing, conversation, historyClosed, fading, noticeFading, close, closeHistory, closeNotice, more } =
    useConversation({
      open,
      request,
      workspaceId,
      showNotice,
      noticeId,
      noticeInChat,
      blocked: secretRequest !== null || question !== null,
      welcome,
    })

  // The welcome is spoken to a field, not an orb: the words are read, and the answer is typed under them.
  useEffect(() => {
    if (welcoming) setMode('text')
  }, [welcoming])

  function press(): void {
    if (busy) return
    if (!hasVoice) {
      setMode('text')
      poke()
      return
    }
    request.press()
  }

  /** Docks the chat: the element takes this overlay's place in the window, and the grid keeps it there. */
  function dock(): void {
    setDockProblem(null)
    dockChat(workspaceId, MAIN_WINDOW).catch((err: unknown) => {
      console.error('[composer] dock', errorMessage(err))
      setDockProblem('No room to dock the chat: make space on the grid first.')
    })
  }

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

  // Space bar is the keyboard version of the orb. Handlers live in a ref so the listeners,
  // registered once per mode, always call the current render's closures.
  const handlers = useRef({ press, release })
  handlers.current = { press, release }
  useEffect(() => {
    if (mode !== 'orb') return
    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || inControl(event) || modalOpen()) return
      event.preventDefault()
      handlers.current.press()
    }
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      if (!inControl(event)) event.preventDefault()
      handlers.current.release() // no-op unless a press started the recording
    }
    const blur = (): void => handlers.current.release()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [mode])

  // Whether the pointer is on the composer, measured from its box on every move rather than from
  // enter and leave on the panel. The panel moves, and a box sliding past a pointer that is holding
  // still fires enter and leave in an order that flaps the reveal on and off; positions cannot.
  useEffect(() => {
    const move = (event: PointerEvent): void => {
      setNearby(
        !modalOpen() && (within(box.current, event) || within(shell.current, event) || within(panel.current, event)),
      )
    }
    const away = (): void => setNearby(false)
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('blur', away)
    document.addEventListener('pointerleave', away)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('blur', away)
      document.removeEventListener('pointerleave', away)
    }
  }, [])

  // One spring carries the whole minimize, on `y` alone: 0 is up in place, 1 is parked below the
  // frame. Everything else reads off it, so the panel sinking and squashing and the arrow swelling
  // are one movement rather than three. Written straight to the DOM, like the orb's motion.
  const springRef = useRef<Spring | null>(null)
  const spring = (springRef.current ??= new Spring((v) => {
    const p = clamp(v.y)
    if (panel.current) {
      const travel = panel.current.offsetHeight + CLEARANCE
      panel.current.style.translate = `0 ${(v.y * travel).toFixed(2)}px`
      panel.current.style.scale = (1 - SQUASH * p).toFixed(4)
      panel.current.style.opacity = clamp(1 - p * 1.4).toFixed(3)
    }
    if (box.current) box.current.style.translate = `0 ${(v.y * ANSWER_DROP).toFixed(2)}px`
    if (arrow.current) {
      arrow.current.style.scale = (ARROW_MIN + (1 - ARROW_MIN) * p).toFixed(4)
      arrow.current.style.opacity = clamp((p - 0.35) / 0.5).toFixed(3)
    }
  }, TUNING))
  // Also paints the starting pose: the target already matches, so the loop applies once and stops.
  useEffect(() => spring.set({ y: open ? 0 : 1 }), [spring, open])
  useEffect(() => () => spring.stop(), [spring])
  // A box that comes up while the spring is at rest has not been through it: the reply of a run that
  // worked out of sight, landing with the composer away. It is posed like the rest, above the arrow,
  // rather than left over a panel that is not there. Once and stop, as above, before it is painted.
  const posed = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (box.current === posed.current) return
    posed.current = box.current
    if (box.current) spring.set({})
  })

  // Escape is the keyboard version of the cross, except where something else on screen already
  // owns the key: the workspace title reverts a rename with it, the switcher menu closes with it.
  useEffect(() => {
    if (shown.length === 0 && !showNotice && !browsing && !(working && open)) return
    const down = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.target instanceof HTMLElement && event.target.closest('#workspace-title')) return
      // Pressed in a tile's box, it is that tile's: it stops or closes nothing here.
      if (!hears(undefined, event.target)) return
      if (document.querySelector('[role=menu]')) return
      // A run in flight is what Escape means first: stopping it leaves the question on screen,
      // where dismissing would take it away while the model was still working. With several in
      // flight it stops the one sent last, and each has a Stop of its own beside its trail. One
      // working out of sight with the composer away is not there to stop: nothing on screen says
      // it is running, and the key is then pressed for something else.
      if (working && open) return stop()
      if (shown.length > 0) close()
      else if (browsing) closeHistory()
      else closeNotice()
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [shown.length, showNotice, noticeInChat, browsing, open, noticeId, working])

  // In text mode the field is the whole control, so it takes focus with the reveal and loses it
  // when the composer leaves. An unfinished line holds the composer up, so nothing typed is lost.
  useEffect(() => {
    if (mode !== 'text') return
    // The key field has the keyboard while it is up; the prompt waits its turn.
    if (open && secretRequest === null && question === null) input.current?.focus()
    else if (!open) input.current?.blur()
  }, [mode, open, secretRequest, question])

  const hint =
    mode === 'orb' ? (hasVoice ? 'Hold the orb or the space bar' : 'Click the orb or press space to type') : ''
  // An error lands under its question when there is one; one from before a question (the microphone,
  // a recording too short) has only this line. A run's steps are in the chat, so thinking says nothing
  // here, unless its box was dismissed from over it and the conversation is not up to show it: the
  // run goes on with nothing on screen saying so, so this line is then all there is to say it, and it
  // carries Stop.
  const shownError = shown.length === 0 ? error : null
  const unseen = working && !watching && !browsing
  const status =
    shownError ?? dockProblem ?? (phase === 'idle' ? hint : phase === 'thinking' && !unseen ? '' : PHASE_TEXT[phase])

  return (
    <div
      id="composer"
      ref={shell}
      // Half the label gutter to the right: the cells start after it, so centering on the window
      // would leave the orb and the arrow under it off-center against the columns they sit over.
      className="pointer-events-none fixed inset-x-0 bottom-0 mx-auto h-44 w-112 max-w-full translate-x-2"
    >
      <div
        ref={panel}
        inert={!open}
        className={`absolute inset-x-0 bottom-12 flex origin-bottom flex-col items-center gap-4 px-4 ${
          open ? 'pointer-events-auto' : ''
        } ${menuOpen ? 'z-10' : ''}`}
      >
        {mode === 'orb' ? (
          <Orb phase={phase} label={hasVoice ? 'Hold to talk' : 'Type a request'} onPress={press} onRelease={release} />
        ) : (
          <form onSubmit={submit} className="relative w-80 max-w-full">
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
              onChange={(event) => {
                setDraft(event.target.value)
                setMenuIndex(0)
              }}
              className="w-full border border-border bg-background px-3 py-2 text-sm shadow-lg disabled:opacity-50"
            />
          </form>
        )}

        <p
          id="agent-status"
          className={`text-center text-xs ${shownError || dockProblem ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {status}
          {status && <span className="text-muted-foreground"> · </span>}
          {!hasVoice ? (
            <span className="text-muted-foreground">Add a voice provider to talk</span>
          ) : mode === 'orb' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode('text')}
              className="text-muted-foreground underline hover:text-foreground"
            >
              Type instead
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode('orb')}
              className="text-muted-foreground underline hover:text-foreground"
            >
              Talk instead
            </button>
          )}
          {phase !== 'thinking' ? (
            <>
              <span className="text-muted-foreground"> · </span>
              <button
                type="button"
                id="composer-dock"
                disabled={busy}
                onClick={dock}
                className="text-muted-foreground underline hover:text-foreground"
              >
                Dock
              </button>
            </>
          ) : (
            unseen && (
              <>
                <span className="text-muted-foreground"> · </span>
                <button
                  type="button"
                  id="composer-stop"
                  onClick={() => stop()}
                  className="text-muted-foreground underline hover:text-foreground"
                >
                  Stop
                </button>
              </>
            )
          )}
        </p>
      </div>

      {secretRequest !== null ? (
        <SecretField key={`${secretRequest.plugin}/${secretRequest.key}`} request={secretRequest} box={box} />
      ) : question !== null ? (
        <QuestionField key={question.id} question={question} box={box} />
      ) : shown.length > 0 ? (
        // Unkeyed, like the conversation below, so an answer joining it stays the same box.
        <Answer
          earlier={earlier}
          onEarlier={more}
          live={shown}
          onStop={stop}
          fading={fading && !open}
          box={box}
          onDismiss={close}
        />
      ) : showNotice && notice ? (
        noticeInChat ? (
          // The chat, with the reply last; unkeyed, so it is the same box the conversation is. With
          // the composer up the box is wanted, so it fades only away from it.
          <Answer earlier={earlier} onEarlier={more} fading={noticeFading && !open} box={box} onDismiss={closeNotice} />
        ) : (
          <Answer
            key={notice.id}
            label={notice.plugin}
            text={notice.text}
            fading={noticeFading}
            box={box}
            onDismiss={closeNotice}
          />
        )
      ) : (
        conversation.mounted &&
        !historyClosed && (
          // The conversation so far, and under it whatever its box was dismissed from over, still working.
          <Answer
            earlier={earlier}
            onEarlier={more}
            live={away}
            onStop={stop}
            fading={conversation.leaving}
            box={box}
            onDismiss={() => closeHistory()}
          />
        )
      )}

      <Peek open={open} onFocusChange={setPeekFocused} onReveal={poke} arrow={arrow} />
    </div>
  )
}

/** True when the pointer sits inside the element's box. */
function within(element: HTMLElement | null, event: PointerEvent): boolean {
  if (!element) return false
  const box = element.getBoundingClientRect()
  return (
    event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom
  )
}

/** Keeps a spring's overshoot from pushing a derived value past the ends of its range. */
function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** True while settings is up over the home screen, which takes the keys and the pointer from the composer. */
function modalOpen(): boolean {
  return document.querySelector('[aria-modal=true]') !== null
}

/** True when the key belongs to a focused control other than the orb: a text field, a menu button. */
function inControl(event: KeyboardEvent): boolean {
  return (
    event.target instanceof HTMLElement &&
    event.target.matches('input, textarea, select, button:not(#talk):not(#composer-peek), [contenteditable]')
  )
}
