import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canHoldSpace, getComposerMode, setComposerMode, statusText, subscribeComposerMode } from './phase.ts'

test('composer mode starts on the orb and persists across subscribers when docking and undocking', () => {
  setComposerMode('orb')
  assert.equal(getComposerMode(), 'orb')

  const seen: string[] = []
  const unsubscribe = subscribeComposerMode(() => seen.push(getComposerMode()))

  setComposerMode('text')
  assert.equal(getComposerMode(), 'text')
  assert.deepEqual(seen, ['text'])

  // Setting the same mode again does not notify subscribers redundantly.
  setComposerMode('text')
  assert.deepEqual(seen, ['text'])

  unsubscribe()
  setComposerMode('orb')
  assert.equal(getComposerMode(), 'orb')
  assert.deepEqual(seen, ['text'])
})

test('statusText shows idle hints, microphone phases, unseen thinking, and voice or dock errors', () => {
  assert.equal(statusText({ mode: 'orb', hasVoice: true, phase: 'idle' }), 'Hold the orb or the space bar')
  assert.equal(statusText({ mode: 'orb', hasVoice: false, phase: 'idle' }), 'Click the orb or press space to type')
  assert.equal(statusText({ mode: 'text', hasVoice: true, phase: 'idle' }), '')
  assert.equal(statusText({ mode: 'text', hasVoice: false, phase: 'idle' }), '')

  assert.equal(statusText({ mode: 'orb', hasVoice: true, phase: 'opening' }), 'Opening the microphone…')
  assert.equal(statusText({ mode: 'orb', hasVoice: true, phase: 'recording' }), 'Listening…')
  assert.equal(statusText({ mode: 'orb', hasVoice: true, phase: 'transcribing' }), 'Transcribing…')

  // In-flight thinking stays silent in the status bar while the trail is visible, and shows when unseen.
  assert.equal(statusText({ mode: 'orb', hasVoice: true, phase: 'thinking', unseen: false }), '')
  assert.equal(statusText({ mode: 'orb', hasVoice: true, phase: 'thinking', unseen: true }), 'Thinking…')

  // Microphone and dock errors take precedence in both orb and text modes.
  assert.equal(
    statusText({
      mode: 'orb',
      hasVoice: true,
      phase: 'idle',
      error: 'Too short. Hold until it says Listening, speak, then release.',
    }),
    'Too short. Hold until it says Listening, speak, then release.',
  )
  assert.equal(
    statusText({
      mode: 'text',
      hasVoice: true,
      phase: 'idle',
      dockProblem: 'No room to dock the chat: make space on the grid first.',
    }),
    'No room to dock the chat: make space on the grid first.',
  )
})

test('canHoldSpace accepts a fresh unmodified Space press only outside controls and modals', () => {
  assert.equal(canHoldSpace({ code: 'Space' }), true)
  assert.equal(canHoldSpace({ code: 'Enter' }), false)
  assert.equal(canHoldSpace({ code: 'Space', repeat: true }), false)
  assert.equal(canHoldSpace({ code: 'Space', ctrlKey: true }), false)
  assert.equal(canHoldSpace({ code: 'Space', metaKey: true }), false)
  assert.equal(canHoldSpace({ code: 'Space', altKey: true }), false)
  assert.equal(canHoldSpace({ code: 'Space', inControl: true }), false)
  assert.equal(canHoldSpace({ code: 'Space', modalOpen: true }), false)
})
