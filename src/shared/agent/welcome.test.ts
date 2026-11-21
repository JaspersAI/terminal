import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkMemory } from './memory.ts'
import {
  buildOnboardingProfile,
  EMPTY_ONBOARDING_ANSWERS,
  ONBOARDING_QUESTIONS,
  parseWatchlistTickers,
  profileReplyFor,
  readOnboardingAction,
  readSavedOnboarding,
  savedOnboarding,
  WELCOME_NOTE,
  welcomeIntroFor,
} from './welcome.ts'

test('the welcome intro greets by name and names the controls it says to use', () => {
  const intro = welcomeIntroFor('Seth')
  assert.match(intro, /Welcome to Jaspers Terminal, Seth\./)
  assert.match(intro, /\*\*Orb\*\*/)
  assert.match(intro, /\*\*Dock\*\*/)
  assert.match(intro, /Jaspers Hub/)
  assert.match(welcomeIntroFor(''), /\*\*Welcome to Jaspers Terminal\.\*\*/)
})

test('the welcome note is one parenthesized line, the shape the transcript tells apart from typing', () => {
  assert.match(WELCOME_NOTE, /^\(.*\)$/s)
  assert.doesNotMatch(WELCOME_NOTE, /\n/)
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
  // In a phrase, only a word written as a symbol is one.
  assert.deepEqual(parseWatchlistTickers('NVDA, TSM and the CPI print'), ['NVDA', 'TSM'])
  assert.deepEqual(parseWatchlistTickers('I like big tech'), [])
  assert.deepEqual(parseWatchlistTickers('long $f and GOOGL'), ['F', 'GOOGL'])
})

test('starter rooms name only the tickers the user gave', () => {
  const macroOnly = buildOnboardingProfile({ ...EMPTY_ONBOARDING_ANSWERS, style: ['macro'] })
  assert.equal(macroOnly.rooms[0]?.id, 'macro-yield-curve')
  for (const profile of [macroOnly, buildOnboardingProfile(EMPTY_ONBOARDING_ANSWERS)]) {
    const text = JSON.stringify(profile.rooms)
    assert.doesNotMatch(text, /NVDA|MSFT|AAPL/)
    assert.ok(!profile.rooms.some((r) => r.id === 'filing-deep-dive' || r.id === 'trading-flow-desk'))
  }
  const one = buildOnboardingProfile({ ...EMPTY_ONBOARDING_ANSWERS, style: ['trading'], focusText: 'AMD' })
  const desk = one.rooms.find((r) => r.id === 'trading-flow-desk')
  assert.match(desk?.title ?? '', /^AMD /)
  assert.doesNotMatch(JSON.stringify(one.rooms), /MSFT|AAPL|tracking/)
})

test('onboarding left partway reads back off state.json, and anything else is nothing to resume', () => {
  const onboarding = {
    step: 1 as const,
    answers: { style: ['macro'], coverage: [], workflows: [], focusText: 'TLT' },
    profile: null,
    startedRooms: { 'macro-yield-curve': 'Room 1' },
  }
  const saved = savedOnboarding('w1', onboarding)
  assert.deepEqual(readSavedOnboarding(JSON.parse(JSON.stringify(saved))), saved)
  assert.equal(readSavedOnboarding(undefined), null)
  assert.equal(readSavedOnboarding({ ...saved, step: 3 }), null)
  assert.equal(readSavedOnboarding({ ...saved, workspaceId: '' }), null)
  assert.equal(readSavedOnboarding({ ...saved, answers: { ...saved.answers, style: 'macro' } }), null)
  assert.equal(readSavedOnboarding({ ...saved, startedRooms: { x: 1 } }), null)
  assert.deepEqual(
    readSavedOnboarding({ ...saved, answers: { ...saved.answers, style: ['macro', 'bogus'] } })?.answers.style,
    ['macro'],
  )
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
