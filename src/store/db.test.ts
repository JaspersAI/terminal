import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { checkQuery } from '../shared/data/store.ts'
import { openStore, StoreVersionError, type Store } from './db.ts'

const folders: string[] = []
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

function store(): { store: Store; file: string } {
  const folder = mkdtempSync(path.join(tmpdir(), 'jaspers-store-'))
  folders.push(folder)
  const file = path.join(folder, 'data', 'jaspers.db')
  return { store: openStore(file), file }
}

const run = (over: Partial<Parameters<Store['record']>[0]> = {}): Parameters<Store['record']>[0] => ({
  source: 'yfinance/quotes',
  args: '{"symbols":["AAPL"]}',
  argsHash: 'h1',
  workspace: 'w1',
  fetchedAt: 1_700_000_000_000,
  rows: [{ symbol: 'AAPL', price: 231.4 }],
  meta: null,
  text: null,
  error: null,
  ...over,
})

test('a run with rows comes back, with what was asked and of whom', () => {
  const { store: db } = store()
  const id = db.record(run())
  const { columns, rows } = db.query({
    sql: "select r.source, r.workspace, json_extract(d.data,'$.symbol') sym, json_extract(d.data,'$.price') px from runs r join run_rows d on d.run_id = r.id",
  })
  assert.deepEqual(columns, ['source', 'workspace', 'sym', 'px'])
  assert.deepEqual(rows, [['yfinance/quotes', 'w1', 'AAPL', 231.4]])
  assert.ok(id > 0)
  db.close()
})

test('a run that answered with text, and one that failed, are both kept', () => {
  const { store: db } = store()
  db.record(run({ rows: null, text: 'Revenue rose 12%.', source: 'fmp/news' }))
  db.record(run({ rows: null, error: 'the server refused the call', source: 'fmp/news' }))
  const { rows } = db.query({ sql: 'select row_count, text, error from runs order by id' })
  assert.deepEqual(rows, [
    [0, 'Revenue rose 12%.', null],
    [0, null, 'the server refused the call'],
  ])
  db.close()
})

test('two providers that name a field differently are joined in the query', () => {
  const { store: db } = store()
  db.record(run({ source: 'yfinance/statements', rows: [{ symbol: 'AAPL', revenue: 391_035 }] }))
  db.record(run({ source: 'fmp/statements', rows: [{ ticker: 'AAPL', revenue: 391_040 }] }))
  const { rows } = db.query({
    sql: `select coalesce(json_extract(d.data,'$.symbol'), json_extract(d.data,'$.ticker')) sym,
                 count(*) n, max(json_extract(d.data,'$.revenue')) - min(json_extract(d.data,'$.revenue')) gap
          from run_rows d group by sym`,
  })
  assert.deepEqual(rows, [['AAPL', 2, 5]])
  db.close()
})

test('a nested array is summed where it lies', () => {
  const { store: db } = store()
  db.record(
    run({
      rows: [
        {
          symbol: 'AAPL',
          segments: [
            { name: 'iPhone', revenue: 201 },
            { name: 'Mac', revenue: 29 },
          ],
        },
      ],
    }),
  )
  const { rows } = db.query({
    sql: "select (select sum(json_extract(value,'$.revenue')) from run_rows d2, json_each(d2.data,'$.segments')) total from run_rows limit 1",
  })
  assert.deepEqual(rows, [[230]])
  db.close()
})

test('text a source answered with is found by phrase and quoted back with its run', () => {
  const { store: db } = store()
  const id = db.record(
    run({
      source: 'sec/sections',
      rows: null,
      text: 'We derive a substantial portion of revenue from the federal government.',
    }),
  )
  db.record(run({ source: 'sec/sections', rows: null, text: 'Our largest customer accounted for 18% of net sales.' }))
  const { rows } = db.query({
    sql: "select rowid, snippet(docs, 0, '[', ']', '…', 6) from docs where docs match 'federal government'",
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]![0], id)
  assert.match(String(rows[0]![1]), /\[federal\] \[government\]/)
  db.close()
})

test('the connection query runs on is read only, and cannot reach another file', () => {
  const { store: db } = store()
  db.record(run())
  assert.throws(() => db.query({ sql: 'select 1; delete from runs' }), /One statement at a time/)
  assert.throws(() => db.query({ sql: 'delete from runs' }), /Only SELECT/)
  // `with … insert` is one statement and begins with `with`, so the text rule lets it by; the
  // connection is what refuses it. Both locks matter, and this is the one that catches the rest.
  assert.throws(
    () =>
      db.query({
        sql: "with x as (select 1) insert into runs (source, args, args_hash, fetched_at, row_count) select 'x', '', '', 0, 0",
      }),
    /readonly/i,
  )
  // `attach` does not begin a select, so the rule refuses it before SQLite is asked.
  assert.throws(() => db.query({ sql: "attach database '/tmp/other.db' as other" }), /Only SELECT/)
  assert.equal(db.query({ sql: 'select count(*) from runs' }).rows[0]![0], 1)
  db.close()
})

test('a select is allowed to hold a semicolon inside a string', () => {
  assert.equal(checkQuery("select 'a;b'"), null)
  assert.equal(checkQuery('select 1;'), null)
  assert.equal(checkQuery('  with x as (select 1) select * from x  '), null)
  assert.match(checkQuery('select 1 -- ;\n; select 2') ?? '', /One statement/)
  assert.match(checkQuery('') ?? '', /Write a SELECT/)
})

test('the rows asked for come whole, however much they hold', () => {
  const { store: db } = store()
  // Three hundred rows of four hundred characters: far more text than one answer used to carry.
  db.record(run({ rows: Array.from({ length: 300 }, (_, i) => ({ i, note: 'x'.repeat(400) })) }))
  const result = db.query({ sql: 'select idx, data from run_rows order by idx' })
  assert.equal(result.rowCount, 300)
  assert.equal(result.rows.length, 300)
  assert.equal(result.truncated, false)
  assert.equal(JSON.parse(String(result.rows[299]![1])).i, 299)
  db.close()
})

test('more rows than were asked for are cut, and say so', () => {
  const { store: db } = store()
  db.record(run({ rows: Array.from({ length: 50 }, (_, i) => ({ i })) }))
  const result = db.query({ sql: 'select idx from run_rows order by idx', limit: 10 })
  assert.equal(result.rowCount, 10)
  assert.equal(result.truncated, true)
  assert.equal(db.query({ sql: 'select idx from run_rows order by idx', limit: 100 }).truncated, false)
  db.close()
})

test('a second open reads the file it left, and a newer one is refused', () => {
  const { store: db, file } = store()
  db.record(run())
  db.close()
  const again = openStore(file)
  assert.equal(again.query({ sql: 'select count(*) from runs' }).rows[0]![0], 1)
  again.close()

  // Written by a version this app does not know.
  const raw = new DatabaseSync(file)
  raw.exec('pragma user_version = 99')
  raw.close()
  assert.throws(() => openStore(file), StoreVersionError)
})

test('stats count what went in, and name the sources seen', () => {
  const { store: db, file } = store()
  db.record(run({ source: 'yfinance/quotes' }))
  db.record(run({ source: 'fmp/news', rows: null, text: 'a headline' }))
  const stats = db.stats()
  assert.equal(stats.runs, 2)
  assert.equal(stats.rows, 1)
  assert.equal(stats.docs, 1)
  assert.equal(stats.oldest, 1_700_000_000_000)
  assert.deepEqual(stats.sources, ['fmp/news', 'yfinance/quotes'])
  assert.equal(stats.path, file)
  assert.ok(stats.bytes > 0)
  db.compact()
  db.close()
})

test('what the model cost is filed by local day and origin', () => {
  const { store: db } = store()
  const usage = { day: '2026-09-17', at: 1_700_000_000_000, provider: 'anthropic', model: 'claude', rounds: 2 }
  db.recordUsage({ ...usage, origin: 'user', input: 1000, output: 200 })
  db.recordUsage({ ...usage, origin: 'user', input: 500, output: 100 })
  db.recordUsage({ ...usage, origin: 'task', input: 9000, output: 50 })
  db.recordUsage({ ...usage, day: '2026-09-16', origin: 'task', input: 7, output: 7 })
  assert.deepEqual(db.usage('2026-09-17'), [
    { origin: 'task', input: 9000, output: 50, runs: 1 },
    { origin: 'user', input: 1500, output: 300, runs: 2 },
  ])
  assert.deepEqual(db.usage('2026-01-01'), [])
  db.close()
})

test('a file written before usage existed gains the table rather than being remade', () => {
  const { store: db, file } = store()
  db.record(run())
  db.close()
  // Back to version 1: the table gone and the stamp with it, as an older app left it.
  const raw = new DatabaseSync(file)
  raw.exec('drop table usage')
  raw.exec('pragma user_version = 1')
  raw.close()

  const again = openStore(file)
  // The run it already held is still there, and usage works now.
  assert.equal(again.query({ sql: 'select count(*) from runs' }).rows[0]![0], 1)
  again.recordUsage({
    day: '2026-09-17',
    at: 1,
    origin: 'user',
    provider: 'p',
    model: 'm',
    input: 1,
    output: 2,
    rounds: 1,
  })
  assert.equal(again.usage('2026-09-17').length, 1)
  again.close()
})

test('a watch is told what it saw last time, and the first time it is told nothing', () => {
  const { store: db } = store()
  const first = db.watch({ task: 't1', at: 1, text: 'AAPL 231' })
  assert.equal(first.previous, null)
  const second = db.watch({ task: 't1', at: 2, text: 'AAPL 244' })
  assert.equal(second.previous?.text, 'AAPL 231')
  // The store hashes what it is given, so the row carries one even though the caller sent none.
  const hash = db.query({ sql: "select hash from watched where task = 't1' order by at" }).rows[0]![0]
  assert.match(String(hash), /^[0-9a-f]{64}$/)
  // Another watch keeps its own history.
  assert.equal(db.watch({ task: 't2', at: 3, text: 'other' }).previous, null)
  assert.equal(db.watch({ task: 't1', at: 4, text: 'AAPL 250' }).previous?.text, 'AAPL 244')
  db.close()
})

test('a watch keeps a short history, not every run it ever made', () => {
  const { store: db } = store()
  for (let i = 0; i < 60; i++) db.watch({ task: 't1', at: i, text: `run ${i}` })
  const kept = db.query({ sql: "select count(*) from watched where task = 't1'" }).rows[0]![0]
  assert.equal(kept, 20)
  // And the newest is still what the next run is compared against.
  assert.equal(db.watch({ task: 't1', at: 99, text: 'new' }).previous?.text, 'run 59')
  db.close()
})

test('a file written before watches gains the table rather than being remade', () => {
  const { store: db, file } = store()
  db.record(run())
  db.close()
  const raw = new DatabaseSync(file)
  raw.exec('drop table watched')
  raw.exec('pragma user_version = 2')
  raw.close()

  const again = openStore(file)
  assert.equal(again.query({ sql: 'select count(*) from runs' }).rows[0]![0], 1)
  assert.equal(again.watch({ task: 't1', at: 1, text: 'x' }).previous, null)
  again.close()
})

test('what the app told the user is kept, newest first, and counted while unread', () => {
  const { store: db } = store()
  assert.equal(db.unread(), 0)
  assert.equal(db.notify(1, 'tasks', 'first').unread, 1)
  assert.equal(db.notify(2, 'research', 'second').unread, 2)
  const all = db.notifications(10)
  assert.deepEqual(
    all.map((one) => one.text),
    ['second', 'first'],
  )
  assert.deepEqual(
    all.map((one) => one.source),
    ['research', 'tasks'],
  )
  assert.equal(
    all.every((one) => one.read === false),
    true,
  )
  db.close()
})

test('reading one, or all of them, takes them off the count', () => {
  const { store: db } = store()
  db.notify(1, 'tasks', 'a')
  db.notify(2, 'tasks', 'b')
  db.notify(3, 'tasks', 'c')
  const [newest] = db.notifications(10)
  assert.equal(db.markRead([newest!.id]).unread, 2)
  assert.equal(db.notifications(10).find((one) => one.id === newest!.id)?.read, true)
  assert.equal(db.markRead([]).unread, 0)
  db.close()
})

test('a file written before the inbox gains it rather than being remade', () => {
  const { store: db, file } = store()
  db.record(run())
  db.close()
  const raw = new DatabaseSync(file)
  raw.exec('drop table notifications')
  raw.exec('pragma user_version = 3')
  raw.close()

  const again = openStore(file)
  assert.equal(again.query({ sql: 'select count(*) from runs' }).rows[0]![0], 1)
  assert.equal(again.notify(1, 'tasks', 'after the migration').unread, 1)
  again.close()
})

test('a workspace keeps the end of its conversation, and replacing it does not pile them up', () => {
  const { store: db } = store()
  assert.equal(db.loadThread('ws-1'), null)
  db.saveThread('ws-1', { at: 1, model: 'anthropic\nclaude', turns: '[{"role":"user"}]' })
  db.saveThread('ws-1', { at: 2, model: 'anthropic\nclaude', turns: '[{"role":"user"},{"role":"assistant"}]' })
  const kept = db.loadThread('ws-1')
  assert.equal(kept?.at, 2)
  assert.match(kept?.turns ?? '', /assistant/)
  assert.equal(db.query({ sql: 'select count(*) from threads' }).rows[0]![0], 1, 'one row a workspace')
  // Another workspace keeps its own.
  db.saveThread('ws-2', { at: 3, model: 'm', turns: '[]' })
  assert.equal(db.loadThread('ws-1')?.at, 2)
  db.clearThread('ws-1')
  assert.equal(db.loadThread('ws-1'), null)
  assert.equal(db.loadThread('ws-2')?.at, 3)
  db.close()
})

test("a workspace's chat is kept an exchange at a time, and read back a page at a time, oldest first", () => {
  const { store: db } = store()
  assert.deepEqual(db.exchanges('ws-1', 10), [])
  const ids = ['a', 'b', 'c', 'd', 'e'].map((q, i) =>
    db.fileExchange('ws-1', i, { question: q, answer: q.toUpperCase() }),
  )
  // The newest page, then the one before it, asked for by the oldest id in hand.
  const last = db.exchanges('ws-1', 2)
  assert.deepEqual(last, [
    { id: ids[3], question: 'd', answer: 'D' },
    { id: ids[4], question: 'e', answer: 'E' },
  ])
  const before = db.exchanges('ws-1', 2, last[0]!.id)
  assert.deepEqual(
    before.map((one) => one.question),
    ['b', 'c'],
  )
  assert.deepEqual(
    db.exchanges('ws-1', 2, before[0]!.id).map((one) => one.question),
    ['a'],
  )
  assert.deepEqual(db.exchanges('ws-1', 2, ids[0]), [])
  db.close()
})

test("one workspace's chat is not another's, however the pages are asked for", () => {
  const { store: db } = store()
  db.fileExchange('ws-1', 1, { question: 'mine', answer: 'yes' })
  const theirs = db.fileExchange('ws-2', 2, { question: 'theirs', answer: 'no' })
  db.fileExchange('ws-1', 3, { question: 'mine again', answer: 'yes' })
  assert.deepEqual(
    db.exchanges('ws-1', 10).map((one) => one.question),
    ['mine', 'mine again'],
  )
  assert.deepEqual(
    db.exchanges('ws-2', 10).map((one) => one.question),
    ['theirs'],
  )
  // Before the other workspace's exchange there is only this one's first.
  assert.deepEqual(
    db.exchanges('ws-1', 10, theirs).map((one) => one.question),
    ['mine'],
  )
  db.close()
})

test('what was said unasked keeps what it was, a reply keeps its sources, and one with neither carries neither', () => {
  const { store: db } = store()
  const source = { id: 'c1', title: 'AAPL 10-K', url: 'https://www.sec.gov/aapl.htm', quote: 'a single supplier' }
  db.fileExchange('ws-1', 1, { question: '', answer: 'SPY crossed 760.', task: 't3' })
  db.fileExchange('ws-1', 2, { question: '', answer: 'Hi.', welcome: true })
  db.fileExchange('ws-1', 3, { question: 'Who?', answer: 'Apple.[^c1]', citations: [source] })
  db.fileExchange('ws-1', 4, { question: 'Thanks', answer: 'Any time.' })
  assert.deepEqual(
    db.exchanges('ws-1', 10).map(({ id: _id, ...rest }) => rest),
    [
      { question: '', answer: 'SPY crossed 760.', task: 't3' },
      { question: '', answer: 'Hi.', welcome: true },
      { question: 'Who?', answer: 'Apple.[^c1]', citations: [source] },
      { question: 'Thanks', answer: 'Any time.' },
    ],
  )
  db.close()
})

test('a file written before the chat was kept gains it rather than being remade', () => {
  const { store: db, file } = store()
  db.record(run())
  db.close()
  const raw = new DatabaseSync(file)
  raw.exec('drop table exchanges')
  raw.exec('pragma user_version = 5')
  raw.close()

  const again = openStore(file)
  assert.equal(again.query({ sql: 'select count(*) from runs' }).rows[0]![0], 1)
  again.fileExchange('ws-1', 1, { question: 'after', answer: 'the migration' })
  assert.deepEqual(
    again.exchanges('ws-1', 10).map((one) => one.question),
    ['after'],
  )
  again.close()
})

test('a file 0.2.20 to 0.2.22 stamped 7 opens at 8, and one from before gains the column they added', () => {
  const { store: db, file } = store()
  db.close()
  const raw = new DatabaseSync(file)
  raw.exec('drop table exchanges')
  raw.exec(
    'create table exchanges (id integer primary key, workspace text not null, at integer not null, question text not null, answer text not null, task text, welcome integer not null default 0, citations text)',
  )
  raw.exec("insert into exchanges (workspace, at, question, answer) values ('ws-1', 1, 'before', 'the column')")
  raw.exec('pragma user_version = 6')
  raw.close()

  const again = openStore(file)
  again.fileExchange('ws-1', 2, { question: 'after', answer: 'the column' })
  assert.deepEqual(
    again.exchanges('ws-1', 10).map((one) => one.question),
    ['before', 'after'],
  )
  again.close()
  const read = new DatabaseSync(file)
  const columns = read.prepare('pragma table_info(exchanges)').all() as { name: string }[]
  assert.ok(columns.some((one) => one.name === 'session'))
  assert.equal((read.prepare('pragma user_version').get() as { user_version: number }).user_version, 8)
  read.close()

  // Opened again, as the file this left is.
  const later = openStore(file)
  assert.equal(later.exchanges('ws-1', 10).length, 2)
  later.close()
})

test('a chat that is forgotten leaves nothing behind, and another chat keeps what is its own', () => {
  const { store: db } = store()
  db.saveThread('w1/f1', { at: 1, model: 'm', turns: '[{"role":"user","text":"hi"}]' })
  db.saveThread('w1', { at: 1, model: 'm', turns: '[{"role":"user","text":"kept"}]' })
  db.fileExchange('w1/f1', 1, { question: 'q', answer: 'a' })
  db.fileExchange('w1/f1', 2, { question: 'q2', answer: 'a2' })
  db.fileExchange('w1', 3, { question: 'kept', answer: 'kept' })
  db.forgetChat('w1/f1')
  assert.equal(db.loadThread('w1/f1'), null)
  assert.deepEqual(db.exchanges('w1/f1', 10), [])
  assert.notEqual(db.loadThread('w1'), null)
  assert.equal(db.exchanges('w1', 10).length, 1)
  db.close()
})

test('a file stamped 7 opens at 8 with every thread and exchange where it was', () => {
  const { store: db, file } = store()
  db.close()
  const raw = new DatabaseSync(file)
  raw.exec('drop table exchanges')
  raw.exec('drop table threads')
  raw.exec(
    'create table threads (workspace text primary key, at integer not null, model text not null, turns text not null)',
  )
  raw.exec(
    'create table exchanges (id integer primary key, workspace text not null, at integer not null, question text not null, answer text not null, task text, welcome integer not null default 0, citations text, session text)',
  )
  raw.exec('create index exchanges_workspace on exchanges(workspace, id desc)')
  raw.exec('create index exchanges_session on exchanges(session, id desc)')
  raw.exec(`insert into threads (workspace, at, model, turns) values ('ws-1', 1, 'm', '[{"role":"user","text":"hi"}]')`)
  raw.exec("insert into exchanges (workspace, at, question, answer) values ('ws-1', 1, 'asked', 'answered')")
  raw.exec(
    "insert into exchanges (workspace, at, question, answer) values ('ws-1/f1', 2, 'in a tile', 'answered there')",
  )
  raw.exec('pragma user_version = 7')
  raw.close()

  const again = openStore(file)
  assert.equal(again.loadThread('ws-1')?.model, 'm')
  assert.deepEqual(
    again.exchanges('ws-1', 10).map((one) => one.question),
    ['asked'],
  )
  assert.deepEqual(
    again.exchanges('ws-1/f1', 10).map((one) => one.question),
    ['in a tile'],
  )
  again.close()
  const read = new DatabaseSync(file)
  assert.equal((read.prepare('pragma user_version').get() as { user_version: number }).user_version, 8)
  const names = (table: string): string[] =>
    (read.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((one) => one.name)
  assert.ok(names('threads').includes('chat') && !names('threads').includes('workspace'))
  assert.ok(names('exchanges').includes('chat') && !names('exchanges').includes('workspace'))
  assert.ok(names('exchanges').includes('steps') && names('exchanges').includes('error'))
  read.close()
  // A second open of what the first left changes nothing.
  const later = openStore(file)
  assert.equal(later.exchanges('ws-1', 10).length, 1)
  later.close()
})

test('a file left half way to 8 is finished, not refused', () => {
  const { store: db, file } = store()
  db.fileExchange('ws-1', 1, { question: 'kept', answer: 'kept' })
  db.close()
  // As a crash between the change and the stamp leaves it: the columns of 8, stamped 7.
  const raw = new DatabaseSync(file)
  raw.exec('pragma user_version = 7')
  raw.close()
  const again = openStore(file)
  assert.equal(again.exchanges('ws-1', 10).length, 1)
  again.close()
})

test('an exchange keeps the steps its run took and why it failed, and one with neither carries neither', () => {
  const { store: db } = store()
  db.fileExchange('w1/f1', 1, { question: 'q', answer: 'a', steps: ['Thinking', 'set: panels/e1/state'] })
  db.fileExchange('w1/f1', 2, { question: 'q2', answer: '', steps: ['Thinking'], error: 'The provider refused.' })
  db.fileExchange('w1/f1', 3, { question: 'q3', answer: 'a3' })
  const [first, second, third] = db.exchanges('w1/f1', 10)
  assert.deepEqual(first!.steps, ['Thinking', 'set: panels/e1/state'])
  assert.equal(first!.error, undefined)
  assert.deepEqual([second!.answer, second!.steps, second!.error], ['', ['Thinking'], 'The provider refused.'])
  assert.ok(!('steps' in third!) && !('error' in third!))
  db.close()
})
