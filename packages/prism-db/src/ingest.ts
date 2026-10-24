// Ingestion helpers: token-aware chunking, transactional `indexSource` with content-hash
// deduplication, and a background ingestion queue (WP-37, SPEC §13).

import { createHash } from 'node:crypto'
import type { Connection } from './connection.ts'
import type { ColumnValue, Metadata } from './types.ts'

export interface ChunkOptions {
  /** Maximum tokens (words/identifiers) per chunk. Default 256. */
  maxTokens?: number
  /** Overlap tokens between consecutive chunks. Default 32. */
  overlap?: number
  /** Content format hint. Default `'text'`. */
  format?: 'text' | 'markdown' | 'code'
}

export interface TextChunk {
  index: number
  text: string
  tokens: number
}

function countTokens(text: string): number {
  const m = text.trim().match(/\S+/g)
  return m ? m.length : 0
}

/**
 * Split `text` into chunks of at most `maxTokens` tokens with `overlap` tokens of context,
 * respecting paragraph, markdown heading, or code block boundaries where possible.
 */
export function chunk(text: string, options: ChunkOptions = {}): TextChunk[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const maxTokens = Math.max(8, options.maxTokens ?? 256)
  const overlap = Math.max(0, Math.min(Math.floor(maxTokens / 2), options.overlap ?? 32))
  const format = options.format ?? 'text'

  const sep =
    format === 'markdown'
      ? /\n(?=#{1,6}\s)|\n\s*\n/
      : format === 'code'
        ? /\n(?=(?:export\s+|function\s+|class\s+|pub\s+|fn\s+|def\s+))|\n\s*\n/
        : /\n\s*\n/

  const blocks = trimmed
    .split(sep)
    .map((b) => b.trim())
    .filter(Boolean)

  const chunks: TextChunk[] = []

  const emitChunk = (words: string[]): void => {
    const content = words.join(' ').trim()
    if (!content) return
    chunks.push({ index: chunks.length, text: content, tokens: words.length })
  }

  let current: string[] = []
  for (const block of blocks) {
    const blockWords = block.split(/\s+/).filter(Boolean)
    if (current.length + blockWords.length <= maxTokens) {
      current.push(...blockWords)
      continue
    }
    if (current.length > 0) {
      emitChunk(current)
      current = overlap > 0 ? current.slice(-overlap) : []
    }
    if (blockWords.length <= maxTokens) {
      current.push(...blockWords)
    } else {
      const step = Math.max(1, maxTokens - overlap)
      for (let i = 0; i < blockWords.length; i += step) {
        const slice = blockWords.slice(i, i + maxTokens)
        if (i + maxTokens < blockWords.length) {
          emitChunk(slice)
        } else {
          current = slice
        }
        if (i + maxTokens >= blockWords.length) break
      }
    }
  }
  if (current.length > 0) emitChunk(current)
  return chunks.length > 0 ? chunks : [{ index: 0, text: trimmed, tokens: countTokens(trimmed) }]
}

export interface IndexSourceInput<M = Metadata> {
  /** Stable source identifier (stored in the `source` column and used as `<source>#<chunk>` id prefix). */
  source: string
  /** Full text of the source. Empty text deletes existing chunks for `source`. */
  text: string
  /** Filter column values to attach to every chunk (merged with `{ source }`). */
  columns?: Record<string, ColumnValue>
  /** Optional metadata to attach to every chunk. */
  metadata?: M
  /** Chunking options. */
  chunkOptions?: ChunkOptions
}

export interface IndexSourceResult {
  source: string
  chunks: number
  skipped: boolean
  hash: string
}

/**
 * Re-index a source in one atomic transaction (`deleteWhere({ source })` + `upsert(chunks)`).
 * Skips the write when the stored content hash (`metadata._sourceHash`) matches `text`.
 */
export async function indexSource<M extends Metadata = Metadata>(
  db: Connection<M>,
  input: IndexSourceInput<M>,
): Promise<IndexSourceResult> {
  const hash = createHash('sha256').update(input.text).digest('hex')
  const firstId = `${input.source}#0`
  const existing = await db.get(firstId)
  if (
    existing &&
    existing.metadata &&
    typeof existing.metadata === 'object' &&
    (existing.metadata as Record<string, unknown>)._sourceHash === hash
  ) {
    const existingCount = db.columns.includes('source') ? await db.count({ source: input.source }) : 1
    return { source: input.source, chunks: existingCount, skipped: true, hash }
  }

  const pieces = chunk(input.text, input.chunkOptions)
  if (pieces.length === 0) {
    if (db.columns.includes('source')) {
      await db.deleteWhere({ source: input.source })
    } else {
      await db.delete(firstId)
    }
    return { source: input.source, chunks: 0, skipped: false, hash }
  }

  const docs = pieces.map((c) => {
    const columns: Record<string, ColumnValue> = { ...input.columns }
    if (db.columns.includes('source')) columns.source = input.source
    const metadata = {
      ...(input.metadata ?? {}),
      _sourceHash: hash,
      _chunkIndex: c.index,
      _chunkCount: pieces.length,
    } as unknown as M
    return {
      id: `${input.source}#${c.index}`,
      text: c.text,
      columns,
      metadata,
    }
  })

  await db.transaction((tx) => {
    if (db.columns.includes('source')) {
      tx.deleteWhere({ source: input.source })
    }
    tx.upsert(docs)
  })

  return { source: input.source, chunks: docs.length, skipped: false, hash }
}

export interface IngestionProgress {
  completed: number
  pending: number
  lastSource: string
}

export interface IngestionQueueOptions {
  concurrency?: number
  onProgress?: (progress: IngestionProgress) => void
  onError?: (error: unknown, source: string) => void
}

export interface IngestionQueue<M extends Metadata = Metadata> {
  enqueue(item: IndexSourceInput<M>): void
  flush(): Promise<void>
  cancel(): void
  readonly pending: number
}

/**
 * Background ingestion queue with bounded concurrency, progress callbacks, and cancellation.
 */
export function createIngestionQueue<M extends Metadata = Metadata>(
  db: Connection<M>,
  options: IngestionQueueOptions = {},
): IngestionQueue<M> {
  const queue: IndexSourceInput<M>[] = []
  let active = 0
  let completed = 0
  const maxConcurrency = Math.max(1, options.concurrency ?? 1)
  const waiters: (() => void)[] = []

  const notifyIdle = (): void => {
    if (queue.length === 0 && active === 0) {
      for (const w of waiters.splice(0)) w()
    }
  }

  const pump = (): void => {
    while (active < maxConcurrency && queue.length > 0) {
      const item = queue.shift()!
      active++
      void indexSource(db, item)
        .then(() => {
          completed++
          options.onProgress?.({ completed, pending: queue.length + active - 1, lastSource: item.source })
        })
        .catch((err: unknown) => {
          options.onError?.(err, item.source)
        })
        .finally(() => {
          active--
          if (queue.length > 0) pump()
          else notifyIdle()
        })
    }
    notifyIdle()
  }

  const flush = (): Promise<void> => {
    if (queue.length === 0 && active === 0) return Promise.resolve()
    return new Promise<void>((resolve) => waiters.push(resolve))
  }

  return {
    enqueue(item) {
      // Replace any queued item for the same source so rapid edits coalesce
      const idx = queue.findIndex((q) => q.source === item.source)
      if (idx >= 0) queue[idx] = item
      else queue.push(item)
      pump()
    },
    flush,
    cancel() {
      queue.length = 0
      notifyIdle()
    },
    get pending() {
      return queue.length + active
    },
  }
}
