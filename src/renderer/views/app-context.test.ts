import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostStyles } from './app-context.ts'

/** The app's own variables, as a page's host would read them off the document. */
const THEME: Record<string, string> = {
  '--jaspers-background': '#0a0a0a',
  '--jaspers-foreground': ' #ededed ',
  '--jaspers-muted': '#1a1a1a',
  '--jaspers-muted-foreground': '#a3a3a3',
  '--jaspers-border': '#2a2a2a',
  '--jaspers-primary': '#ededed',
  '--jaspers-primary-foreground': '#0a0a0a',
  '--jaspers-destructive': '#f87171',
  '--jaspers-positive': '#4ade80',
  '--jaspers-font-sans': 'ui-sans-serif, system-ui',
  '--jaspers-font-mono': 'ui-monospace, Menlo',
}

test("a page is handed the app's colors and faces under the names the extension gives them", () => {
  const styles = hostStyles((name) => THEME[name] ?? '')
  const wants: [string, string][] = [
    ['--color-background-primary', '#0a0a0a'],
    ['--color-background-secondary', '#1a1a1a'],
    ['--color-background-inverse', '#ededed'],
    ['--color-text-primary', '#ededed'],
    ['--color-text-secondary', '#a3a3a3'],
    ['--color-text-inverse', '#0a0a0a'],
    ['--color-text-danger', '#f87171'],
    ['--color-text-success', '#4ade80'],
    ['--color-border-primary', '#2a2a2a'],
    ['--color-border-danger', '#f87171'],
    ['--color-ring-primary', '#ededed'],
    ['--font-sans', 'ui-sans-serif, system-ui'],
    ['--font-mono', 'ui-monospace, Menlo'],
  ]
  for (const [name, want] of wants) assert.equal(styles[name], want, name)
})

test('corners are square, as the app draws everything', () => {
  const styles = hostStyles(() => '')
  for (const size of ['xs', 'sm', 'md', 'lg', 'xl', 'full'])
    assert.equal(styles[`--border-radius-${size}`], '0px', size)
  assert.equal(styles['--border-width-regular'], '1px')
})

test('a name the app has no color for is left out, so the page keeps its own', () => {
  const styles = hostStyles((name) => (name === '--jaspers-background' ? '#ffffff' : ''))
  assert.equal(styles['--color-background-primary'], '#ffffff')
  assert.equal('--color-text-primary' in styles, false)
  assert.equal('--color-background-warning' in styles, false)
  assert.equal('--font-sans' in styles, false)
})
