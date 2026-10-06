import { ACTIVATE_SKILL, READ_SKILL_FILE, skillLoaded } from '@jaspers-ai/sdk/skills'
import { callOf, cutFrom, makeRoom, sent, setAside, type Sending } from '../../../shared/agent/aside'
import { cited, keptOn, type Citation } from '../../../shared/agent/citations'
import { putBack, standing, type Fork } from '../../../shared/agent/fork'
import { RECENT, recent, withoutThinking } from '../../../shared/agent/history'
import { keepTail, settle } from '../../../shared/agent/thread-store'
import { CLOSED_NOTE, lastExchange, maskExchange, transcript, type Exchange } from '../../../shared/agent/transcript'
import { ranByUser, saidByUser } from '../../../shared/agent/typed'
import { isOverflow } from '../../../shared/llm/limits'
import type { Turn } from '../../../shared/llm/llm'
import { stripSkillContent } from '../../../shared/skills/skills'
import { citationsFor } from '../../data/citations'
import { fileExchange, forgetChat, readExchanges } from '../../data/store'
import { getProviderConfig } from '../../secrets'
import { dropThread, forgetThread, threadFile } from '../thread-file'
import { createThreads, threadKey, type ThreadModel } from '../threads'
import type { Tool, ToolContext } from '../tools/types'
import { knownSecrets } from './settings'

// A chat's thread: where it is kept, how much of it goes on, how much of it a round sends, how it is
// mended and room made in it, and what is read back out of it. And beside it the chat's log, which is
// what the user saw of it: the thread is what the model works from, the log holds every exchange. A
// chat is named by a key, and a workspace's own chat by the workspace's id. Which chat a request is on
// is for its entry point to say: nothing here reads what is on screen.

/** One thread per chat. A workspace's own is under the workspace's id: the elements a request is about are the ones on that workspace's grid. */
export const threadFor = createThreads(threadFile)

/** Which conversation a run on a chat's thread belongs to: the chat, and the model its thread is held on. */
export function conversationOf(chat: string, model: ThreadModel): string {
  return `${chat}:${threadKey(model)}`
}

/** Kept whole, so the next session carries on from exactly here. */
export function keep(chat: string, model: ThreadModel, history: Turn[]): void {
  if (forgotten.has(chat)) return
  threadFile.save(chat, threadKey(model), history)
}

/**
 * A run's work so far, kept with its thread as the thread would stand were the run to end here
 * (`standing`): the run asks for it as each turn joins its copy, so a conversation is in the store as
 * far as it got, whatever becomes of the run or the app, and the next session carries on from there.
 * It is written over each time, and by the run's own end last. Nothing is kept of a run whose
 * conversation is gone. With two requests at work on one chat, what is kept is the thread with the
 * work of whichever kept last; each joins it whole as it ends.
 */
export function keepOpen(chat: string, model: ThreadModel, thread: Turn[], fork: Fork, era: number): void {
  if (stillOn(chat, thread, era)) keep(chat, model, standing(thread, fork, CLOSED_NOTE))
}

/** The thread started over, in place: what was kept of it goes with it. */
export function startOver(chat: string, model: ThreadModel, history: Turn[]): void {
  history.length = 0
  eras.set(history, eraOf(history) + 1)
  forgetThread(chat, threadKey(model))
}

/** The chats gone for good this session. A run still ending on one keeps and files nothing. */
const forgotten = new Set<string>()

/**
 * A chat gone for good, with its thread and its log: a loop's, when the loop is. The thread in
 * hand is emptied and marked started over, so a run still on it joins nothing.
 */
export function forget(chat: string): void {
  forgotten.add(chat)
  const config = getProviderConfig('llm')
  if (config) {
    const thread = threadFor(chat, config)
    thread.length = 0
    eras.set(thread, eraOf(thread) + 1)
  }
  dropThread(chat)
  forgetChat(chat)
}

/** How many times each thread has been started over, which is how a run tells its conversation is gone. */
const eras = new WeakMap<Turn[], number>()

/** Which conversation a thread is on: it goes up each time the thread is started over. */
export function eraOf(thread: Turn[]): number {
  return eras.get(thread) ?? 0
}

/**
 * A run's end, on its chat's thread. What the run added joins the thread, in one step, with whatever
 * it withheld or cut of the thread to make room, and the thread is kept. It does not join a conversation that
 * is gone: one started over since the run began (`era` is the thread's when it did), or one on a
 * language model the app is no longer set to. The chat's log is another matter: its exchange is filed
 * either way (`file`), since the chat showed it.
 */
export function join(chat: string, model: ThreadModel, thread: Turn[], fork: Fork, era: number): void {
  if (!stillOn(chat, thread, era)) return
  putBack(thread, fork)
  keep(chat, model, thread)
}

/**
 * Whether a run's conversation is still its chat's: not started over since the run began (`era` is
 * the thread's when it did), and on the language model the app is still set to. A run whose
 * conversation is gone goes on and is shown, and nothing of it joins the one that took its place.
 */
export function stillOn(chat: string, thread: Turn[], era: number): boolean {
  const now = getProviderConfig('llm')
  return now !== null && threadFor(chat, now) === thread && eraOf(thread) === era
}

/**
 * Cuts a thread, in place, to the exchanges that go on, before a new one joins it. The model works
 * from those and the new one; what was said before them stays in the chat's log, which it never reads.
 */
export function cutToRecent(history: Turn[]): void {
  const kept = recent(history)
  if (kept === history) return
  console.log(`[agent] thread goes on with its last ${RECENT} exchanges: ${history.length - kept.length} turns dropped`)
  history.splice(0, history.length, ...kept)
}

/**
 * Files the exchange a thread ends on in its chat's log, as the chat showed it, every key the app
 * holds masked out of it. For a thread a run has just ended on, with the steps that run took, or one
 * something was just said into, which took none.
 */
export function file(chat: string, history: Turn[], steps: string[] = []): void {
  if (forgotten.has(chat)) return
  const secrets = knownSecrets()
  const exchange = lastExchange(history, secrets)
  if (exchange) void fileExchange(chat, Date.now(), maskExchange({ ...exchange, steps }, secrets))
}

/**
 * Files a run that failed in its chat's log: what was asked, what it did, and why it ended, since
 * the log is read to learn what happened. The thread keeps what the run did, closed off with why.
 */
export function fileFailed(chat: string, question: string, steps: string[], error: string): void {
  if (forgotten.has(chat)) return
  void fileExchange(chat, Date.now(), maskExchange({ question, answer: '', steps, error }, knownSecrets()))
}

/**
 * The end of a chat, for whatever shows it: its last `limit` exchanges, or with `before` the last
 * ones ahead of that one, from the chat's log, with every key the app holds now masked out of them.
 * A store that is down must not take the conversation off the screen: its end is then read off the
 * thread the next request continues, which holds the last few.
 */
export async function exchanges(chat: string, limit: number, before?: number): Promise<Exchange[]> {
  const secrets = knownSecrets()
  try {
    return (await readExchanges(chat, limit, before)).map((one) => maskExchange(one, secrets))
  } catch {
    const config = getProviderConfig('llm')
    return config && before === undefined ? transcript(threadFor(chat, config), limit, secrets) : []
  }
}

/**
 * What a tool may ask of the thread its run is on. A run with no conversation behind it gives an
 * empty thread, which answers no to all three.
 */
export function threadReads(history: Turn[]): Pick<ToolContext, 'userSaid' | 'inThread' | 'userRan'> {
  return {
    userSaid: (text) => saidByUser(history, text),
    inThread: (text) => skillLoaded(history, text),
    userRan: (id) => ranByUser(history, id),
  }
}

/**
 * The sources a reply cites, looked up among what this workspace's source runs have brought and what
 * the thread's earlier replies cited: an id none of them gave is the model's own, and points at nothing.
 */
export function citedBy(text: string, history: Turn[], workspaceId: string): Citation[] {
  return cited(text, new Map([...keptOn(history), ...citationsFor(workspaceId)]))
}

/** The tools whose answers are instructions a run goes by, which always go whole. */
const INSTRUCTIONS: ReadonlySet<string> = new Set([ACTIVATE_SKILL, READ_SKILL_FILE])

/** A run's history as its model is sent it this round (`sent` in `shared/agent/aside.ts`). The history itself keeps everything. */
export function sentOf(history: Turn[], sending: Sending): Turn[] {
  return sent(history, sending, INSTRUCTIONS)
}

/**
 * Sets a request's answers aside once they are more than it keeps whole, all but the newest round's,
 * moving the mark in place. The answers stay in the history, which is what is kept; turns that held
 * thinking are replaced by ones without, never rewritten, since another run may hold the same ones.
 * Said in the log only: it is how a long run goes, not something that happened to it.
 */
export function putAway(history: Turn[], sending: Sending, log: (line: string) => void): void {
  const made = setAside(history, sending, INSTRUCTIONS)
  if (!made) return
  log(
    `${answers(made.aside)} set aside, ${made.saved.toLocaleString('en-US')} characters: read, and kept in the thread`,
  )
  history.splice(0, history.length, ...made.turns)
  Object.assign(sending, made.sending)
}

/**
 * A refusal that is about the thread rather than the request, and the thread made acceptable again, in
 * place. Thinking tied to a conversation that has since changed (a plugin was built, a memory written)
 * is taken out, which is the way back the provider gives. A thread too long for its model has room
 * made in it (`shorten`). False when there is nothing to mend, or nothing more to be done about it.
 */
export function mend(history: Turn[], sending: Sending, message: string, tell: (line: string) => void): boolean {
  if (/ returned 400: /.test(message) && /signature/i.test(message)) {
    const without = withoutThinking(history)
    if (without.every((turn, at) => turn === history[at])) return false
    history.splice(0, history.length, ...without)
    tell('Thinking dropped: the conversation it was tied to has changed')
    return true
  }
  return isOverflow(message) && shorten(history, sending, tell)
}

/**
 * Makes what a thread sends shorter when its model cannot read it, in place: the provider refusing
 * it, or the model's window cutting its reply off, with the request still within what it keeps whole.
 * That is a model with a small window, or one answer too long to read. Room is made as `makeRoom`
 * says: the request's answers before its newest round are set aside, then the round just run has its
 * largest withheld, each saying where its data still is. Turns are replaced, not rewritten, and none
 * is added or removed. Only when no answer is left does the thread keep just its end, which is what
 * unsticks a model with a small window: left alone, every request after the first that did not fit
 * fails the same way. False when it is already as short as it gets.
 */
export function shorten(history: Turn[], sending: Sending, tell: (line: string) => void): boolean {
  const room = makeRoom(history, sending, INSTRUCTIONS)
  if (room) {
    const what = room.withheld > 0 ? `${answers(room.withheld)} withheld` : `${answers(room.aside)} set aside`
    tell(`Conversation too long for the model: ${what}, ${room.saved.toLocaleString('en-US')} characters`)
    history.splice(0, history.length, ...room.turns)
    Object.assign(sending, room.sending)
    return true
  }
  const shorter = settle(keepTail(history))
  if (shorter.length === 0 || shorter.length === history.length) return false
  tell(`Conversation too long for the model: kept its last ${shorter.length} of ${history.length} turns`)
  Object.assign(sending, cutFrom(sending, history.length - shorter.length))
  history.splice(0, history.length, ...shorter)
  return true
}

function answers(count: number): string {
  return `${count} answer${count === 1 ? '' : 's'}`
}

/**
 * What a run may call: the tools it was given and, with them, the one that gives back what was set
 * aside. A run given none is offered none.
 */
export function offered(tools: Tool[], history: Turn[]): Tool[] {
  return tools.length > 0 ? [...tools, readAgain(history)] : tools
}

/**
 * The tool that gives back what a note stands for: a call as it was made and what it answered, out of
 * the run's own history, which keeps both whole. It is made with the run rather than composed with
 * the tool families because it reads that run's conversation and no other: a builder's notes are of
 * its build's turns, not of the request it runs under.
 */
function readAgain(history: Turn[]): Tool {
  return {
    name: 'read_again',
    readsOnly: true,
    whole: true,
    description:
      'Bring back a call from earlier in this conversation as it was made and what it answered, whole, with nothing run again. A long answer you have already read stands as a note saying so, and so do the long arguments of an earlier request: the note gives the id to pass here. Use it rather than running the tool again; when only some rows of a source are needed, query reads those from the store.',
    parameters: {
      type: 'object',
      // Named for what it is, not `id`: a run's trail shows a call's id argument, and this one says nothing to a person.
      properties: { call: { type: 'string', description: 'The id of the call, as the note gives it.' } },
      required: ['call'],
    },
    async run(input) {
      // A model that writes the argument's name its own way, or keeps the note's quotes, means the same call.
      const given = input.call ?? input.id
      const id = typeof given === 'string' ? given.trim().replace(/^"(.*)"$/, '$1') : ''
      const found = id ? callOf(history, id) : null
      if (!found) {
        throw new Error(
          `No call "${id}" in this conversation. The id is in the note that stands where an answer or an argument was set aside.`,
        )
      }
      return `${found.call.name} ${JSON.stringify(found.call.input)}\n\n${found.answer ?? '(Nothing answered this call.)'}`
    },
  }
}

/** Puts the state as it is now on the turn about to be sent again, with a note for the model when there is one. */
export function restate(history: Turn[], state: string, note?: string): void {
  const last = history[history.length - 1]
  if (!last || last.role === 'assistant') return
  last.context = [state, ...(note ? [note] : [])].join('\n')
}

/** A user turn for the log: what was typed, and the size of any skill a /name loaded into it. */
export function userLine(text: string): string {
  const typed = stripSkillContent(text).trim()
  return typed.length === text.trim().length ? typed : `${typed} [+ skill, ${text.length - typed.length} characters]`
}
