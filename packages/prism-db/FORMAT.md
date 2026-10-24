# The `.prism` file format (versions 1 and 2)

One database is one file.

| File | Purpose |
| --- | --- |
| `name.prism` | The database: documents, vectors, text, filter columns, zone maps, and BM25 postings. Created with mode `0600` on macOS and Linux. |
| `name.prism.lock` | Exclusive writer lock file holding the owning process PID and timestamp. Stale locks from a dead (`SIGKILL`ed) writer process are reclaimed automatically on open. |
| `name.prism.compact-tmp` | Temporary file written and synced during compaction or `upgrade()`. |
| `name.prism.old-<seq>` | Windows rename-aside target during file replacement. If `name.prism` is missing on open after an interrupted replacement, a valid `.compact-tmp` or newest `.old-<seq>` is restored before checking whether the file exists. |

All integers are little-endian.

## Layout

```text
offset 0      header slot A   (48 bytes used, one 4 KiB page)
offset 4096   header slot B   (48 bytes used, one 4 KiB page)
offset 8192   records, each starting on a 4 KiB boundary: segments and manifests
```

- **Header slot** (48 bytes): magic `PRISMDB\x01` · format version `u32` (`1` or `2`) · `seq u64` · `manifest_off u64` · `manifest_len u64` · `committed_end u64` · CRC-32 of the first 44 bytes.
- **Record header** (64 bytes): magic `PRSMREC\x01` · kind `u32` (`1` = segment, `2` = manifest) · reserved `u32` · `body_len u64` · `meta_len u64` · `meta_crc u32` · CRC-32 of the first 36 bytes · zero padding.
- **Manifest** (JSON): `format` (`1` or `2`), `seq`, `schema` (`dim`, `model`, `columns`, and in v2 `columnTypes: Record<string, 'string' | 'time' | 'int'>` and `tokenizer: 'v1' | 'v2'`), `segments` (`id`, `offset`, `len`, `n_docs`, `clustered`, `deleted` as `[start, count]` runs), `next_segment_id`.
- **Segment** (`PRSMSEG\x01`): 64-byte fixed header, 32-byte section table entries (`kind`, `col`, `off`, `len`, `crc`), then 64-byte-aligned sections:
  - `1–2`: `ids` (`u64` offsets + UTF-8 bytes)
  - `3`: `blocks` (`[start, end)` `u32` pairs, at most 256 documents per block)
  - `4–5`: block centroids (`f32`) and centroid norms (`f32`)
  - `6`: unit-length vectors (`f32`, `n × dim`)
  - `7–9`: int8 codes (`n × dim`), per-vector scale (`f32`) and residual error bound (`f32`)
  - `10–13`: `text` and `meta` (`u64` offsets + UTF-8 bytes)
  - `14–20`: BM25 sorted term dictionary, document frequency, posting pointers, posting doc positions, term frequencies (`u16`), and document lengths (`u32`)
  - `21`: positions sorted by `id` (`u32`) for binary-search lookups
  - `22–26` (per column): sorted value dictionary, per-document `u32` code, per-block distinct codes
  - `27` (v2 typed columns `'time'` and `'int'`): `n` signed 64-bit integers (`i64`) followed by `n` validity bytes (`1` = value, `0` = null)
  - `28` (v2 typed columns `'time'` and `'int'`): `(nb + 1)` 24-byte zone map entries (`min i64`, `max i64`, `flags u32` bit 0 = hasValue, bit 1 = hasNull, `pad u32`) for each block plus the segment-wide zone map at index `nb`

## Version compatibility

- Readers accept format versions `1` and `2`.
- Writers keep an existing file in its format version; a v1 file stays v1 until `upgrade()` is called explicitly.
- A file with a checksum-valid header slot of a newer version `N > 2` is refused with `"the file was written in format version N; this build reads versions 1..=2"`.
