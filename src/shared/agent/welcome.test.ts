import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkMemory } from './memory.ts'
import {
  buildOnboardingProfile,
  EMPTY_ONBOARDING_ANSWERS,
  EXAMPLE_ASK,
  EXPLANATION,
  GREETING,
  greetingFor,
  ONBOARDING_QUESTIONS,
  parseWatchlistTickers,
  profileReplyFor,
  readOnboardingAction,
  WELCOME_NOTE,
  welcomeIntroFor,
} from './welcome.ts'

test('the explanation and welcome intro cover voice Orb, Dock, and the core README capabilities', () => {
  assert.match(EXPLANATION, /hold the orb/)
  assert.match(EXPLANATION, /Dock/)
  assert.ok(EXPLANATION.indexOf('talk') < EXPLANATION.indexOf('Typing'))

  const intro = welcomeIntroFor('Seth')
  assert.match(intro, /Welcome to Jaspers Terminal, Seth\./)
  assert.match(intro, /100×100 Grid & Isolated Rooms/)
  assert.match(intro, /jaspers\.db/)
  assert.match(intro, /Jaspers Hub/)
  assert.match(intro, /build_plugin/)
  assert.match(intro, /speak: "changed"/)
  assert.match(welcomeIntroFor(''), /\*\*Welcome to Jaspers Terminal\.\*\*/)
})

test('the notes are one parenthesized line each, the shape the transcript tells apart from typing', () => {
  for (const note of [WELCOME_NOTE, EXAMPLE_ASK]) {
    assert.match(note, /^\(.*\)$/s)
    assert.doesNotMatch(note, /\n/)
  }
  assert.notEqual(GREETING, '')
  assert.equal(greetingFor('Seth'), 'Hi Seth, I’m Jaspers, the assistant in this terminal. Welcome.')
  assert.equal(greetingFor(''), GREETING)
})

test('onboarding questions highlight core terminal concepts across 3 skippable steps', () => {
  assert.equal(ONBOARDING_QUESTIONS.length, 3)
  assert.deepEqual(
    ONBOARDING_QUESTIONS.map((q) => q.id),
    ['style', 'coverage', 'workflows'],
  )
  for (const question of ONBOARDING_QUESTIONS) {
    assert.ok(question.title.length > 0)
    assert.ok(question.highlight.length > 0)
    assert.equal(question.choices.length, 4)
  }
  assert.ok(ONBOARDING_QUESTIONS[1]?.focusPlaceholder)
})

test('parseWatchlistTickers extracts clean uppercase ticker symbols without matching macro acronyms or prose', () => {
  assert.deepEqual(parseWatchlistTickers('$nvda, MSFT; BRK.B semis CPI FED'), ['NVDA', 'MSFT', 'BRK.B'])
  assert.deepEqual(parseWatchlistTickers('nvda, msft, tsm'), ['NVDA', 'MSFT', 'TSM'])
  assert.deepEqual(parseWatchlistTickers('semiconductors and software'), [])
  assert.deepEqual(parseWatchlistTickers('semiconductors and NVDA'), ['NVDA'])
})

test('buildOnboardingProfile tailors memory, Hub plugin suggestions, and starter rooms by investor profile', () => {
  const equityProfile = buildOnboardingProfile(
    {
      style: ['fundamental'],
      coverage: ['us-equities'],
      workflows: ['filings-screen'],
      focusText: 'NVDA, TSM, semis',
    },
    { signedIn: true, installedPlugins: ['screener-mcp', 'agents'] },
  )
  assert.equal(equityProfile.answered, true)
  assert.deepEqual(equityProfile.tickers, ['NVDA', 'TSM'])
  assert.match(equityProfile.headline, /Fundamental & Equities/)
  assert.ok(equityProfile.memory !== null)
  assert.equal(checkMemory(equityProfile.memory.name, equityProfile.memory.about, equityProfile.memory.body), null)
  // Since screener-mcp and agents are already installed, uninstalled top matches surface first.
  assert.ok(equityProfile.plugins.some((p) => p.name === 'sec'))
  assert.ok(equityProfile.plugins.some((p) => p.name === 'yfinance'))
  assert.equal(equityProfile.rooms.length, 3)
  assert.equal(equityProfile.rooms[0]?.id, 'filing-deep-dive')
  assert.match(equityProfile.rooms[0]?.title ?? '', /NVDA/)
  assert.match(profileReplyFor(equityProfile), /NVDA Filing & Fundamentals/)

  const macroProfile = buildOnboardingProfile({
    style: ['macro'],
    coverage: ['rates-fiscal', 'global-macro'],
    workflows: ['watches-skills'],
    focusText: '',
  })
  assert.ok(macroProfile.plugins.some((p) => p.name === 'fed'))
  assert.ok(macroProfile.plugins.some((p) => p.name === 'treasury' || p.name === 'bls'))
  assert.equal(macroProfile.rooms[0]?.id, 'macro-yield-curve')

  const tradingProfile = buildOnboardingProfile({
    style: ['trading'],
    coverage: ['positioning'],
    workflows: ['charts-browser'],
    focusText: '$SPY, QQQ',
  })
  assert.ok(tradingProfile.plugins.some((p) => p.name === 'tradingview'))
  assert.ok(tradingProfile.plugins.some((p) => p.name === 'cftc' || p.name === 'finra'))
  assert.equal(tradingProfile.rooms[0]?.id, 'trading-flow-desk')
  assert.ok(tradingProfile.rooms.some((r) => r.id === 'live-market-browser'))

  const builderProfile = buildOnboardingProfile({
    style: ['quant'],
    coverage: [],
    workflows: ['builder-shell'],
    focusText: '',
  })
  assert.ok(builderProfile.rooms.some((r) => r.id === 'sqlite-watch-lab'))
  assert.ok(builderProfile.rooms.some((r) => r.id === 'custom-plugin-studio'))

  const skippedProfile = buildOnboardingProfile(EMPTY_ONBOARDING_ANSWERS)
  assert.equal(skippedProfile.answered, false)
  assert.equal(skippedProfile.memory, null)
  assert.equal(skippedProfile.plugins.length, 4)
  assert.equal(skippedProfile.rooms.length, 3)
})

test('readOnboardingAction validates steps, filters unknown choice ids, and rejects malformed payloads', () => {
  assert.deepEqual(readOnboardingAction({ kind: 'answer', step: 0, selected: ['fundamental', 'bogus', 'macro'] }), {
    kind: 'answer',
    step: 0,
    selected: ['fundamental', 'macro'],
  })
  assert.deepEqual(readOnboardingAction({ kind: 'skip-question', step: 1, focusText: 'AAPL' }), {
    kind: 'skip-question',
    step: 1,
    focusText: 'AAPL',
  })
  assert.deepEqual(readOnboardingAction({ kind: 'back' }), { kind: 'back' })
  assert.deepEqual(readOnboardingAction({ kind: 'skip-all' }), { kind: 'skip-all' })
  assert.deepEqual(readOnboardingAction({ kind: 'dismiss' }), { kind: 'dismiss' })
  assert.deepEqual(readOnboardingAction({ kind: 'start-room', roomId: 'filing-deep-dive' }), {
    kind: 'start-room',
    roomId: 'filing-deep-dive',
  })
  assert.throws(() => readOnboardingAction(null), /Malformed/)
  assert.throws(() => readOnboardingAction({ kind: 'answer', step: 5, selected: [] }), /Invalid/)
  assert.throws(() => readOnboardingAction({ kind: 'start-room', roomId: '   ' }), /Choose a starter room/)
})
