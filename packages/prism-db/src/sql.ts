// A small SQL dialect for prism-db: tokenizer and parser (no I/O). A database file is one table;
// its columns are `id`, `text`, `metadata`, `vector`, `score` and the filter columns declared at
// creation.
//
// Supports SELECT (with ORDER BY HYBRID/SIMILARITY/BM25, optional RECENCY() and RERANK n, or
// ORDER BY a typed column for latest-N scans), WHERE with =, IN (...), IS NULL, <, <=, >, >=, and
// BETWEEN ... AND ... on typed columns, COUNT(*), GROUP BY, DISTINCT, LIMIT/OFFSET,
// INSERT / REPLACE / UPSERT INTO ... VALUES, DELETE ... WHERE, and EXPLAIN.

import { PrismError } from './errors.ts'
import type { SqlParams } from './types.ts'

export interface Condition {
  path: string[]
  column: string
  /** Allowed exact values (OR); null means "no value". */
  values?: (string | number | bigint | boolean | Date | null)[]
  gt?: unknown
  gte?: unknown
  lt?: unknown
  lte?: unknown
  at: number
}

export interface RankRecency {
  column: string
  halfLifeMs: number
  weight: number
  at: number
}

export interface Rank {
  fn: 'HYBRID' | 'SIMILARITY' | 'BM25'
  text?: string
  vector?: unknown
  weight?: number
  recency?: RankRecency
  at: number
}

export type SelectItem =
  | { kind: 'star'; at: number }
  | { kind: 'count'; name: string; at: number }
  | { kind: 'path'; path: string[]; name: string; aliased: boolean; at: number }

export interface PathRef {
  path: string[]
  at: number
}

export interface OrderKey {
  key: { kind: 'count' } | { kind: 'path'; path: string[] }
  desc: boolean
  at: number
}

export interface SelectStatement {
  kind: 'select'
  explain: boolean
  distinct: boolean
  items: SelectItem[]
  table: string
  where: Condition[]
  groupBy?: PathRef[]
  rank?: Rank
  order?: OrderKey[]
  limit?: number
  offset: number
  rerank?: number
}

export interface DeleteStatement {
  kind: 'delete'
  explain: boolean
  table: string
  where: Condition[]
}

export type WithTableAt<T> = T & { tableAt: number }

export interface InsertStatement {
  kind: 'insert'
  explain: boolean
  mode: 'INSERT' | 'REPLACE'
  table: string
  columns: PathRef[]
  rows: unknown[][]
}

export type Statement = SelectStatement | DeleteStatement | InsertStatement

type Tok =
  | { t: 'word'; v: string; at: number }
  | { t: 'ident'; v: string; at: number }
  | { t: 'string'; v: string; at: number }
  | { t: 'number'; v: number; raw: string; at: number }
  | { t: 'param'; v: string; at: number }
  | { t: 'op'; v: string; at: number }
  | { t: 'eof'; at: number }

export function sqlError(sql: string, at: number, message: string): PrismError {
  const before = sql.slice(0, at)
  const line = before.split('\n').length
  const col = at - before.lastIndexOf('\n')
  const near = sql
    .slice(at, at + 24)
    .split('\n')[0]!
    .trimEnd()
  return new PrismError(
    'PRISM_SQL',
    `${message} (line ${line}, column ${col}${near ? `, near "${near}"` : ', at the end'})`,
    { position: at },
  )
}

function tokenizeSql(sql: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) throw sqlError(sql, i, 'unclosed /* comment')
      i = end + 2
    } else if (c === "'") {
      const at = i
      let v = ''
      i++
      for (;;) {
        if (i >= sql.length) throw sqlError(sql, at, 'unclosed string')
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            v += "'"
            i += 2
            continue
          }
          i++
          break
        }
        v += sql[i++]
      }
      toks.push({ t: 'string', v, at })
    } else if (c === '"' || c === '`') {
      const at = i
      let v = ''
      i++
      for (;;) {
        if (i >= sql.length) throw sqlError(sql, at, 'unclosed quoted name')
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            v += c
            i += 2
            continue
          }
          i++
          break
        }
        v += sql[i++]
      }
      if (v === '') throw sqlError(sql, at, 'empty quoted name')
      toks.push({ t: 'ident', v, at })
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(sql.slice(i))!
      toks.push({ t: 'number', v: Number(m[0]), raw: m[0], at: i })
      i += m[0].length
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))!
      toks.push({ t: 'word', v: m[0], at: i })
      i += m[0].length
    } else if (c === '?') {
      toks.push({ t: 'param', v: '?', at: i++ })
    } else if ((c === ':' || c === '$' || c === '@') && /[A-Za-z0-9_]/.test(sql[i + 1] || '')) {
      const m = /^[A-Za-z0-9_]+/.exec(sql.slice(i + 1))!
      toks.push({ t: 'param', v: c + m[0], at: i })
      i += 1 + m[0].length
    } else {
      const two = sql.slice(i, i + 2)
      if (['!=', '<>', '<=', '>='].includes(two)) {
        toks.push({ t: 'op', v: two, at: i })
        i += 2
      } else if ('(),*.;=<>+-'.includes(c)) {
        toks.push({ t: 'op', v: c, at: i++ })
      } else {
        throw sqlError(sql, i, `unexpected character "${c}"`)
      }
    }
  }
  toks.push({ t: 'eof', at: sql.length })
  return toks
}

const RANK_FNS = new Set(['HYBRID', 'SIMILARITY', 'BM25'])

export function parseDurationMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  if (typeof v !== 'string') return null
  const m =
    /^\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?|w|weeks?)\s*$/i.exec(v)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  if (unit.startsWith('ms') || unit.startsWith('millisecond')) return n
  if (unit.startsWith('s')) return n * 1000
  if (unit.startsWith('m')) return n * 60_000
  if (unit.startsWith('h')) return n * 3_600_000
  if (unit.startsWith('d')) return n * 86_400_000
  if (unit.startsWith('w')) return n * 7 * 86_400_000
  return null
}

class Parser {
  private k = 0
  private positional = 0
  private usedNamed = false
  private readonly sql: string
  private readonly toks: Tok[]
  private readonly params: SqlParams | undefined

  constructor(sql: string, toks: Tok[], params: SqlParams | undefined) {
    this.sql = sql
    this.toks = toks
    this.params = params
  }

  private get tok(): Tok {
    return this.toks[this.k]!
  }
  private fail(message: string, tok: Tok = this.tok): never {
    throw sqlError(this.sql, tok.at, message)
  }
  private isWord(...words: string[]): boolean {
    const t = this.tok
    return t.t === 'word' && words.includes(t.v.toUpperCase())
  }
  private isOp(op: string): boolean {
    const t = this.tok
    return t.t === 'op' && t.v === op
  }
  private word(...words: string[]): string {
    if (!this.isWord(...words)) this.fail(`expected ${words.join(' or ')}`)
    return (this.toks[this.k++] as { v: string }).v.toUpperCase()
  }
  private op(op: string): void {
    if (!this.isOp(op)) this.fail(`expected "${op}"`)
    this.k++
  }
  private maybeWord(...words: string[]): boolean {
    if (!this.isWord(...words)) return false
    this.k++
    return true
  }
  private maybeOp(op: string): boolean {
    if (!this.isOp(op)) return false
    this.k++
    return true
  }
  private name(what = 'a name'): string {
    const t = this.tok
    if (t.t === 'ident' || t.t === 'word') {
      this.k++
      return t.v
    }
    return this.fail(`expected ${what}`)
  }

  private value(): unknown {
    const t = this.tok
    if (t.t === 'string' || t.t === 'number') {
      this.k++
      return t.v
    }
    if (t.t === 'op' && t.v === '-' && this.toks[this.k + 1]?.t === 'number') {
      this.k += 2
      return -(this.toks[this.k - 1] as { v: number }).v
    }
    if (t.t === 'param') {
      this.k++
      return this.param(t)
    }
    if (this.maybeWord('NULL')) return null
    if (this.maybeWord('TRUE')) return true
    if (this.maybeWord('FALSE')) return false
    return this.fail('expected a value (a quoted string, a number or a parameter)')
  }

  private param(t: Tok & { v: string }): unknown {
    const p = this.params
    if (t.v === '?') {
      if (!Array.isArray(p)) this.fail('"?" needs an array of parameters', t)
      if (this.usedNamed) this.fail('mixing "?" and named parameters', t)
      if (this.positional >= p.length) this.fail(`missing parameter ${this.positional + 1}`, t)
      return p[this.positional++]
    }
    if (t.v[0] === '$' && /^\$\d+$/.test(t.v)) {
      if (!Array.isArray(p)) this.fail(`"${t.v}" needs an array of parameters`, t)
      const i = Number(t.v.slice(1)) - 1
      if (i < 0 || i >= p.length) this.fail(`missing parameter ${t.v}`, t)
      return p[i]
    }
    if (!p || Array.isArray(p) || typeof p !== 'object') {
      this.fail(`"${t.v}" needs an object of named parameters`, t)
    }
    this.usedNamed = true
    const key = t.v.slice(1)
    if (!Object.prototype.hasOwnProperty.call(p, key)) this.fail(`missing parameter ${t.v}`, t)
    return (p as Record<string, unknown>)[key]
  }

  private integer(what: string, min = 0): number {
    const at = this.tok
    const v = this.value()
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
      this.fail(`${what} must be a whole number of at least ${min}`, at)
    }
    return v
  }

  parse(): WithTableAt<Statement> {
    const explain = this.maybeWord('EXPLAIN')
    if (explain) this.maybeWord('ANALYZE')
    let stmt: WithTableAt<Statement>
    if (this.isWord('SELECT')) stmt = this.select(explain)
    else if (this.isWord('DELETE')) stmt = this.delete(explain)
    else if (this.isWord('INSERT', 'REPLACE', 'UPSERT')) stmt = this.insert(explain)
    else if (this.isWord('UPDATE')) this.fail('UPDATE is not supported: REPLACE INTO writes whole documents')
    else this.fail('expected SELECT, INSERT, REPLACE, UPSERT, DELETE or EXPLAIN')
    this.maybeOp(';')
    if (this.tok.t !== 'eof') this.fail('unexpected text after the end of the statement (one statement at a time)')
    if (this.positional > 0 && Array.isArray(this.params) && this.positional < this.params.length) {
      throw new PrismError('PRISM_SQL', `${this.params.length} parameters given, the statement uses ${this.positional}`)
    }
    return stmt
  }

  private select(explain: boolean): WithTableAt<SelectStatement> {
    this.word('SELECT')
    const distinct = this.maybeWord('DISTINCT')
    const items: SelectItem[] = []
    do {
      if (this.isOp('*')) {
        items.push({ kind: 'star', at: this.tok.at })
        this.k++
        continue
      }
      if (
        this.isWord('COUNT') &&
        this.toks[this.k + 1]?.t === 'op' &&
        (this.toks[this.k + 1] as { v: string }).v === '('
      ) {
        const at = this.tok.at
        this.k += 2
        if (!this.isOp('*')) this.fail('COUNT takes *: COUNT(*)')
        this.op('*')
        this.op(')')
        items.push({ kind: 'count', name: this.alias() ?? 'count', at })
        continue
      }
      if (this.tok.t === 'word' && ['SUM', 'AVG', 'MIN', 'MAX'].includes(this.tok.v.toUpperCase())) {
        this.fail(`${this.tok.v.toUpperCase()}() is not supported; COUNT(*) is`)
      }
      const at = this.tok.at
      if (this.tok.t === 'word' && RANK_FNS.has(this.tok.v.toUpperCase())) {
        this.fail(`${this.tok.v.toUpperCase()}() goes in ORDER BY; select its value as score`)
      }
      const path = this.path()
      const alias = this.alias()
      items.push({ kind: 'path', path, name: alias ?? path[path.length - 1]!, aliased: alias !== undefined, at })
    } while (this.maybeOp(','))
    this.word('FROM')
    const tableAt = this.tok.at
    const table = this.name('a table name')
    if (this.isOp(',') || this.isWord('JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS')) {
      this.fail('joins are not supported: a database is one table')
    }
    const where = this.maybeWord('WHERE') ? this.conditions() : []
    let groupBy: PathRef[] | undefined
    if (this.maybeWord('GROUP')) {
      this.word('BY')
      groupBy = []
      do {
        const at = this.tok.at
        groupBy.push({ path: this.path(), at })
      } while (this.maybeOp(','))
    }
    if (this.isWord('HAVING')) this.fail('HAVING is not supported')
    let rank: Rank | undefined
    let order: OrderKey[] | undefined
    if (this.maybeWord('ORDER')) {
      this.word('BY')
      const t = this.tok
      if (t.t === 'word' && RANK_FNS.has(t.v.toUpperCase())) {
        rank = this.rank()
        if (this.isWord('ASC'))
          this.fail('ranked results come best first: ORDER BY ... DESC (or leave the direction out)')
        this.maybeWord('DESC')
        if (this.isOp(',')) this.fail(`ORDER BY ${rank.fn}() is the whole ordering: results come best first`)
      } else {
        order = []
        do {
          const k = this.tok
          if (k.t === 'word' && RANK_FNS.has(k.v.toUpperCase())) {
            this.fail(`${k.v.toUpperCase()}() must be the only ORDER BY key`)
          }
          let key: OrderKey['key']
          if (
            this.isWord('COUNT') &&
            this.toks[this.k + 1]?.t === 'op' &&
            (this.toks[this.k + 1] as { v: string }).v === '('
          ) {
            this.k += 2
            this.op('*')
            this.op(')')
            key = { kind: 'count' }
          } else if (k.t === 'word' || k.t === 'ident') {
            key = { kind: 'path', path: this.path() }
          } else {
            this.fail('ORDER BY takes HYBRID(text [, weight]), SIMILARITY(text), BM25(text), or a column')
          }
          const desc = this.maybeWord('DESC')
          if (!desc) this.maybeWord('ASC')
          order.push({ key, desc, at: k.at })
        } while (this.maybeOp(','))
      }
    }
    let limit: number | undefined
    let offset = 0
    if (this.maybeWord('LIMIT')) {
      limit = this.integer('LIMIT')
      if (this.maybeOp(',')) {
        offset = limit
        limit = this.integer('LIMIT')
      } else if (this.maybeWord('OFFSET')) {
        offset = this.integer('OFFSET')
      }
    } else if (this.maybeWord('OFFSET')) {
      offset = this.integer('OFFSET')
    }
    let rerank: number | undefined
    if (this.maybeWord('RERANK')) {
      if (!rank) this.fail('RERANK requires ORDER BY HYBRID(...), SIMILARITY(...), or BM25(...)')
      rerank = this.integer('RERANK', 1)
    }
    return {
      kind: 'select',
      explain,
      distinct,
      items,
      table,
      tableAt,
      where,
      groupBy,
      rank,
      order,
      limit,
      offset,
      rerank,
    }
  }

  private path(): string[] {
    const path = [this.name('a column')]
    while (this.maybeOp('.')) path.push(this.name('a field name'))
    return path
  }

  private alias(): string | undefined {
    if (this.maybeWord('AS')) return this.name('a column name')
    const t = this.tok
    if (
      t.t === 'ident' ||
      (t.t === 'word' && !['FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'RERANK'].includes(t.v.toUpperCase()))
    ) {
      this.k++
      return t.v
    }
    return undefined
  }

  private parseRecency(): RankRecency {
    const at = this.tok.at
    this.word('RECENCY')
    this.op('(')
    const column = this.name('a time column name')
    this.op(',')
    const hlTok = this.tok
    const hlVal = this.value()
    const halfLifeMs = parseDurationMs(hlVal)
    if (halfLifeMs === null) {
      this.fail("RECENCY() half-life must be a positive number of ms or a duration like '3 days'", hlTok)
    }
    let weight = 0.15
    if (this.maybeOp(',')) {
      const wTok = this.tok
      const wVal = this.value()
      if (typeof wVal !== 'number' || !(wVal >= 0 && wVal <= 1)) {
        this.fail('RECENCY() weight must be a number between 0 and 1', wTok)
      }
      weight = wVal
    }
    this.op(')')
    return { column, halfLifeMs, weight, at }
  }

  private rank(): Rank {
    const t = this.tok as Tok & { v: string }
    const fn = t.v.toUpperCase() as Rank['fn']
    this.k++
    this.op('(')
    const args: { v: unknown; tok: Tok }[] = []
    let recency: RankRecency | undefined
    if (!this.isOp(')')) {
      do {
        if (this.isWord('RECENCY')) {
          recency = this.parseRecency()
        } else {
          const tok = this.tok
          args.push({ v: this.value(), tok })
        }
      } while (this.maybeOp(','))
    }
    this.op(')')
    const isVec = (v: unknown) =>
      typeof v === 'object' && v !== null && typeof (v as ArrayLike<number>).length === 'number'
    const text = (a: { v: unknown; tok: Tok } | undefined) => {
      if (!a || typeof a.v !== 'string' || !a.v.trim())
        this.fail(`${fn}() needs the query text as a string`, a?.tok ?? t)
      return a.v
    }
    if (fn === 'BM25') {
      if (args.length !== 1) this.fail('BM25(text) takes one argument', t)
      return { fn, text: text(args[0]), recency, at: t.at }
    }
    if (fn === 'SIMILARITY') {
      if (args.length !== 1) this.fail('SIMILARITY(text) or SIMILARITY(:vector) takes one argument', t)
      return isVec(args[0]!.v)
        ? { fn, vector: args[0]!.v, recency, at: t.at }
        : { fn, text: text(args[0]), recency, at: t.at }
    }
    let i = 0
    let vector: unknown
    if (args[0] && isVec(args[0].v)) vector = args[i++]!.v
    const q = text(args[i++])
    let weight: number | undefined
    if (args[i]) {
      const w = args[i++]!
      if (typeof w.v !== 'number' || !(w.v >= 0 && w.v <= 1)) {
        this.fail('the HYBRID() weight is the share of keyword scoring, between 0 and 1', w.tok)
      }
      weight = w.v
    }
    if (i < args.length) this.fail('HYBRID() takes (text [, weight]) or (vector, text [, weight])', args[i]!.tok)
    return { fn, text: q, vector, weight, recency, at: t.at }
  }

  private conditions(): Condition[] {
    const out: Condition[] = []
    do {
      out.push(...this.disjunction())
    } while (this.maybeWord('AND'))
    return out
  }

  private disjunction(): Condition[] {
    const first = this.primary()
    if (!this.isWord('OR')) return first
    const parts = [{ conds: first, tok: this.toks[this.k - 1]! }]
    while (this.maybeWord('OR')) {
      const tok = this.tok
      parts.push({ conds: this.primary(), tok })
    }
    const only =
      "OR works between values of one column, as in (kind = 'a' OR kind = 'b'); for several columns run separate queries"
    const column = first.length === 1 && first[0]!.values ? first[0]!.column : this.fail(only, parts[1]!.tok)
    const merged: Condition = { path: first[0]!.path, column, values: [], at: first[0]!.at }
    for (const p of parts) {
      if (p.conds.length !== 1 || !p.conds[0]!.values || p.conds[0]!.column.toLowerCase() !== column.toLowerCase()) {
        this.fail(only, p.tok)
      }
      merged.values!.push(...p.conds[0]!.values!)
    }
    return [merged]
  }

  private primary(): Condition[] {
    if (!this.maybeOp('(')) return [this.predicate()]
    const inner = this.conditions()
    this.op(')')
    return inner
  }

  private predicate(): Condition {
    const colTok = this.tok
    const at = colTok.at
    const path = this.path()
    const column = path.join('.')
    if (this.maybeWord('IS')) {
      if (this.isWord('NOT')) this.fail('IS NOT NULL is not supported: filters match values, not their absence')
      this.word('NULL')
      return { path, column, values: [null], at }
    }
    if (this.isWord('NOT')) this.fail('NOT IN is not supported: filters match values (list the ones you want with IN)')
    if (this.maybeWord('IN')) {
      this.op('(')
      if (this.isOp(')')) this.fail('IN () needs at least one value')
      const values: (string | number | bigint | boolean | Date | null)[] = []
      do {
        values.push(this.rawColumnValue())
      } while (this.maybeOp(','))
      this.op(')')
      return { path, column, values, at }
    }
    if (this.maybeWord('BETWEEN')) {
      const low = this.rawColumnValue()
      if (low === null) this.fail('BETWEEN bounds cannot be NULL')
      this.word('AND')
      const high = this.rawColumnValue()
      if (high === null) this.fail('BETWEEN bounds cannot be NULL')
      return { path, column, gte: low, lte: high, at }
    }
    if (this.isWord('LIKE', 'MATCH', 'ILIKE', 'GLOB', 'REGEXP')) {
      this.fail(
        `${(this.tok as { v: string }).v.toUpperCase()} is not supported: filter with =, IN, or ranges, and search text with BM25() or HYBRID() in ORDER BY`,
      )
    }
    const t = this.tok
    if (t.t === 'op' && (t.v === '!=' || t.v === '<>')) {
      this.fail(`"${t.v}" is not supported: filters match values with = or IN`)
    }
    if (t.t === 'op' && ['<', '<=', '>', '>='].includes(t.v)) {
      const op = t.v
      this.k++
      const vt = this.tok
      const v = this.rawColumnValue()
      if (v === null) this.fail(`range bound after ${op} cannot be NULL`, vt)
      return {
        path,
        column,
        ...(op === '<' ? { lt: v } : op === '<=' ? { lte: v } : op === '>' ? { gt: v } : { gte: v }),
        at,
      }
    }
    if (!this.isOp('=')) this.fail(`expected =, IN, BETWEEN, <, <=, >, >= or IS NULL after ${column}`, colTok)
    this.k++
    const vt = this.tok
    const v = this.rawColumnValue()
    if (v === null) this.fail(`use "${column} IS NULL" to match documents with no value`, vt)
    return { path, column, values: [v], at }
  }

  private rawColumnValue(): string | number | bigint | boolean | Date | null {
    const at = this.tok
    const v = this.value()
    if (v === null) return null
    if (
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean' ||
      typeof v === 'bigint' ||
      v instanceof Date
    ) {
      return v
    }
    return this.fail('filter values must be strings, numbers, dates or booleans', at)
  }

  private delete(explain: boolean): WithTableAt<DeleteStatement> {
    this.word('DELETE')
    this.word('FROM')
    const tableAt = this.tok.at
    const table = this.name('a table name')
    if (!this.isWord('WHERE')) this.fail('DELETE needs a WHERE clause (to empty a database, delete its file)')
    this.word('WHERE')
    return { kind: 'delete', explain, table, tableAt, where: this.conditions() }
  }

  private insert(explain: boolean): WithTableAt<InsertStatement> {
    const verb = this.word('INSERT', 'REPLACE', 'UPSERT')
    if (verb === 'INSERT' && this.isWord('OR')) {
      this.k++
      this.word('REPLACE')
      return this.insertRest(explain, 'REPLACE')
    }
    return this.insertRest(explain, verb === 'INSERT' ? 'INSERT' : 'REPLACE')
  }

  private insertRest(explain: boolean, mode: 'INSERT' | 'REPLACE'): WithTableAt<InsertStatement> {
    this.word('INTO')
    const tableAt = this.tok.at
    const table = this.name('a table name')
    if (!this.isOp('(')) this.fail('expected the column list, as in INSERT INTO documents (id, text) VALUES (...)')
    this.op('(')
    const columns: PathRef[] = []
    do {
      const at = this.tok.at
      columns.push({ path: this.path(), at })
    } while (this.maybeOp(','))
    this.op(')')
    this.word('VALUES')
    const rows: unknown[][] = []
    do {
      const at = this.tok
      this.op('(')
      const row: unknown[] = []
      do {
        row.push(this.value())
      } while (this.maybeOp(','))
      this.op(')')
      if (row.length !== columns.length) this.fail(`${row.length} values for ${columns.length} columns`, at)
      rows.push(row)
    } while (this.maybeOp(','))
    return { kind: 'insert', explain, mode, table, tableAt, columns, rows }
  }
}

export function parseSql(sql: string, params?: SqlParams): WithTableAt<Statement> {
  if (typeof sql !== 'string') throw new PrismError('PRISM_SQL', 'query() takes the SQL text as a string')
  return new Parser(sql, tokenizeSql(sql), params).parse()
}

export function escapeLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PrismError('PRISM_INVALID', `escapeLiteral: ${value} has no SQL literal`)
    return String(value)
  }
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return `'${value.toISOString()}'`
  if (typeof value !== 'string') {
    throw new PrismError('PRISM_INVALID', 'escapeLiteral takes a string, number, boolean or null')
  }
  return `'${value.replace(/'/g, "''")}'`
}

export function escapeIdentifier(name: string): string {
  if (typeof name !== 'string' || name === '') {
    throw new PrismError('PRISM_INVALID', 'escapeIdentifier takes a non-empty string')
  }
  return `"${name.replace(/"/g, '""')}"`
}
