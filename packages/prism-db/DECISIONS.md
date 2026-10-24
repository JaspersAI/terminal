# Prism DB Decisions

- **D-001 (Certified int8 scan over semantic blocks):** Search scans compact int8 codes with a deterministic error bound over blocks of at most 256 documents in spherical k-means semantic order, rescoring in full precision only candidates whose upper bound exceeds the current top-k threshold.
- **D-002 (No ANN graph index in v0):** Exact single-pass search is the default; approximate search uses `probe` mode over block centroids.
- **D-003 (Convex combination in one pass):** Vector cosine, normalized BM25 (`BM25 / BM25_max`), and exponential recency (`2^(-age / halfLife)`) are combined linearly in a single pass with an exact upper bound.
- **D-004 (Two-stage retrieval):** Stage 1 returns the exact hybrid top N; Stage 2 optionally reorders those N candidates with a `Reranker` (`search({ rerank })` or SQL `RERANK`).
- **D-005 (One embedding model per database):** Files record the model fingerprint (`BAAI/bge-small-en-v1.5@v0/cls/l2/q1`); connecting with a mismatched `Embedder` fails with `PRISM_SCHEMA`.
- **D-006 (Local-first):** One file per user profile (`~/Jaspers/data/memory.prism`), `0600` permissions on Unix, local `bge-small-en-v1.5` embedding without network calls, and background non-blocking ingestion.
- **D-007 & D-008 (TypeScript integration surface across macOS, Linux, and Windows):** `packages/prism-db` provides the `.prism` v1/v2 binary storage and exact search engine in Node.js/TypeScript alongside N-API prebuild loading, running identically across macOS, Linux, and Windows in Node 24 and Electron without native rebuild steps.
- **D-013 (Format v2 with v1 compatibility):** New files use format v2 (typed columns with zone maps, tokenizer version, model fingerprint); v1 files remain readable and writable in v1 until `upgrade()`.
