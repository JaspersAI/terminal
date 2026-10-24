// Tokenizers for BM25 keyword indexing and querying.
// Tokenization is part of the file format: stored postings only match queries tokenized the same
// way. A file records its tokenizer version ('v1' or 'v2'), and queries against it use that version.

export type TokenizerVersion = 'v1' | 'v2'

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'of',
  'at',
  'by',
  'for',
  'with',
  'about',
  'against',
  'between',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'to',
  'from',
  'up',
  'down',
  'in',
  'out',
  'on',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  'can',
  'will',
  'just',
  'should',
  'now',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'doing',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'it',
  'its',
  'they',
  'them',
  'their',
  'what',
  'which',
  'who',
  'whom',
  'this',
  'that',
  'these',
  'those',
  'am',
  'as',
  'would',
  'could',
  'also',
  'br',
])

/** Harman's "S" stemmer: strips simple English plurals. Frozen for format compatibility. */
function sStem(w: string): string {
  const n = w.length
  if (n > 4 && w.endsWith('ies') && !w.endsWith('eies') && !w.endsWith('aies')) {
    return `${w.slice(0, n - 3)}y`
  }
  if (n > 3 && w.endsWith('es') && !w.endsWith('aes') && !w.endsWith('ees') && !w.endsWith('oes')) {
    return w.slice(0, n - 1)
  }
  if (n > 3 && w.endsWith('s') && !w.endsWith('us') && !w.endsWith('ss')) {
    return w.slice(0, n - 1)
  }
  return w
}

/** v1 tokenizer: lowercase, split on non-alphanumerics, drop stopwords and 1-char tokens, strip plurals. */
export function tokenizeV1(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/[^\p{L}\p{N}]+/u)) {
    if ([...part].length < 2) continue
    const low = part.toLowerCase()
    if (STOPWORDS.has(low)) continue
    out.push(sStem(low))
  }
  return out
}

const PURE_ALPHA = /^[a-z]+$/

/**
 * v2 tokenizer for code, commands, paths, and logs (SPEC §7):
 * - Unicode NFKC normalization
 * - Split identifiers (camelCase, PascalCase, snake_case, kebab-case, dotted names, paths) while
 *   also indexing the whole compound token
 * - Keep numbers of 2+ characters, versions (v1.2.3), hex values (0x1f), and error codes (ECONNREFUSED, E0425, 503)
 * - Stem plurals only for purely alphabetic standalone words
 * - No stopwords dropped inside compound identifiers
 */
export function tokenizeV2(text: string): string[] {
  const norm = text.normalize('NFKC')
  const out: string[] = []
  const chunks = norm.split(/[^\p{L}\p{N}_./:-]+/u)
  for (const rawChunk of chunks) {
    const chunk = rawChunk.replace(/^[._/:-]+|[._/:-]+$/g, '')
    if (!chunk) continue
    const isCompound =
      /[_./:-]/.test(chunk) ||
      /[a-z][A-Z]/.test(chunk) ||
      /[A-Z]{2,}[a-z]/.test(chunk) ||
      (/[\p{L}]/u.test(chunk) && /\d/.test(chunk))

    if (isCompound) {
      const whole = chunk.toLowerCase()
      if ([...whole].length >= 2) out.push(whole)
      // Split on separators first, then camelCase / PascalCase / letter-digit transitions.
      const subparts = chunk
        .split(/[_./:-]+/)
        .flatMap((seg) =>
          seg
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .split(' '),
        )
        .filter(Boolean)
      for (const sub of subparts) {
        const low = sub.toLowerCase()
        if ([...low].length < 2) continue
        if (low !== whole) out.push(low)
      }
    } else {
      const low = chunk.toLowerCase()
      if ([...low].length < 2) continue
      if (STOPWORDS.has(low)) continue
      out.push(PURE_ALPHA.test(low) ? sStem(low) : low)
    }
  }
  return out
}

export function tokenize(text: string, version: TokenizerVersion = 'v2'): string[] {
  return version === 'v1' ? tokenizeV1(text) : tokenizeV2(text)
}
