import assert from 'node:assert/strict'
import { test } from 'node:test'
import { builderRound, builderSystem, type BuildRun, type Reference } from './prompt.ts'

const reference: Reference = {
  sdk: '# SDK reference\n\ndefinePlugin does things.',
  tutorial: '# Writing a plugin\n\nA watchlist.',
  types: [
    { path: 'context.ts', content: 'export interface BackendContext {\n  jobs: Jobs\n}\n' },
    { path: 'llm.ts', content: 'export interface Completion {\n  text: string\n}\n' },
  ],
  templates: [
    {
      name: 'feed',
      files: [
        { path: 'plugin.tsx', content: 'export default definePlugin({ id: "feed" })' },
        { path: 'package.json', content: '{"name":"feed"}' },
      ],
    },
  ],
}

const run: BuildRun = {
  request: 'chart the 10 year treasury yield from FRED',
  id: 'fred',
  taken: ['yfinance', 'screener'],
  search: true,
  platform: 'darwin',
  live: false,
  begun: false,
  built: [],
}

test('the first block is the same for every run, and the second is the run', () => {
  const [fixed, dynamic] = builderSystem(reference, run)
  const [again, other] = builderSystem(reference, { ...run, request: 'a PDF of the memo', id: 'memo-pdf' })
  assert.equal(fixed, again)
  assert.notEqual(dynamic, other)
  assert.match(dynamic!, /chart the 10 year treasury yield from FRED/)
  assert.match(dynamic!, /The plugin id: fred\./)
  assert.match(dynamic!, /Ids already taken: yfinance, screener\./)
  assert.match(dynamic!, /darwin/)
})

test('the fixed block carries the procedure, the rules, the templates whole, and the docs', () => {
  const [fixed] = builderSystem(reference, run)
  assert.match(fixed!, /You are the builder inside Jaspers Terminal/)
  assert.match(fixed!, /1\. /)
  assert.match(fixed!, /install_plugin/)
  assert.match(fixed!, /run_source/)
  assert.match(fixed!, /--- feed\/plugin\.tsx ---\nexport default definePlugin\(\{ id: "feed" \}\)\n/)
  assert.match(fixed!, /--- feed\/package\.json ---\n\{"name":"feed"\}\n/)
  assert.match(fixed!, /# SDK reference\n\ndefinePlugin does things\./)
  assert.match(fixed!, /# Writing a plugin\n\nA watchlist\./)
})

test("the fixed block carries the SDK's own types for ctx, each file whole under its name, after the docs that name them", () => {
  const [fixed] = builderSystem(reference, run)
  assert.match(fixed!, /--- context\.ts ---\nexport interface BackendContext \{\n {2}jobs: Jobs\n\}\n/)
  assert.match(fixed!, /--- llm\.ts ---\nexport interface Completion \{\n {2}text: string\n\}\n/)
  const docs = fixed!.indexOf('## SDK reference')
  const types = fixed!.indexOf('## SDK types')
  const tutorial = fixed!.indexOf('## Writing a plugin, the tutorial')
  assert.ok(docs > 0 && docs < types && types < tutorial, 'the docs, the types, the tutorial')
  // Told they are the SDK's, and where a helper of its own gets ctx's type from, so it writes none.
  assert.match(fixed!, /its own types for everything ctx gives/)
  assert.match(fixed!, /import type \{ BackendContext \} from '@jaspers-ai\/sdk'/)
})

test('the procedure builds in small steps: the shell, the install, then each piece filled in, built, and run', () => {
  const [fixed] = builderSystem(reference, run)
  const shell = fixed!.indexOf('Write the shell first')
  const install = fixed!.indexOf('Call install_plugin on the shell')
  const fill = fixed!.indexOf('Fill the shell in with edit_file')
  const runs = fixed!.indexOf('run_source it in the next round')
  assert.ok(
    shell > 0 && shell < install && install < fill && fill < runs,
    'the shell, the install, the filling, the runs',
  )
  // A shell builds and does nothing yet, and says so when it is run.
  assert.match(fixed!, /not written yet/)
  // The user is asked once, on the shell, for all the finished plugin will reach; more is asked for when it is needed.
  assert.match(fixed!, /everything the finished plugin will reach/)
  assert.match(fixed!, /call install_plugin again with the whole list/)
  // Filled a piece at a time, by edits, each one built before the next, and no further than the request needs.
  assert.match(fixed!, /one piece a round/)
  assert.match(fixed!, /Call check_plugin after each piece/)
  assert.match(fixed!, /Never write several long pieces in one reply/)
  assert.match(fixed!, /when it is needed, not before/)
  assert.match(fixed!, /edit_file replaces one passage of a file and leaves the rest as it is/)
  assert.match(fixed!, /Fix those lines with edit_file/)
  // One short file is written whole: a shell of it would be the same write twice.
  assert.match(fixed!, /has no shell/)
  // Numbered through, so a step that names another by its number names the right one.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.match(fixed!, new RegExp(`\\n${n}\\. `))
  assert.doesNotMatch(fixed!, /\n9\. /)
  assert.match(fixed!, /\n4\. Call install_plugin on the shell/)
  assert.match(fixed!, /step 5 has nothing left to fill/)
  // And the builder is who it is told it is: the shell, the approval, then the filling.
  assert.match(fixed!, /write that plugin's shell, install it with the user's approval, then fill it in/)
})

test('finding the API starts from the Markdown documentation sites serve, and says when to stop', () => {
  const [fixed] = builderSystem(reference, run)
  assert.match(fixed!, /\/llms\.txt/)
  assert.match(fixed!, /\.md on the end/)
  assert.match(fixed!, /drawn by JavaScript/)
  assert.match(fixed!, /Stop reading/)
  // A plugin built here before for the same service comes before the web; a key never carries over.
  assert.match(fixed!, /built here before/)
  assert.match(fixed!, /its own keys/)
})

test('the plugins built here before are listed with what each is for, and how to read them', () => {
  const [, dynamic] = builderSystem(reference, {
    ...run,
    built: [
      { id: 'databento', purpose: 'Databento OPRA options quotes.' },
      { id: 'rates', purpose: '' },
    ],
  })
  assert.match(dynamic!, /list_files and read_file/)
  assert.match(dynamic!, /\n- databento: Databento OPRA options quotes\.\n- rates\n/)
  const [, none] = builderSystem(reference, run)
  assert.doesNotMatch(none!, /built here before/)
})

test('without search the run says to fetch known addresses or ask; a live plugin says edits rebuild it', () => {
  const [, dynamic] = builderSystem(reference, { ...run, search: false })
  assert.match(dynamic!, /No search provider is set/)
  assert.doesNotMatch(dynamic!, /search_web is available/)
  const [, withSearch] = builderSystem(reference, run)
  assert.match(withSearch!, /search_web is available/)
  const [, live] = builderSystem(reference, { ...run, live: true })
  assert.match(live!, /installed already/)
  const [, fresh] = builderSystem(reference, run)
  assert.match(fresh!, /nothing is built or run until install_plugin/)
})

test('a build that carries on from one that never installed is told its folder holds what that one wrote', () => {
  const [, fresh] = builderSystem(reference, run)
  assert.match(fresh!, /Its folder is empty/)
  const [, begun] = builderSystem(reference, { ...run, begun: true })
  assert.doesNotMatch(begun!, /Its folder is empty/)
  assert.match(begun!, /earlier build of it ended before it was installed/)
  assert.match(begun!, /carry on from/)
  assert.match(begun!, /nothing is built or run until install_plugin/i)
  // Installed is installed, however the build before it ended.
  const [, live] = builderSystem(reference, { ...run, live: true, begun: true })
  assert.match(live!, /installed already/)
  assert.doesNotMatch(live!, /earlier build of it ended/)
})

test('a No ends the request it answered, not every request after it', () => {
  const [fixed] = builderSystem(reference, run)
  assert.match(fixed!, /A No from the user is final for the request it answered/)
  assert.match(fixed!, /until a new request comes/)
})

test('a round says what the folder holds and what the tree says of the plugin', () => {
  assert.equal(
    builderRound('plugin.tsx 2.1 KB\npackage.json 0.2 KB', 'fred: ready (v1), sources fred/series'),
    'Folder:\nplugin.tsx 2.1 KB\npackage.json 0.2 KB\n\nPlugin: fred: ready (v1), sources fred/series',
  )
})
