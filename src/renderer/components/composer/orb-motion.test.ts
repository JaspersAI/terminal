import assert from 'node:assert/strict'
import { test } from 'node:test'
import { orbBaseScale, orbVibration } from './orb-motion.ts'

test('idle orb rests without light vibration and scales up only when hovered', () => {
  assert.equal(orbBaseScale('idle', false), 1)
  assert.equal(orbBaseScale('idle', true), 1.08)

  const rest = orbVibration('idle', 500, 0.8)
  assert.equal(rest.active, false)
  assert.equal(rest.scaleOffset, 0)
  assert.equal(rest.haloOpacity, 0)
  assert.equal(rest.waveOpacity, 0)
  assert.equal(rest.glossX, 32)
  assert.equal(rest.glossY, 26)
})

test('pressing the orb to listen produces a continuous light vibration that varies over time even in silence', () => {
  assert.equal(orbBaseScale('opening', false), 0.94)
  assert.equal(orbBaseScale('recording', false), 1.14)

  const t0 = orbVibration('recording', 0, 0)
  const t1 = orbVibration('recording', 180, 0)
  const t2 = orbVibration('recording', 410, 0)

  assert.equal(t0.active, true)
  assert.equal(t1.active, true)
  assert.ok(t0.haloOpacity > 0.3, `expected visible luminous halo at t0, got ${t0.haloOpacity}`)
  assert.ok(t1.waveOpacity > 0.15, `expected visible outer light wave at t1, got ${t1.waveOpacity}`)
  assert.ok(t1.haloScale > 1 && t1.waveScale > 1, 'expected aura layers to expand around the orb')

  // Unlike the static ring, the vibration moves continuously over time across scale, halo, and gloss.
  assert.notEqual(t0.haloScale, t1.haloScale)
  assert.notEqual(t1.haloOpacity, t2.haloOpacity)
  assert.notEqual(t0.glossX, t1.glossX)
  assert.notEqual(t0.glossY, t1.glossY)
  assert.notEqual(t0.scaleOffset, t1.scaleOffset)
})

test('voice audio energy amplifies the recording orb light vibration and scale pulse', () => {
  const quiet = orbVibration('recording', 250, 0)
  const loud = orbVibration('recording', 250, 0.9)

  assert.ok(loud.scaleOffset > quiet.scaleOffset)
  assert.ok(loud.haloScale > quiet.haloScale)
  assert.ok(loud.haloOpacity > quiet.haloOpacity)
  assert.ok(loud.waveScale > quiet.waveScale)
  assert.ok(loud.rimGlow > quiet.rimGlow)
})

test('transcribing and thinking keep a gentle luminous pulse without fading the sphere', () => {
  assert.equal(orbBaseScale('transcribing', false), 1.04)
  assert.equal(orbBaseScale('thinking', false), 1.04)

  const a = orbVibration('transcribing', 100, 0)
  const b = orbVibration('transcribing', 550, 0)
  assert.equal(a.active, true)
  assert.ok(a.haloOpacity > 0.2)
  assert.notEqual(a.haloOpacity, b.haloOpacity)
  assert.notEqual(a.glossX, b.glossX)
})
