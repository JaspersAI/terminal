import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Exchange } from '../shared/agent/transcript.ts'
import {
  checkQuery,
  EXCHANGES_MAX,
  QUERY_LIMIT_DEFAULT,
  QUERY_LIMIT_MAX,
  type QueryRequest,
  type QueryResult,
  type RunRecord,
  type StoreStats,
} from '../shared/data/store.ts'

// The store itself: one SQLite file holding every run of every source, and the two ways to read it
// back. All of the logic is here so it can be opened on a temp file in a test; the process around
// it is the wire and nothing else.

/** Raised when the file on disk was written by a newer version of the app. */
export class StoreVersionError extends Error {}

const VERSION = 8

/**
 * What the model cost, one row per run of the orchestrator. Here rather than in the state tree,
 * which is pushed whole to every window on every change, and rather than beside the tasks, since
 * this is what happened rather than what is. `day` is local, because a budget is a person's day.
 */
const USAGE = `
create table if not exists usage (
  id integer primary key,
  day text not null,
  at integer not null,
  origin text not null,
  provider text not null,
  model text not null,
  input integer not null,
  output integer not null,
  rounds integer not null
);
create index if not exists usage_day on usage(day, origin);
`

/**
 * What a watch saw, one row an observation, so the comparison is the last two and a history comes
 * free. Here rather than on the task, which lives in the tree and is pushed whole to every window.
 */
const WATCHED = `
create table if not exists watched (
  id integer primary key,
  task text not null,
  at integer not null,
  hash text not null,
  text text not null
);
create index if not exists watched_task on watched(task, at desc);
`

/**
 * Everything the app has told the user, kept. A notice said in the answer box is gone in fifteen
 * seconds, and a plugin's is not said there at all; this is the same line written down, so something
 * said at three in the morning is still there in the morning. Whatever raises one is `source`: a
 * plugin's id, `tasks`, or the app.
 */
const NOTIFICATIONS = `
create table if not exists notifications (
  id integer primary key,
  at integer not null,
  source text not null,
  text text not null,
  read integer not null default 0
);
create index if not exists notifications_at on notifications(at desc);
create index if not exists notifications_unread on notifications(read, at desc);
`

/**
 * Each chat's conversation, so quitting and coming back carries on rather than starting again. A chat
 * is a workspace's own, under its id, one of its loops', under `<workspace>/<loop>`, or a plugin's
 * build that was cut off, under `build/<plugin>`. One row a chat, replaced each time, with the model
 * it was held on: a thread belongs to the model it was started on, since an assistant turn replays
 * what that provider sent.
 */
const THREADS = `
create table if not exists threads (
  chat text primary key,
  at integer not null,
  model text not null,
  turns text not null
);
`

/**
 * Each chat as it was shown: what was asked and the reply that ended its run, with what the run did
 * and, when it failed, why; and what a task or the welcome said unasked. One row an exchange, and all of them kept. A thread is what the
 * model is given, which is cut to its last few exchanges, has room made in it when long, and is started over on
 * another model; this is what the user saw, and none of that touches it.
 */
const EXCHANGES = `
create table if not exists exchanges (
  id integer primary key,
  chat text not null,
  at integer not null,
  question text not null,
  answer text not null,
  task text,
  welcome integer not null default 0,
  citations text,
  session text,
  steps text,
  error text
);
create index if not exists exchanges_chat on exchanges(chat, id desc);
create index if not exists exchanges_session on exchanges(session, id desc);
`

/**
 * Version 7 filed each exchange under its session, from 0.2.20 to 0.2.22, when every message was a
 * conversation of its own. Nothing reads or writes the column now, but those versions stamped their
 * files 7, and a file stamped newer than the app is refused: the column stays, and the version with
 * it. A file from before gains it, so every file at 7 has the same shape.
 */
function addSession(db: DatabaseSync): void {
  const columns = db.prepare('pragma table_info(exchanges)').all() as { name: string }[]
  if (!columns.some((one) => one.name === 'session')) db.exec('alter table exchanges add column session text')
  db.exec('create index if not exists exchanges_session on exchanges(session, id desc)')
}

/**
 * Version 8 names the column a thread and an exchange are filed under for what it holds: a chat's
 * key, which is a workspace's id for its own chat and `<workspace>/<loop>` for one of its loops'.
 * It was `workspace`, and held both from the day loops had chats. And an exchange gains what its run
 * did and why it failed. Each part is done only where it has not been, so a file caught between this
 * and the stamp is finished on the next open.
 */
function toEight(db: DatabaseSync): void {
  const columnsOf = (table: string): string[] =>
    (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((one) => one.name)
  for (const table of ['threads', 'exchanges']) {
    if (columnsOf(table).includes('workspace')) db.exec(`alter table ${table} rename column workspace to chat`)
  }
  db.exec('drop index if exists exchanges_workspace')
  db.exec('create index if not exists exchanges_chat on exchanges(chat, id desc)')
  for (const column of ['steps', 'error']) {
    if (!columnsOf('exchanges').includes(column)) db.exec(`alter table exchanges add column ${column} text`)
  }
}

/**
 * The shape of the file. `runs` is the call, `run_rows` is what came back (one row per row, so it
 * can be filtered and joined), and `docs` is a full text index over the text a run answered with,
 * external content so the text is not held twice.
 */
const SCHEMA = `
create table runs (
  id integer primary key,
  source text not null,
  args text not null,
  args_hash text not null,
  workspace text,
  fetched_at integer not null,
  row_count integer not null,
  meta text,
  text text,
  error text
);
create table run_rows (
  run_id integer not null references runs(id) on delete cascade,
  idx integer not null,
  data text not null,
  primary key (run_id, idx)
);
create virtual table docs using fts5(text, content='runs', content_rowid='id');
create index runs_source_at on runs(source, fetched_at desc);
create index runs_lookup on runs(source, args_hash, fetched_at desc);
${USAGE}
${WATCHED}
${NOTIFICATIONS}
${THREADS}
${EXCHANGES}
`

/** One run of the orchestrator, as it goes to the store. */
export interface UsageRecord {
  day: string
  at: number
  origin: string
  provider: string
  model: string
  input: number
  output: number
  rounds: number
}

/** One thing a watch saw. The hash is the store's own doing, since it owns the column. */
export interface Observation {
  task: string
  at: number
  text: string
}

/** One thing the app told the user. */
export interface Notification {
  id: number
  at: number
  source: string
  text: string
  read: boolean
}

/** A conversation as it is kept: the turns as JSON, and the model they were held on. */
export interface StoredThread {
  at: number
  model: string
  turns: string
}

export interface Store {
  /** Keeps the end of one chat's conversation, replacing what was there. */
  saveThread(chat: string, thread: StoredThread): void
  /** What was kept for a chat, or null. */
  loadThread(chat: string): StoredThread | null
  /** Every chat's, by its key, for reading them all back at startup. */
  allThreads(): Record<string, StoredThread>
  /** Forgets one, which is what starting over means. */
  clearThread(chat: string): void
  /** Forgets a chat for good: its thread, and every exchange of its log. */
  forgetChat(chat: string): void
  /** Files one exchange of a chat, as it was shown. Answers its id. */
  fileExchange(chat: string, at: number, exchange: Exchange): number
  /**
   * The end of a chat, oldest first: its last `limit` exchanges, or with `before` the
   * last ones filed ahead of that id.
   */
  exchanges(chat: string, limit: number, before?: number): Exchange[]
  /** Writes one down, and answers how many are unread now. */
  notify(at: number, source: string, text: string): { unread: number }
  /** The newest first, for the inbox. */
  notifications(limit: number): Notification[]
  /** Marks them read; no ids means all of them. Answers how many are unread after. */
  markRead(ids: number[]): { unread: number }
  unread(): number
  /** Files what a watch just saw, and answers what it saw before, or null the first time. */
  watch(seen: Observation): { previous: Observation | null }
  /** Files what one run of the model cost. */
  recordUsage(usage: UsageRecord): void
  /** What has been spent today, by origin, for the budget and for the Data pane. */
  usage(day: string): { origin: string; input: number; output: number; runs: number }[]
  /** Files one run. Answers its id, which is the rowid every other table hangs off. */
  record(run: RunRecord): number
  query(request: QueryRequest): QueryResult
  stats(): StoreStats
  /** Reclaims the space rows deleted by hand left behind. */
  compact(): void
  close(): void
}

/**
 * Opens the store, making it on the first run. Two connections: one that writes, and a read only
 * one for `query`, which refuses a write and cannot attach another file.
 */
export function openStore(file: string): Store {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal')
  // The file holds everything the app fetched, so it is the user's to read and nobody else's, the
  // way state.json is. WAL makes two more files beside it, and they are opened after the pragma.
  restrict(file)
  db.exec('pragma foreign_keys = on')
  migrate(db)

  const reader = new DatabaseSync(file, { readOnly: true })
  const insertRun = db.prepare(
    'insert into runs (source, args, args_hash, workspace, fetched_at, row_count, meta, text, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insertRow = db.prepare('insert into run_rows (run_id, idx, data) values (?, ?, ?)')
  // External content: `docs` indexes `runs.text` and stores no second copy, so a count over it
  // would count `runs`. Anything that wants the number of documents counts the text itself.
  const insertDoc = db.prepare('insert into docs (rowid, text) values (?, ?)')
  const insertUsage = db.prepare(
    'insert into usage (day, at, origin, provider, model, input, output, rounds) values (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insertWatched = db.prepare('insert into watched (task, at, hash, text) values (?, ?, ?, ?)')
  const readWatched = db.prepare(
    'select task, at, hash, text from watched where task = ? order by at desc, id desc limit 1',
  )
  const trimWatched = db.prepare(
    'delete from watched where task = ? and id not in (select id from watched where task = ? order by at desc, id desc limit 20)',
  )
  const writeThread = db.prepare(
    'insert into threads (chat, at, model, turns) values (?, ?, ?, ?) on conflict(chat) do update set at = excluded.at, model = excluded.model, turns = excluded.turns',
  )
  const readThread = db.prepare('select at, model, turns from threads where chat = ?')
  const readThreads = db.prepare('select chat, at, model, turns from threads')
  const deleteThread = db.prepare('delete from threads where chat = ?')
  const deleteExchanges = db.prepare('delete from exchanges where chat = ?')
  const insertExchange = db.prepare(
    'insert into exchanges (chat, at, question, answer, task, welcome, citations, steps, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const readExchanges = db.prepare(
    'select id, question, answer, task, welcome, citations, steps, error from exchanges where chat = ? and id < ? order by id desc limit ?',
  )
  const insertNotification = db.prepare('insert into notifications (at, source, text) values (?, ?, ?)')
  const readNotifications = db.prepare(
    'select id, at, source, text, read from notifications order by at desc, id desc limit ?',
  )
  const countUnreadRow = db.prepare('select count(*) n from notifications where read = 0')
  const countUnread = (): number => (countUnreadRow.get() as { n: number }).n
  const readUsage = db.prepare(
    'select origin, sum(input) input, sum(output) output, count(*) runs from usage where day = ? group by origin order by origin',
  )

  return {
    record(run) {
      const rows = run.rows ?? []
      // One transaction, so a run is in the file whole or not at all.
      db.exec('begin')
      try {
        const result = insertRun.run(
          run.source,
          run.args,
          run.argsHash,
          run.workspace,
          run.fetchedAt,
          rows.length,
          run.meta ? JSON.stringify(run.meta) : null,
          run.text,
          run.error,
        )
        const id = Number(result.lastInsertRowid)
        for (const [idx, row] of rows.entries()) insertRow.run(id, idx, JSON.stringify(row))
        // Only text worth searching goes in the index; an empty answer would be a row of nothing.
        if (run.text) insertDoc.run(id, run.text)
        db.exec('commit')
        return id
      } catch (error) {
        db.exec('rollback')
        throw error
      }
    },

    saveThread(chat, thread) {
      writeThread.run(chat, thread.at, thread.model, thread.turns)
    },

    loadThread(chat) {
      const row = readThread.get(chat) as StoredThread | undefined
      return row ? { at: row.at, model: row.model, turns: row.turns } : null
    },

    allThreads() {
      const rows = readThreads.all() as unknown as (StoredThread & { chat: string })[]
      const out: Record<string, StoredThread> = {}
      for (const row of rows) out[row.chat] = { at: row.at, model: row.model, turns: row.turns }
      return out
    },

    clearThread(chat) {
      deleteThread.run(chat)
    },

    forgetChat(chat) {
      deleteThread.run(chat)
      deleteExchanges.run(chat)
    },

    fileExchange(chat, at, { question, answer, task, welcome, citations, steps, error }) {
      const result = insertExchange.run(
        chat,
        at,
        question,
        answer,
        task ?? null,
        welcome ? 1 : 0,
        citations?.length ? JSON.stringify(citations) : null,
        steps?.length ? JSON.stringify(steps) : null,
        error ?? null,
      )
      return Number(result.lastInsertRowid)
    },

    exchanges(chat, limit, before) {
      const take = Math.max(1, Math.min(limit, EXCHANGES_MAX))
      const rows = readExchanges.all(chat, before ?? Number.MAX_SAFE_INTEGER, take) as unknown as {
        id: number
        question: string
        answer: string
        task: string | null
        welcome: number
        citations: string | null
        steps: string | null
        error: string | null
      }[]
      // Read newest first, since the limit is of the end; handed back in the order they were said. A
      // mark an exchange does not have is left out, as it is on one read off a thread.
      return rows.reverse().map((row) => ({
        id: row.id,
        question: row.question,
        answer: row.answer,
        ...(row.task === null ? {} : { task: row.task }),
        ...(row.welcome === 1 ? { welcome: true as const } : {}),
        ...(row.citations === null ? {} : { citations: JSON.parse(row.citations) as Exchange['citations'] }),
        ...(row.steps === null ? {} : { steps: JSON.parse(row.steps) as string[] }),
        ...(row.error === null ? {} : { error: row.error }),
      }))
    },

    notify(at, source, text) {
      insertNotification.run(at, source, text)
      return { unread: countUnread() }
    },

    notifications(limit) {
      // The column is 0 or 1; the shape a caller reads is a boolean.
      const rows = readNotifications.all(Math.max(1, Math.min(limit, 1000))) as unknown as {
        id: number
        at: number
        source: string
        text: string
        read: number
      }[]
      return rows.map((row) => ({ id: row.id, at: row.at, source: row.source, text: row.text, read: row.read === 1 }))
    },

    markRead(ids) {
      if (ids.length === 0) db.exec('update notifications set read = 1 where read = 0')
      else {
        const one = db.prepare('update notifications set read = 1 where id = ?')
        for (const id of ids) one.run(id)
      }
      return { unread: countUnread() }
    },

    unread: () => countUnread(),

    watch(seen) {
      const previous = (readWatched.get(seen.task) as (Observation & { hash: string }) | undefined) ?? null
      insertWatched.run(seen.task, seen.at, hashOf(seen.text), seen.text)
      // Two are enough to compare; the rest is history nobody reads, and a watch on a short
      // interval would fill the file with it.
      trimWatched.run(seen.task, seen.task)
      return { previous: previous ? { ...previous } : null }
    },

    recordUsage(usage) {
      insertUsage.run(
        usage.day,
        usage.at,
        usage.origin,
        usage.provider,
        usage.model,
        usage.input,
        usage.output,
        usage.rounds,
      )
    },

    usage(day) {
      // Spread: a row from node:sqlite has a null prototype, which surprises anything that reads it
      // as an ordinary object.
      return (readUsage.all(day) as { origin: string; input: number; output: number; runs: number }[]).map((row) => ({
        ...row,
      }))
    },

    query({ sql, limit }) {
      const refusal = checkQuery(sql)
      if (refusal) throw new Error(refusal)
      const take = Math.min(Math.max(1, Math.trunc(limit ?? QUERY_LIMIT_DEFAULT)), QUERY_LIMIT_MAX)
      const statement = reader.prepare(sql)
      statement.setReadBigInts(false)
      return read(statement, take)
    },

    stats() {
      const counts = db
        .prepare(
          'select (select count(*) from runs) runs, (select count(*) from run_rows) rows, (select count(*) from runs where text is not null) docs, (select min(fetched_at) from runs) oldest',
        )
        .get() as { runs: number; rows: number; docs: number; oldest: number | null }
      const sources = (
        db.prepare('select distinct source from runs order by source').all() as { source: string }[]
      ).map((row) => row.source)
      return { path: file, bytes: sizeOf(file), ...counts, sources }
    },

    compact() {
      db.exec('vacuum')
    },

    close() {
      reader.close()
      db.close()
    },
  }
}

/**
 * The rows of one statement, as columns and tuples: as many as were asked for, each one whole. A row
 * is never cut short or left out for what it holds; a statement that matched more than were asked for
 * says so, and the rest are asked for with an offset.
 */
function read(statement: StatementSync, take: number): QueryResult {
  const found = statement.all() as Record<string, unknown>[]
  const columns = found.length > 0 ? Object.keys(found[0]!) : []
  const rows = found.slice(0, take).map((row) => columns.map((column) => row[column] ?? null))
  return { columns, rows, rowCount: rows.length, truncated: found.length > take }
}

/** Makes the file on the first open, and refuses one a newer app wrote. */
function migrate(db: DatabaseSync): void {
  const { user_version: found } = db.prepare('pragma user_version').get() as { user_version: number }
  if (found === VERSION) return
  if (found > VERSION) throw new StoreVersionError(`The store was written by a newer version of Jaspers (v${found}).`)
  if (found === 0) {
    // A new file is made whole; the steps below are for one that already exists.
    db.exec(SCHEMA)
  } else {
    // Each step is from the version before it, so an old file walks forward one at a time. Each is
    // written to survive being run twice, since a crash between the change and the stamp below would
    // otherwise leave a file that no version can open.
    if (found < 2) db.exec(USAGE)
    if (found < 3) db.exec(WATCHED)
    if (found < 4) db.exec(NOTIFICATIONS)
    if (found < 5) db.exec(THREADS)
    if (found < 6) db.exec(EXCHANGES)
    if (found < 7) addSession(db)
    if (found < 8) toEight(db)
  }
  db.exec(`pragma user_version = ${VERSION}`)
}

/** What is written beside an observation, so two runs can be told apart without reading both. */
function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The store and the two files WAL keeps beside it, readable and writable by their owner alone. */
function restrict(file: string): void {
  for (const name of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(name, 0o600)
    } catch {
      // Not there yet, or a filesystem with no modes; the folder is 0700 either way.
    }
  }
}

/** The file and everything WAL keeps beside it, since that is what the folder costs. */
function sizeOf(file: string): number {
  return [file, `${file}-wal`, `${file}-shm`].reduce((total, name) => {
    try {
      return total + statSync(name).size
    } catch {
      return total
    }
  }, 0)
}
