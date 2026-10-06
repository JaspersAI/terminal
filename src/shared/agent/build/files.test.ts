import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BUILD_LIMITS, checkBuildContent, checkBuildPath, describeFolder, replaceOnce, sizeText } from './files.ts'

test('a relative path with a code extension is its segments', () => {
  assert.deepEqual(checkBuildPath('plugin.tsx'), ['plugin.tsx'])
  assert.deepEqual(checkBuildPath('views/Table.tsx'), ['views', 'Table.tsx'])
  assert.deepEqual(checkBuildPath('./styles.css'), ['styles.css'])
  assert.deepEqual(checkBuildPath('package.json'), ['package.json'])
})

test('a path that is not a string, empty, absolute, or leaving the folder is refused', () => {
  assert.throws(() => checkBuildPath(7), /A path is a string/)
  assert.throws(() => checkBuildPath(''), /A path is a string/)
  assert.throws(() => checkBuildPath('../../.zshrc'), /leaves the plugin's folder/)
  assert.throws(() => checkBuildPath('views/../../x.ts'), /leaves the plugin's folder/)
  assert.throws(() => checkBuildPath('/etc/passwd'), /absolute/)
  assert.throws(() => checkBuildPath('C:/x.ts'), /absolute/)
  assert.throws(() => checkBuildPath('a\\b.ts'), /not a path/)
  assert.throws(() => checkBuildPath('a\0b.ts'), /not a path/)
})

test('node_modules, hidden names, and unknown extensions are refused', () => {
  assert.throws(() => checkBuildPath('node_modules/x.js'), /node_modules/)
  assert.throws(() => checkBuildPath('.jaspers-build.json'), /starts with a dot/)
  assert.throws(() => checkBuildPath('views/.hidden.ts'), /starts with a dot/)
  assert.throws(() => checkBuildPath('plugin.exe'), /ts, tsx, js/)
  assert.throws(() => checkBuildPath('Makefile'), /ts, tsx, js/)
})

test('content has to be text within the limit, and package.json has to parse', () => {
  assert.equal(checkBuildContent(['plugin.tsx'], 'export {}'), 'export {}')
  assert.throws(() => checkBuildContent(['plugin.tsx'], 7), /content is the file's text/)
  assert.throws(() => checkBuildContent(['plugin.tsx'], 'x'.repeat(BUILD_LIMITS.fileBytes + 1)), /200 KB/)
  assert.throws(() => checkBuildContent(['package.json'], '{ not json'), /package.json has to be JSON/)
  assert.equal(checkBuildContent(['package.json'], '{"name":"x"}'), '{"name":"x"}')
})

test('a folder is described one file a line with its size', () => {
  assert.equal(describeFolder([]), '(no files yet)')
  assert.equal(
    describeFolder([
      { path: 'plugin.tsx', size: 2150 },
      { path: 'styles.css', size: 512 },
    ]),
    'plugin.tsx 2.1 KB\nstyles.css 0.5 KB',
  )
  assert.equal(sizeText(100), '0.1 KB')
  assert.equal(sizeText(1024 * 1024 * 3), '3.0 MB')
})

test('one passage of a file is replaced where it stands, and the rest is left as it is', () => {
  const shell = "a()\nthrow new Error('not written yet')\nb()\n"
  assert.equal(replaceOnce(shell, "throw new Error('not written yet')", 'return 1'), 'a()\nreturn 1\nb()\n')
  // What goes in is taken as written: a $& is text, not the passage it replaces.
  assert.equal(replaceOnce('x = OLD', 'OLD', '`${a}$&$1`'), 'x = `${a}$&$1`')
  // Nothing in its place takes the passage out.
  assert.equal(replaceOnce('keep drop keep', ' drop', ''), 'keep keep')
})

test('a passage that is not in the file, or is there more than once, is refused, and so is a change of nothing', () => {
  assert.throws(() => replaceOnce('abc', 'x', 'y'), /is not in the file/)
  assert.throws(() => replaceOnce('a a a', 'a', 'b'), /in the file 3 times/)
  assert.throws(() => replaceOnce('abc', '', 'y'), /old is the passage/)
  assert.throws(() => replaceOnce('abc', 7, 'y'), /old is the passage/)
  assert.throws(() => replaceOnce('abc', 'a', 7), /new is the text/)
  assert.throws(() => replaceOnce('abc', 'a', 'a'), /the same/)
})
