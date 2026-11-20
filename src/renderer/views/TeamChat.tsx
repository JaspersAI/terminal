import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { usePanelState, usePublish, usePublishText } from '@jaspers-ai/sdk'
import { othersIn, personName, roomSharing } from '../../shared/collab/collab'
import {
  formatTeamChatTranscript,
  readTeamChatMessages,
  TEAM_CHAT_MESSAGE_MAX,
  type TeamChatMessage,
} from '../../shared/collab/team-chat'
import { formatAsOf } from '../../shared/tasks/tasks'
import { TeammateBadge } from '../components/collab/TeammateBadge'
import { MarkdownText } from '../components/composer/MarkdownText'
import { errorMessage } from '../lib/errors'
import { currentWorkspace, dispatch, useAppState } from '../lib/state'
import type { ViewProps } from './index'

/**
 * Built-in direct teammate chat view (`core/team-chat`): human-to-human messaging inside a shared
 * room with no AI agent triggers. Messages live in `panel.state.messages` keyed by message id so
 * concurrent sends from the owner and teammates merge cleanly across collaboration sync.
 */
export function TeamChat({ panel }: ViewProps): ReactElement {
  const workspaceId = panel.workspaceId
  const [rawMessages] = usePanelState<Record<string, unknown>>(panel, 'messages', {})
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickToBottomRef = useRef(true)

  const tabActive = useAppState((s) => currentWorkspace(s).id === workspaceId)
  const jaspers = useAppState((s) => s.jaspers)
  const collab = useAppState((s) => s.collab)
  const workspace = useAppState((s) => s.workspaces.find((w) => w.id === workspaceId))
  const loop = useAppState((s) => {
    const grids = s.grids[workspaceId] ?? {}
    for (const grid of Object.values(grids)) {
      const elem = grid.elements.find((e) => e.panelId === panel.id || e.id === panel.id)
      if (elem?.loop) return s.loops[workspaceId]?.find((one) => one.id === elem.loop)
    }
    return undefined
  })

  const sharing = useMemo(() => roomSharing(collab, workspace, loop), [collab, workspace, loop])
  const messages = useMemo(() => readTeamChatMessages(rawMessages), [rawMessages])
  const lastAt = messages.length > 0 ? messages[messages.length - 1]!.at : null
  const transcript = useMemo(() => formatTeamChatTranscript(messages), [messages])

  usePublish(panel, { messageCount: messages.length, lastAt })
  usePublishText(panel, transcript)

  const others = useMemo(
    () => (sharing?.share ? othersIn(sharing.share, collab.accountId) : []),
    [sharing?.share, collab.accountId],
  )
  const recipientNames = others.map((one) => personName(one)).join(', ')

  const readOnlyReason = useMemo(() => {
    if (sharing?.role !== 'member') return null
    if (!collab.connected) return 'Not connected to Jaspers: read-only until reconnected.'
    if (sharing.share && !sharing.share.ownerOnline) {
      const ownerLabel = personName({
        firstName: sharing.share.ownerFirstName,
        lastName: sharing.share.ownerLastName,
        email: sharing.share.ownerEmail,
      })
      return `${ownerLabel} is offline: read-only until they are back.`
    }
    return null
  }, [sharing, collab.connected])

  useEffect(() => {
    const feed = feedRef.current
    if (!feed || !stickToBottomRef.current) return
    feed.scrollTop = feed.scrollHeight
  }, [messages.length, lastAt])

  useEffect(() => {
    if (tabActive && !readOnlyReason) inputRef.current?.focus()
  }, [tabActive, readOnlyReason])

  async function sendMessage(): Promise<void> {
    const text = draft.trim()
    if (!text || sending || readOnlyReason) return
    const senderEmail = jaspers.email?.trim() || 'you@local'
    const now = Date.now()
    const id = `${now}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const message: TeamChatMessage = {
      id,
      senderEmail,
      ...(collab.firstName ? { senderFirstName: collab.firstName } : {}),
      ...(collab.lastName ? { senderLastName: collab.lastName } : {}),
      text: text.slice(0, TEAM_CHAT_MESSAGE_MAX),
      at: now,
    }
    setError(null)
    setSending(true)
    stickToBottomRef.current = true
    try {
      await dispatch({
        type: 'panel.setState',
        workspaceId,
        panelId: panel.id,
        path: ['messages', id],
        value: message,
      })
      setDraft('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void sendMessage()
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const myEmailLower = jaspers.email?.trim().toLowerCase() ?? ''

  return (
    <div data-team-chat-view className="flex h-full w-full flex-col bg-background select-text">
      <div
        ref={feedRef}
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-xs text-muted-foreground">
            <p className="font-medium text-foreground">
              {recipientNames ? `Direct chat with ${recipientNames}` : 'Team chat'}
            </p>
            <p>
              {sharing
                ? 'Messages here go straight to everyone in this room — no AI agent is asked.'
                : 'Share this room with a teammate to message them live.'}
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe =
              (myEmailLower.length > 0 && msg.senderEmail.toLowerCase() === myEmailLower) ||
              msg.senderEmail === 'you@local'
            const teammate = collab.teammates.find((t) => t.email.toLowerCase() === msg.senderEmail.toLowerCase())
            const lit = isMe ? collab.connected || !jaspers.signedIn : Boolean(teammate?.online)
            const senderLabel =
              msg.senderEmail === 'you@local'
                ? personName({ firstName: collab.firstName, lastName: collab.lastName, email: 'You' })
                : personName({
                    firstName: msg.senderFirstName ?? teammate?.firstName,
                    lastName: msg.senderLastName ?? teammate?.lastName,
                    email: msg.senderEmail,
                  })
            return (
              <div key={msg.id} data-team-chat-message={msg.id} className="flex items-start gap-2.5 text-sm">
                <TeammateBadge
                  email={msg.senderEmail}
                  firstName={msg.senderFirstName ?? teammate?.firstName}
                  lastName={msg.senderLastName ?? teammate?.lastName}
                  lit={lit}
                  size={20}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5 text-xs">
                    <span className="truncate font-medium text-foreground">{senderLabel}</span>
                    {isMe && senderLabel.toLowerCase() !== 'you' && (
                      <span className="shrink-0 text-muted-foreground">you</span>
                    )}
                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatAsOf(msg.at)}</span>
                  </div>
                  <div className="mt-0.5 font-prose text-prose break-words text-foreground">
                    <MarkdownText source={msg.text} />
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {error && <p className="shrink-0 border-t border-border px-3 py-1 text-xs text-destructive">{error}</p>}

      <form onSubmit={onSubmit} className="shrink-0 border-t border-border p-2">
        <div className="flex items-end gap-1.5 border border-border bg-background px-2 py-1 focus-within:border-foreground">
          <textarea
            ref={inputRef}
            name="prompt"
            data-team-chat-input
            aria-label={recipientNames ? `Message ${recipientNames}` : 'Message teammates'}
            rows={1}
            maxLength={TEAM_CHAT_MESSAGE_MAX}
            disabled={sending || Boolean(readOnlyReason)}
            value={draft}
            placeholder={
              readOnlyReason
                ? readOnlyReason
                : recipientNames
                  ? `Message ${recipientNames}…`
                  : 'Message teammates in this room…'
            }
            onKeyDown={onKeyDown}
            onChange={(event) => setDraft(event.target.value)}
            className="max-h-24 min-h-5 min-w-0 flex-1 resize-none bg-transparent text-xs leading-5 outline-none disabled:opacity-60"
          />
          <button
            type="submit"
            data-team-chat-send
            aria-label="Send message"
            title="Send message (Enter)"
            disabled={sending || Boolean(readOnlyReason) || !draft.trim()}
            className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-35"
          >
            <svg viewBox="0 0 14 14" fill="none" aria-hidden className="h-3.5 w-3.5 stroke-current stroke-[1.5]">
              <path d="M2 7h9.5M8 3.5 11.5 7 8 10.5" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  )
}
