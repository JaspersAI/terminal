import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uvFile } from './uv.ts'

test('uv and uvx are the app’s own, with Windows’ .exe; any other command is left to PATH', () => {
  assert.equal(uvFile('uv', 'darwin'), 'uv')
  assert.equal(uvFile('uvx', 'darwin'), 'uvx')
  assert.equal(uvFile('uv', 'win32'), 'uv.exe')
  assert.equal(uvFile('uvx', 'win32'), 'uvx.exe')
  for (const command of ['python', 'npx', 'uv.exe', '/usr/local/bin/uv', 'UV'])
    assert.equal(uvFile(command, 'darwin'), null)
})
