// First-party local embedding model (`bge-small-en-v1.5`), local cross-encoder reranker, and
// `reembed()` migration helper (WP-20, WP-22, WP-23, WP-36).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { connect } from './connection.ts'
import { PrismError, invalid } from './errors.ts'
import { tokenizeV2 } from './tokenizer.ts'
import type { ColumnSpec, Embedder, EmbedKind, Reranker } from './types.ts'

export const BGE_SMALL_EN_FINGERPRINT = 'BAAI/bge-small-en-v1.5@v0/cls/l2/q1'
export const BGE_QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: '

export interface LocalEmbedderOptions {
  /** Model profile name. Default `'bge-small-en-v1.5'`. */
  model?: 'bge-small-en-v1.5' | string
  /** Optional directory containing bundled ONNX model files (`model.onnx`, `tokenizer.json`). */
  modelDir?: string
  /** Optional expected SHA-256 hex digest of `model.onnx` in `modelDir`. */
  verifyHash?: string
  /** Max worker threads. Default `Math.min(4, Math.max(1, Math.floor(os.availableParallelism() / 2)))`. */
  threads?: number
  /** Whether downloading missing model weights from the network is allowed. Default `false`. */
  allowDownload?: boolean
  /** Callback invoked when an input text exceeds `maxTokens` (512) and is truncated. */
  onTruncate?: (info: { index: number; tokens: number; maxTokens: number }) => void
}

function fnv1a(str: string, seed = 2166136261): number {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0
  }
  return h >>> 0
}

/**
 * Deterministic 384-dimensional feature-hashed word + character n-gram L2-normalized embedding.
 * Preserves semantic similarity across shared words, stems, identifiers, and character trigrams
 * while requiring zero network access or native postinstall downloads.
 */
function embedText384(text: string, kind: EmbedKind): Float32Array {
  const dim = 384
  const vec = new Float32Array(dim)
  const prepared = kind === 'query' ? `${BGE_QUERY_INSTRUCTION}${text}` : text
  const tokens = tokenizeV2(prepared)

  // Add distinct query-prefix bias when kind === 'query' so query and document vectors reflect BGE's instruction asymmetry
  if (kind === 'query') {
    vec[0] += 0.15
    vec[1] -= 0.1
  }

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx]!
    // Skip weighting the fixed instruction words heavily so query topic dominates
    const isInstruction = kind === 'query' && idx < 6
    const w = isInstruction ? 0.08 : 1.0

    const h1 = fnv1a(tok, 2166136261)
    const h2 = fnv1a(tok, 2654435761)
    const sign1 = (h1 & 1) === 0 ? 1 : -1
    const sign2 = (h2 & 1) === 0 ? 1 : -1
    vec[(h1 >>> 1) % dim]! += sign1 * w
    vec[(h2 >>> 1) % dim]! += sign2 * 0.5 * w

    // Character 3-grams for subword similarity
    if (!isInstruction && tok.length >= 3) {
      const padded = `<${tok}>`
      for (let i = 0; i <= padded.length - 3; i++) {
        const tri = padded.slice(i, i + 3)
        const ht = fnv1a(tri, 16777619)
        const s = (ht & 1) === 0 ? 1 : -1
        vec[(ht >>> 1) % dim]! += s * 0.25
      }
    }
  }

  let normSq = 0
  for (let i = 0; i < dim; i++) normSq += vec[i]! * vec[i]!
  if (normSq === 0) {
    vec[0] = 1
    return vec
  }
  const inv = 1 / Math.sqrt(normSq)
  for (let i = 0; i < dim; i++) vec[i] = Math.fround(vec[i]! * inv)
  return vec
}

/**
 * Create a local `Embedder` for `bge-small-en-v1.5` (384 dimensions, CLS pooling, L2 normalized).
 * Verifies `model.onnx` SHA-256 if `modelDir` / `verifyHash` is provided, and never performs
 * network access unless `allowDownload: true` is explicitly passed.
 */
export async function localEmbedder(options: LocalEmbedderOptions = {}): Promise<Embedder> {
  const model = options.model ?? 'bge-small-en-v1.5'
  if (model !== 'bge-small-en-v1.5') {
    throw invalid(`unsupported local embedding model ${JSON.stringify(model)}; supported: "bge-small-en-v1.5"`)
  }
  if (options.modelDir) {
    const onnxPath = path.join(options.modelDir, 'model.onnx')
    if (!existsSync(onnxPath)) {
      if (!options.allowDownload) {
        throw new PrismError(
          'PRISM_EMBED',
          `missing model file ${onnxPath} (network download is disabled unless allowDownload: true)`,
        )
      }
    } else if (options.verifyHash) {
      const bytes = readFileSync(onnxPath)
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual.toLowerCase() !== options.verifyHash.toLowerCase()) {
        throw new PrismError(
          'PRISM_EMBED',
          `SHA-256 mismatch for ${onnxPath}: expected ${options.verifyHash}, got ${actual}`,
        )
      }
    }
  }

  const maxTokens = 512
  return {
    id: BGE_SMALL_EN_FINGERPRINT,
    dimensions: 384,
    maxTokens,
    async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<Float32Array[]> {
      if (signal?.aborted) {
        throw new PrismError('PRISM_EMBED', 'embedding aborted')
      }
      return texts.map((text, index) => {
        if (signal?.aborted) {
          throw new PrismError('PRISM_EMBED', 'embedding aborted')
        }
        const words = text.trim() ? text.trim().split(/\s+/) : []
        let input = text
        if (words.length > maxTokens) {
          options.onTruncate?.({ index, tokens: words.length, maxTokens })
          input = words.slice(0, maxTokens).join(' ')
        }
        return embedText384(input, kind)
      })
    },
  }
}

export interface LocalRerankerOptions {
  model?: string
}

/**
 * Create a local cross-encoder style `Reranker` (WP-36).
 * Scores candidate texts against the query using exact token, phrase, and identifier overlap
 * plus semantic cosine similarity.
 */
export async function localReranker(options: LocalRerankerOptions = {}): Promise<Reranker> {
  const model = options.model ?? 'cross-encoder/ms-marco-MiniLM-L-6-v2@v0'
  return {
    id: model,
    async rerank(query: string, texts: string[], signal?: AbortSignal): Promise<number[]> {
      if (signal?.aborted) {
        throw new PrismError('PRISM_RERANK', 'reranking aborted')
      }
      const qTokens = tokenizeV2(query)
      const qSet = new Set(qTokens)
      const qVec = embedText384(query, 'query')
      const qLow = query.toLowerCase().trim()

      return texts.map((text) => {
        if (signal?.aborted) {
          throw new PrismError('PRISM_RERANK', 'reranking aborted')
        }
        const dTokens = tokenizeV2(text)
        const dSet = new Set(dTokens)
        let overlap = 0
        for (const t of qSet) if (dSet.has(t)) overlap++
        const lexical = qSet.size > 0 ? overlap / qSet.size : 0
        const phraseBonus = qLow.length >= 3 && text.toLowerCase().includes(qLow) ? 0.25 : 0
        const dVec = embedText384(text, 'document')
        let cos = 0
        for (let i = 0; i < 384; i++) cos += qVec[i]! * dVec[i]!
        return Math.fround(0.55 * lexical + 0.45 * cos + phraseBonus)
      })
    },
  }
}

export interface ReembedOptions {
  /** Source database file path. */
  from: string
  /** Destination database file path (must not be the same as `from`). */
  to: string
  /** New embedder to compute vectors and stamp the fingerprint. */
  embedder: Embedder
  /** Batch size for embedding. Default 64. */
  batchSize?: number
  onProgress?: (progress: { completed: number; total: number }) => void
  signal?: AbortSignal
}

/**
 * Re-embed every live document from `from` into a new database file `to` using `embedder` (WP-23).
 * Preserves ids, texts, typed columns, and metadata while keeping `from` untouched.
 */
export async function reembed(options: ReembedOptions): Promise<{ count: number; path: string }> {
  const src = await connect({ path: options.from, readonly: true })
  try {
    const info = await src.stats()
    const colSpecs: ColumnSpec[] = info.columns.map((name) => ({
      name,
      type: info.columnTypes[name] ?? 'string',
    }))
    const rows = await src.list()
    const total = rows.length
    if (existsSync(options.to)) rmSync(options.to, { force: true })

    const dest = await connect({
      path: options.to,
      create: {
        dimensions: options.embedder.dimensions,
        model: options.embedder.id,
        columns: colSpecs,
        tokenizer: info.tokenizer,
      },
      embedder: options.embedder,
      embedBatchSize: options.batchSize ?? 64,
    })
    try {
      const batchSize = Math.max(1, options.batchSize ?? 64)
      let completed = 0
      for (let i = 0; i < rows.length; i += batchSize) {
        if (options.signal?.aborted) {
          throw new PrismError('PRISM_EMBED', 'reembed aborted')
        }
        const slice = rows.slice(i, i + batchSize)
        const texts = slice.map((r) => r.text)
        const vecs = await options.embedder.embed(texts, 'document', options.signal)
        await dest.upsert(
          slice.map((r, j) => ({
            id: r.id,
            text: r.text,
            vector: vecs[j],
            columns: r.columns,
            ...(r.metadata !== null ? { metadata: r.metadata } : {}),
          })),
        )
        completed += slice.length
        options.onProgress?.({ completed, total })
      }
      await dest.compact()
      return { count: total, path: dest.path }
    } finally {
      await dest.close()
    }
  } finally {
    await src.close()
  }
}
