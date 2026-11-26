import assert from 'node:assert/strict'
import { test } from 'node:test'
import { weightedTaskTokens } from './budget.ts'
import { findProvider } from '../llm/providers.ts'
import { CENTRAL_CHAT } from './history.ts'
import {
  chatRunsOn,
  parsePromptRouting,
  resolveStickyRoomTier,
  shouldEscalateFastRun,
  SITTING_IDLE_MS,
  workRunsOn,
} from './model.ts'

const ANTHROPIC = findProvider('llm', 'anthropic')!
const JASPERS = findProvider('llm', 'jaspers')!
const SET = { provider: ANTHROPIC, model: 'claude-opus-5' }

test('a piece of work runs on the configured model at medium effort by default, or on the BYOK model/class it names', () => {
  assert.deepEqual(workRunsOn(SET), { model: 'claude-opus-5', effort: 'medium', modelClass: 'main' })
  assert.deepEqual(workRunsOn(SET, 'claude-sonnet-5'), {
    model: 'claude-sonnet-5',
    effort: 'medium',
    modelClass: 'main',
  })
  assert.equal(workRunsOn(SET, '  ').model, 'claude-opus-5')
  assert.equal(workRunsOn(SET, null).model, 'claude-opus-5')
})

test('Jaspers ignores arbitrary raw model names while honoring orthogonal modelClass (fast | main | code) and effort', () => {
  const jaspers = { provider: JASPERS, model: JASPERS.model, fastModel: JASPERS.fastModel }
  assert.deepEqual(workRunsOn(jaspers, 'openai/gpt-5.4'), { model: 'main', effort: 'medium', modelClass: 'main' })
  assert.deepEqual(workRunsOn(jaspers, { modelClass: 'fast' }), { model: 'fast', effort: 'low', modelClass: 'fast' })
  assert.deepEqual(workRunsOn(jaspers, { modelClass: 'main', effort: 'high', surface: 'room' }), {
    model: 'main',
    effort: 'high',
    modelClass: 'main',
    surface: 'room',
  })
  assert.deepEqual(workRunsOn(jaspers, { modelClass: 'code', surface: 'build' }), {
    model: 'code',
    effort: 'medium',
    modelClass: 'code',
    surface: 'build',
  })
})

const BOTH = { provider: ANTHROPIC, model: 'claude-opus-5', fastModel: 'small' }

test('BYOK providers run Central on fastModel at low effort when configured, rooms on main at medium, and build/* on code at medium', () => {
  assert.deepEqual(chatRunsOn(CENTRAL_CHAT, BOTH), {
    model: 'small',
    effort: 'low',
    modelClass: 'fast',
    surface: 'central',
  })
  assert.deepEqual(chatRunsOn('w1/f3', BOTH), {
    model: 'claude-opus-5',
    effort: 'medium',
    modelClass: 'main',
    surface: 'room',
  })
  assert.deepEqual(chatRunsOn('build/fred', BOTH), {
    model: 'claude-opus-5',
    effort: 'medium',
    modelClass: 'code',
    surface: 'build',
  })
})

test('a BYOK provider with no fast model runs Central on its configured model at medium effort', () => {
  for (const fastModel of [undefined, '', '   ']) {
    assert.deepEqual(chatRunsOn(CENTRAL_CHAT, { ...BOTH, fastModel }), {
      model: 'claude-opus-5',
      effort: 'medium',
      modelClass: 'main',
      surface: 'central',
    })
  }
})

test('a BYOK fast model named the same as the thinking model runs Central on it at low effort', () => {
  assert.deepEqual(chatRunsOn(CENTRAL_CHAT, { ...BOTH, fastModel: 'claude-opus-5' }), {
    model: 'claude-opus-5',
    effort: 'low',
    modelClass: 'fast',
    surface: 'central',
  })
})

test("a room's own BYOK model or Jaspers modelClass is the room's, and never Central's", () => {
  assert.equal(chatRunsOn('w1/f3', BOTH, 'claude-sonnet-5').model, 'claude-sonnet-5')
  assert.equal(chatRunsOn('w1/f3', BOTH, { modelClass: 'fast' }).model, 'small')
  assert.equal(chatRunsOn(CENTRAL_CHAT, BOTH, 'claude-sonnet-5').model, 'small')
})

test('under Jaspers One, Central runs on main at low effort with surface central, build/* on code at medium, and rooms on their chosen class', () => {
  const set = { provider: JASPERS, model: JASPERS.model, fastModel: JASPERS.fastModel }
  assert.deepEqual(chatRunsOn(CENTRAL_CHAT, set), {
    model: 'main',
    effort: 'low',
    modelClass: 'main',
    surface: 'central',
  })
  assert.deepEqual(chatRunsOn('build/pacer', set), {
    model: 'code',
    effort: 'medium',
    modelClass: 'code',
    surface: 'build',
  })
  assert.deepEqual(chatRunsOn('w1/f3', set), {
    model: 'main',
    effort: 'medium',
    modelClass: 'main',
    surface: 'room',
  })
  assert.deepEqual(chatRunsOn('w1/f3', set, { modelClass: 'fast', effort: 'low' }), {
    model: 'fast',
    effort: 'low',
    modelClass: 'fast',
    surface: 'room',
  })
  assert.deepEqual(chatRunsOn('w1/f3', set, { modelClass: 'main', effort: 'high' }), {
    model: 'main',
    effort: 'high',
    modelClass: 'main',
    surface: 'room',
  })
})

test('parsePromptRouting handles /deep, /fast, skill shadowing, composer toggle, and attached file floors', () => {
  assert.deepEqual(parsePromptRouting('/deep audit NVDA 10-K revenue recognition'), {
    cleanedInput: 'audit NVDA 10-K revenue recognition',
    modelClass: 'main',
    effort: 'high',
    explicit: true,
  })
  assert.deepEqual(parsePromptRouting('/fast open AAPL chart'), {
    cleanedInput: 'open AAPL chart',
    modelClass: 'fast',
    effort: 'low',
    explicit: true,
  })
  // User skill named /deep takes precedence over the built-in routing directive
  const shadowed = parsePromptRouting('/deep NVDA', { hasSkill: (name) => name === 'deep' })
  assert.equal(shadowed.explicit, false)
  assert.equal(shadowed.cleanedInput, '/deep NVDA')

  assert.deepEqual(parsePromptRouting('compare margins', { composerEffort: 'high' }), {
    cleanedInput: 'compare margins',
    modelClass: 'main',
    effort: 'high',
    explicit: true,
  })

  const withFile = parsePromptRouting('summarize this\n\n<attached_file name="10k.pdf">text</attached_file>')
  assert.equal(withFile.explicit, false)
  assert.equal(withFile.attachmentFloor, 'medium')
})

test('resolveStickyRoomTier preserves warm prefix caches within a sitting and allows re-tiering after an idle gap', () => {
  const t0 = 1_000_000
  const warmFast = { modelClass: 'fast' as const, effort: 'low' as const, createdAt: t0, lastActiveAt: t0 + 5_000 }
  // Promoting fast -> main mid-sitting succeeds and adopts the target effort
  assert.deepEqual(resolveStickyRoomTier(warmFast, { modelClass: 'main', effort: 'high' }, { now: t0 + 10_000 }), {
    modelClass: 'main',
    effort: 'high',
    changed: true,
  })

  const warmMain = { modelClass: 'main' as const, effort: 'medium' as const, createdAt: t0, lastActiveAt: t0 + 5_000 }
  // Mid-sitting downgrade main -> fast is ignored to keep Argon prefix cache warm
  assert.deepEqual(resolveStickyRoomTier(warmMain, { modelClass: 'fast', effort: 'low' }, { now: t0 + 10_000 }), {
    modelClass: 'main',
    effort: 'medium',
    changed: false,
  })
  // Mid-sitting non-explicit effort flip on warm main is also held steady so Vertex implicit cache is preserved
  assert.deepEqual(resolveStickyRoomTier(warmMain, { modelClass: 'main', effort: 'high' }, { now: t0 + 10_000 }), {
    modelClass: 'main',
    effort: 'medium',
    changed: false,
  })
  // Explicit /deep override immediately promotes effort even mid-sitting
  assert.deepEqual(
    resolveStickyRoomTier(warmMain, { modelClass: 'main', effort: 'high' }, { now: t0 + 10_000, explicit: true }),
    { modelClass: 'main', effort: 'high', changed: true },
  )
  // After an idle gap >= SITTING_IDLE_MS, cache is cold so re-tiering down or up is allowed
  assert.deepEqual(
    resolveStickyRoomTier(warmMain, { modelClass: 'fast', effort: 'low' }, { now: t0 + 5_000 + SITTING_IDLE_MS }),
    { modelClass: 'fast', effort: 'low', changed: true },
  )
})

test('shouldEscalateFastRun triggers deterministically on refusal, timeout, tool errors, excessive rounds, or prior failures', () => {
  assert.equal(shouldEscalateFastRun({ modelClass: 'fast', round: 1, toolErrors: 0 }), false)
  assert.equal(shouldEscalateFastRun({ modelClass: 'fast', round: 1, toolErrors: 0, refused: true }), true)
  assert.equal(shouldEscalateFastRun({ modelClass: 'fast', round: 1, toolErrors: 0, timedOut: true }), true)
  assert.equal(shouldEscalateFastRun({ modelClass: 'fast', round: 2, toolErrors: 2 }), true)
  assert.equal(shouldEscalateFastRun({ modelClass: 'fast', round: 5, toolErrors: 0 }), true)
  assert.equal(shouldEscalateFastRun({ modelClass: 'fast', round: 1, toolErrors: 0, priorFailures: 1 }), true)
  assert.equal(shouldEscalateFastRun({ modelClass: 'main', round: 8, toolErrors: 4, refused: true }), false)
})

test('weightedTaskTokens discounts fast background task tokens to 0.25x while keeping main and code at 1x', () => {
  assert.equal(weightedTaskTokens(1000, 'fast'), 250)
  assert.equal(weightedTaskTokens(1000, 'main'), 1000)
  assert.equal(weightedTaskTokens(1000, 'code'), 1000)
  assert.equal(weightedTaskTokens(0, 'fast'), 0)
})
