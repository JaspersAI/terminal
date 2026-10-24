// Runs parsed SQL statements against a connection, through its public methods plus internal hooks
// (search statistics, one-pass group counts, timed writes).

import type { Connection, SearchRun } from './connection.ts'
import { PrismError } from './errors.ts'
import {
  escapeIdentifier,
  escapeLiteral,
  parseSql,
  sqlError,
  type Condition,
  type DeleteStatement,
  type InsertStatement,
  type SelectStatement,
  type WithTableAt,
} from './sql.ts'
import type {
  ColumnValue,
  Document,
  Hit,
  QueryOptions,
  QueryResult,
  QueryStats,
  RangeFilter,
  Row,
  SearchMode,
  SortDirection,
  SqlParams,
  StoredColumnValue,
  Where,
} from './types.ts'

type Conn = Connection<unknown>
type Value = string | null

const U32_MAX = 0xffff_ffff
const BUILT_IN = ['id', 'text', 'score', 'metadata', 'vector'] as const
type BuiltIn = (typeof BUILT_IN)[number]

type Ref = { kind: BuiltIn } | { kind: 'column'; name: string } | { kind: 'field'; path: string[] }

interface Filters {
  columns: Map<string, Set<Value>>
  ranges: Map<string, RangeFilter>
  ids?: string[]
  none: boolean
  conflict?: string
  idAt?: number
}

const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const fmt = (n: number) => n.toLocaleString('en-US')
const ms = (x: number) => `${x < 10 ? x.toFixed(1) : Math.round(x)} ms`
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function ident(name: string): string {
  return PLAIN_NAME.test(name) ? name : escapeIdentifier(name)
}

function conditionSql(name: string, allowed: Iterable<Value>): string {
  const set = [...allowed]
  const values = set.filter((v): v is string => v !== null)
  const col = ident(name)
  const eq =
    values.length === 0
      ? ''
      : values.length === 1
        ? `${col} = ${escapeLiteral(values[0])}`
        : `${col} IN (${values.map((v) => escapeLiteral(v)).join(', ')})`
  if (!set.includes(null)) return eq
  return eq ? `(${eq} OR ${col} IS NULL)` : `${col} IS NULL`
}

class Exec {
  readonly t0 = performance.now()
  embedMs = 0
  databaseMs = 0
  rerankMs = 0
  readonly conn: Conn
  readonly sql: string
  readonly options: QueryOptions

  constructor(conn: Conn, sql: string, options: QueryOptions) {
    this.conn = conn
    this.sql = sql
    this.options = options
  }

  fail(at: number, message: string): never {
    throw sqlError(this.sql, at, message)
  }

  async db<T>(p: Promise<T>): Promise<T> {
    const t = performance.now()
    try {
      return await p
    } finally {
      this.databaseMs += performance.now() - t
    }
  }

  result<R>(r: Omit<QueryResult<R>, 'timing'>): QueryResult<R> {
    return {
      ...r,
      timing: {
        totalMs: performance.now() - this.t0,
        embedMs: this.embedMs,
        databaseMs: this.databaseMs,
        ...(this.rerankMs > 0 ? { rerankMs: this.rerankMs } : {}),
      },
    }
  }

  allColumns(): string {
    return [...BUILT_IN, ...this.conn.columns].join(', ')
  }

  checkTable(table: string, at: number): void {
    if (!eqi(table, this.conn.table)) {
      this.fail(
        at,
        `unknown table ${escapeIdentifier(table)}: this database's table is ${escapeIdentifier(this.conn.table)}`,
      )
    }
  }

  column(name: string, at: number): string | undefined {
    const cols = this.conn.columns
    if (cols.includes(name)) return name
    const ci = cols.filter((c) => eqi(c, name))
    if (ci.length > 1) {
      this.fail(
        at,
        `${ident(name)} matches the columns ${ci.map(ident).join(' and ')}: write the exact name in double quotes`,
      )
    }
    return ci[0]
  }

  ref(path: string[], at: number): Ref {
    let p = path
    if (p.length > 1 && eqi(p[0]!, this.conn.table)) p = p.slice(1)
    const head = p[0]!
    if (eqi(head, 'metadata')) return p.length === 1 ? { kind: 'metadata' } : { kind: 'field', path: p.slice(1) }
    if (p.length === 1) {
      const builtIn = BUILT_IN.find((b) => eqi(b, head))
      if (builtIn) return { kind: builtIn }
      const name = this.column(head, at)
      if (name) return { kind: 'column', name }
    } else if (p.length === 2 && eqi(head, 'columns')) {
      const name = this.column(p[1]!, at)
      if (name) return { kind: 'column', name }
    }
    return this.fail(at, `unknown column ${ident(path.join('.'))} (the columns are ${this.allColumns()})`)
  }

  filters(conds: Condition[]): Filters {
    const columns = new Map<string, Set<Value>>()
    const ranges = new Map<string, RangeFilter>()
    const f: Filters = { columns, ranges, none: false }
    for (const c of conds) {
      const ref = this.ref(c.path, c.at)
      const hasRange = c.gt !== undefined || c.gte !== undefined || c.lt !== undefined || c.lte !== undefined
      if (hasRange) {
        if (ref.kind !== 'column') {
          this.fail(c.at, `range comparisons only work on filter columns`)
        }
        const colType = this.conn.columnTypes[ref.name] ?? 'string'
        if (colType === 'string') {
          this.fail(c.at, `range comparisons (<, <=, >, >=, BETWEEN) require a typed 'time' or 'int' column`)
        }
        const cur = ranges.get(ref.name) ?? {}
        if (c.gt !== undefined) cur.gt = c.gt as ColumnValue
        if (c.gte !== undefined) cur.gte = c.gte as ColumnValue
        if (c.lt !== undefined) cur.lt = c.lt as ColumnValue
        if (c.lte !== undefined) cur.lte = c.lte as ColumnValue
        ranges.set(ref.name, cur)
        continue
      }

      const values = (c.values ?? []).map((v) => {
        if (v === null || v === '') return null
        if (ref.kind === 'column') return this.conn._encodeColumnValue(ref.name, v, () => `WHERE ${ref.name}`)
        return String(v)
      })
      if (ref.kind === 'id') {
        const ids = values.filter((v): v is string => v !== null)
        const prev = f.ids
        f.ids = prev ? prev.filter((x) => ids.includes(x)) : [...new Set(ids)]
        f.idAt ??= c.at
        if (f.ids.length === 0 && !f.none) {
          f.none = true
          f.conflict =
            ids.length === 0
              ? 'id IS NULL, but every document has an id'
              : `${conditionSql('id', prev ?? [])} AND ${conditionSql('id', ids)}`
        }
      } else if (ref.kind === 'column') {
        const set = new Set(values)
        const prev = columns.get(ref.name)
        const next = prev ? new Set([...prev].filter((v) => set.has(v))) : set
        columns.set(ref.name, next)
        if (next.size === 0 && !f.none) {
          f.none = true
          f.conflict = `${conditionSql(ref.name, prev ?? [])} AND ${conditionSql(ref.name, set)}`
        }
      } else if (ref.kind === 'text') {
        this.fail(c.at, 'text is not a filter column: rank by it with ORDER BY BM25(...) or HYBRID(...)')
      } else if (ref.kind === 'score') {
        this.fail(c.at, 'score cannot be filtered: rank with ORDER BY and keep the best with LIMIT')
      } else if (ref.kind === 'vector') {
        this.fail(c.at, 'vectors cannot be filtered: rank by them with ORDER BY SIMILARITY(...)')
      } else {
        const cols = this.conn.columns
        this.fail(
          c.at,
          `metadata is not indexed for filtering; ${cols.length > 0 ? `the filter columns are ${cols.map(ident).join(', ')}` : 'this database has no filter columns'}`,
        )
      }
    }
    return f
  }

  where(f: Filters): Where {
    const w: Where = {}
    for (const [name, values] of f.columns) w[name] = [...values]
    for (const [name, range] of f.ranges) {
      const existing = f.columns.get(name)
      if (existing) {
        w[name] = { ...range, in: [...existing] }
      } else {
        w[name] = range
      }
    }
    return w
  }

  describe(f: Filters): string {
    const parts: string[] = []
    if (f.ids) parts.push(conditionSql('id', f.ids))
    for (const [name, set] of f.columns) parts.push(conditionSql(name, set))
    for (const [name, r] of f.ranges) {
      const col = ident(name)
      if (r.gte !== undefined && r.lte !== undefined) {
        parts.push(`${col} BETWEEN ${escapeLiteral(r.gte)} AND ${escapeLiteral(r.lte)}`)
      } else {
        if (r.gt !== undefined) parts.push(`${col} > ${escapeLiteral(r.gt)}`)
        if (r.gte !== undefined) parts.push(`${col} >= ${escapeLiteral(r.gte)}`)
        if (r.lt !== undefined) parts.push(`${col} < ${escapeLiteral(r.lt)}`)
        if (r.lte !== undefined) parts.push(`${col} <= ${escapeLiteral(r.lte)}`)
      }
    }
    return parts.join(' AND ')
  }

  passes(row: Row<unknown>, f: Filters): boolean {
    for (const [name, set] of f.columns) {
      const v = row.columns[name]
      const str = v === undefined ? null : String(v)
      if (!set.has(str)) return false
    }
    return true
  }

  async byId(f: Filters, includeVector: boolean): Promise<Row<unknown>[]> {
    const rows = await this.db(this.conn.getMany(f.ids ?? [], { includeVector }))
    return rows.filter((r): r is Row<unknown> => r !== null && this.passes(r, f))
  }

  maxRows(): number | undefined {
    const m = this.options.maxRows
    if (m === undefined) return undefined
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 0) {
      throw new PrismError('PRISM_INVALID', 'maxRows must be a whole number of at least 0')
    }
    return m
  }

  page<T>(rows: T[], s: SelectStatement): { rows: T[]; truncated: boolean } {
    let out = rows.slice(s.offset, s.limit === undefined ? undefined : s.offset + s.limit)
    const max = this.maxRows()
    const truncated = max !== undefined && out.length > max
    if (truncated) out = out.slice(0, max)
    return { rows: out, truncated }
  }

  readOnlyCheck(what: string): void {
    if (this.options.readonly) {
      throw new PrismError(
        'PRISM_READONLY',
        `${what} writes, and this query is read-only (readonly: true): only SELECT and EXPLAIN run`,
      )
    }
  }
}

type Item = { name: string; ref: Ref; at: number } | { name: string; count: true; at: number }

function namesUnique(items: { name: string }[]): void {
  const used = new Map<string, number>()
  for (const it of items) {
    const n = used.get(it.name) ?? 0
    used.set(it.name, n + 1)
    if (n > 0) {
      let k = n + 1
      while (used.has(`${it.name}_${k}`)) k++
      it.name = `${it.name}_${k}`
      used.set(it.name, 1)
    }
  }
}

function itemsOf(x: Exec, s: SelectStatement, ranked: boolean): Item[] {
  const out: Item[] = []
  for (const it of s.items) {
    if (it.kind === 'star') {
      out.push({ name: 'id', ref: { kind: 'id' }, at: 0 })
      if (ranked) out.push({ name: 'score', ref: { kind: 'score' }, at: 0 })
      for (const c of x.conn.columns) out.push({ name: c, ref: { kind: 'column', name: c }, at: 0 })
      out.push({ name: 'text', ref: { kind: 'text' }, at: 0 }, { name: 'metadata', ref: { kind: 'metadata' }, at: 0 })
    } else if (it.kind === 'count') {
      out.push({ name: it.name, count: true, at: it.at })
    } else {
      const ref = x.ref(it.path, it.at)
      const name = it.aliased
        ? it.name
        : ref.kind === 'column'
          ? ref.name
          : ref.kind === 'field'
            ? ref.path[ref.path.length - 1]!
            : ref.kind
      out.push({ name, ref, at: it.at })
    }
  }
  namesUnique(out)
  return out
}

function dig(v: unknown, path: string[]): unknown {
  let cur = v
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur === undefined ? null : cur
}

function valueOf(row: Row<unknown> | Hit<unknown>, ref: Ref): unknown {
  switch (ref.kind) {
    case 'id':
      return row.id
    case 'text':
      return row.text
    case 'score':
      return (row as Hit<unknown>).score
    case 'metadata':
      return row.metadata ?? null
    case 'vector':
      return row.vector ?? null
    case 'column':
      return row.columns[ref.name] ?? null
    case 'field':
      return dig(row.metadata, ref.path)
  }
}

function project(items: Item[], rows: (Row<unknown> | Hit<unknown>)[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {}
    for (const it of items) if ('ref' in it) o[it.name] = valueOf(r, it.ref)
    return o
  })
}

async function runSelect(x: Exec, s: WithTableAt<SelectStatement>): Promise<QueryResult> {
  x.checkTable(s.table, s.tableAt)
  const f = x.filters(s.where)
  const counts = s.items.filter((i) => i.kind === 'count')
  if (s.rank) {
    if (s.groupBy || s.distinct || counts.length > 0) {
      x.fail(
        s.rank.at,
        `ORDER BY ${s.rank.fn}() ranks documents; it cannot be combined with GROUP BY, DISTINCT or COUNT(*)`,
      )
    }
    return runRanked(x, s, f)
  }
  if (s.groupBy || s.distinct) return runGroups(x, s, f)
  if (counts.length > 0) return runCount(x, s, f)
  return runScan(x, s, f)
}

async function runRanked(x: Exec, s: WithTableAt<SelectStatement>, f: Filters): Promise<QueryResult> {
  const rank = s.rank!
  if (f.ids) {
    x.fail(
      f.idAt!,
      `an id condition cannot be combined with ORDER BY ${rank.fn}(): to get documents by id, leave out ORDER BY`,
    )
  }
  const items = itemsOf(x, s, true)
  const mode: SearchMode = rank.fn === 'HYBRID' ? 'hybrid' : rank.fn === 'SIMILARITY' ? 'vector' : 'keyword'
  if (mode !== 'keyword' && rank.vector === undefined && !x.conn._canEmbed) {
    throw new PrismError(
      'PRISM_INVALID',
      `${rank.fn}('...') embeds its text, which needs an embed function (pass embed or embedder to connect()); or pass the query vector as a parameter: ${rank.fn === 'HYBRID' ? "HYBRID(:vector, 'text')" : 'SIMILARITY(:vector)'}`,
    )
  }
  const max = x.maxRows()
  let k = s.limit === undefined ? U32_MAX : s.offset + s.limit
  if (max !== undefined) k = Math.min(k, s.offset + max + 1)
  const columns = items.map((i) => i.name)
  let run: SearchRun<unknown> | undefined
  let hits: Hit<unknown>[] = []
  if (!f.none && k > 0) {
    run = await x.conn._search({
      text: rank.text,
      vector: rank.vector as Float32Array | undefined,
      mode,
      textWeight: rank.weight,
      ...(rank.recency
        ? {
            recency: {
              column: rank.recency.column,
              halfLife: rank.recency.halfLifeMs,
              weight: rank.recency.weight,
            },
          }
        : {}),
      ...(s.rerank !== undefined ? { rerank: s.rerank } : {}),
      limit: Math.min(k, U32_MAX),
      where: x.where(f),
    })
    x.embedMs += run.embedMs
    x.databaseMs += run.searchMs
    if (run.rerankMs) x.rerankMs += run.rerankMs
    hits = run.hits
  }
  const { rows: page, truncated } = x.page(hits, s)
  if (items.some((i) => 'ref' in i && i.ref.kind === 'vector') && page.length > 0) {
    const full = await x.db(
      x.conn.getMany(
        page.map((h) => h.id),
        { includeVector: true },
      ),
    )
    page.forEach((h, i) => {
      h.vector = full[i]?.vector
    })
  }
  const stats: QueryStats | undefined = run && {
    documents: run.stats.docs,
    segments: run.stats.segments,
    blocks: run.stats.blocks,
    blocksScanned: run.stats.blocksScanned,
    blocksSkipped: run.stats.blocksSkipped,
    matched: run.stats.docsScanned,
    rescored: run.stats.rescored,
    version: run.stats.seq,
  }
  if (s.explain) {
    const plan: string[] = []
    if (f.none) {
      plan.push(`The conditions contradict each other (${f.conflict}): no document can match, so nothing is searched`)
    } else if (k === 0) {
      plan.push('LIMIT 0: nothing is searched')
    } else if (run && stats) {
      plan.push(...rankedPlan(x, rank.fn, run, stats, f, s, page.length))
    }
    return x.result({
      command: 'EXPLAIN',
      columns: ['plan'],
      rows: plan.map((p) => ({ plan: p })),
      rowCount: plan.length,
      stats,
      plan,
    })
  }
  return x.result({
    command: 'SELECT',
    columns,
    rows: project(items, page),
    rowCount: page.length,
    ...(truncated ? { truncated } : {}),
    stats,
  })
}

function rankedPlan(
  x: Exec,
  fn: string,
  run: SearchRun<unknown>,
  st: QueryStats,
  f: Filters,
  s: SelectStatement,
  returned: number,
): string[] {
  const lines: string[] = []
  const model = x.conn.model ? ` (${x.conn.model})` : ''
  if (run.vectorFrom === 'embedded') {
    lines.push(`Embed the query text with the connection's embed function${model}: ${ms(run.embedMs)}`)
  } else if (run.vectorFrom === 'cache') {
    lines.push(`Query vector: this text's embedding${model}, reused from earlier on this connection`)
  } else if (run.vectorFrom === 'given') {
    lines.push('Query vector: given as a parameter')
  }
  lines.push(
    `One exact pass over version ${fmt(st.version)}: ${plural(st.documents, 'document')} in ${plural(st.segments, 'segment')}, ${plural(st.blocks, 'block')}: ${ms(run.searchMs)}`,
  )
  const filter = x.describe(f)
  const hasRanges = f.ranges.size > 0
  if (filter) {
    lines.push(
      `  Filter ${filter}: ${fmt(st.blocksSkipped)} of ${plural(st.blocks, 'block')} skipped whole by their ${hasRanges ? 'zone maps and value sets' : 'value sets'}; ${plural(st.matched, 'document')} match`,
    )
  } else if (run.mode === 'keyword' && st.blocksSkipped > 0) {
    lines.push(
      `  ${fmt(st.blocksSkipped)} of ${plural(st.blocks, 'block')} skipped whole: no query word occurs in their segment`,
    )
  } else {
    lines.push(`  No filters: all ${plural(st.matched, 'document')} are candidates`)
  }
  const recWeight = s.rank?.recency?.weight ?? 0
  if (run.mode === 'hybrid') {
    const w = run.textWeight
    const vW = +(1 - w - recWeight).toFixed(3)
    const recPart = recWeight > 0 ? ` + ${+recWeight.toFixed(3)} × recency(${s.rank!.recency!.column})` : ''
    lines.push(`  Score: ${vW} × cosine similarity + ${+w.toFixed(3)} × BM25 (scaled to 0–1)${recPart}`)
  } else if (run.mode === 'vector') {
    const recPart = recWeight > 0 ? ` + ${+recWeight.toFixed(3)} × recency(${s.rank!.recency!.column})` : ''
    lines.push(`  Score: cosine similarity${recPart}`)
  } else {
    lines.push('  Score: BM25 (scaled to 0–1), for documents that contain a query word')
  }
  if (run.mode !== 'keyword') {
    lines.push(
      `  int8 bounds ruled out ${fmt(Math.max(0, st.matched - st.rescored))} of ${fmt(st.matched)}; ${fmt(st.rescored)} rescored in full precision`,
    )
  }
  if (s.rerank !== undefined) {
    lines.push(`  Rerank top ${fmt(s.rerank)} candidates with stage-2 reranker: ${ms(run.rerankMs ?? 0)}`)
  }
  const want = s.limit === undefined ? 'all matches' : `the best ${fmt(s.offset + s.limit)}`
  lines.push(
    `${fn}: keep ${want}, best first${s.offset > 0 ? `, skip ${fmt(s.offset)}` : ''}: ${plural(returned, 'row')}`,
  )
  return lines
}

async function runGroups(x: Exec, s: WithTableAt<SelectStatement>, f: Filters): Promise<QueryResult> {
  const keys: string[] = []
  const keyOf = (path: string[], at: number, what: string): number => {
    const r = x.ref(path, at)
    if (r.kind !== 'column') {
      x.fail(
        at,
        `${what} works on filter columns (${x.conn.columns.map(ident).join(', ') || 'this database has none'})`,
      )
    }
    if (!keys.includes(r.name)) keys.push(r.name)
    return keys.indexOf(r.name)
  }
  if (s.groupBy) {
    for (const g of s.groupBy) keyOf(g.path, g.at, 'GROUP BY')
  } else {
    for (const it of s.items) {
      if (it.kind === 'count') {
        x.fail(it.at, 'COUNT(*) with DISTINCT needs GROUP BY: SELECT kind, COUNT(*) FROM ... GROUP BY kind')
      }
      if (it.kind === 'star') x.fail(it.at, 'DISTINCT works on filter columns: SELECT DISTINCT kind FROM ...')
      keyOf(it.path, it.at, 'DISTINCT')
    }
  }
  type GItem = { name: string; key: number; at: number } | { name: string; count: true; at: number }
  const items: GItem[] = []
  for (const it of s.items) {
    if (it.kind === 'star') x.fail(it.at, 'with GROUP BY, select the grouped columns and COUNT(*), not *')
    if (it.kind === 'count') {
      items.push({ name: it.name, count: true, at: it.at })
      continue
    }
    const ref = x.ref(it.path, it.at)
    const key = ref.kind === 'column' ? keys.indexOf(ref.name) : -1
    if (key < 0) {
      x.fail(
        it.at,
        `with GROUP BY ${keys.map(ident).join(', ')}, select ${keys.length > 1 ? 'those columns' : ident(keys[0]!)} and COUNT(*)`,
      )
    }
    items.push({ name: it.aliased ? it.name : keys[key]!, key, at: it.at })
  }
  namesUnique(items)
  let groups: { values: (StoredColumnValue | null)[]; count: number }[] = []
  if (!f.none) {
    if (f.ids) {
      const counts = new Map<string, { values: (StoredColumnValue | null)[]; count: number }>()
      for (const r of await x.byId(f, false)) {
        const values = keys.map((k) => r.columns[k] ?? null)
        const id = JSON.stringify(values.map((v) => (typeof v === 'bigint' ? v.toString() : v)))
        const g = counts.get(id)
        if (g) g.count++
        else counts.set(id, { values, count: 1 })
      }
      groups = [...counts.values()]
    } else {
      groups = await x.db(x.conn._countBy(keys, x.where(f)))
    }
  }
  const cmpValue = (a: StoredColumnValue | null, b: StoredColumnValue | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1
  const order: {
    get: (g: { values: (StoredColumnValue | null)[]; count: number }) => number | StoredColumnValue | null
    desc: boolean
  }[] = []
  for (const o of s.order ?? []) {
    let get: (g: { values: (StoredColumnValue | null)[]; count: number }) => number | StoredColumnValue | null
    if (o.key.kind === 'count') get = (g) => g.count
    else {
      const path = o.key.path
      const named = path.length === 1 ? items.find((i) => eqi(i.name, path[0]!)) : undefined
      if (named) {
        get =
          'count' in named
            ? (g) => g.count
            : (
                (k) => (g: { values: (StoredColumnValue | null)[] }) =>
                  g.values[k]!
              )(named.key)
      } else {
        const r = x.ref(path, o.at)
        const k = r.kind === 'column' ? keys.indexOf(r.name) : -1
        if (k < 0) x.fail(o.at, `ORDER BY here takes ${keys.map(ident).join(', ')}${s.groupBy ? ' or COUNT(*)' : ''}`)
        get = (g) => g.values[k]!
      }
    }
    if (o.key.kind === 'count' && !s.groupBy) x.fail(o.at, 'ORDER BY COUNT(*) needs GROUP BY')
    order.push({ get, desc: o.desc })
  }
  groups.sort((a, b) => {
    for (const o of order) {
      const va = o.get(a)
      const vb = o.get(b)
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : cmpValue(va, vb)
      if (c !== 0) return o.desc ? -c : c
    }
    for (let i = 0; i < keys.length; i++) {
      const c = cmpValue(a.values[i]!, b.values[i]!)
      if (c !== 0) return c
    }
    return 0
  })
  const { rows: page, truncated } = x.page(groups, s)
  if (s.explain) {
    const filter = x.describe(f)
    const total = groups.reduce((n, g) => n + g.count, 0)
    const by = keys.map(ident).join(', ')
    const plan = f.none
      ? [`The conditions contradict each other (${f.conflict}): no document can match`]
      : [
          f.ids
            ? `Look up ${plural(f.ids.length, 'id')} (binary search in each segment's sorted ids)${f.columns.size > 0 ? `, keep those with ${x.describe({ ...f, ids: undefined })}` : ''}, and count them by ${by}`
            : `One pass over the ${plural(total, 'document')}${filter ? ` matching ${filter}` : ''}, counting them by ${by}${filter ? ' (blocks whose value sets cannot match are skipped)' : ''}: ${ms(x.databaseMs)}`,
          `${plural(groups.length, 'group')}${order.length > 0 ? ', in ORDER BY order' : ''}; return ${plural(page.length, 'row')}`,
        ]
    return x.result({
      command: 'EXPLAIN',
      columns: ['plan'],
      rows: plan.map((p) => ({ plan: p })),
      rowCount: plan.length,
      plan,
    })
  }
  const rows = page.map((g) => {
    const o: Record<string, unknown> = {}
    for (const it of items) o[it.name] = 'count' in it ? g.count : g.values[it.key]
    return o
  })
  return x.result({
    command: 'SELECT',
    columns: items.map((i) => i.name),
    rows,
    rowCount: rows.length,
    ...(truncated ? { truncated } : {}),
  })
}

async function runCount(x: Exec, s: WithTableAt<SelectStatement>, f: Filters): Promise<QueryResult> {
  for (const it of s.items) {
    if (it.kind !== 'count') {
      x.fail(it.at, 'COUNT(*) without GROUP BY returns one row: select only COUNT(*), or add GROUP BY <column>')
    }
  }
  if (s.order) x.fail(s.order[0]!.at, 'ORDER BY with COUNT(*) needs GROUP BY')
  const items = s.items.map((it) => ({ name: (it as { name: string }).name }))
  namesUnique(items)
  const n = f.none ? 0 : f.ids ? (await x.byId(f, false)).length : await x.db(x.conn.count(x.where(f)))
  const { rows: page } = x.page([n], s)
  if (s.explain) {
    const filter = x.describe(f)
    const plan = f.none
      ? [`The conditions contradict each other (${f.conflict}): the count is 0`]
      : f.ids
        ? [
            `Look up ${plural(f.ids.length, 'id')} (binary search in each segment's sorted ids): ${fmt(n)} found${f.columns.size > 0 ? ' that pass the other conditions' : ''}`,
          ]
        : filter
          ? [
              `Count the documents matching ${filter} (blocks whose value sets cannot match are skipped): ${fmt(n)}, ${ms(x.databaseMs)}`,
            ]
          : [`Count all live documents (kept in the manifest, no scan): ${fmt(n)}`]
    return x.result({
      command: 'EXPLAIN',
      columns: ['plan'],
      rows: plan.map((p) => ({ plan: p })),
      rowCount: plan.length,
      plan,
    })
  }
  const rows = page.map((c) => Object.fromEntries(items.map((i) => [i.name, c])))
  return x.result({ command: 'SELECT', columns: items.map((i) => i.name), rows, rowCount: rows.length })
}

async function runScan(x: Exec, s: WithTableAt<SelectStatement>, f: Filters): Promise<QueryResult> {
  let orderBy: Record<string, SortDirection> | undefined
  if (s.order) {
    if (s.order.length > 1) {
      x.fail(s.order[1]!.at, 'ORDER BY without GROUP BY supports one typed column')
    }
    const o = s.order[0]!
    if (o.key.kind !== 'path') {
      x.fail(o.at, 'ORDER BY COUNT(*) needs GROUP BY')
    }
    const ref = x.ref(o.key.path, o.at)
    if (ref.kind !== 'column') {
      x.fail(o.at, 'ORDER BY without a ranking function works on typed filter columns')
    }
    const colType = x.conn.columnTypes[ref.name] ?? 'string'
    if (colType === 'string') {
      x.fail(
        o.at,
        'ORDER BY a string column is not supported (there are no sorted scans on string columns): order by a time or int column, rank with ORDER BY HYBRID(), SIMILARITY() or BM25(), or count with GROUP BY',
      )
    }
    orderBy = { [ref.name]: o.desc ? 'desc' : 'asc' }
  }
  const items = itemsOf(x, s, false)
  const scoreItem = items.find((i) => 'ref' in i && i.ref.kind === 'score')
  if (scoreItem) x.fail(scoreItem.at, 'score needs a ranking: add ORDER BY HYBRID(...), SIMILARITY(...) or BM25(...)')
  const includeVector = items.some((i) => 'ref' in i && i.ref.kind === 'vector')
  const max = x.maxRows()
  let rows: Row<unknown>[] = []
  let truncated = false
  if (!f.none && s.limit !== 0) {
    if (f.ids) {
      ;({ rows, truncated } = x.page(await x.byId(f, includeVector), s))
    } else {
      let limit = s.limit ?? U32_MAX
      if (max !== undefined) limit = Math.min(limit, max + 1)
      rows = await x.db(x.conn.list({ where: x.where(f), orderBy, offset: s.offset, limit, includeVector }))
      if (max !== undefined && rows.length > max) {
        rows = rows.slice(0, max)
        truncated = true
      }
    }
  }
  if (s.explain) {
    const filter = x.describe(f)
    let plan: string[]
    if (f.none) plan = [`The conditions contradict each other (${f.conflict}): no document can match`]
    else if (f.ids) {
      plan = [
        `Look up ${plural(f.ids.length, 'id')} (binary search in each segment's sorted ids)${f.columns.size > 0 ? `, keep those with ${x.describe({ ...f, ids: undefined })}` : ''}: ${plural(rows.length, 'row')}`,
      ]
    } else {
      const matched = await x.db(x.conn.count(x.where(f)))
      const orderDesc = orderBy
        ? `ordered by ${Object.entries(orderBy)
            .map(([k, d]) => `${ident(k)} ${d.toUpperCase()}`)
            .join(', ')} (with zone-map early termination)`
        : 'in storage order'
      plan = [
        `Read ${filter ? `the ${plural(matched, 'document')} matching ${filter}` : `all ${plural(matched, 'document')}`} ${orderDesc}${filter ? ' (blocks whose value sets or zone maps cannot match are skipped)' : ''}`,
        `Return ${plural(rows.length, 'row')}${s.offset > 0 ? ` after skipping ${fmt(s.offset)}` : ''}${orderBy ? '' : ' (no ranking: add ORDER BY HYBRID(), SIMILARITY() or BM25() to rank)'}`,
      ]
    }
    return x.result({
      command: 'EXPLAIN',
      columns: ['plan'],
      rows: plan.map((p) => ({ plan: p })),
      rowCount: plan.length,
      plan,
    })
  }
  return x.result({
    command: 'SELECT',
    columns: items.map((i) => i.name),
    rows: project(items, rows),
    rowCount: rows.length,
    ...(truncated ? { truncated } : {}),
  })
}

function jsonValue(v: unknown, what: string, fail: (m: string) => never): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return fail(`${what} must be JSON, such as '{"page": 3}', or an object passed as a parameter`)
  }
}

async function runInsert(x: Exec, s: WithTableAt<InsertStatement>): Promise<QueryResult> {
  x.checkTable(s.table, s.tableAt)
  const refs = s.columns.map((c) => ({ ref: x.ref(c.path, c.at), at: c.at }))
  const seen = new Set<string>()
  for (const { ref, at } of refs) {
    if (ref.kind === 'score') x.fail(at, 'score is computed by ORDER BY; it cannot be inserted')
    if (ref.kind === 'field') {
      x.fail(at, 'set metadata as a whole: a JSON string such as \'{"page": 3}\', or an object passed as a parameter')
    }
    const key = ref.kind === 'column' ? `column:${ref.name}` : ref.kind
    if (seen.has(key)) x.fail(at, `${ref.kind === 'column' ? ident(ref.name) : ref.kind} is listed twice`)
    seen.add(key)
  }
  const idAt = refs.find((r) => r.ref.kind === 'id')?.at
  if (idAt === undefined) x.fail(s.columns[0]!.at, 'the column list needs id')
  const docs: Document<unknown>[] = s.rows.map((values, r) => {
    const doc: Document<unknown> = { id: '' }
    const columns: Record<string, ColumnValue> = {}
    refs.forEach(({ ref, at }, i) => {
      const v = values[i]
      const fail = (m: string): never => x.fail(at, s.rows.length > 1 ? `row ${r + 1}: ${m}` : m)
      switch (ref.kind) {
        case 'id':
          if (typeof v === 'number' && Number.isFinite(v)) doc.id = String(v)
          else if (typeof v === 'string' && v !== '') doc.id = v
          else fail('id must be a non-empty string')
          break
        case 'text':
          if (v !== null && v !== undefined && typeof v !== 'string') fail('text must be a string')
          if (typeof v === 'string') doc.text = v
          break
        case 'vector': {
          if (v === null || v === undefined) break
          const vec = jsonValue(v, 'the vector', fail)
          if (!(vec instanceof Float32Array) && !Array.isArray(vec)) {
            fail("the vector must be an array of numbers (as a parameter, or a string such as '[0.1, 0.2]')")
          }
          doc.vector = vec as ArrayLike<number>
          break
        }
        case 'metadata':
          if (v !== null && v !== undefined) doc.metadata = jsonValue(v, 'metadata', fail)
          break
        case 'column':
          if (
            v !== null &&
            v !== undefined &&
            !['string', 'number', 'boolean', 'bigint'].includes(typeof v) &&
            !(v instanceof Date)
          ) {
            fail(`${ident(ref.name)} must be a string, number, boolean, Date or NULL`)
          }
          columns[ref.name] = v as ColumnValue
          break
        default:
          break
      }
    })
    if (Object.keys(columns).length > 0) doc.columns = columns
    return doc
  })
  const verb = s.mode === 'INSERT' ? 'INSERT' : 'REPLACE'
  if (s.explain) {
    const toEmbed = docs.filter(
      (d) => d.vector === undefined && typeof d.text === 'string' && d.text.trim() !== '',
    ).length
    const plan = [
      ...(toEmbed > 0
        ? [
            `Embed ${plural(toEmbed, 'text')} with the connection's embed function${x.conn.model ? ` (${x.conn.model})` : ''}`,
          ]
        : []),
      s.mode === 'INSERT'
        ? `Insert ${plural(docs.length, 'document')} in one atomic commit; it fails with PRISM_DUPLICATE, writing nothing, if an id already exists`
        : `Write ${plural(docs.length, 'document')} in one atomic commit, replacing any with the same id`,
      'Not run: EXPLAIN only describes writes',
    ]
    return x.result({
      command: 'EXPLAIN',
      columns: ['plan'],
      rows: plan.map((p) => ({ plan: p })),
      rowCount: plan.length,
      plan,
    })
  }
  x.readOnlyCheck(verb)
  const w = await x.conn._writeTimed(s.mode === 'INSERT' ? 'insert' : 'upsert', docs)
  x.embedMs += w.embedMs
  x.databaseMs += w.databaseMs
  return x.result({ command: verb, columns: [], rows: [], rowCount: w.result.upserted, version: w.result.version })
}

async function runDelete(x: Exec, s: WithTableAt<DeleteStatement>): Promise<QueryResult> {
  x.checkTable(s.table, s.tableAt)
  const f = x.filters(s.where)
  if (f.ids && (f.columns.size > 0 || f.ranges.size > 0)) {
    x.fail(f.idAt!, 'DELETE by id cannot be combined with other conditions: delete by id, or by filter columns')
  }
  const filter = x.describe(f)
  if (s.explain) {
    let plan: string[]
    if (f.none) plan = [`The conditions contradict each other (${f.conflict}): nothing would be deleted`]
    else if (f.ids) {
      const found = (await x.byId(f, false)).length
      plan = [`Delete ${plural(f.ids.length, 'id')} (${fmt(found)} stored now) in one atomic commit`]
    } else {
      const n = await x.db(x.conn.count(x.where(f)))
      plan = [
        `Delete the ${plural(n, 'document')} matching ${filter} in one atomic commit (blocks whose value sets cannot match are skipped)`,
      ]
    }
    plan.push('Not run: EXPLAIN only describes writes')
    return x.result({
      command: 'EXPLAIN',
      columns: ['plan'],
      rows: plan.map((p) => ({ plan: p })),
      rowCount: plan.length,
      plan,
    })
  }
  x.readOnlyCheck('DELETE')
  if (f.none) return x.result({ command: 'DELETE', columns: [], rows: [], rowCount: 0 })
  const r = await x.db(f.ids ? x.conn.delete(f.ids) : x.conn.deleteWhere(x.where(f)))
  return x.result({ command: 'DELETE', columns: [], rows: [], rowCount: r.deleted, version: r.version })
}

export async function runQuery(
  conn: Conn,
  sql: string,
  params: SqlParams | undefined,
  options: QueryOptions | undefined,
): Promise<QueryResult> {
  if (options !== undefined && (options === null || typeof options !== 'object')) {
    throw new PrismError('PRISM_INVALID', 'query() options must be an object')
  }
  if (params !== undefined && params !== null && typeof params !== 'object') {
    throw new PrismError('PRISM_INVALID', 'query() parameters must be an array or an object')
  }
  const stmt = parseSql(sql, params ?? undefined)
  const x = new Exec(conn, sql, options ?? {})
  switch (stmt.kind) {
    case 'select':
      return runSelect(x, stmt)
    case 'insert':
      return runInsert(x, stmt)
    case 'delete':
      return runDelete(x, stmt)
  }
}
