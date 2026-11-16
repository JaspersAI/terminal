import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SettingsPane } from '../../shared/agent/settings.ts'
import { onOpenSettingsPane, openSettings } from './settings-nav.ts'

test('openSettings tells whoever is listening the pane asked for, and nobody once they stop', () => {
  const seen: SettingsPane[] = []
  const off = onOpenSettingsPane((pane) => seen.push(pane))
  openSettings('team')
  openSettings('llm')
  off()
  openSettings('team')
  assert.deepEqual(seen, ['team', 'llm'])
})
