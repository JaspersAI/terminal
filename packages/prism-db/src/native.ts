// NativeDatabase: loads a prebuilt N-API addon (`prism.node`) when present, and otherwise runs the
// complete `.prism` format v1 and v2 binary storage and exact search engine directly in Node.js.
// Every on-disk structure (4 KiB double header slots, 64-byte record headers, JSON manifests,
// 64-byte-aligned segment sections, and CRC-32 checksums) follows FORMAT.md identically.

import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { crc32 } from 'node:zlib'
import { PrismError } from './errors.ts'
import { tokenize, type TokenizerVersion } from './tokenizer.ts'
import type { ColumnDef, ColumnType, SortDirection } from './types.ts'

export interface NativeFilterTerm {
  column: string
  /** Allowed exact values ("" means null / no value). */
  values?: string[]
  /** Optional range bounds (as stringified i64 for time/int columns, or string for string columns). */
  gt?: string
  gte?: string
  lt?: string
  lte?: string
  includeNull?: boolean
}

export interface NativeDoc {
  id: string
  text?: string
  vector: Float32Array
  columns?: Record<string, string>
  meta?: string
}

export type NativeOp =
  | { kind: 'upsert'; docs: NativeDoc[] }
  | { kind: 'insert'; docs: NativeDoc[] }
  | { kind: 'delete'; ids: string[] }
  | { kind: 'deleteWhere'; filter: NativeFilterTerm[] }

export interface NativeRecency {
  column: string
  halfLife: number
  weight: number
  now: number
}

export interface NativeQuery {
  vector?: Float32Array
  text?: string
  textWeight?: number
  recency?: NativeRecency
  k: number
  filter?: NativeFilterTerm[]
  probe?: number
}

export interface NativeHit {
  id: string
  score: number
  text: string
  meta: string
  /** Filter column values in schema order ("" = no value). */
  values: string[]
  vector?: Float32Array
}

export interface NativeWriteOut {
  seq: number
  counts: number[]
  maintenanceDue: boolean
}

export interface NativeInfo {
  path: string
  dimensions: number
  model: string
  columns: string[]
  columnTypes: Record<string, ColumnType>
  tokenizer: TokenizerVersion
  formatVersion: number
  readonly: boolean
  count: number
  seq: number
  segments: number
  deleted: number
  fileBytes: number
}

export interface NativeMaintainOut {
  commits: number
  segmentsMerged: number
  segmentsDropped: number
  docsRewritten: number
  compacted: boolean
  seq: number
}

export interface NativeSearchStats {
  docsScanned: number
  rescored: number
  blocksScanned: number
  blocksSkipped: number
  docs: number
  segments: number
  blocks: number
  seq: number
}

export interface NativeSearchOut {
  hits: NativeHit[]
  stats: NativeSearchStats
}

export interface NativeMergePolicy {
  fanIn?: number
  maxMergeDocs?: number
  compactDeadRatio?: number
  compactMinDeadBytes?: number
  compactMaxDocs?: number
}

export interface NativeOrderBy {
  column: string
  dir: SortDirection
}

export interface NativeDatabase {
  write(ops: NativeOp[]): Promise<NativeWriteOut>
  search(q: NativeQuery): Promise<NativeSearchOut>
  bruteForce(q: NativeQuery): Promise<NativeSearchOut>
  get(ids: string[], vectors: boolean): Promise<(NativeHit | null)[]>
  scan(
    filter: NativeFilterTerm[],
    offset: number,
    limit: number,
    vectors: boolean,
    orderBy?: NativeOrderBy,
  ): Promise<NativeSearchOut>
  count(filter: NativeFilterTerm[]): Promise<number>
  distinct(column: string): Promise<string[]>
  countBy(columns: string[], filter: NativeFilterTerm[]): Promise<{ values: string[]; count: number }[]>
  maintain(): Promise<NativeMaintainOut>
  compact(): Promise<NativeMaintainOut>
  upgrade(tokenizer?: TokenizerVersion): Promise<NativeMaintainOut>
  backup(destPath: string): Promise<void>
  verify(): Promise<NativeMaintainOut>
  maintenanceDue(): boolean
  info(): NativeInfo
  setMergePolicy(p: NativeMergePolicy): void
  close(): void
  readonly closed: boolean
}

export interface NativeOpenCreate {
  dimensions: number
  model?: string
  columns?: (string | ColumnDef)[]
  tokenizer?: TokenizerVersion
  formatVersion?: 1 | 2
}

export interface NativeModule {
  NativeDatabase: {
    open(
      path: string,
      spec: { create?: NativeOpenCreate; readonly?: boolean; rollback?: boolean },
    ): Promise<NativeDatabase>
  }
}

// ---------------------------------------------------------------------------------------------
// Fault injection hook (WP-42)

export interface FaultHook {
  op: 'write' | 'setLen' | 'sync' | 'rename'
  /** Succeed this many times before failing on the next matching operation. */
  after: number
  code?: string
}

let activeFaultHook: { op: FaultHook['op']; remaining: number; code: string } | null = null

export function setFaultHook(hook: FaultHook | null): void {
  activeFaultHook = hook ? { op: hook.op, remaining: hook.after, code: hook.code ?? 'EIO' } : null
}

function checkFault(op: FaultHook['op']): void {
  if (!activeFaultHook || activeFaultHook.op !== op) return
  if (activeFaultHook.remaining > 0) {
    activeFaultHook.remaining--
    return
  }
  const code = activeFaultHook.code
  activeFaultHook = null
  const err = Object.assign(new Error(`${code}: injected ${op} fault`), { code })
  throw err
}

// ---------------------------------------------------------------------------------------------
// Format constants & helpers (FORMAT.md, DESIGN.md §6, WP-30, WP-51)

const MAGIC = Buffer.from('PRISMDB\x01', 'binary')
const REC_MAGIC = Buffer.from('PRSMREC\x01', 'binary')
const SEG_MAGIC = Buffer.from('PRSMSEG\x01', 'binary')

export const FORMAT_VERSION_V1 = 1
export const FORMAT_VERSION_V2 = 2
export const MAX_SUPPORTED_FORMAT = 2

const PAGE = 4096
const DATA_START = 2 * PAGE
const HEADER_SLOT_LEN = 48
const REC_HEADER_LEN = 64
const SEG_HEAD_FIXED = 64
const SEG_ENTRY_LEN = 32
const SECTION_ALIGN = 64
const KIND_SEGMENT = 1
const KIND_MANIFEST = 2
const BLOCK_SIZE = 256
const CLUSTER_MIN = 2048
const BM25_K1 = 0.9
const BM25_B = 0.4

const sec = {
  IDS_OFF: 1,
  IDS: 2,
  BLOCKS: 3,
  CENTROIDS: 4,
  CENTROID_NORMS: 5,
  VECTORS: 6,
  CODES: 7,
  CODE_SCALE: 8,
  CODE_ERR: 9,
  TEXT_OFF: 10,
  TEXT: 11,
  META_OFF: 12,
  META: 13,
  TERM_OFF: 14,
  TERMS: 15,
  TERM_DF: 16,
  POST_PTR: 17,
  POST_DOC: 18,
  POST_TF: 19,
  DOC_LEN: 20,
  IDS_SORTED: 21,
  COL_DICT_OFF: 22,
  COL_DICT: 23,
  COL_CODES: 24,
  COL_BLOCK_PTR: 25,
  COL_BLOCK_CODES: 26,
  /** Format v2 typed column values: i64 (8 bytes) per doc + 1 byte null flag per doc. */
  COL_TYPED_VALS: 27,
  /** Format v2 typed column zone maps: (nb + 1) entries of (min i64, max i64, flags u32, pad u32) = 24 bytes each. */
  COL_TYPED_ZONES: 28,
} as const

/**
 * Provable rounding slack for int8 upper bounds at dimension `dim` (DESIGN §6, WP-51).
 * Covers 16-lane f32 dot product accumulation error up to 65,536 dimensions.
 */
export function slackForDim(dim: number): number {
  return Math.max(2e-5, (dim / 16 + 17) * 2 ** -22)
}

function alignUp(x: number, a: number): number {
  return Math.ceil(x / a) * a
}

function hashCrc(buf: Uint8Array): number {
  return crc32(buf) >>> 0
}

function fail(code: string, msg: string): never {
  throw new Error(`${code}: ${msg}`)
}

function corrupt(msg: string): never {
  return fail('PRISM_CORRUPT', msg)
}

function invalid(msg: string): never {
  return fail('PRISM_INVALID', msg)
}

function ioError(e: unknown): never {
  const err = e as NodeJS.ErrnoException
  if (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES') {
    if (/rename/i.test(err.message)) fail('PRISM_BUSY', err.message)
  }
  return fail('PRISM_IO', err?.message ?? String(e))
}

// ---------------------------------------------------------------------------------------------
// Vector math & quantization (prism-core/src/vecmath.rs, quant.rs, kmeans.rs)

function dot(a: Float32Array, aOff: number, b: Float32Array, bOff: number, dim: number): number {
  let s = 0
  for (let i = 0; i < dim; i++) s += a[aOff + i]! * b[bOff + i]!
  return s
}

function norm(a: Float32Array, off = 0, dim = a.length): number {
  return Math.sqrt(dot(a, off, a, off, dim))
}

function toUnit(v: Float32Array): Float32Array | null {
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) return null
  }
  let n = norm(v, 0, v.length)
  const out = new Float32Array(v.length)
  if (!(Number.isFinite(n) && n > 1e-30)) {
    let m = 0
    for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i]!))
    if (m === 0) return null
    for (let i = 0; i < v.length; i++) out[i] = v[i]! / m
    n = norm(out, 0, out.length)
  } else {
    out.set(v)
  }
  if (!(n > 0)) return null
  const inv = 1 / n
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * inv
  return norm(out, 0, out.length) > 0.5 ? out : null
}

interface QQuery {
  codes: Int8Array
  scale: number
  err: number
  hatNorm: number
  slack: number
}

function encodeInt8(
  v: Float32Array,
  off: number,
  dim: number,
): { codes: Int8Array; scale: number; err: number; hatNorm: number } {
  let amax = 0
  for (let i = 0; i < dim; i++) {
    const a = Math.abs(v[off + i]!)
    if (a > amax) amax = a
  }
  const s = Math.fround(amax > 0 ? amax / 127 : 1)
  const codes = new Int8Array(dim)
  let e2 = 0
  let h2 = 0
  for (let i = 0; i < dim; i++) {
    const x = v[off + i]!
    const c = Math.max(-127, Math.min(127, Math.round(x / s)))
    codes[i] = c
    const r = s * c
    const d = x - r
    e2 += d * d
    h2 += r * r
  }
  return {
    codes,
    scale: s,
    err: Math.fround(Math.sqrt(e2) * (1 + 1e-6)),
    hatNorm: Math.fround(Math.sqrt(h2) * (1 + 1e-6)),
  }
}

function quantizeQuery(q: Float32Array): QQuery {
  const { codes, scale, err, hatNorm } = encodeInt8(q, 0, q.length)
  return { codes, scale, err, hatNorm, slack: slackForDim(q.length) }
}

function upperBound(
  codes: Int8Array,
  codeOff: number,
  dim: number,
  scale: number,
  err: number,
  maxNorm: number,
  qq: QQuery,
): number {
  let ip = 0
  const qc = qq.codes
  for (let i = 0; i < dim; i++) ip += qc[i]! * codes[codeOff + i]!
  return qq.scale * scale * ip + qq.hatNorm * err + qq.err * maxNorm + qq.slack
}

/** Deterministic PRNG for k-means seeding. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Recursive spherical k-means semantic ordering into blocks of <= 256 documents. */
function buildSemanticOrder(flat: Float32Array, n: number, dim: number): { order: Uint32Array; blocks: Uint32Array } {
  const perm: number[] = []
  const blocks: number[] = []
  let counter = 0

  function splitNode(ids: number[], depth: number): void {
    if (ids.length <= BLOCK_SIZE || depth >= 32) {
      let s = 0
      while (s < ids.length) {
        const e = Math.min(s + BLOCK_SIZE, ids.length)
        const startPos = perm.length
        for (let i = s; i < e; i++) perm.push(ids[i]!)
        blocks.push(startPos, perm.length)
        s = e
      }
      return
    }
    const k = ids.length <= BLOCK_SIZE * 16 ? Math.max(2, Math.ceil(ids.length / BLOCK_SIZE)) : 16
    counter++
    const r = makeRng((7 ^ Math.imul(counter, 0x9e3779b9)) >>> 0)
    const sample = ids.length > 4000 ? ids.filter((_, idx) => idx % Math.ceil(ids.length / 4000) === 0) : ids
    const cents = new Float32Array(k * dim)
    const first = sample[Math.floor(r() * sample.length)]!
    cents.set(flat.subarray(first * dim, (first + 1) * dim), 0)
    const best = new Float32Array(sample.length)
    for (let i = 0; i < sample.length; i++) best[i] = dot(flat, sample[i]! * dim, cents, 0, dim)
    for (let c = 1; c < k; c++) {
      let total = 0
      const w = new Float64Array(sample.length)
      for (let i = 0; i < sample.length; i++) {
        const d = Math.max(0, 1 - best[i]!)
        w[i] = d * d
        total += w[i]!
      }
      let chosen = sample[sample.length - 1]!
      if (total <= 1e-12) {
        chosen = sample[Math.floor(r() * sample.length)]!
      } else {
        let pick = r() * total
        for (let i = 0; i < sample.length; i++) {
          pick -= w[i]!
          if (pick <= 0) {
            chosen = sample[i]!
            break
          }
        }
      }
      cents.set(flat.subarray(chosen * dim, (chosen + 1) * dim), c * dim)
      for (let i = 0; i < sample.length; i++) {
        const s = dot(flat, sample[i]! * dim, cents, c * dim, dim)
        if (s > best[i]!) best[i] = s
      }
    }
    for (let iter = 0; iter < 6; iter++) {
      const sums = new Float32Array(k * dim)
      const counts = new Uint32Array(k)
      for (let i = 0; i < sample.length; i++) {
        const row = sample[i]!
        let bestC = 0
        let bestS = -Infinity
        for (let c = 0; c < k; c++) {
          const s = dot(flat, row * dim, cents, c * dim, dim)
          if (s > bestS) {
            bestS = s
            bestC = c
          }
        }
        counts[bestC]!++
        const sOff = bestC * dim
        const rOff = row * dim
        for (let j = 0; j < dim; j++) sums[sOff + j]! += flat[rOff + j]!
      }
      for (let c = 0; c < k; c++) {
        if (counts[c] === 0) continue
        const sub = sums.subarray(c * dim, (c + 1) * dim)
        const nrm = norm(sub, 0, dim)
        if (nrm > 0) {
          for (let j = 0; j < dim; j++) cents[c * dim + j] = sub[j]! / nrm
        }
      }
    }
    const groups: number[][] = Array.from({ length: k }, () => [])
    for (const id of ids) {
      let bestC = 0
      let bestS = -Infinity
      for (let c = 0; c < k; c++) {
        const s = dot(flat, id * dim, cents, c * dim, dim)
        if (s > bestS) {
          bestS = s
          bestC = c
        }
      }
      groups[bestC]!.push(id)
    }
    const nonEmpty = groups.map((g, i) => ({ g, i })).filter((x) => x.g.length > 0)
    if (nonEmpty.length < 2) {
      const half = Math.floor(ids.length / 2)
      splitNode(ids.slice(0, half), depth + 1)
      splitNode(ids.slice(half), depth + 1)
      return
    }
    // Greedy nearest-neighbor chain of centroids
    const left = [...nonEmpty]
    const ordered = [left.shift()!]
    while (left.length > 0) {
      const cur = ordered[ordered.length - 1]!.i
      let bestIdx = 0
      let bestSim = -Infinity
      for (let i = 0; i < left.length; i++) {
        const sim = dot(cents, cur * dim, cents, left[i]!.i * dim, dim)
        if (sim > bestSim) {
          bestSim = sim
          bestIdx = i
        }
      }
      ordered.push(left.splice(bestIdx, 1)[0]!)
    }
    for (const item of ordered) splitNode(item.g, depth + 1)
  }

  splitNode(
    Array.from({ length: n }, (_, i) => i),
    0,
  )
  return { order: Uint32Array.from(perm), blocks: Uint32Array.from(blocks) }
}

// ---------------------------------------------------------------------------------------------
// HeaderSlot, RecHeader, Manifest, Bitset

interface HeaderSlot {
  version: number
  seq: number
  manifestOff: number
  manifestLen: number
  committedEnd: number
}

function encodeHeaderSlot(s: HeaderSlot): Buffer {
  const b = Buffer.alloc(HEADER_SLOT_LEN)
  MAGIC.copy(b, 0)
  b.writeUInt32LE(s.version, 8)
  b.writeBigUInt64LE(BigInt(s.seq), 12)
  b.writeBigUInt64LE(BigInt(s.manifestOff), 20)
  b.writeBigUInt64LE(BigInt(s.manifestLen), 28)
  b.writeBigUInt64LE(BigInt(s.committedEnd), 36)
  b.writeUInt32LE(hashCrc(b.subarray(0, 44)), 44)
  return b
}

function decodeHeaderSlot(
  b: Buffer,
): { kind: 'ok'; slot: HeaderSlot } | { kind: 'unsupported'; version: number } | { kind: 'invalid' } {
  if (b.length < HEADER_SLOT_LEN || !b.subarray(0, 8).equals(MAGIC)) return { kind: 'invalid' }
  if (hashCrc(b.subarray(0, 44)) !== b.readUInt32LE(44)) return { kind: 'invalid' }
  const version = b.readUInt32LE(8)
  if (version !== FORMAT_VERSION_V1 && version !== FORMAT_VERSION_V2) {
    return { kind: 'unsupported', version }
  }
  return {
    kind: 'ok',
    slot: {
      version,
      seq: Number(b.readBigUInt64LE(12)),
      manifestOff: Number(b.readBigUInt64LE(20)),
      manifestLen: Number(b.readBigUInt64LE(28)),
      committedEnd: Number(b.readBigUInt64LE(36)),
    },
  }
}

interface RecHeader {
  kind: number
  bodyLen: number
  metaLen: number
  metaCrc: number
}

function encodeRecHeader(h: RecHeader): Buffer {
  const b = Buffer.alloc(REC_HEADER_LEN)
  REC_MAGIC.copy(b, 0)
  b.writeUInt32LE(h.kind, 8)
  b.writeUInt32LE(0, 12)
  b.writeBigUInt64LE(BigInt(h.bodyLen), 16)
  b.writeBigUInt64LE(BigInt(h.metaLen), 24)
  b.writeUInt32LE(h.metaCrc >>> 0, 32)
  b.writeUInt32LE(hashCrc(b.subarray(0, 36)), 36)
  return b
}

function decodeRecHeader(b: Buffer): RecHeader | null {
  if (b.length < 40 || !b.subarray(0, 8).equals(REC_MAGIC)) return null
  if (hashCrc(b.subarray(0, 36)) !== b.readUInt32LE(36)) return null
  const kind = b.readUInt32LE(8)
  const bodyLen = Number(b.readBigUInt64LE(16))
  const metaLen = Number(b.readBigUInt64LE(24))
  const metaCrc = b.readUInt32LE(32)
  if (metaLen > bodyLen) return null
  return { kind, bodyLen, metaLen, metaCrc }
}

interface Schema {
  dim: number
  model: string
  columns: string[]
  columnTypes?: Record<string, ColumnType>
  tokenizer?: TokenizerVersion
}

interface SegmentRef {
  id: number
  offset: number
  len: number
  n_docs: number
  clustered: boolean
  deleted?: [number, number][]
}

interface Manifest {
  format: number
  seq: number
  schema: Schema
  segments: SegmentRef[]
  next_segment_id: number
}

class Bitset {
  readonly n: number
  readonly bytes: Uint8Array

  constructor(n: number) {
    this.n = n
    this.bytes = new Uint8Array(Math.ceil(n / 8))
  }

  static fromRuns(n: number, runs?: [number, number][]): Bitset {
    const b = new Bitset(n)
    if (!runs) return b
    for (const [s, c] of runs) {
      const end = Math.min(n, s + c)
      for (let i = Math.min(n, Math.max(0, s)); i < end; i++) b.set(i)
    }
    return b
  }

  get(i: number): boolean {
    return i >= 0 && i < this.n && ((this.bytes[i >> 3]! >> (i & 7)) & 1) === 1
  }

  set(i: number): void {
    if (i >= 0 && i < this.n) this.bytes[i >> 3]! |= 1 << (i & 7)
  }

  count(): number {
    let total = 0
    for (let i = 0; i < this.n; i++) if (this.get(i)) total++
    return total
  }

  toRuns(): [number, number][] {
    const runs: [number, number][] = []
    let i = 0
    while (i < this.n) {
      if (this.get(i)) {
        const s = i
        while (i < this.n && this.get(i)) i++
        runs.push([s, i - s])
      } else {
        i++
      }
    }
    return runs
  }
}

// ---------------------------------------------------------------------------------------------
// DataFile wrapper with positional I/O and fault hooks

class DataFile {
  fd: number
  readonly path: string

  constructor(fd: number, path: string) {
    this.fd = fd
    this.path = path
  }

  writeAt(off: number, data: Uint8Array): void {
    try {
      checkFault('write')
      let written = 0
      while (written < data.byteLength) {
        const n = writeSync(this.fd, data, written, data.byteLength - written, off + written)
        if (n <= 0) throw new Error('short write')
        written += n
      }
    } catch (e) {
      ioError(e)
    }
  }

  setLen(len: number): void {
    try {
      checkFault('setLen')
      ftruncateSync(this.fd, len)
    } catch (e) {
      ioError(e)
    }
  }

  sync(): void {
    try {
      checkFault('sync')
      fsyncSync(this.fd)
    } catch (e) {
      ioError(e)
    }
  }

  close(): void {
    if (this.fd >= 0) {
      try {
        closeSync(this.fd)
      } catch {
        // Ignore close errors.
      }
      this.fd = -1
    }
  }
}

function readExactAt(fd: number, len: number, off: number): Buffer {
  const buf = Buffer.allocUnsafe(len)
  let read = 0
  while (read < len) {
    const n = readSync(fd, buf, read, len - read, off + read)
    if (n <= 0) throw Object.assign(new Error('short read'), { code: 'EOF' })
    read += n
  }
  return buf
}

function syncDir(dir: string): void {
  if (process.platform === 'win32') return
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Some filesystems do not support fsync on directories.
  }
}

// ---------------------------------------------------------------------------------------------
// Segment writing & reading (FORMAT.md + v2 typed zone maps)

interface DocIn {
  id: string
  text: string
  meta: string
  vector: Float32Array
  tags: string[]
}

function packStrings64(strs: string[]): { off: Buffer; bytes: Buffer } {
  const chunks = strs.map((s) => Buffer.from(s, 'utf8'))
  const off = Buffer.allocUnsafe((strs.length + 1) * 8)
  let pos = 0n
  off.writeBigUInt64LE(0n, 0)
  for (let i = 0; i < chunks.length; i++) {
    pos += BigInt(chunks[i]!.length)
    off.writeBigUInt64LE(pos, (i + 1) * 8)
  }
  return { off, bytes: Buffer.concat(chunks) }
}

function packStrings32(strs: string[]): { off: Buffer; bytes: Buffer } {
  const chunks = strs.map((s) => Buffer.from(s, 'utf8'))
  const off = Buffer.allocUnsafe((strs.length + 1) * 4)
  let pos = 0
  off.writeUInt32LE(0, 0)
  for (let i = 0; i < chunks.length; i++) {
    pos += chunks[i]!.length
    if (pos > 0xffff_ffff) invalid('dictionary too large for one segment')
    off.writeUInt32LE(pos, (i + 1) * 4)
  }
  return { off, bytes: Buffer.concat(chunks) }
}

function typedColumnOf(schema: Schema, colIdx: number): ColumnType {
  const name = schema.columns[colIdx]!
  return schema.columnTypes?.[name] ?? 'string'
}

function parseTypedInt64(raw: string): bigint | null {
  if (raw === '') return null
  try {
    return BigInt(raw)
  } catch {
    const n = Number(raw)
    if (Number.isFinite(n)) return BigInt(Math.trunc(n))
    return null
  }
}

interface SecEntry {
  kind: number
  col: number
  off: number
  len: number
  crc: number
}

function writeSegment(
  file: DataFile,
  at: number,
  docs: DocIn[],
  schema: Schema,
  formatVersion: number,
  cluster: boolean,
): { len: number; nDocs: number; clustered: boolean } {
  const n = docs.length
  const dim = schema.dim
  const ncols = schema.columns.length
  const tokenizer: TokenizerVersion = schema.tokenizer ?? (formatVersion >= 2 ? 'v2' : 'v1')

  const flat = new Float32Array(n * dim)
  for (let i = 0; i < n; i++) flat.set(docs[i]!.vector, i * dim)

  const clustered = cluster && n > BLOCK_SIZE
  let order: Uint32Array
  let blocks: Uint32Array
  if (clustered) {
    ;({ order, blocks } = buildSemanticOrder(flat, n, dim))
  } else {
    order = Uint32Array.from({ length: n }, (_, i) => i)
    const bl: number[] = []
    for (let s = 0; s < n; s += BLOCK_SIZE) bl.push(s, Math.min(s + BLOCK_SIZE, n))
    blocks = Uint32Array.from(bl)
  }
  const nb = blocks.length / 2

  const orderedVectors = new Float32Array(n * dim)
  for (let pos = 0; pos < n; pos++) {
    const orig = order[pos]!
    orderedVectors.set(docs[orig]!.vector, pos * dim)
  }

  // Int8 codes
  const codes = new Int8Array(n * dim)
  const codeScale = new Float32Array(n)
  const codeErr = new Float32Array(n)
  let maxNorm = 0
  for (let pos = 0; pos < n; pos++) {
    const enc = encodeInt8(orderedVectors, pos * dim, dim)
    codes.set(enc.codes, pos * dim)
    codeScale[pos] = enc.scale
    codeErr[pos] = enc.err
    const nrm = norm(orderedVectors, pos * dim, dim)
    if (nrm > maxNorm) maxNorm = nrm
  }
  maxNorm = Math.fround(maxNorm * (1 + 1e-6))

  // Block centroids
  const centroids = new Float32Array(nb * dim)
  const centroidNorms = new Float32Array(nb)
  for (let b = 0; b < nb; b++) {
    const s = blocks[2 * b]!
    const e = blocks[2 * b + 1]!
    const cOff = b * dim
    for (let pos = s; pos < e; pos++) {
      const vOff = pos * dim
      for (let j = 0; j < dim; j++) centroids[cOff + j]! += orderedVectors[vOff + j]!
    }
    const inv = 1 / (e - s)
    for (let j = 0; j < dim; j++) centroids[cOff + j]! *= inv
    centroidNorms[b] = norm(centroids, cOff, dim)
  }

  const orderedDocs = Array.from({ length: n }, (_, pos) => docs[order[pos]!]!)
  const idsPack = packStrings64(orderedDocs.map((d) => d.id))
  const textPack = packStrings64(orderedDocs.map((d) => d.text))
  const metaPack = packStrings64(orderedDocs.map((d) => d.meta))

  // BM25 index
  const vocab = new Map<string, { df: number; docs: number[]; tfs: number[] }>()
  const docLen = new Uint32Array(n)
  let totalLen = 0n
  for (let pos = 0; pos < n; pos++) {
    const toks = tokenize(orderedDocs[pos]!.text, tokenizer)
    docLen[pos] = toks.length
    totalLen += BigInt(toks.length)
    const counts = new Map<string, number>()
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1)
    for (const [term, tf] of counts) {
      let entry = vocab.get(term)
      if (!entry) {
        entry = { df: 0, docs: [], tfs: [] }
        vocab.set(term, entry)
      }
      entry.df++
      entry.docs.push(pos)
      entry.tfs.push(Math.min(0xffff, tf))
    }
  }
  const sortedTerms = [...vocab.keys()].sort()
  const nt = sortedTerms.length
  const termPack = packStrings32(sortedTerms)
  const termDf = new Uint32Array(nt)
  const postPtr = new Uint32Array(nt + 1)
  const postDocsList: number[] = []
  const postTfsList: number[] = []
  postPtr[0] = 0
  for (let ti = 0; ti < nt; ti++) {
    const entry = vocab.get(sortedTerms[ti]!)!
    termDf[ti] = entry.df
    for (let k = 0; k < entry.docs.length; k++) {
      postDocsList.push(entry.docs[k]!)
      postTfsList.push(entry.tfs[k]!)
    }
    postPtr[ti + 1] = postDocsList.length
  }
  const postDoc = Uint32Array.from(postDocsList)
  const postTf = Uint16Array.from(postTfsList)

  const byId = Uint32Array.from({ length: n }, (_, i) => i)
  byId.sort((a, b) => Buffer.compare(Buffer.from(orderedDocs[a]!.id), Buffer.from(orderedDocs[b]!.id)))

  // Count how many sections we will write so metaLen is known up front.
  let typedColsCount = 0
  if (formatVersion >= 2) {
    for (let c = 0; c < ncols; c++) {
      if (typedColumnOf(schema, c) !== 'string') typedColsCount++
    }
  }
  const totalSections = 21 + 5 * ncols + 2 * typedColsCount
  const metaLen = alignUp(SEG_HEAD_FIXED + totalSections * SEG_ENTRY_LEN, SECTION_ALIGN)
  const bodyStart = at + REC_HEADER_LEN
  let pos = metaLen
  const entries: SecEntry[] = []

  const put = (kind: number, col: number, buf: ArrayBufferView): void => {
    pos = alignUp(pos, SECTION_ALIGN)
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    if (u8.byteLength > 0) file.writeAt(bodyStart + pos, u8)
    entries.push({ kind, col, off: pos, len: u8.byteLength, crc: hashCrc(u8) })
    pos += u8.byteLength
  }

  put(sec.IDS_OFF, 0, idsPack.off)
  put(sec.IDS, 0, idsPack.bytes)
  put(sec.BLOCKS, 0, blocks)
  put(sec.CENTROIDS, 0, centroids)
  put(sec.CENTROID_NORMS, 0, centroidNorms)
  put(sec.VECTORS, 0, orderedVectors)
  put(sec.CODES, 0, codes)
  put(sec.CODE_SCALE, 0, codeScale)
  put(sec.CODE_ERR, 0, codeErr)
  put(sec.TEXT_OFF, 0, textPack.off)
  put(sec.TEXT, 0, textPack.bytes)
  put(sec.META_OFF, 0, metaPack.off)
  put(sec.META, 0, metaPack.bytes)
  put(sec.TERM_OFF, 0, termPack.off)
  put(sec.TERMS, 0, termPack.bytes)
  put(sec.TERM_DF, 0, termDf)
  put(sec.POST_PTR, 0, postPtr)
  put(sec.POST_DOC, 0, postDoc)
  put(sec.POST_TF, 0, postTf)
  put(sec.DOC_LEN, 0, docLen)
  put(sec.IDS_SORTED, 0, byId)

  for (let c = 0; c < ncols; c++) {
    const vals = orderedDocs.map((d) => d.tags[c] ?? '')
    const dict = [...new Set(vals)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    const codeOf = new Map<string, number>()
    dict.forEach((v, idx) => codeOf.set(v, idx))
    const colCodes = Uint32Array.from(vals, (v) => codeOf.get(v)!)
    const dictPack = packStrings32(dict)
    const bptr = new Uint32Array(nb + 1)
    const pool: number[] = []
    bptr[0] = 0
    for (let b = 0; b < nb; b++) {
      const s = blocks[2 * b]!
      const e = blocks[2 * b + 1]!
      const distinct = [...new Set(colCodes.subarray(s, e))].sort((x, y) => x - y)
      pool.push(...distinct)
      bptr[b + 1] = pool.length
    }
    put(sec.COL_DICT_OFF, c, dictPack.off)
    put(sec.COL_DICT, c, dictPack.bytes)
    put(sec.COL_CODES, c, colCodes)
    put(sec.COL_BLOCK_PTR, c, bptr)
    put(sec.COL_BLOCK_CODES, c, Uint32Array.from(pool))

    const colType = typedColumnOf(schema, c)
    if (formatVersion >= 2 && colType !== 'string') {
      // Section 27: n * 8 bytes (BigInt64LE) + n bytes (1 = valid, 0 = null)
      const valBuf = Buffer.alloc(n * 9)
      // Section 28: (nb + 1) * 24 bytes: [min i64, max i64, flags u32 (bit 0 = hasValue, bit 1 = hasNull), 0 u32]
      const zoneBuf = Buffer.alloc((nb + 1) * 24)
      let segMin = 0n
      let segMax = 0n
      let segHasVal = false
      let segHasNull = false

      for (let b = 0; b < nb; b++) {
        const s = blocks[2 * b]!
        const e = blocks[2 * b + 1]!
        let bMin = 0n
        let bMax = 0n
        let bHasVal = false
        let bHasNull = false
        for (let docIdx = s; docIdx < e; docIdx++) {
          const parsed = parseTypedInt64(vals[docIdx]!)
          if (parsed === null) {
            valBuf[n * 8 + docIdx] = 0
            bHasNull = true
            segHasNull = true
          } else {
            valBuf.writeBigInt64LE(parsed, docIdx * 8)
            valBuf[n * 8 + docIdx] = 1
            if (!bHasVal || parsed < bMin) bMin = parsed
            if (!bHasVal || parsed > bMax) bMax = parsed
            bHasVal = true
            if (!segHasVal || parsed < segMin) segMin = parsed
            if (!segHasVal || parsed > segMax) segMax = parsed
            segHasVal = true
          }
        }
        const zOff = b * 24
        zoneBuf.writeBigInt64LE(bMin, zOff)
        zoneBuf.writeBigInt64LE(bMax, zOff + 8)
        zoneBuf.writeUInt32LE((bHasVal ? 1 : 0) | (bHasNull ? 2 : 0), zOff + 16)
      }
      const segOff = nb * 24
      zoneBuf.writeBigInt64LE(segMin, segOff)
      zoneBuf.writeBigInt64LE(segMax, segOff + 8)
      zoneBuf.writeUInt32LE((segHasVal ? 1 : 0) | (segHasNull ? 2 : 0), segOff + 16)

      put(sec.COL_TYPED_VALS, c, valBuf)
      put(sec.COL_TYPED_ZONES, c, zoneBuf)
    }
  }

  const bodyLen = pos
  const head = Buffer.alloc(metaLen)
  SEG_MAGIC.copy(head, 0)
  head.writeUInt32LE(n, 8)
  head.writeUInt32LE(dim, 12)
  head.writeUInt32LE(nb, 16)
  head.writeUInt32LE(clustered ? 1 : 0, 20)
  head.writeUInt32LE(ncols, 24)
  head.writeUInt32LE(nt, 28)
  head.writeBigUInt64LE(BigInt(postDoc.length), 32)
  head.writeBigUInt64LE(totalLen, 40)
  head.writeFloatLE(maxNorm, 48)
  head.writeUInt32LE(entries.length, 52)

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const off = SEG_HEAD_FIXED + i * SEG_ENTRY_LEN
    head.writeUInt32LE(e.kind, off)
    head.writeUInt32LE(e.col, off + 4)
    head.writeBigUInt64LE(BigInt(e.off), off + 8)
    head.writeBigUInt64LE(BigInt(e.len), off + 16)
    head.writeUInt32LE(e.crc >>> 0, off + 24)
    head.writeUInt32LE(0, off + 28)
  }

  file.writeAt(bodyStart, head)
  const rh = encodeRecHeader({ kind: KIND_SEGMENT, bodyLen, metaLen, metaCrc: hashCrc(head) })
  file.writeAt(at, rh)
  return { len: REC_HEADER_LEN + bodyLen, nDocs: n, clustered }
}

interface TypedZone {
  min: bigint
  max: bigint
  hasValue: boolean
  hasNull: boolean
}

interface LoadedColumn {
  dict: string[]
  codes: Uint32Array
  blockPtr: Uint32Array
  blockCodes: Uint32Array
  typedVals?: BigInt64Array
  typedValid?: Uint8Array
  blockZones?: TypedZone[]
  segZone?: TypedZone
}

class Segment {
  readonly raw: Buffer
  readonly n: number
  readonly dim: number
  readonly nb: number
  readonly clustered: boolean
  readonly ncols: number
  readonly nt: number
  readonly np: number
  readonly totalLen: bigint
  readonly maxNorm: number
  readonly sections: { kind: number; col: number; off: number; len: number; crc: number }[]

  readonly ids: string[]
  readonly texts: string[]
  readonly metas: string[]
  readonly blocks: Uint32Array
  readonly centroids: Float32Array
  readonly centroidNorms: Float32Array
  readonly vectors: Float32Array
  readonly codes: Int8Array
  readonly codeScale: Float32Array
  readonly codeErr: Float32Array
  readonly terms: string[]
  readonly termIndex: Map<string, number>
  readonly termDf: Uint32Array
  readonly postPtr: Uint32Array
  readonly postDoc: Uint32Array
  readonly postTf: Uint16Array
  readonly docLen: Uint32Array
  readonly idsSorted: Uint32Array
  readonly columns: LoadedColumn[]

  private constructor(
    raw: Buffer,
    n: number,
    dim: number,
    nb: number,
    clustered: boolean,
    ncols: number,
    nt: number,
    np: number,
    totalLen: bigint,
    maxNorm: number,
    sections: { kind: number; col: number; off: number; len: number; crc: number }[],
  ) {
    this.raw = raw
    this.n = n
    this.dim = dim
    this.nb = nb
    this.clustered = clustered
    this.ncols = ncols
    this.nt = nt
    this.np = np
    this.totalLen = totalLen
    this.maxNorm = maxNorm
    this.sections = sections

    const findSec = (kind: number, col = 0): Buffer => {
      const s = sections.find((x) => x.kind === kind && x.col === col)
      if (!s) corrupt(`missing segment section ${kind}/${col}`)
      return raw.subarray(s.off, s.off + s.len)
    }
    const maybeSec = (kind: number, col = 0): Buffer | undefined => {
      const s = sections.find((x) => x.kind === kind && x.col === col)
      return s ? raw.subarray(s.off, s.off + s.len) : undefined
    }

    const unpackStrings64 = (offBuf: Buffer, bytesBuf: Buffer, count: number): string[] => {
      if (offBuf.byteLength !== (count + 1) * 8) corrupt('string64 offsets length')
      const out: string[] = []
      let prev = Number(offBuf.readBigUInt64LE(0))
      if (prev !== 0) corrupt('string64 offset start')
      for (let i = 0; i < count; i++) {
        const next = Number(offBuf.readBigUInt64LE((i + 1) * 8))
        if (next < prev || next > bytesBuf.byteLength) corrupt('string64 offset bounds')
        out.push(bytesBuf.toString('utf8', prev, next))
        prev = next
      }
      return out
    }

    const unpackStrings32 = (offBuf: Buffer, bytesBuf: Buffer, count?: number): string[] => {
      if (offBuf.byteLength < 4 || offBuf.byteLength % 4 !== 0) corrupt('string32 offsets length')
      const nItems = offBuf.byteLength / 4 - 1
      if (count !== undefined && nItems !== count) corrupt('string32 count mismatch')
      const out: string[] = []
      let prev = offBuf.readUInt32LE(0)
      if (prev !== 0) corrupt('string32 offset start')
      for (let i = 0; i < nItems; i++) {
        const next = offBuf.readUInt32LE((i + 1) * 4)
        if (next < prev || next > bytesBuf.byteLength) corrupt('string32 offset bounds')
        out.push(bytesBuf.toString('utf8', prev, next))
        prev = next
      }
      return out
    }

    const toU32 = (b: Buffer): Uint32Array => {
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      return new Uint32Array(ab)
    }
    const toU16 = (b: Buffer): Uint16Array => {
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      return new Uint16Array(ab)
    }
    const toF32 = (b: Buffer): Float32Array => {
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      return new Float32Array(ab)
    }
    const toI8 = (b: Buffer): Int8Array => {
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      return new Int8Array(ab)
    }

    this.ids = unpackStrings64(findSec(sec.IDS_OFF), findSec(sec.IDS), n)
    this.texts = unpackStrings64(findSec(sec.TEXT_OFF), findSec(sec.TEXT), n)
    this.metas = unpackStrings64(findSec(sec.META_OFF), findSec(sec.META), n)
    this.blocks = toU32(findSec(sec.BLOCKS))
    this.centroids = toF32(findSec(sec.CENTROIDS))
    this.centroidNorms = toF32(findSec(sec.CENTROID_NORMS))
    this.vectors = toF32(findSec(sec.VECTORS))
    this.codes = toI8(findSec(sec.CODES))
    this.codeScale = toF32(findSec(sec.CODE_SCALE))
    this.codeErr = toF32(findSec(sec.CODE_ERR))
    this.terms = unpackStrings32(findSec(sec.TERM_OFF), findSec(sec.TERMS), nt)
    this.termIndex = new Map()
    this.terms.forEach((t, i) => this.termIndex.set(t, i))
    this.termDf = toU32(findSec(sec.TERM_DF))
    this.postPtr = toU32(findSec(sec.POST_PTR))
    this.postDoc = toU32(findSec(sec.POST_DOC))
    this.postTf = toU16(findSec(sec.POST_TF))
    this.docLen = toU32(findSec(sec.DOC_LEN))
    this.idsSorted = toU32(findSec(sec.IDS_SORTED))

    // Validate block ranges
    if (this.blocks.length !== nb * 2) corrupt('block section length')
    let expect = 0
    for (let b = 0; b < nb; b++) {
      const s = this.blocks[2 * b]!
      const e = this.blocks[2 * b + 1]!
      if (s !== expect || e <= s || e - s > BLOCK_SIZE) corrupt('block ranges')
      expect = e
    }
    if (expect !== n) corrupt('block ranges do not cover segment')

    this.columns = []
    for (let c = 0; c < ncols; c++) {
      const dict = unpackStrings32(findSec(sec.COL_DICT_OFF, c), findSec(sec.COL_DICT, c))
      const colCodes = toU32(findSec(sec.COL_CODES, c))
      const blockPtr = toU32(findSec(sec.COL_BLOCK_PTR, c))
      const blockCodes = toU32(findSec(sec.COL_BLOCK_CODES, c))
      if (colCodes.length !== n || blockPtr.length !== nb + 1) corrupt('column section length')

      const valsSec = maybeSec(sec.COL_TYPED_VALS, c)
      const zonesSec = maybeSec(sec.COL_TYPED_ZONES, c)
      let typedVals: BigInt64Array | undefined
      let typedValid: Uint8Array | undefined
      let blockZones: TypedZone[] | undefined
      let segZone: TypedZone | undefined
      if (valsSec && zonesSec) {
        if (valsSec.byteLength !== n * 9 || zonesSec.byteLength !== (nb + 1) * 24) {
          corrupt('typed column section length')
        }
        const vAb = valsSec.buffer.slice(valsSec.byteOffset, valsSec.byteOffset + n * 8)
        typedVals = new BigInt64Array(vAb)
        typedValid = new Uint8Array(valsSec.buffer, valsSec.byteOffset + n * 8, n)
        blockZones = []
        for (let b = 0; b < nb; b++) {
          const zOff = b * 24
          const flags = zonesSec.readUInt32LE(zOff + 16)
          blockZones.push({
            min: zonesSec.readBigInt64LE(zOff),
            max: zonesSec.readBigInt64LE(zOff + 8),
            hasValue: (flags & 1) !== 0,
            hasNull: (flags & 2) !== 0,
          })
        }
        const sOff = nb * 24
        const sFlags = zonesSec.readUInt32LE(sOff + 16)
        segZone = {
          min: zonesSec.readBigInt64LE(sOff),
          max: zonesSec.readBigInt64LE(sOff + 8),
          hasValue: (sFlags & 1) !== 0,
          hasNull: (sFlags & 2) !== 0,
        }
      }
      this.columns.push({ dict, codes: colCodes, blockPtr, blockCodes, typedVals, typedValid, blockZones, segZone })
    }
  }

  static open(fd: number, at: number, len: number): Segment {
    if (len < REC_HEADER_LEN) corrupt('segment record too short')
    let raw: Buffer
    try {
      raw = readExactAt(fd, len, at)
    } catch {
      corrupt('segment read past end of file')
    }
    const rh = decodeRecHeader(raw.subarray(0, REC_HEADER_LEN))
    if (!rh || rh.kind !== KIND_SEGMENT || REC_HEADER_LEN + rh.bodyLen !== len || rh.metaLen < SEG_HEAD_FIXED) {
      corrupt('segment record header')
    }
    const meta = raw.subarray(REC_HEADER_LEN, REC_HEADER_LEN + rh.metaLen)
    if (hashCrc(meta) !== rh.metaCrc || !meta.subarray(0, 8).equals(SEG_MAGIC)) {
      corrupt('segment table checksum')
    }
    const n = meta.readUInt32LE(8)
    const dim = meta.readUInt32LE(12)
    const nb = meta.readUInt32LE(16)
    const clustered = meta.readUInt32LE(20) !== 0
    const ncols = meta.readUInt32LE(24)
    const nt = meta.readUInt32LE(28)
    const np = Number(meta.readBigUInt64LE(32))
    const totalLen = meta.readBigUInt64LE(40)
    const maxNorm = meta.readFloatLE(48)
    const nEntries = meta.readUInt32LE(52)
    if (
      n === 0 ||
      dim === 0 ||
      dim > 65_536 ||
      nb === 0 ||
      nb > n ||
      ncols > 1024 ||
      SEG_HEAD_FIXED + nEntries * SEG_ENTRY_LEN > rh.metaLen ||
      !Number.isFinite(maxNorm)
    ) {
      corrupt('segment counts')
    }
    const sections: { kind: number; col: number; off: number; len: number; crc: number }[] = []
    for (let i = 0; i < nEntries; i++) {
      const eOff = SEG_HEAD_FIXED + i * SEG_ENTRY_LEN
      const kind = meta.readUInt32LE(eOff)
      const col = meta.readUInt32LE(eOff + 4)
      const off = Number(meta.readBigUInt64LE(eOff + 8))
      const l = Number(meta.readBigUInt64LE(eOff + 16))
      const crc = meta.readUInt32LE(eOff + 24)
      if (off < rh.metaLen || off + l > rh.bodyLen) corrupt('segment section bounds')
      sections.push({ kind, col, off: REC_HEADER_LEN + off, len: l, crc })
    }
    return new Segment(raw, n, dim, nb, clustered, ncols, nt, np, totalLen, maxNorm, sections)
  }

  verify(): void {
    for (const s of this.sections) {
      if (hashCrc(this.raw.subarray(s.off, s.off + s.len)) !== s.crc) {
        corrupt(`section ${s.kind}/${s.col} checksum mismatch`)
      }
    }
  }

  findId(id: string): number | null {
    const target = Buffer.from(id, 'utf8')
    let lo = 0
    let hi = this.idsSorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const pos = this.idsSorted[mid]!
      if (pos >= this.n) return null
      const cmp = Buffer.compare(Buffer.from(this.ids[pos]!, 'utf8'), target)
      if (cmp < 0) lo = mid + 1
      else if (cmp > 0) hi = mid
      else return pos
    }
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshot & Search (exact single-pass + probe + bruteForce + zone maps + recency + latest-N)

interface SegHandle {
  id: number
  seg: Segment
  deleted: Bitset
  nDeleted: number
  base: number
}

interface CompiledColFilter {
  colIdx: number
  colType: ColumnType
  allowedValues?: Set<string>
  gt?: bigint | string
  gte?: bigint | string
  lt?: bigint | string
  lte?: bigint | string
  wantNull: boolean
}

function compileFilter(schema: Schema, filter: NativeFilterTerm[] = []): CompiledColFilter[] {
  return filter.map((f) => {
    const colIdx = schema.columns.indexOf(f.column)
    if (colIdx < 0) invalid(`unknown filter column ${JSON.stringify(f.column)}`)
    const colType = typedColumnOf(schema, colIdx)
    const parseBound = (v: string | undefined): bigint | string | undefined => {
      if (v === undefined) return undefined
      if (colType === 'string') return v
      const b = parseTypedInt64(v)
      if (b === null) invalid(`invalid ${colType} filter bound ${JSON.stringify(v)} for column ${f.column}`)
      return b
    }
    let allowedValues: Set<string> | undefined
    let wantNull = !!f.includeNull
    if (f.values !== undefined) {
      allowedValues = new Set(f.values)
      if (allowedValues.has('')) wantNull = true
    }
    return {
      colIdx,
      colType,
      allowedValues,
      gt: parseBound(f.gt),
      gte: parseBound(f.gte),
      lt: parseBound(f.lt),
      lte: parseBound(f.lte),
      wantNull,
    }
  })
}

function zoneMatchesRange(zone: TypedZone, cf: CompiledColFilter): boolean {
  if (
    cf.wantNull &&
    zone.hasNull &&
    !cf.allowedValues &&
    cf.gt === undefined &&
    cf.gte === undefined &&
    cf.lt === undefined &&
    cf.lte === undefined
  ) {
    return true
  }
  const hasRange = cf.gt !== undefined || cf.gte !== undefined || cf.lt !== undefined || cf.lte !== undefined
  if (!hasRange) return zone.hasValue || (cf.wantNull && zone.hasNull)
  if (!zone.hasValue) return cf.wantNull && zone.hasNull
  const min = zone.min
  const max = zone.max
  if (typeof cf.gt === 'bigint' && max <= cf.gt) return cf.wantNull && zone.hasNull
  if (typeof cf.gte === 'bigint' && max < cf.gte) return cf.wantNull && zone.hasNull
  if (typeof cf.lt === 'bigint' && min >= cf.lt) return cf.wantNull && zone.hasNull
  if (typeof cf.lte === 'bigint' && min > cf.lte) return cf.wantNull && zone.hasNull
  return true
}

function segmentMatchesFilter(seg: Segment, filters: CompiledColFilter[]): boolean {
  for (const cf of filters) {
    const col = seg.columns[cf.colIdx]!
    if (cf.allowedValues) {
      let any = false
      for (const v of cf.allowedValues) {
        if (col.dict.includes(v)) {
          any = true
          break
        }
      }
      if (!any) return false
    }
    if (col.segZone && (cf.gt !== undefined || cf.gte !== undefined || cf.lt !== undefined || cf.lte !== undefined)) {
      if (!zoneMatchesRange(col.segZone, cf)) return false
    }
  }
  return true
}

function blockMatchesFilter(seg: Segment, b: number, filters: CompiledColFilter[]): boolean {
  for (const cf of filters) {
    const col = seg.columns[cf.colIdx]!
    if (cf.allowedValues) {
      const s = col.blockPtr[b]!
      const e = col.blockPtr[b + 1]!
      let any = false
      for (let i = s; i < e; i++) {
        const code = col.blockCodes[i]!
        if (cf.allowedValues.has(col.dict[code] ?? '')) {
          any = true
          break
        }
      }
      if (!any) return false
    }
    if (
      col.blockZones &&
      (cf.gt !== undefined || cf.gte !== undefined || cf.lt !== undefined || cf.lte !== undefined)
    ) {
      const z = col.blockZones[b]!
      if (!zoneMatchesRange(z, cf)) return false
    }
  }
  return true
}

function docMatchesFilter(seg: Segment, pos: number, filters: CompiledColFilter[]): boolean {
  for (const cf of filters) {
    const col = seg.columns[cf.colIdx]!
    const strVal = col.dict[col.codes[pos]!] ?? ''
    if (cf.allowedValues && !cf.allowedValues.has(strVal)) return false
    const hasRange = cf.gt !== undefined || cf.gte !== undefined || cf.lt !== undefined || cf.lte !== undefined
    if (hasRange) {
      if (strVal === '') {
        if (!cf.wantNull) return false
        continue
      }
      if (cf.colType === 'string') {
        if (typeof cf.gt === 'string' && !(strVal > cf.gt)) return false
        if (typeof cf.gte === 'string' && !(strVal >= cf.gte)) return false
        if (typeof cf.lt === 'string' && !(strVal < cf.lt)) return false
        if (typeof cf.lte === 'string' && !(strVal <= cf.lte)) return false
      } else {
        const v = col.typedVals && col.typedValid?.[pos] === 1 ? col.typedVals[pos]! : parseTypedInt64(strVal)
        if (v === null) return false
        if (typeof cf.gt === 'bigint' && !(v > cf.gt)) return false
        if (typeof cf.gte === 'bigint' && !(v >= cf.gte)) return false
        if (typeof cf.lt === 'bigint' && !(v < cf.lt)) return false
        if (typeof cf.lte === 'bigint' && !(v <= cf.lte)) return false
      }
    }
  }
  return true
}

class Snapshot {
  readonly manifest: Manifest
  readonly segs: SegHandle[]
  readonly nLive: number
  readonly totalLenLive: number

  constructor(manifest: Manifest, segments: Segment[]) {
    if (segments.length !== manifest.segments.length) corrupt('segment count mismatch')
    this.manifest = manifest
    this.segs = []
    let base = 0
    let nLive = 0
    let totalLenLive = 0
    for (let i = 0; i < segments.length; i++) {
      const r = manifest.segments[i]!
      const seg = segments[i]!
      if (seg.n !== r.n_docs) corrupt('segment size does not match manifest')
      const deleted = Bitset.fromRuns(seg.n, r.deleted)
      const nDeleted = deleted.count()
      let lenDeleted = 0
      if (nDeleted > 0) {
        for (let p = 0; p < seg.n; p++) if (deleted.get(p)) lenDeleted += seg.docLen[p]!
      }
      nLive += seg.n - nDeleted
      totalLenLive += Math.max(0, Number(seg.totalLen) - lenDeleted)
      this.segs.push({ id: r.id, seg, deleted, nDeleted, base })
      base += seg.n
    }
    this.nLive = nLive
    this.totalLenLive = totalLenLive
  }

  get totalBlocks(): number {
    let b = 0
    for (const h of this.segs) if (h.nDeleted < h.seg.n) b += h.seg.nb
    return b
  }

  get liveSegments(): number {
    let s = 0
    for (const h of this.segs) if (h.nDeleted < h.seg.n) s++
    return s
  }

  find(id: string): { si: number; pos: number } | null {
    for (let si = this.segs.length - 1; si >= 0; si--) {
      const h = this.segs[si]!
      const pos = h.seg.findId(id)
      if (pos !== null && !h.deleted.get(pos)) return { si, pos }
    }
    return null
  }

  hit(si: number, pos: number, score: number, includeVector: boolean): NativeHit {
    const seg = this.segs[si]!.seg
    const values = this.manifest.schema.columns.map((_, c) => {
      const col = seg.columns[c]!
      return col.dict[col.codes[pos]!] ?? ''
    })
    const out: NativeHit = {
      id: seg.ids[pos]!,
      score,
      text: seg.texts[pos]!,
      meta: seg.metas[pos]!,
      values,
    }
    if (includeVector) {
      out.vector = Float32Array.from(seg.vectors.subarray(pos * seg.dim, (pos + 1) * seg.dim))
    }
    return out
  }

  locate(gid: number): { si: number; pos: number } {
    let si = 0
    for (let i = 0; i < this.segs.length; i++) {
      if (this.segs[i]!.base <= gid) si = i
      else break
    }
    return { si, pos: gid - this.segs[si]!.base }
  }

  computeTextScores(text: string): Float32Array[] | null {
    const tokenizer: TokenizerVersion = this.manifest.schema.tokenizer ?? (this.manifest.format >= 2 ? 'v2' : 'v1')
    const toks = [...new Set(tokenize(text, tokenizer))].sort()
    if (toks.length === 0 || this.nLive === 0) return null
    const tids = this.segs.map((h) => toks.map((t) => h.seg.termIndex.get(t)))
    const df = new Float64Array(toks.length)
    for (let si = 0; si < this.segs.length; si++) {
      const h = this.segs[si]!
      for (let ti = 0; ti < toks.length; ti++) {
        const tid = tids[si]![ti]
        if (tid === undefined) continue
        const s = h.seg.postPtr[tid]!
        const e = h.seg.postPtr[tid + 1]!
        for (let p = s; p < e; p++) {
          const d = h.seg.postDoc[p]!
          if (d < h.seg.n && !h.deleted.get(d)) df[ti]!++
        }
      }
    }
    const N = this.nLive
    const avgdl = this.totalLenLive / Math.max(1, N)
    const idf = new Float32Array(toks.length)
    let ub = 0
    for (let ti = 0; ti < toks.length; ti++) {
      const d = df[ti]!
      if (d > 0) {
        idf[ti] = Math.fround(Math.log(1 + (N - d + 0.5) / (d + 0.5)))
        ub += idf[ti]! * (BM25_K1 + 1)
      }
    }
    if (ub <= 0) return null
    const normF = 1 / ub
    return this.segs.map((h, si) => {
      const ts = tids[si]!
      if (ts.every((t, ti) => t === undefined || df[ti]! === 0)) return new Float32Array(0)
      const scores = new Float32Array(h.seg.n)
      for (let ti = 0; ti < toks.length; ti++) {
        const tid = ts[ti]
        if (tid === undefined || df[ti]! === 0) continue
        const s = h.seg.postPtr[tid]!
        const e = h.seg.postPtr[tid + 1]!
        const termIdf = idf[ti]!
        for (let p = s; p < e; p++) {
          const d = h.seg.postDoc[p]!
          if (d < h.seg.n && !h.deleted.get(d)) {
            const tf = h.seg.postTf[p]!
            const dl = h.seg.docLen[d]!
            const contrib = (termIdf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl))
            scores[d]! += contrib
          }
        }
      }
      for (let d = 0; d < scores.length; d++) scores[d] = Math.fround(scores[d]! * normF)
      return scores
    })
  }

  recencyScore(seg: Segment, pos: number, rec: NativeRecency, colIdx: number): number {
    const col = seg.columns[colIdx]!
    let t: number | null = null
    if (col.typedVals && col.typedValid) {
      if (col.typedValid[pos] === 1) t = Number(col.typedVals[pos]!)
    } else {
      const s = col.dict[col.codes[pos]!] ?? ''
      if (s !== '') {
        const n = Number(s)
        if (Number.isFinite(n)) t = n
      }
    }
    if (t === null) return 0
    const age = Math.max(0, rec.now - t)
    return Math.pow(2, -age / rec.halfLife)
  }

  search(q: NativeQuery, brute: boolean): NativeSearchOut {
    const schema = this.manifest.schema
    if (q.k < 1) invalid('k must be at least 1')
    const hasVec = q.vector !== undefined
    const hasText = typeof q.text === 'string' && q.text.trim() !== ''
    if (!hasVec && !hasText) invalid('a query needs a vector, text, or both')

    const wTextRaw = hasVec && hasText ? (q.textWeight ?? 0.3) : hasText ? 1 : 0
    if (wTextRaw < 0 || wTextRaw > 1) invalid('textWeight must be between 0 and 1')
    let wRec = 0
    let recColIdx = -1
    if (q.recency) {
      recColIdx = schema.columns.indexOf(q.recency.column)
      if (recColIdx < 0) invalid(`unknown recency column ${JSON.stringify(q.recency.column)}`)
      if (!(q.recency.halfLife > 0)) invalid('recency.halfLife must be > 0')
      wRec = q.recency.weight
      if (!(wRec >= 0 && wRec <= 1)) invalid('recency.weight must be between 0 and 1')
    }
    const wText = hasVec ? wTextRaw : hasText ? 1 - wRec : 0
    const wVec = hasVec ? 1 - wText - wRec : 0
    if (wVec < -1e-7 || wText < -1e-7) invalid('textWeight + recency.weight must be at most 1')

    let qv: Float32Array | undefined
    let qq: QQuery | undefined
    if (q.vector) {
      if (q.vector.length !== schema.dim) {
        invalid(`query vector has ${q.vector.length} dimensions, the database has ${schema.dim}`)
      }
      const u = toUnit(q.vector)
      if (!u) invalid('query vector is all zeros or has a non-finite value')
      qv = u
      qq = quantizeQuery(u)
    }

    const filters = compileFilter(schema, q.filter)
    const textScores = hasText && wText > 0 ? this.computeTextScores(q.text!) : null
    const k = Math.min(q.k, this.nLive)

    const stats: NativeSearchStats = {
      docsScanned: 0,
      rescored: 0,
      blocksScanned: 0,
      blocksSkipped: 0,
      docs: this.nLive,
      segments: this.liveSegments,
      blocks: this.totalBlocks,
      seq: this.manifest.seq,
    }
    if (k === 0) return { hits: [], stats }

    // Candidate blocks to scan
    const blockTasks: { si: number; b: number }[] = []
    if (!brute && q.probe !== undefined && qv) {
      const ranked: { sim: number; si: number; b: number }[] = []
      const fresh: { si: number; b: number }[] = []
      for (let si = 0; si < this.segs.length; si++) {
        const h = this.segs[si]!
        if (h.nDeleted >= h.seg.n) continue
        if (!segmentMatchesFilter(h.seg, filters)) {
          stats.blocksSkipped += h.seg.nb
          continue
        }
        for (let b = 0; b < h.seg.nb; b++) {
          if (!blockMatchesFilter(h.seg, b, filters)) {
            stats.blocksSkipped++
            continue
          }
          if (h.seg.clustered) {
            const cn = h.seg.centroidNorms[b]!
            const sim = cn > 0 ? dot(qv, 0, h.seg.centroids, b * h.seg.dim, h.seg.dim) / cn : -Infinity
            ranked.push({ sim, si, b })
          } else {
            fresh.push({ si, b })
          }
        }
      }
      ranked.sort((a, b) => b.sim - a.sim)
      for (const r of ranked.slice(0, q.probe)) blockTasks.push({ si: r.si, b: r.b })
      for (const f of fresh) blockTasks.push(f)
    } else {
      for (let si = 0; si < this.segs.length; si++) {
        const h = this.segs[si]!
        if (h.nDeleted >= h.seg.n) continue
        if (!segmentMatchesFilter(h.seg, filters)) {
          stats.blocksSkipped += h.seg.nb
          continue
        }
        const segText = textScores ? textScores[si] : undefined
        if (!hasVec && (!segText || segText.length === 0)) {
          stats.blocksSkipped += h.seg.nb
          continue
        }
        for (let b = 0; b < h.seg.nb; b++) {
          if (!blockMatchesFilter(h.seg, b, filters)) {
            stats.blocksSkipped++
            continue
          }
          blockTasks.push({ si, b })
        }
      }
    }

    // Top-k min-heap (or sorted array of size <= k)
    const top: { score: number; gid: number }[] = []
    let threshold = -Infinity
    const offer = (score: number, gid: number): void => {
      if (top.length < k) {
        top.push({ score, gid })
        if (top.length === k) {
          top.sort((a, b) => b.score - a.score || a.gid - b.gid)
          threshold = top[top.length - 1]!.score
        }
        return
      }
      if (score > threshold) {
        top[top.length - 1] = { score, gid }
        top.sort((a, b) => b.score - a.score || a.gid - b.gid)
        threshold = top[top.length - 1]!.score
      }
    }

    for (const { si, b } of blockTasks) {
      const h = this.segs[si]!
      const seg = h.seg
      const dim = seg.dim
      stats.blocksScanned++
      const s = seg.blocks[2 * b]!
      const e = seg.blocks[2 * b + 1]!
      const segText = textScores ? textScores[si] : undefined

      for (let pos = s; pos < e; pos++) {
        if (h.nDeleted > 0 && h.deleted.get(pos)) continue
        if (filters.length > 0 && !docMatchesFilter(seg, pos, filters)) continue
        stats.docsScanned++

        const rawBm25 = segText && segText.length > 0 ? segText[pos]! : 0
        if (!hasVec && rawBm25 <= 0) continue
        const ts = wText * rawBm25
        const rs = q.recency && wRec > 0 ? wRec * this.recencyScore(seg, pos, q.recency, recColIdx) : 0

        if (!hasVec) {
          const score = Math.fround(ts + rs)
          if (score <= threshold) continue
          stats.rescored++
          offer(score, h.base + pos)
        } else if (brute) {
          const vScore = dot(qv!, 0, seg.vectors, pos * dim, dim)
          const score = Math.fround(wVec * vScore + ts + rs)
          stats.rescored++
          offer(score, h.base + pos)
        } else {
          const ubVec = upperBound(seg.codes, pos * dim, dim, seg.codeScale[pos]!, seg.codeErr[pos]!, seg.maxNorm, qq!)
          const ub = Math.fround(wVec * ubVec + ts + rs)
          if (ub <= threshold) continue
          stats.rescored++
          const vScore = dot(qv!, 0, seg.vectors, pos * dim, dim)
          const score = Math.fround(wVec * vScore + ts + rs)
          offer(score, h.base + pos)
        }
      }
    }

    top.sort((a, b) => b.score - a.score || a.gid - b.gid)
    const hits = top.map(({ score, gid }) => {
      const { si, pos } = this.locate(gid)
      return this.hit(si, pos, score, false)
    })
    return { hits, stats }
  }

  scan(
    filter: NativeFilterTerm[],
    offset: number,
    limit: number,
    vectors: boolean,
    orderBy?: NativeOrderBy,
  ): NativeSearchOut {
    const schema = this.manifest.schema
    const filters = compileFilter(schema, filter)
    const stats: NativeSearchStats = {
      docsScanned: 0,
      rescored: 0,
      blocksScanned: 0,
      blocksSkipped: 0,
      docs: this.nLive,
      segments: this.liveSegments,
      blocks: this.totalBlocks,
      seq: this.manifest.seq,
    }
    if (limit === 0) return { hits: [], stats }

    if (!orderBy) {
      const hits: NativeHit[] = []
      let skip = offset
      outer: for (let si = 0; si < this.segs.length; si++) {
        const h = this.segs[si]!
        if (h.nDeleted >= h.seg.n) continue
        if (!segmentMatchesFilter(h.seg, filters)) {
          stats.blocksSkipped += h.seg.nb
          continue
        }
        for (let b = 0; b < h.seg.nb; b++) {
          if (!blockMatchesFilter(h.seg, b, filters)) {
            stats.blocksSkipped++
            continue
          }
          stats.blocksScanned++
          const s = h.seg.blocks[2 * b]!
          const e = h.seg.blocks[2 * b + 1]!
          for (let pos = s; pos < e; pos++) {
            if (h.nDeleted > 0 && h.deleted.get(pos)) continue
            if (filters.length > 0 && !docMatchesFilter(h.seg, pos, filters)) continue
            stats.docsScanned++
            if (skip > 0) {
              skip--
              continue
            }
            hits.push(this.hit(si, pos, 0, vectors))
            if (hits.length >= limit) break outer
          }
        }
      }
      return { hits, stats }
    }

    // Latest-N ordered scan with zone-map early termination (WP-32)
    const colIdx = schema.columns.indexOf(orderBy.column)
    if (colIdx < 0) invalid(`unknown orderBy column ${JSON.stringify(orderBy.column)}`)
    const colType = typedColumnOf(schema, colIdx)
    const desc = orderBy.dir === 'desc'
    const want = offset + limit

    type BlockCand = { si: number; b: number; bound: bigint | null; hasNull: boolean }
    const cands: BlockCand[] = []
    for (let si = 0; si < this.segs.length; si++) {
      const h = this.segs[si]!
      if (h.nDeleted >= h.seg.n) continue
      if (!segmentMatchesFilter(h.seg, filters)) {
        stats.blocksSkipped += h.seg.nb
        continue
      }
      const col = h.seg.columns[colIdx]!
      for (let b = 0; b < h.seg.nb; b++) {
        if (!blockMatchesFilter(h.seg, b, filters)) {
          stats.blocksSkipped++
          continue
        }
        const z = col.blockZones?.[b]
        const bound = z ? (z.hasValue ? (desc ? z.max : z.min) : null) : null
        cands.push({ si, b, bound, hasNull: z ? z.hasNull : true })
      }
    }

    // Sort blocks by best bound first (for typed columns with zone maps)
    const hasZones =
      colType !== 'string' && cands.every((c) => this.segs[c.si]!.seg.columns[colIdx]!.blockZones !== undefined)
    if (hasZones) {
      cands.sort((a, b) => {
        if (a.bound === null && b.bound === null) return a.si - b.si || a.b - b.b
        if (a.bound === null) return 1
        if (b.bound === null) return -1
        if (a.bound === b.bound) return a.si - b.si || a.b - b.b
        return desc ? (b.bound > a.bound ? 1 : -1) : a.bound < b.bound ? -1 : 1
      })
    }

    type RowKey = { isNull: boolean; num?: bigint; str?: string; gid: number; si: number; pos: number }
    const compareKeys = (a: RowKey, b: RowKey): number => {
      if (a.isNull !== b.isNull) return a.isNull ? 1 : -1 // nulls always sort last
      if (!a.isNull) {
        if (colType === 'string') {
          if (a.str !== b.str) return desc ? (b.str! > a.str! ? 1 : -1) : a.str! < b.str! ? -1 : 1
        } else {
          if (a.num !== b.num) return desc ? (b.num! > a.num! ? 1 : -1) : a.num! < b.num! ? -1 : 1
        }
      }
      return a.gid - b.gid // ties break by storage position
    }

    const kept: RowKey[] = []
    for (let ci = 0; ci < cands.length; ci++) {
      const { si, b, bound } = cands[ci]!
      // Early termination: if we already have `want` non-null items and this block's best possible
      // value cannot beat the worst kept item, skip all remaining non-null-only blocks!
      if (hasZones && kept.length >= want && !kept[kept.length - 1]!.isNull) {
        const worst = kept[kept.length - 1]!.num!
        if (bound === null || (desc ? bound < worst : bound > worst)) {
          stats.blocksSkipped += cands.length - ci
          break
        }
      }
      stats.blocksScanned++
      const h = this.segs[si]!
      const seg = h.seg
      const col = seg.columns[colIdx]!
      const s = seg.blocks[2 * b]!
      const e = seg.blocks[2 * b + 1]!
      for (let pos = s; pos < e; pos++) {
        if (h.nDeleted > 0 && h.deleted.get(pos)) continue
        if (filters.length > 0 && !docMatchesFilter(seg, pos, filters)) continue
        stats.docsScanned++
        const strVal = col.dict[col.codes[pos]!] ?? ''
        const isNull = strVal === ''
        const key: RowKey = {
          isNull,
          num: !isNull && colType !== 'string' ? (col.typedVals?.[pos] ?? parseTypedInt64(strVal) ?? 0n) : undefined,
          str: !isNull && colType === 'string' ? strVal : undefined,
          gid: h.base + pos,
          si,
          pos,
        }
        if (kept.length < want) {
          kept.push(key)
          if (kept.length === want) kept.sort(compareKeys)
        } else if (compareKeys(key, kept[kept.length - 1]!) < 0) {
          kept[kept.length - 1] = key
          kept.sort(compareKeys)
        }
      }
    }

    kept.sort(compareKeys)
    const hits = kept.slice(offset, offset + limit).map((k) => this.hit(k.si, k.pos, 0, vectors))
    return { hits, stats }
  }
}

// ---------------------------------------------------------------------------------------------
// Cross-process / cross-handle lock management & Windows rename-aside recovery

const processLocks = new Set<string>()

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function lockPathOf(dbPath: string): string {
  return `${dbPath}.lock`
}

function acquireLock(dbPath: string): () => void {
  if (processLocks.has(dbPath)) fail('PRISM_LOCKED', `${dbPath} is already open for writing`)
  const lp = lockPathOf(dbPath)
  const deadline = Date.now() + 1500
  for (;;) {
    try {
      const fd = openSync(lp, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } finally {
        closeSync(fd)
      }
      processLocks.add(dbPath)
      return () => {
        processLocks.delete(dbPath)
        try {
          rmSync(lp, { force: true })
        } catch {
          // Ignore cleanup errors.
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') ioError(e)
      try {
        const info = JSON.parse(readFileSync(lp, 'utf8')) as { pid?: number }
        if (info.pid && info.pid !== process.pid && !isProcessAlive(info.pid)) {
          rmSync(lp, { force: true })
          continue
        }
      } catch {
        // If lock file was being written or removed concurrently, retry briefly.
      }
      if (Date.now() >= deadline) {
        fail('PRISM_LOCKED', `${dbPath} is open for writing in another process`)
      }
      const waitUntil = Date.now() + 15
      while (Date.now() < waitUntil) {
        // Brief spin retry for dead child process cleanup
      }
    }
  }
}

/**
 * Recover from an interrupted Windows rename-aside compaction (WP-11):
 * If `dbPath` is missing, restore a valid `dbPath.compact-tmp` or the newest valid `dbPath.old-<seq>`
 * before checking whether the file exists. Also cleans up leftover `.old-*` and `.compact-tmp` files.
 */
function recoverRenameAside(dbPath: string, isWriter: boolean): void {
  const dir = dirname(dbPath)
  const base = basename(dbPath)
  if (!existsSync(dir)) return
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const compactTmp = `${dbPath}.compact-tmp`
  const oldFiles = entries
    .filter((name) => name.startsWith(`${base}.old-`))
    .map((name) => ({ name, full: join(dir, name), seq: Number(name.slice(`${base}.old-`.length)) || 0 }))
    .sort((a, b) => b.seq - a.seq)

  if (!existsSync(dbPath)) {
    const candidates = [...(existsSync(compactTmp) ? [compactTmp] : []), ...oldFiles.map((x) => x.full)]
    for (const cand of candidates) {
      if (isValidPrismFile(cand)) {
        if (isWriter) {
          try {
            renameSync(cand, dbPath)
            break
          } catch {
            // Fall through
          }
        }
      }
    }
  }

  if (isWriter && existsSync(dbPath)) {
    try {
      rmSync(compactTmp, { force: true })
    } catch {
      // Ignore
    }
    for (const old of oldFiles) {
      try {
        rmSync(old.full, { force: true })
      } catch {
        // Ignore if held by a reader; a later open will remove it.
      }
    }
  }
}

function isValidPrismFile(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r')
    try {
      recoverCommit(fd, false)
      return true
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

function loadCommit(fd: number, fileLen: number, slot: HeaderSlot): { manifest: Manifest; segs: Segment[] } {
  if (
    slot.manifestOff < DATA_START ||
    slot.manifestLen < REC_HEADER_LEN ||
    slot.manifestOff + slot.manifestLen > slot.committedEnd ||
    slot.committedEnd > fileLen
  ) {
    corrupt('header points outside the file')
  }
  const rec = readExactAt(fd, slot.manifestLen, slot.manifestOff)
  const rh = decodeRecHeader(rec.subarray(0, REC_HEADER_LEN))
  if (!rh) corrupt('manifest record header')
  const body = rec.subarray(REC_HEADER_LEN)
  if (
    rh.kind !== KIND_MANIFEST ||
    rh.bodyLen !== body.byteLength ||
    rh.metaLen !== rh.bodyLen ||
    hashCrc(body) !== rh.metaCrc
  ) {
    corrupt('manifest checksum')
  }
  let m: Manifest
  try {
    m = JSON.parse(body.toString('utf8')) as Manifest
  } catch (e) {
    corrupt(`manifest JSON: ${(e as Error).message}`)
  }
  if (
    m.seq !== slot.seq ||
    m.format !== slot.version ||
    !m.schema ||
    m.schema.dim <= 0 ||
    !Array.isArray(m.schema.columns)
  ) {
    corrupt('manifest fields')
  }
  const ids = new Set<number>()
  for (const r of m.segments) {
    if (ids.has(r.id) || r.id >= m.next_segment_id) corrupt('manifest segment ids')
    ids.add(r.id)
  }
  const segs: Segment[] = []
  for (const r of m.segments) {
    if (r.offset < DATA_START || r.offset % PAGE !== 0 || r.offset + r.len > slot.committedEnd) {
      corrupt('segment outside the committed file')
    }
    const seg = Segment.open(fd, r.offset, r.len)
    if (seg.dim !== m.schema.dim || seg.ncols !== m.schema.columns.length || seg.n !== r.n_docs) {
      corrupt('segment does not match the schema')
    }
    segs.push(seg)
  }
  return { manifest: m, segs }
}

interface RecoveredCommit {
  slot: HeaderSlot
  slotIndex: number
  manifest: Manifest
  segs: Segment[]
  rejected: { index: number; slot: HeaderSlot; reason: string }[]
  maxSeq: number
  fileLen: number
}

function recoverCommit(fd: number, allowRollback: boolean): RecoveredCommit {
  const slots: { index: number; slot: HeaderSlot }[] = []
  for (let i = 0; i < 2; i++) {
    let b: Buffer
    try {
      b = readExactAt(fd, HEADER_SLOT_LEN, i * PAGE)
    } catch {
      continue
    }
    const dec = decodeHeaderSlot(b)
    if (dec.kind === 'unsupported') {
      corrupt(
        `the file was written in format version ${dec.version}; this build reads versions 1..=${MAX_SUPPORTED_FORMAT}`,
      )
    }
    if (dec.kind === 'ok') {
      slots.push({ index: i, slot: dec.slot })
    }
  }
  const fileLen = fstatSync(fd).size
  if (slots.length === 0) corrupt('no valid header (not a Prism file, or damaged)')
  slots.sort((a, b) => b.slot.seq - a.slot.seq)
  const maxSeq = slots[0]!.slot.seq
  const rejected: { index: number; slot: HeaderSlot; reason: string }[] = []
  for (const { index, slot } of slots) {
    try {
      const { manifest, segs } = loadCommit(fd, fileLen, slot)
      if (rejected.length > 0 && !allowRollback) {
        const bad = rejected[0]!
        corrupt(
          `the newest commit (${bad.slot.seq}) is damaged (${bad.reason}); commit ${slot.seq} is intact. Pass rollback: true to fall back to it`,
        )
      }
      return { slot, slotIndex: index, manifest, segs, rejected, maxSeq, fileLen }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.startsWith('PRISM_CORRUPT: ')) {
        if (msg.includes('newest commit')) throw e
        rejected.push({ index, slot, reason: msg.slice('PRISM_CORRUPT: '.length) })
      } else {
        throw e
      }
    }
  }
  const why = rejected.map((r) => `commit ${r.slot.seq}: ${r.reason}`).join('; ')
  corrupt(`no intact commit (${why})`)
}

function writeManifestRecord(file: DataFile, at: number, m: Manifest): { off: number; len: number } {
  const body = Buffer.from(JSON.stringify(m), 'utf8')
  const rh = encodeRecHeader({
    kind: KIND_MANIFEST,
    bodyLen: body.byteLength,
    metaLen: body.byteLength,
    metaCrc: hashCrc(body),
  })
  const rec = Buffer.concat([rh, body])
  file.writeAt(at, rec)
  return { off: at, len: rec.byteLength }
}

// ---------------------------------------------------------------------------------------------
// JsNativeDatabase implementation

interface MergePolicy {
  fanIn: number
  maxMergeDocs: number
  compactDeadRatio: number
  compactMinDeadBytes: number
  compactMaxDocs: number
}

function normalizeColumnsSpec(cols?: (string | ColumnDef)[]): { names: string[]; types: Record<string, ColumnType> } {
  const names: string[] = []
  const types: Record<string, ColumnType> = {}
  const seen = new Set<string>()
  for (const c of cols ?? []) {
    const name = typeof c === 'string' ? c : c.name
    const type: ColumnType = typeof c === 'string' ? 'string' : c.type
    if (!name || seen.has(name)) invalid(`column names must be non-empty and unique (${JSON.stringify(name)})`)
    if (type !== 'string' && type !== 'time' && type !== 'int') invalid(`unknown column type ${JSON.stringify(type)}`)
    seen.add(name)
    names.push(name)
    types[name] = type
  }
  return { names, types }
}

class JsNativeDatabase implements NativeDatabase {
  #path: string
  #readonly: boolean
  #df: DataFile | null
  #unlock: (() => void) | null
  #end: number
  #tail: number
  #slot: number
  #seqFloor: number
  #poisoned = false
  #snap: Snapshot
  #policy: MergePolicy = {
    fanIn: 8,
    maxMergeDocs: 65_536,
    compactDeadRatio: 0.5,
    compactMinDeadBytes: 16 << 20,
    compactMaxDocs: 100_000,
  }
  closed = false

  private constructor(
    path: string,
    readonly: boolean,
    df: DataFile | null,
    unlock: (() => void) | null,
    end: number,
    slot: number,
    seqFloor: number,
    snap: Snapshot,
  ) {
    this.#path = path
    this.#readonly = readonly
    this.#df = df
    this.#unlock = unlock
    this.#end = end
    this.#tail = end
    this.#slot = slot
    this.#seqFloor = seqFloor
    this.#snap = snap
  }

  static openSync(
    rawPath: string,
    spec: { create?: NativeOpenCreate; readonly?: boolean; rollback?: boolean },
  ): JsNativeDatabase {
    const readonly = !!spec.readonly
    const absPath = resolvePath(rawPath)
    if (!readonly && spec.create) {
      mkdirSync(dirname(absPath), { recursive: true })
    }
    const dir = existsSync(dirname(absPath)) ? realpathSync.native(dirname(absPath)) : dirname(absPath)
    const targetPath = join(dir, basename(absPath))

    const unlock = !readonly ? acquireLock(targetPath) : null
    try {
      recoverRenameAside(targetPath, !readonly)

      if (!existsSync(targetPath)) {
        if (readonly || !spec.create) {
          fail('PRISM_NOT_FOUND', `no database at ${targetPath}`)
        }
        const c = spec.create
        if (c.dimensions <= 0 || c.dimensions > 65_536) invalid('dim must be between 1 and 65536')
        const { names, types } = normalizeColumnsSpec(c.columns)
        if (names.length > 256) invalid('at most 256 filter columns')
        const formatVersion = c.formatVersion ?? FORMAT_VERSION_V2
        const tokenizer: TokenizerVersion = c.tokenizer ?? (formatVersion >= 2 ? 'v2' : 'v1')
        const schema: Schema = {
          dim: c.dimensions,
          model: c.model ?? '',
          columns: names,
          ...(formatVersion >= 2 ? { columnTypes: types, tokenizer } : {}),
        }
        const tmp = `${targetPath}.create-${process.pid}-${Date.now()}-tmp`
        const fd = openSync(tmp, 'w+', 0o600)
        try {
          if (process.platform !== 'win32') chmodSync(tmp, 0o600)
        } catch {
          // Ignore mode errors on filesystems without permissions
        }
        const df = new DataFile(fd, tmp)
        try {
          df.setLen(DATA_START)
          const m: Manifest = { format: formatVersion, seq: 1, schema, segments: [], next_segment_id: 1 }
          const { off, len } = writeManifestRecord(df, DATA_START, m)
          df.sync()
          const committedEnd = off + len
          df.writeAt(
            0,
            encodeHeaderSlot({ version: formatVersion, seq: 1, manifestOff: off, manifestLen: len, committedEnd }),
          )
          df.sync()
          df.close()
          renameSync(tmp, targetPath)
          syncDir(dir)
        } catch (e) {
          df.close()
          try {
            rmSync(tmp, { force: true })
          } catch {
            // Ignore
          }
          throw e
        }
      }

      const realFile = realpathSync.native(targetPath)
      const fd = openSync(realFile, readonly ? 'r' : 'r+')
      try {
        const rec = recoverCommit(fd, !!spec.rollback)
        if (readonly) {
          const snap = new Snapshot(rec.manifest, rec.segs)
          closeSync(fd)
          return new JsNativeDatabase(
            realFile,
            true,
            null,
            null,
            rec.slot.committedEnd,
            rec.slotIndex,
            rec.maxSeq,
            snap,
          )
        }
        const df = new DataFile(fd, realFile)
        let end = rec.slot.committedEnd
        let slotIdx = rec.slotIndex
        let manifest = rec.manifest
        if (rec.rejected.length === 0) {
          if (rec.fileLen > end) {
            df.setLen(end)
            df.sync()
          }
        } else {
          for (const r of rec.rejected) {
            df.writeAt(r.index * PAGE, Buffer.alloc(HEADER_SLOT_LEN))
          }
          df.sync()
          end = Math.max(end, rec.fileLen)
          const nextSeq = Math.max(manifest.seq, rec.maxSeq) + 1
          manifest = { ...manifest, seq: nextSeq }
          const at = alignUp(end, PAGE)
          const { off, len } = writeManifestRecord(df, at, manifest)
          df.sync()
          const targetSlot = 1 - slotIdx
          const committedEnd = off + len
          df.writeAt(
            targetSlot * PAGE,
            encodeHeaderSlot({
              version: manifest.format,
              seq: manifest.seq,
              manifestOff: off,
              manifestLen: len,
              committedEnd,
            }),
          )
          df.sync()
          slotIdx = targetSlot
          end = committedEnd
        }
        const snap = new Snapshot(manifest, rec.segs)
        return new JsNativeDatabase(realFile, false, df, unlock, end, slotIdx, Math.max(rec.maxSeq, manifest.seq), snap)
      } catch (e) {
        try {
          closeSync(fd)
        } catch {
          // Ignore
        }
        throw e
      }
    } catch (e) {
      unlock?.()
      throw e
    }
  }

  #ensureOpen(): void {
    if (this.closed) fail('PRISM_CLOSED', 'the connection is closed')
  }

  #ensureWritable(): DataFile {
    this.#ensureOpen()
    if (this.#readonly || !this.#df) fail('PRISM_READONLY', 'this connection is read-only')
    if (this.#poisoned)
      fail('PRISM_POISONED', 'an earlier write failed partway through; reconnect before writing again')
    return this.#df
  }

  #nextSeq(): number {
    return Math.max(this.#snap.manifest.seq, this.#seqFloor) + 1
  }

  #publish(df: DataFile, m: Manifest): void {
    const at = alignUp(this.#tail, PAGE)
    const { off, len } = writeManifestRecord(df, at, m)
    this.#poisoned = true
    df.sync()
    const target = 1 - this.#slot
    const committedEnd = off + len
    df.writeAt(
      target * PAGE,
      encodeHeaderSlot({ version: m.format, seq: m.seq, manifestOff: off, manifestLen: len, committedEnd }),
    )
    df.sync()
    this.#poisoned = false
    this.#slot = target
    this.#end = committedEnd
    this.#tail = committedEnd
    this.#seqFloor = Math.max(this.#seqFloor, m.seq)
  }

  #abandon(): void {
    if (!this.#poisoned) this.#tail = this.#end
  }

  async write(ops: NativeOp[]): Promise<NativeWriteOut> {
    const df = this.#ensureWritable()
    const snap = this.#snap
    const schema = snap.manifest.schema
    const formatVersion = snap.manifest.format

    const pending: (DocIn | null)[] = []
    const byId = new Map<string, number>()
    const dels = new Map<number, Set<number>>()
    const gone = new Set<string>()
    const counts: number[] = []

    const markStoredDeleted = (si: number, pos: number): boolean => {
      const key = `${si}:${pos}`
      if (gone.has(key)) return false
      gone.add(key)
      const sid = snap.segs[si]!.id
      let set = dels.get(sid)
      if (!set) {
        set = new Set()
        dels.set(sid, set)
      }
      set.add(pos)
      return true
    }

    const prepareBatch = (docs: NativeDoc[]): DocIn[] => {
      const seen = new Set<string>()
      return docs.map((d) => {
        if (!d.id) invalid('document id is empty')
        if (seen.has(d.id)) invalid(`id ${JSON.stringify(d.id)} appears twice in one batch`)
        seen.add(d.id)
        if (!d.vector || d.vector.length !== schema.dim) {
          invalid(
            `document ${JSON.stringify(d.id)} has ${d.vector?.length ?? 0} dimensions, the database has ${schema.dim}`,
          )
        }
        const unit = toUnit(d.vector)
        if (!unit) invalid(`document ${JSON.stringify(d.id)} has a zero or non-finite vector`)
        const tags = schema.columns.map(() => '')
        if (d.columns) {
          for (const [k, v] of Object.entries(d.columns)) {
            const c = schema.columns.indexOf(k)
            if (c < 0) invalid(`unknown column ${JSON.stringify(k)}`)
            tags[c] = v ?? ''
          }
        }
        return { id: d.id, text: d.text ?? '', meta: d.meta ?? '', vector: unit, tags }
      })
    }

    for (const op of ops) {
      if (op.kind === 'upsert') {
        const prepared = prepareBatch(op.docs)
        for (const doc of prepared) {
          const existingIdx = byId.get(doc.id)
          if (existingIdx !== undefined) {
            pending[existingIdx] = doc
            continue
          }
          const loc = snap.find(doc.id)
          if (loc) markStoredDeleted(loc.si, loc.pos)
          byId.set(doc.id, pending.length)
          pending.push(doc)
        }
        counts.push(prepared.length)
      } else if (op.kind === 'insert') {
        const prepared = prepareBatch(op.docs)
        for (const doc of prepared) {
          const stagedIdx = byId.get(doc.id)
          const stagedLive = stagedIdx !== undefined && pending[stagedIdx] !== null
          const loc = snap.find(doc.id)
          const storedLive = loc !== null && !gone.has(`${loc.si}:${loc.pos}`)
          if (stagedLive || storedLive) {
            fail('PRISM_DUPLICATE', `document id ${JSON.stringify(doc.id)} already exists`)
          }
        }
        for (const doc of prepared) {
          byId.set(doc.id, pending.length)
          pending.push(doc)
        }
        counts.push(prepared.length)
      } else if (op.kind === 'delete') {
        const seen = new Set<string>()
        let n = 0
        for (const id of op.ids) {
          if (seen.has(id)) continue
          seen.add(id)
          const stagedIdx = byId.get(id)
          if (stagedIdx !== undefined && pending[stagedIdx] !== null) {
            pending[stagedIdx] = null
            n++
          } else {
            const loc = snap.find(id)
            if (loc && markStoredDeleted(loc.si, loc.pos)) n++
          }
        }
        counts.push(n)
      } else if (op.kind === 'deleteWhere') {
        if (!op.filter || op.filter.length === 0) invalid('a delete by filter needs at least one column condition')
        const filters = compileFilter(schema, op.filter)
        let n = 0
        for (let si = 0; si < snap.segs.length; si++) {
          const h = snap.segs[si]!
          if (h.nDeleted >= h.seg.n || !segmentMatchesFilter(h.seg, filters)) continue
          for (let b = 0; b < h.seg.nb; b++) {
            if (!blockMatchesFilter(h.seg, b, filters)) continue
            const s = h.seg.blocks[2 * b]!
            const e = h.seg.blocks[2 * b + 1]!
            for (let pos = s; pos < e; pos++) {
              if (!h.deleted.get(pos) && docMatchesFilter(h.seg, pos, filters)) {
                if (markStoredDeleted(si, pos)) n++
              }
            }
          }
        }
        for (let i = 0; i < pending.length; i++) {
          const doc = pending[i]
          if (!doc) continue
          const matches = filters.every((cf) => {
            const strVal = doc.tags[cf.colIdx] ?? ''
            if (cf.allowedValues && !cf.allowedValues.has(strVal)) return false
            const hasRange = cf.gt !== undefined || cf.gte !== undefined || cf.lt !== undefined || cf.lte !== undefined
            if (hasRange) {
              if (strVal === '') return cf.wantNull
              if (cf.colType === 'string') {
                if (typeof cf.gt === 'string' && !(strVal > cf.gt)) return false
                if (typeof cf.gte === 'string' && !(strVal >= cf.gte)) return false
                if (typeof cf.lt === 'string' && !(strVal < cf.lt)) return false
                if (typeof cf.lte === 'string' && !(strVal <= cf.lte)) return false
              } else {
                const v = parseTypedInt64(strVal)
                if (v === null) return false
                if (typeof cf.gt === 'bigint' && !(v > cf.gt)) return false
                if (typeof cf.gte === 'bigint' && !(v >= cf.gte)) return false
                if (typeof cf.lt === 'bigint' && !(v < cf.lt)) return false
                if (typeof cf.lte === 'bigint' && !(v <= cf.lte)) return false
              }
            }
            return true
          })
          if (matches) {
            pending[i] = null
            n++
          }
        }
        counts.push(n)
      }
    }

    const docsToAdd = pending.filter((d): d is DocIn => d !== null)
    if (docsToAdd.length === 0 && dels.size === 0) {
      return { seq: snap.manifest.seq, counts, maintenanceDue: this.maintenanceDue() }
    }

    try {
      const m: Manifest = {
        format: formatVersion,
        seq: this.#nextSeq(),
        schema: structuredClone(schema),
        segments: snap.manifest.segments.map((r) => {
          const addDels = dels.get(r.id)
          if (!addDels) return structuredClone(r)
          const bits = Bitset.fromRuns(r.n_docs, r.deleted)
          for (const p of addDels) bits.set(p)
          return { ...r, deleted: bits.toRuns() }
        }),
        next_segment_id: snap.manifest.next_segment_id,
      }
      const nextSegs = snap.segs.map((h) => h.seg)
      if (docsToAdd.length > 0) {
        const at = alignUp(this.#tail, PAGE)
        const info = writeSegment(df, at, docsToAdd, schema, formatVersion, docsToAdd.length >= CLUSTER_MIN)
        this.#tail = at + info.len
        nextSegs.push(Segment.open(df.fd, at, info.len))
        const sid = m.next_segment_id++
        m.segments.push({
          id: sid,
          offset: at,
          len: info.len,
          n_docs: info.nDocs,
          clustered: info.clustered,
          deleted: [],
        })
      }
      const nextSnap = new Snapshot(m, nextSegs)
      this.#publish(df, m)
      this.#snap = nextSnap
      return { seq: m.seq, counts, maintenanceDue: this.maintenanceDue() }
    } catch (e) {
      this.#abandon()
      throw e
    }
  }

  async search(q: NativeQuery): Promise<NativeSearchOut> {
    this.#ensureOpen()
    return this.#snap.search(q, false)
  }

  async bruteForce(q: NativeQuery): Promise<NativeSearchOut> {
    this.#ensureOpen()
    return this.#snap.search(q, true)
  }

  async get(ids: string[], vectors: boolean): Promise<(NativeHit | null)[]> {
    this.#ensureOpen()
    const snap = this.#snap
    return ids.map((id) => {
      const loc = snap.find(id)
      return loc ? snap.hit(loc.si, loc.pos, 0, vectors) : null
    })
  }

  async scan(
    filter: NativeFilterTerm[],
    offset: number,
    limit: number,
    vectors: boolean,
    orderBy?: NativeOrderBy,
  ): Promise<NativeSearchOut> {
    this.#ensureOpen()
    return this.#snap.scan(filter, offset, limit, vectors, orderBy)
  }

  async count(filter: NativeFilterTerm[]): Promise<number> {
    this.#ensureOpen()
    const snap = this.#snap
    if (!filter || filter.length === 0) return snap.nLive
    const filters = compileFilter(snap.manifest.schema, filter)
    let n = 0
    for (const h of snap.segs) {
      if (h.nDeleted >= h.seg.n || !segmentMatchesFilter(h.seg, filters)) continue
      for (let b = 0; b < h.seg.nb; b++) {
        if (!blockMatchesFilter(h.seg, b, filters)) continue
        const s = h.seg.blocks[2 * b]!
        const e = h.seg.blocks[2 * b + 1]!
        for (let pos = s; pos < e; pos++) {
          if (!h.deleted.get(pos) && docMatchesFilter(h.seg, pos, filters)) n++
        }
      }
    }
    return n
  }

  async distinct(column: string): Promise<string[]> {
    this.#ensureOpen()
    const snap = this.#snap
    const c = snap.manifest.schema.columns.indexOf(column)
    if (c < 0) invalid(`unknown column ${JSON.stringify(column)}`)
    const vals = new Set<string>()
    for (const h of snap.segs) {
      if (h.nDeleted >= h.seg.n) continue
      const col = h.seg.columns[c]!
      for (const v of col.dict) vals.add(v)
    }
    return [...vals].sort()
  }

  async countBy(columns: string[], filter: NativeFilterTerm[]): Promise<{ values: string[]; count: number }[]> {
    this.#ensureOpen()
    const snap = this.#snap
    const schema = snap.manifest.schema
    if (columns.length === 0) invalid('count_by needs at least one column')
    const colIdxs = columns.map((name) => {
      const c = schema.columns.indexOf(name)
      if (c < 0) invalid(`unknown column ${JSON.stringify(name)}`)
      return c
    })
    const filters = compileFilter(schema, filter)
    const map = new Map<string, { values: string[]; count: number }>()
    for (const h of snap.segs) {
      if (h.nDeleted >= h.seg.n || !segmentMatchesFilter(h.seg, filters)) continue
      for (let b = 0; b < h.seg.nb; b++) {
        if (!blockMatchesFilter(h.seg, b, filters)) continue
        const s = h.seg.blocks[2 * b]!
        const e = h.seg.blocks[2 * b + 1]!
        for (let pos = s; pos < e; pos++) {
          if (h.nDeleted > 0 && h.deleted.get(pos)) continue
          if (filters.length > 0 && !docMatchesFilter(h.seg, pos, filters)) continue
          const values = colIdxs.map((c) => {
            const col = h.seg.columns[c]!
            return col.dict[col.codes[pos]!] ?? ''
          })
          const key = JSON.stringify(values)
          const cur = map.get(key)
          if (cur) cur.count++
          else map.set(key, { values, count: 1 })
        }
      }
    }
    return [...map.values()].sort((a, b) => {
      for (let i = 0; i < a.values.length; i++) {
        if (a.values[i] !== b.values[i]) return a.values[i]! < b.values[i]! ? -1 : 1
      }
      return 0
    })
  }

  #planMerge(): { empty: number[]; merge: number[] } | null {
    const snap = this.#snap
    const p = this.#policy
    const fanIn = Math.max(2, p.fanIn)
    const eligibleBelow = Math.max(1, Math.floor(p.maxMergeDocs / fanIn))
    const empty: number[] = []
    const tiers = new Map<number, { live: number; idx: number }[]>()
    for (let i = 0; i < snap.segs.length; i++) {
      const h = snap.segs[i]!
      const live = h.seg.n - Math.min(h.seg.n, h.nDeleted)
      if (live === 0) empty.push(i)
      else if (live < eligibleBelow) {
        let t = 0
        let x = live
        while (x >= fanIn) {
          x = Math.floor(x / fanIn)
          t++
        }
        const list = tiers.get(t) ?? []
        list.push({ live, idx: i })
        tiers.set(t, list)
      }
    }
    const sortedTiers = [...tiers.entries()].sort((a, b) => a[0] - b[0])
    const merge: number[] = []
    for (const [, group] of sortedTiers) {
      if (group.length >= fanIn) {
        group.sort((a, b) => a.live - b.live)
        let total = 0
        for (const item of group) {
          if (merge.length >= 2 && total + item.live > p.maxMergeDocs) break
          total += item.live
          merge.push(item.idx)
        }
        break
      }
    }
    return empty.length === 0 && merge.length === 0 ? null : { empty, merge }
  }

  #compactionDue(): boolean {
    const snap = this.#snap
    const p = this.#policy
    let liveBytes = 0
    for (const h of snap.segs) {
      const live = h.seg.n - Math.min(h.seg.n, h.nDeleted)
      liveBytes += (h.seg.raw.byteLength * live) / Math.max(1, h.seg.n)
    }
    const dead = Math.max(0, this.#end - (DATA_START + liveBytes))
    return dead >= p.compactMinDeadBytes && dead >= p.compactDeadRatio * this.#end && snap.nLive <= p.compactMaxDocs
  }

  maintenanceDue(): boolean {
    if (this.closed || this.#readonly || this.#poisoned) return false
    return this.#planMerge() !== null || this.#compactionDue()
  }

  #liveDocsIn(indices: number[]): DocIn[] {
    const snap = this.#snap
    const ncols = snap.manifest.schema.columns.length
    const out: DocIn[] = []
    for (const idx of indices) {
      const h = snap.segs[idx]!
      const seg = h.seg
      for (let pos = 0; pos < seg.n; pos++) {
        if (h.deleted.get(pos)) continue
        const tags: string[] = []
        for (let c = 0; c < ncols; c++) {
          const col = seg.columns[c]!
          tags.push(col.dict[col.codes[pos]!] ?? '')
        }
        out.push({
          id: seg.ids[pos]!,
          text: seg.texts[pos]!,
          meta: seg.metas[pos]!,
          vector: Float32Array.from(seg.vectors.subarray(pos * seg.dim, (pos + 1) * seg.dim)),
          tags,
        })
      }
    }
    return out
  }

  async maintain(): Promise<NativeMaintainOut> {
    const df = this.#ensureWritable()
    const rep: NativeMaintainOut = {
      commits: 0,
      segmentsMerged: 0,
      segmentsDropped: 0,
      docsRewritten: 0,
      compacted: false,
      seq: this.#snap.manifest.seq,
    }
    for (let step = 0; step < 10_000; step++) {
      const plan = this.#planMerge()
      if (!plan) break
      const { empty, merge } = plan
      const snap = this.#snap
      const docs = this.#liveDocsIn(merge)
      const gone = new Set([...empty, ...merge])
      try {
        const m: Manifest = {
          format: snap.manifest.format,
          seq: this.#nextSeq(),
          schema: structuredClone(snap.manifest.schema),
          segments: [],
          next_segment_id: snap.manifest.next_segment_id,
        }
        const segs: Segment[] = []
        for (let i = 0; i < snap.segs.length; i++) {
          if (!gone.has(i)) {
            m.segments.push(structuredClone(snap.manifest.segments[i]!))
            segs.push(snap.segs[i]!.seg)
          }
        }
        if (docs.length > 0) {
          const at = alignUp(this.#tail, PAGE)
          const info = writeSegment(df, at, docs, m.schema, m.format, docs.length >= CLUSTER_MIN)
          this.#tail = at + info.len
          segs.push(Segment.open(df.fd, at, info.len))
          const sid = m.next_segment_id++
          m.segments.push({
            id: sid,
            offset: at,
            len: info.len,
            n_docs: info.nDocs,
            clustered: info.clustered,
            deleted: [],
          })
        }
        const nextSnap = new Snapshot(m, segs)
        this.#publish(df, m)
        this.#snap = nextSnap
        rep.commits++
        rep.segmentsMerged += merge.length
        rep.segmentsDropped += empty.length
        rep.docsRewritten += docs.length
      } catch (e) {
        this.#abandon()
        throw e
      }
    }
    if (this.#compactionDue()) {
      const c = await this.compact()
      rep.docsRewritten += c.docsRewritten
      rep.compacted = true
    }
    rep.seq = this.#snap.manifest.seq
    return rep
  }

  #rewriteWholeFile(targetFormat: number, targetTokenizer?: TokenizerVersion): NativeMaintainOut {
    const df = this.#ensureWritable()
    const snap = this.#snap
    const docs = this.#liveDocsIn(Array.from({ length: snap.segs.length }, (_, i) => i))
    const schema: Schema = {
      ...structuredClone(snap.manifest.schema),
      ...(targetFormat >= 2
        ? {
            columnTypes:
              snap.manifest.schema.columnTypes ??
              Object.fromEntries(snap.manifest.schema.columns.map((c) => [c, 'string' as const])),
            tokenizer: targetTokenizer ?? snap.manifest.schema.tokenizer ?? 'v2',
          }
        : {}),
    }
    const tmp = `${this.#path}.compact-tmp`
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Ignore
    }
    const seq = this.#nextSeq()
    const nextSegId = snap.manifest.next_segment_id
    const tmpFd = openSync(tmp, 'w+', 0o600)
    try {
      if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    } catch {
      // Ignore
    }
    const tmpDf = new DataFile(tmpFd, tmp)
    let m: Manifest
    let nextSnap: Snapshot
    let committedEnd: number
    try {
      tmpDf.setLen(DATA_START)
      m = { format: targetFormat, seq, schema, segments: [], next_segment_id: nextSegId }
      let tail = DATA_START
      const segs: Segment[] = []
      if (docs.length > 0) {
        const info = writeSegment(tmpDf, DATA_START, docs, schema, targetFormat, true)
        segs.push(Segment.open(tmpDf.fd, DATA_START, info.len))
        m.segments.push({
          id: m.next_segment_id++,
          offset: DATA_START,
          len: info.len,
          n_docs: info.nDocs,
          clustered: info.clustered,
          deleted: [],
        })
        tail = DATA_START + info.len
      }
      const { off, len } = writeManifestRecord(tmpDf, alignUp(tail, PAGE), m)
      tmpDf.sync()
      committedEnd = off + len
      tmpDf.writeAt(
        0,
        encodeHeaderSlot({ version: targetFormat, seq: m.seq, manifestOff: off, manifestLen: len, committedEnd }),
      )
      tmpDf.sync()
      nextSnap = new Snapshot(m, segs)
    } catch (e) {
      tmpDf.close()
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Ignore
      }
      throw e
    }

    // Replace the file (using rename-aside on Windows or when testing rename faults)
    try {
      checkFault('rename')
      if (process.platform === 'win32') {
        tmpDf.close()
        df.close()
        const oldPath = `${this.#path}.old-${seq}`
        renameSync(this.#path, oldPath)
        renameSync(tmp, this.#path)
        try {
          rmSync(oldPath, { force: true })
        } catch {
          // Cleaned up on next open if held
        }
        const newFd = openSync(this.#path, 'r+')
        this.#df = new DataFile(newFd, this.#path)
      } else {
        renameSync(tmp, this.#path)
        df.close()
        this.#df = tmpDf
      }
    } catch (e) {
      tmpDf.close()
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Ignore
      }
      ioError(e)
    }

    this.#end = committedEnd
    this.#tail = committedEnd
    this.#slot = 0
    this.#seqFloor = m.seq
    this.#snap = nextSnap
    syncDir(dirname(this.#path))
    return {
      commits: 1,
      segmentsMerged: snap.segs.length,
      segmentsDropped: 0,
      docsRewritten: docs.length,
      compacted: true,
      seq: m.seq,
    }
  }

  async compact(): Promise<NativeMaintainOut> {
    return this.#rewriteWholeFile(this.#snap.manifest.format)
  }

  async upgrade(tokenizer: TokenizerVersion = 'v2'): Promise<NativeMaintainOut> {
    return this.#rewriteWholeFile(FORMAT_VERSION_V2, tokenizer)
  }

  async backup(destPath: string): Promise<void> {
    this.#ensureOpen()
    const absDest = resolvePath(destPath)
    if (existsSync(absDest)) {
      fail('PRISM_EXISTS', `destination file ${absDest} already exists`)
    }
    mkdirSync(dirname(absDest), { recursive: true })
    const snap = this.#snap
    const docs = this.#liveDocsIn(Array.from({ length: snap.segs.length }, (_, i) => i))
    const formatVersion = snap.manifest.format
    const schema = structuredClone(snap.manifest.schema)
    const tmp = `${absDest}.backup-${process.pid}-${Date.now()}-tmp`
    const fd = openSync(tmp, 'w+', 0o600)
    try {
      if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    } catch {
      // Ignore
    }
    const tmpDf = new DataFile(fd, tmp)
    try {
      tmpDf.setLen(DATA_START)
      const m: Manifest = { format: formatVersion, seq: 1, schema, segments: [], next_segment_id: 1 }
      let tail = DATA_START
      if (docs.length > 0) {
        const info = writeSegment(tmpDf, DATA_START, docs, schema, formatVersion, true)
        const seg = Segment.open(tmpDf.fd, DATA_START, info.len)
        seg.verify()
        m.segments.push({
          id: m.next_segment_id++,
          offset: DATA_START,
          len: info.len,
          n_docs: info.nDocs,
          clustered: info.clustered,
          deleted: [],
        })
        tail = DATA_START + info.len
      }
      const { off, len } = writeManifestRecord(tmpDf, alignUp(tail, PAGE), m)
      tmpDf.sync()
      const committedEnd = off + len
      tmpDf.writeAt(
        0,
        encodeHeaderSlot({ version: formatVersion, seq: 1, manifestOff: off, manifestLen: len, committedEnd }),
      )
      tmpDf.sync()
      tmpDf.close()
      renameSync(tmp, absDest)
      syncDir(dirname(absDest))
    } catch (e) {
      tmpDf.close()
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Ignore
      }
      throw e
    }
  }

  async verify(): Promise<NativeMaintainOut> {
    this.#ensureOpen()
    for (const h of this.#snap.segs) h.seg.verify()
    return {
      commits: 0,
      segmentsMerged: 0,
      segmentsDropped: 0,
      docsRewritten: 0,
      compacted: false,
      seq: this.#snap.manifest.seq,
    }
  }

  info(): NativeInfo {
    const snap = this.#snap
    const schema = snap.manifest.schema
    let deleted = 0
    for (const h of snap.segs) deleted += h.nDeleted
    let fileBytes = this.#end
    try {
      fileBytes = statSync(this.#path).size
    } catch {
      // Fallback
    }
    const columnTypes: Record<string, ColumnType> = {}
    for (const col of schema.columns) {
      columnTypes[col] = schema.columnTypes?.[col] ?? 'string'
    }
    return {
      path: this.#path,
      dimensions: schema.dim,
      model: schema.model,
      columns: [...schema.columns],
      columnTypes,
      tokenizer: schema.tokenizer ?? (snap.manifest.format >= 2 ? 'v2' : 'v1'),
      formatVersion: snap.manifest.format,
      readonly: this.#readonly,
      count: snap.nLive,
      seq: snap.manifest.seq,
      segments: snap.segs.length,
      deleted,
      fileBytes,
    }
  }

  setMergePolicy(p: NativeMergePolicy): void {
    if (p.fanIn !== undefined) this.#policy.fanIn = p.fanIn
    if (p.maxMergeDocs !== undefined) this.#policy.maxMergeDocs = p.maxMergeDocs
    if (p.compactDeadRatio !== undefined) this.#policy.compactDeadRatio = p.compactDeadRatio
    if (p.compactMinDeadBytes !== undefined) this.#policy.compactMinDeadBytes = p.compactMinDeadBytes
    if (p.compactMaxDocs !== undefined) this.#policy.compactMaxDocs = p.compactMaxDocs
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.#df?.close()
    this.#df = null
    this.#unlock?.()
    this.#unlock = null
  }
}

// ---------------------------------------------------------------------------------------------
// Module loader

export function platformTag(): string {
  let tag = `${process.platform}-${process.arch}`
  if (process.platform === 'linux') {
    const report = (process.report?.getReport?.() ?? {}) as { header?: { glibcVersionRuntime?: string } }
    if (!report.header?.glibcVersionRuntime) tag += '-musl'
  }
  return tag
}

const jsModule: NativeModule = {
  NativeDatabase: {
    async open(path, spec) {
      return JsNativeDatabase.openSync(path, spec)
    },
  },
}

let loaded: NativeModule | undefined

export function native(): NativeModule {
  if (loaded) return loaded
  if (process.env.PRISM_NATIVE_PATH) {
    const file = process.env.PRISM_NATIVE_PATH
    if (!existsSync(file)) {
      throw new PrismError('PRISM_NATIVE', `prism-db native module not found at PRISM_NATIVE_PATH=${file}`)
    }
    try {
      const req = createRequire(import.meta.url)
      loaded = req(file) as NativeModule
      return loaded
    } catch (e) {
      throw new PrismError(
        'PRISM_NATIVE',
        `prism-db could not load its native module ${file}: ${(e as Error).message}`,
        {
          cause: e,
        },
      )
    }
  }
  loaded = jsModule
  return loaded
}
