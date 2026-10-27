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

test('the procedure asks for approval first, writes complete files in a single pass with plugin.tsx last, and validates on each save', () => {
  const [fixed] = builderSystem(reference, run)
  const install = fixed!.indexOf('Call install_plugin before writing code')
  const write = fixed!.indexOf('Write the complete files in a single pass with write_file')
  const runs = fixed!.indexOf('run_source it in the next round')
  const fix = fixed!.indexOf('Fix those lines with edit_file')
  assert.ok(
    install > 0 && install < write && write < runs && runs < fix,
    'approval first, complete files written, sources run, errors fixed',
  )
  // Asks once up front for everything the plugin will reach, including shell: true for ~/Jaspers/shell.
  assert.match(fixed!, /everything the finished plugin will reach/)
  assert.match(fixed!, /shell: true/)
  assert.match(fixed!, /~\/Jaspers\/shell/)
  assert.match(fixed!, /Call install_plugin again only when/)
  // Complete files in one pass with plugin.tsx last, rather than not-written-yet shells.
  assert.match(fixed!, /plugin\.tsx last/)
  assert.match(fixed!, /rather than throwing not written yet shells/)
  // Automatic validation on each save from write_file and edit_file.
  assert.match(fixed!, /each write_file and edit_file save automatically rebuilds/)
  assert.match(fixed!, /edit_file replaces one passage of a file and leaves the rest as it is/)
  // Shell-prepared files are read through ctx.files with shell: paths.
  assert.match(fixed!, /ctx\.files/)
  assert.match(fixed!, /shell:/)
  // Numbered through, so a step that names another by its number names the right one.
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.match(fixed!, new RegExp(`\\n${n}\\. `))
  assert.doesNotMatch(fixed!, /\n8\. /)
  // And the builder is who it is told it is: approval first, complete files with plugin.tsx last, validated on save.
  assert.match(
    fixed!,
    /get the user's approval with install_plugin before writing code, write the plugin's complete files with write_file \(plugin\.tsx last\) while the app validates each save automatically/,
  )
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

test('the builder is told to recall coding memories and save lessons with remember when it hits issues, self-corrects, or is corrected', () => {
  const [fixed, withoutMemories] = builderSystem(reference, run)
  assert.match(fixed!, /\brecall\b/)
  assert.match(fixed!, /\bremember\b/)
  assert.match(fixed!, /correct yourself|corrected/i)
  assert.doesNotMatch(withoutMemories!, /earlier plugin builds/)

  const [fixedWith, withMemories] = builderSystem(reference, {
    ...run,
    memories: [
      { name: 'older-quirk', about: 'An older endpoint note', at: 1 },
      { name: 'fred-dates', about: 'FRED series observations require YYYY-MM-DD dates', at: 5 },
    ],
  })
  // Coding memories ride in the run's dynamic block so the cached static block never changes.
  assert.equal(fixedWith, fixed)
  assert.match(withMemories!, /What you learned from earlier plugin builds/)
  assert.match(
    withMemories!,
    /- fred-dates: FRED series observations require YYYY-MM-DD dates\n- older-quirk: An older endpoint note/,
  )
})
