import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { isTheme, WINDOW_BACKGROUND } from './theme.ts'

test('a theme is system, light, or dark, and nothing else', () => {
  for (const theme of ['system', 'light', 'dark']) assert.equal(isTheme(theme), true, theme)
  for (const other of ['Dark', 'auto', '', null, undefined, 1]) assert.equal(isTheme(other), false, String(other))
})

test("a window paints the theme's own background before its page does", () => {
  const css = fs.readFileSync(new URL('../../host-runtime/theme.css', import.meta.url), 'utf8')
  const [light, dark] = [...css.matchAll(/--jaspers-background:\s*(#[0-9a-f]+)/g)].map((match) => match[1])
  assert.deepEqual(WINDOW_BACKGROUND, { light, dark })
})
