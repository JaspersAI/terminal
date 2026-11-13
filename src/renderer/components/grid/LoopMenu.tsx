import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import { endedAs, type Exchange } from '../../../shared/agent/transcript'
import { EMPTY_COLLAB, findRoomShare } from '../../../shared/collab/collab'
import { editedInstructionsPrompt, loopTitle, type Loop } from '../../../shared/loops/loops'
import { menuOf } from '../../../shared/loops/menu'
import { formatAsOf } from '../../../shared/tasks/tasks'
import { useAppState } from '../../lib/state'
import { PAGE } from '../composer/request'
import { sendToRoom } from './LoopBox'
import { send } from './send'
import { useLoopStatus } from './status'

interface Props {
  workspaceId: string
  elementId: string
  loop: Loop
  /** The button that opens it: a press there is the button's to answer, not a press outside. */
  opener: RefObject<HTMLButtonElement | null>
  /** True on a minimized tile, which is as tall as its bar: the menu hangs below it, as tall as it needs. */
  hangs: boolean
  onClose: () => void
  onRename?: () => void
}

/**
 * A tile's menu, under its bar. First what may be done, so it is reached however long the rest is:
 * what the loop is doing stopped, the loop closed, which keeps it for View loops in Settings to
 * reopen, and the loop deleted for good, which asks once here rather than in a dialog. Then what the loop was
 * told of, with each connection and what it is doing, and the work's timeline, newest first, each
 * request with the steps its run took and how it ended. It is drawn inside its
 * tile, like the tile's box, so it works in every window. It closes on Escape, on a press outside it,
 * when the window loses the keyboard, and with its tile.
 */
export function LoopMenu({
  workspaceId,
  elementId,
  loop,
  opener,
  hangs,
  onClose,
  onRename,
}: Props): ReactElement | null {
  // The slices the rule reads, each as the tree holds it, so the menu is rebuilt only when one changes.
  const loops = useAppState((s) => s.loops[workspaceId])
  const plugins = useAppState((s) => s.plugins)
  const connections = useAppState((s) => s.connections)
  const collab = useAppState((s) => s.collab ?? EMPTY_COLLAB)
  const roomShare = useMemo(
    () => findRoomShare(collab, workspaceId, loop.id, loop.shareId),
    [collab, workspaceId, loop.id, loop.shareId],
  )
  const availableTeammates = useMemo(() => {
    const byEmail = new Map(collab.teammates.map((t) => [t.email.toLowerCase(), t]))
    for (const inv of collab.outgoingInvites) {
      const key = inv.inviteeEmail.toLowerCase()
      if (!byEmail.has(key)) {
        byEmail.set(key, { accountId: inv.inviteeEmail, email: inv.inviteeEmail, since: inv.createdAt })
      }
    }
    return [...byEmail.values()]
  }, [collab.teammates, collab.outgoingInvites])
  const [inviteEmail, setInviteEmail] = useState('')
  const shareInputRef = useRef<HTMLInputElement>(null)
  const menu = useMemo(
    () => menuOf({ loops: { [workspaceId]: loops ?? [] }, plugins, connections }, workspaceId, loop.id),
    [workspaceId, loop.id, loops, plugins, connections],
  )
  const [timeline, setTimeline] = useState<Exchange[]>([])
  /** The oldest exchange read, while there may be more before it. */
  const [earlier, setEarlier] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [editingInstructions, setEditingInstructions] = useState(false)
  const [briefDraft, setBriefDraft] = useState(loop.brief)
  const [systemDraft, setSystemDraft] = useState(loop.systemPrompt ?? '')
  const root = useRef<HTMLDivElement>(null)
  const reading = useRef(0)
  const status = useLoopStatus(workspaceId, loop.id)

  useEffect(() => {
    if (!editingInstructions) {
      setBriefDraft(loop.brief)
      setSystemDraft(loop.systemPrompt ?? '')
    }
  }, [loop.brief, loop.systemPrompt, editingInstructions])

  function saveInstructions(andRun: boolean): void {
    send({
      type: 'room.update',
      workspaceId,
      room: loop.id,
      brief: briefDraft,
      systemPrompt: systemDraft,
    })
    setEditingInstructions(false)
    if (andRun) {
      const prompt = editedInstructionsPrompt(briefDraft, systemDraft)
      if (prompt) sendToRoom({ workspaceId, on: elementId }, loop.id, prompt)
    }
  }

  /** Reads a page of the work's log, as its box reads it (every key the app holds masked), newest first. */
  const read = useCallback(
    (before?: number) => {
      const request = ++reading.current
      window.app.agent.history(PAGE, before, loop.id).then(
        (page) => {
          if (request !== reading.current) return
          const newestFirst = [...page].reverse()
          setTimeline((had) => (before === undefined ? newestFirst : [...had, ...newestFirst]))
          setEarlier(page.length === PAGE ? (page[0]?.id ?? null) : null)
        },
        // The work went while this was open: there is nothing to read, and the menu goes with its tile.
        () => {
          if (request === reading.current) setEarlier(null)
        },
      )
    },
    [workspaceId, loop.id],
  )

  useEffect(() => {
    read()
    return () => {
      reading.current++
    }
  }, [read])

  // The menu holds the keyboard while it is open, so Escape reaches it: on opening, and again when
  // the button that was pressed goes (Delete becoming its question, or Keep taking that back).
  useEffect(() => {
    root.current?.focus()
  }, [confirming])

  /** Stops what the work is doing: every run of its in flight, and no other. */
  const stop = useCallback(() => {
    void window.app.agent.running().then((runs) => {
      for (const run of runs) {
        if (run.loop === loop.id && run.workspaceId === workspaceId) void window.app.agent.stop(run.runId)
      }
    })
  }, [workspaceId, loop.id])

  useEffect(() => {
    const pressed = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (root.current?.contains(target) || opener.current?.contains(target)) return
      onClose()
    }
    // In the capture phase: a press on a tile's bar is stopped before it reaches the document.
    document.addEventListener('pointerdown', pressed, true)
    // A press inside a view's own frame never reaches this document; the window losing the keyboard does.
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', pressed, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, opener])

  if (!menu) return null
  const item = 'px-2 py-1 text-left hover:bg-muted'

  return (
    <div
      ref={root}
      id={`loop-menu-${elementId}`}
      role="dialog"
      aria-label={`More for ${loopTitle(loop)}`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        if (editingInstructions) {
          setEditingInstructions(false)
          setBriefDraft(loop.brief)
          setSystemDraft(loop.systemPrompt ?? '')
          return
        }
        onClose()
      }}
      // Above the edges that resize and the bar's buttons, and inside the tile: it scrolls when the tile is short.
      className={`absolute top-6 right-0 z-30 flex w-72 max-w-full flex-col overflow-y-auto border border-border bg-background text-xs outline-none select-text ${
        hangs ? 'max-h-80' : 'max-h-[calc(100%-1.5rem)]'
      }`}
    >
      <div className="flex shrink-0 flex-col border-b border-border py-1">
        {status === 'working' && (
          <button type="button" data-stop onClick={stop} className={item}>
            Stop what it is doing
          </button>
        )}
        {onRename && (
          <button type="button" data-rename onClick={onRename} className={item}>
            Rename this room
          </button>
        )}
        <button type="button" data-menu-share-button onClick={() => shareInputRef.current?.focus()} className={item}>
          Share
        </button>
        <button
          type="button"
          data-close
          onClick={() => send({ type: 'room.close', workspaceId, room: loop.id })}
          className={item}
        >
          Close this room
        </button>
        {confirming ? (
          <div data-confirm className="px-2 py-1">
            <p>Permanently delete it, with its conversation? Closing keeps it saved in Rooms.</p>
            <div className="mt-1 flex gap-1">
              <button
                type="button"
                data-delete-now
                onClick={() => send({ type: 'room.delete', workspaceId, room: loop.id })}
                className="border border-destructive px-2 py-0.5 text-destructive"
              >
                Delete permanently
              </button>
              <button
                type="button"
                data-keep
                onClick={() => setConfirming(false)}
                className="border border-border px-2 py-0.5"
              >
                Keep
              </button>
            </div>
          </div>
        ) : (
          <button type="button" data-delete onClick={() => setConfirming(true)} className={`${item} text-destructive`}>
            Delete this room
          </button>
        )}
      </div>
      <section data-menu-instructions className="border-b border-border p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-muted-foreground">Instructions</h3>
          {!editingInstructions && (
            <button
              type="button"
              data-menu-edit-instructions
              onClick={() => {
                setBriefDraft(loop.brief)
                setSystemDraft(loop.systemPrompt ?? '')
                setEditingInstructions(true)
              }}
              className="text-muted-foreground underline hover:text-foreground"
            >
              {menu.brief || menu.systemPrompt ? 'Edit' : 'Add'}
            </button>
          )}
        </div>
        {editingInstructions ? (
          <div className="flex flex-col gap-1.5">
            <textarea
              data-menu-brief-input
              aria-label="Room instructions"
              rows={3}
              value={briefDraft}
              placeholder="Instructions for what this room's agent should do…"
              onChange={(event) => setBriefDraft(event.target.value)}
              className="w-full resize-y border border-border bg-background px-1.5 py-1 text-xs leading-snug outline-none focus:border-foreground"
            />
            <textarea
              data-menu-system-prompt-input
              aria-label="Room system prompt"
              rows={2}
              value={systemDraft}
              placeholder="System prompt (optional)…"
              onChange={(event) => setSystemDraft(event.target.value)}
              className="w-full resize-y border border-border bg-background px-1.5 py-1 text-xs leading-snug outline-none focus:border-foreground"
            />
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                data-menu-apply-instructions
                onClick={() => saveInstructions(true)}
                className="border border-primary bg-primary px-2 py-0.5 text-primary-foreground"
              >
                Save &amp; run
              </button>
              <button
                type="button"
                data-menu-save-instructions
                onClick={() => saveInstructions(false)}
                className="border border-border px-2 py-0.5 hover:bg-muted"
              >
                Save
              </button>
              <button
                type="button"
                data-menu-cancel-instructions
                onClick={() => {
                  setEditingInstructions(false)
                  setBriefDraft(loop.brief)
                  setSystemDraft(loop.systemPrompt ?? '')
                }}
                className="px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : menu.brief || menu.systemPrompt ? (
          <div className="space-y-1">
            {menu.brief && <p className="whitespace-pre-wrap break-words">{menu.brief}</p>}
            {menu.systemPrompt && menu.systemPrompt !== menu.brief && (
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                <span className="font-medium">System prompt:</span> {menu.systemPrompt}
              </p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">No instructions set</p>
        )}
      </section>
      <section data-menu-share className="border-b border-border p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="text-muted-foreground">Share</h3>
          {roomShare && (
            <button
              type="button"
              data-menu-unshare-room
              onClick={() => send({ type: 'room.unshare', workspaceId, room: loop.id })}
              className="text-muted-foreground underline hover:text-foreground"
            >
              {roomShare.isOwner ? 'Stop sharing' : 'Leave'}
            </button>
          )}
        </div>
        <div className="space-y-1.5">
          {availableTeammates.length > 0 && (
            <ul className="space-y-1">
              {availableTeammates.map((tm) => {
                const activeMemberIds = (roomShare?.members ?? [])
                  .map((m) => m.accountId)
                  .filter((id) => id !== roomShare?.ownerAccountId)
                const inRoom =
                  activeMemberIds.includes(tm.accountId) ||
                  (roomShare?.members ?? []).some((m) => m.email.toLowerCase() === tm.email.toLowerCase())
                return (
                  <li key={tm.accountId} className="flex items-center justify-between gap-2">
                    <span className="truncate">{tm.email}</span>
                    <button
                      type="button"
                      data-share-teammate={tm.accountId}
                      aria-pressed={inRoom}
                      onClick={() => {
                        const nextIds = inRoom
                          ? activeMemberIds.filter(
                              (id) => id !== tm.accountId && id.toLowerCase() !== tm.email.toLowerCase(),
                            )
                          : [...activeMemberIds, tm.accountId]
                        if (nextIds.length === 0 && roomShare) {
                          send({ type: 'room.unshare', workspaceId, room: loop.id })
                        } else {
                          send({ type: 'room.share', workspaceId, room: loop.id, memberAccountIds: nextIds })
                        }
                      }}
                      className={`border px-1.5 py-0.5 ${
                        inRoom ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'
                      }`}
                    >
                      {inRoom ? 'Added' : 'Add'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const trimmed = inviteEmail.trim()
              if (!trimmed) return
              const activeMemberIds = (roomShare?.members ?? [])
                .map((m) => m.accountId)
                .filter((id) => id !== roomShare?.ownerAccountId)
              send({
                type: 'room.share',
                workspaceId,
                room: loop.id,
                memberAccountIds: [...new Set([...activeMemberIds, trimmed])],
              })
              setInviteEmail('')
            }}
            className="flex gap-1 pt-0.5"
          >
            <input
              ref={shareInputRef}
              type="email"
              data-menu-invite-email
              aria-label="Share room with teammate email"
              placeholder="teammate@fund.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="min-w-0 flex-1 border border-border bg-background px-1.5 py-0.5 text-xs outline-none focus:border-foreground"
            />
            <button
              type="submit"
              data-menu-invite-submit
              disabled={!inviteEmail.trim()}
              className="border border-border px-1.5 py-0.5 hover:bg-muted disabled:opacity-40"
            >
              Share
            </button>
          </form>
        </div>
      </section>
      <section className="border-b border-border p-2">
        <h3 className="mb-1 text-muted-foreground">Told of</h3>
        {menu.plugins.length === 0 ? (
          <p>No plugins</p>
        ) : (
          <ul>
            {menu.plugins.map((plugin) => (
              <li key={plugin.id} data-plugin={plugin.id} className="mb-1 last:mb-0">
                <p className="truncate">
                  {plugin.id}
                  {plugin.installed ? '' : ' · not installed'}
                </p>
                {plugin.connections.map((one) => (
                  <p key={one.id} data-connection={one.id} className="truncate pl-2 text-muted-foreground">
                    {one.id} · {one.status}
                    {one.error ? ` · ${one.error}` : ''}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="p-2">
        <h3 className="mb-1 text-muted-foreground">Timeline</h3>
        {timeline.length === 0 ? (
          <p>Nothing has been said yet</p>
        ) : (
          <ol>
            {timeline.map((one, at) => (
              <Entry key={one.id ?? `at-${at}`} exchange={one} />
            ))}
          </ol>
        )}
        {earlier !== null && (
          <button
            type="button"
            data-earlier
            onClick={() => read(earlier)}
            className="mt-1 text-muted-foreground underline"
          >
            Earlier
          </button>
        )}
      </section>
    </div>
  )
}

/** One request in the timeline: what was asked, the steps its run took, and how it ended. */
function Entry({ exchange }: { exchange: Exchange }): ReactElement {
  const ended = endedAs(exchange)
  const how =
    ended === 'failed'
      ? `Failed: ${exchange.error ?? ''}`
      : ended === 'stopped'
        ? 'Stopped'
        : (exchange.answer.trim().split('\n')[0] ?? '')
  const asOf = exchange.at !== undefined ? formatAsOf(exchange.at) : ''
  return (
    <li data-exchange data-ended={ended} className="mb-2 last:mb-0">
      <p className="truncate">{exchange.question}</p>
      {exchange.steps && exchange.steps.length > 0 && (
        <p className="truncate text-muted-foreground">{exchange.steps.join(' · ')}</p>
      )}
      <p className={`truncate ${ended === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{how}</p>
      {asOf && <p className="truncate text-[11px] text-muted-foreground">{asOf}</p>}
    </li>
  )
}
