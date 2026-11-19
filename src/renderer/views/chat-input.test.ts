import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHAT_INPUT_MAX_HEIGHT,
  CHAT_INPUT_MIN_HEIGHT,
  chatInputMaxHeight,
  dockedChatKeyAction,
  measureChatInput,
  type ChatKeyInput,
} from './chat-input.ts'

function keyInput(overrides: Partial<ChatKeyInput> = {}): ChatKeyInput {
  return {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    draft: 'screen for software companies',
    menuOpen: false,
    activeMatchId: null,
    matchCount: 0,
    activeIndex: 0,
    ...overrides,
  }
}

test('single-line or empty drafts stay at the single-line height with hidden scrollbar', () => {
  assert.deepEqual(measureChatInput(0, 640), { height: CHAT_INPUT_MIN_HEIGHT, overflowY: 'hidden' })
  assert.deepEqual(measureChatInput(20, 640), { height: CHAT_INPUT_MIN_HEIGHT, overflowY: 'hidden' })
})

test('multi-line drafts expand to match their wrapped scrollHeight up to the cap', () => {
  assert.deepEqual(measureChatInput(68, 640), { height: 68, overflowY: 'hidden' })
  assert.deepEqual(measureChatInput(148, 640), { height: 148, overflowY: 'hidden' })
})

test('drafts taller than the cap clamp height and switch to vertical scrolling', () => {
  assert.deepEqual(measureChatInput(260, 640), { height: CHAT_INPUT_MAX_HEIGHT, overflowY: 'auto' })
})

test('short docked panels clamp the field so the conversation above stays visible', () => {
  assert.equal(chatInputMaxHeight(200), 90)
  assert.deepEqual(measureChatInput(140, 200), { height: 90, overflowY: 'auto' })
  // Even a very short tile preserves at least two lines of height.
  assert.equal(chatInputMaxHeight(40), 36)
})

test('zoom scales minimum and maximum heights proportionally', () => {
  assert.deepEqual(measureChatInput(14, 800, 0.8), { height: 16, overflowY: 'hidden' })
  assert.deepEqual(measureChatInput(400, 800, 1.5), { height: 300, overflowY: 'auto' })
})

test('Enter submits while Shift+Enter and arrow keys stay native for multi-line editing', () => {
  assert.deepEqual(dockedChatKeyAction(keyInput({ key: 'Enter', shiftKey: false })), { kind: 'submit' })
  assert.deepEqual(dockedChatKeyAction(keyInput({ key: 'Enter', shiftKey: true })), { kind: 'none' })
  assert.deepEqual(dockedChatKeyAction(keyInput({ key: 'ArrowUp' })), { kind: 'none' })
  assert.deepEqual(dockedChatKeyAction(keyInput({ key: 'ArrowDown' })), { kind: 'none' })
})

test('IME composition never triggers submit or slash-menu actions', () => {
  assert.deepEqual(dockedChatKeyAction(keyInput({ key: 'Enter', isComposing: true })), { kind: 'none' })
  assert.deepEqual(
    dockedChatKeyAction(
      keyInput({
        key: 'Enter',
        isComposing: true,
        draft: '/dcf',
        menuOpen: true,
        activeMatchId: 'dcf-model',
        matchCount: 2,
      }),
    ),
    { kind: 'none' },
  )
})

test('slash menu navigates with arrows, picks an incomplete skill on Enter or Tab, and submits an exact /skill', () => {
  const menuBase: Partial<ChatKeyInput> = {
    draft: '/dc',
    menuOpen: true,
    activeMatchId: 'dcf',
    matchCount: 3,
    activeIndex: 0,
  }
  assert.deepEqual(dockedChatKeyAction(keyInput({ ...menuBase, key: 'ArrowDown' })), {
    kind: 'move-menu',
    nextIndex: 1,
  })
  assert.deepEqual(dockedChatKeyAction(keyInput({ ...menuBase, key: 'ArrowUp' })), {
    kind: 'move-menu',
    nextIndex: 2,
  })
  assert.deepEqual(dockedChatKeyAction(keyInput({ ...menuBase, key: 'Tab' })), { kind: 'pick-skill' })
  assert.deepEqual(dockedChatKeyAction(keyInput({ ...menuBase, key: 'Enter' })), { kind: 'pick-skill' })
  assert.deepEqual(dockedChatKeyAction(keyInput({ ...menuBase, draft: '/dcf', key: 'Enter' })), { kind: 'submit' })
  assert.deepEqual(dockedChatKeyAction(keyInput({ ...menuBase, key: 'Enter', shiftKey: true })), { kind: 'none' })
  assert.deepEqual(dockedChatKeyAction(keyInput({ ...menuBase, key: 'Escape' })), { kind: 'close-menu' })
})
