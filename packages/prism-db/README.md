# prism-db (v0 — 0.2.0)

An embedded retrieval database for Node.js and Electron. Everything that passes through the harness (messages, tool output, files, commands, notes, web pages) is stored locally in **one file** and found again by meaning, by keywords (BM25) and by typed filters, **exact by default**, on macOS, Linux and Windows, with a local embedding model and no server.

```ts
import { connect, localEmbedder } from 'prism-db'

const embedder = await localEmbedder({ model: 'bge-small-en-v1.5' })
const db = await connect({
  path: 'memory.prism',
  create: {
    columns: ['source', 'kind', 'session', 'project', 'role', { name: 'createdAt', type: 'time' }],
  },
  embedder,
})

await db.upsert([
  {
    id: 'todo.md#0',
    text: 'Renew the TLS certificate before Friday',
    columns: { source: 'todo.md', kind: 'note', createdAt: new Date() },
  },
])

const hits = await db.search({
  text: 'certificate expiry',
  where: { kind: ['note', 'message'], createdAt: { gte: Date.now() - 7 * 86_400_000 } },
  recency: { column: 'createdAt', halfLife: 3 * 86_400_000, weight: 0.15 },
  limit: 5,
})

await db.close()
```

## Features in v0 (`0.2.0`)

- **Exact single-pass hybrid search:** vector cosine similarity, normalized BM25 (`k1 = 0.9`, `b = 0.4`), and exponential recency decay are blended linearly in one pass using certified int8 upper bounds with dimension-aware rounding slack up to 65,536 dimensions.
- **Typed columns and zone maps:** `'string'` (default), `'time'` (UTC epoch ms, accepting `Date`, `number`, or ISO-8601 string), and `'int'` (64-bit signed integer, accepting `number` or `bigint`). Range filters (`gt`, `gte`, `lt`, `lte`, SQL `<`, `<=`, `>`, `>=`, `BETWEEN`) skip non-matching blocks and segments using per-block min/max zone maps.
- **Latest-N ordered listing:** `db.list({ where, orderBy: { createdAt: 'desc' }, limit: 50 })` and SQL `ORDER BY createdAt DESC LIMIT 50` with early termination over block zone maps.
- **Code-aware Tokenizer v2:** Unicode NFKC normalization, splitting `camelCase`, `PascalCase`, `snake_case`, `kebab-case`, dotted names, and file paths while also indexing the whole compound token, preserving numbers, versions, hex literals, and error codes (`ECONNREFUSED`, `E0425`, `0x1f`, `503`).
- **One embedding model per database:** `Embedder` interface with verified model fingerprints (`BAAI/bge-small-en-v1.5@v0/cls/l2/q1`), `localEmbedder({ model: 'bge-small-en-v1.5' })`, and `reembed()` for model migration.
- **Two-stage retrieval:** pluggable `Reranker` (`connect({ reranker })`, `search({ rerank: 50 })`, SQL `LIMIT 10 RERANK 50`, and `localReranker()`).
- **Crash-safe single-file format v2 (with v1 backward compatibility):** double checksummed 4 KiB header slots, page-aligned segments and manifests, `0600` file permissions on Unix, Windows rename-aside compaction and recovery, explicit `upgrade()`, and online `backup(destPath)`.
- **Ingestion helpers:** `chunk()`, transactional `indexSource()` with content-hash deduplication, and `createIngestionQueue()`.
- **Electron IPC helpers:** `prism-db/electron` (`serveToRenderer`, read-only by default) and `prism-db/electron-preload` (`createRendererClient`).

## Error codes

| Code | When |
| --- | --- |
| `PRISM_NOT_FOUND` | No file at `path`, and no `create` option. |
| `PRISM_LOCKED` | Another process has the file open for writing. |
| `PRISM_BUSY` | Another program holds the file in a way that blocks file replacement; nothing changed, retryable. |
| `PRISM_SCHEMA` | The file exists with different `dimensions`, `columns`, or `model` fingerprint. |
| `PRISM_INVALID` | Bad input: wrong vector length, empty id, unknown column, invalid range or option. |
| `PRISM_DUPLICATE` | `insert` (or SQL `INSERT`) of an id that already exists. |
| `PRISM_SQL` | A SQL statement that does not parse, or names an unknown table or column (`error.position`). |
| `PRISM_EMBED` | The `embed` function or `Embedder` failed or returned bad vectors. |
| `PRISM_RERANK` | The `Reranker` failed or returned invalid scores. |
| `PRISM_READONLY` | A write on a read-only connection or read-only SQL query. |
| `PRISM_CLOSED` | The connection was closed. |
| `PRISM_CORRUPT` | The file is damaged or is not a Prism database. |
| `PRISM_POISONED` | A write failed partway through after the first sync; reconnect before writing again. |
| `PRISM_IO` | An operating-system I/O error (disk full, permissions, ...). |
| `PRISM_EXISTS` | Destination file already exists (`backup()`). |
| `PRISM_NATIVE` | The native module could not be loaded. |
