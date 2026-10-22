import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProviderSetting } from '../state'
import { settingChange, type SettingsNow } from './settings.ts'

const ANTHROPIC: ProviderSetting = {
  providerId: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-5',
  hasToken: true,
}
const NOW: SettingsNow = { workspaceId: 'w1', providers: { llm: ANTHROPIC, voice: null, search: null } }

test('an everyday setting is the action Settings dispatches, applied without asking', () => {
  assert.deepEqual(settingChange({ setting: 'theme', theme: 'dark' }, NOW), {
    action: { type: 'theme.set', theme: 'dark' },
    confirm: null,
    done: 'Theme set to dark.',
  })
  assert.deepEqual(settingChange({ setting: 'grid_size', cols: 20, rows: 10 }, NOW).action, {
    type: 'grid.setSize',
    workspaceId: 'w1',
    size: { cols: 20, rows: 10 },
  })
  assert.deepEqual(settingChange({ setting: 'skill', id: 'dcf', enabled: false }, NOW).action, {
    type: 'skill.setEnabled',
    id: 'dcf',
    enabled: false,
  })
  assert.equal(settingChange({ setting: 'open_at_login', enabled: true }, NOW).confirm, null)
})

test('removing a plugin and switching a provider are asked first', () => {
  const removed = settingChange({ setting: 'remove_plugin', id: 'alpaca' }, NOW)
  assert.deepEqual(removed.action, { type: 'plugin.remove', id: 'alpaca' })
  assert.match(removed.confirm!, /^Remove the plugin alpaca\?/)
  const model = settingChange({ setting: 'provider', kind: 'llm', model: 'claude-sonnet-5' }, NOW)
  assert.match(
    model.confirm!,
    /^Switch the language model to Anthropic, claude-sonnet-5\? The conversation goes on with it/,
  )
})

test('a provider switch keeps what is set on the same provider, takes the default on another, and carries no key', () => {
  const same = settingChange({ setting: 'provider', kind: 'llm', model: 'claude-sonnet-5' }, NOW)
  assert.deepEqual(same.action, {
    type: 'provider.set',
    kind: 'llm',
    input: { providerId: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', token: '' },
  })
  const other = settingChange({ setting: 'provider', kind: 'llm', provider: 'openai' }, NOW).action
  assert.ok(other.type === 'provider.set' && other.input.providerId === 'openai' && other.input.baseUrl !== '')
  const jaspers = settingChange({ setting: 'provider', kind: 'llm', provider: 'jaspers', model: 'openai/gpt-5.4' }, NOW)
  assert.deepEqual(jaspers, {
    action: {
      type: 'provider.set',
      kind: 'llm',
      input: {
        providerId: 'jaspers',
        baseUrl: 'https://account.jsprai.com/v1',
        model: 'gemini-4-argon',
        token: '',
      },
    },
    confirm: 'Switch the language model to Jaspers? The conversation goes on with it from the next request.',
    done: 'The language model is now Jaspers. The conversation goes on with it from the next request.',
  })
  assert.throws(
    () => settingChange({ setting: 'provider', kind: 'llm', provider: 'nope' }, NOW),
    /No language model provider nope/,
  )
  assert.throws(() => settingChange({ setting: 'provider', kind: 'voice' }, NOW), /Name the provider/)
})

test('a call that names no setting, or gives the wrong kind of value, is refused with what to give', () => {
  assert.throws(() => settingChange({ setting: 'pro_mode' }, NOW), /setting is one of theme, open_at_login/)
  assert.throws(() => settingChange({ setting: 'theme', theme: 'blue' }, NOW), /theme is one of system, light, dark/)
  assert.throws(() => settingChange({ setting: 'grid_size', cols: '20', rows: 10 }, NOW), /cols is a whole number/)
  assert.throws(() => settingChange({ setting: 'skill', id: 'dcf', enabled: 'yes' }, NOW), /enabled is true or false/)
})
