// The judge's answer, read strictly: an object with a boolean `pass`, a non-empty list of string
// `reasons`, and a string `evidence`. Anything else is no verdict, and a scenario without one fails.

export interface Verdict {
  pass: boolean
  reasons: string[]
  evidence: string
}

export type Parsed = { ok: true; verdict: Verdict } | { ok: false; error: string }

/** Reads a verdict out of the judge's reply: bare JSON, JSON in a code fence, or one object amid words. */
export function parseVerdict(reply: string): Parsed {
  const candidates = [reply.trim()]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply)
  if (fenced) candidates.push(fenced[1]!.trim())
  const first = reply.indexOf('{')
  const last = reply.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(reply.slice(first, last + 1))
  let error = 'no JSON object in the reply'
  for (const candidate of candidates) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    const checked = checkVerdict(value)
    if (checked.ok) return checked
    error = checked.error
  }
  return { ok: false, error }
}

function checkVerdict(value: unknown): Parsed {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'not an object' }
  const v = value as Record<string, unknown>
  if (typeof v['pass'] !== 'boolean') return { ok: false, error: 'pass must be true or false' }
  const reasons = v['reasons']
  if (!Array.isArray(reasons) || reasons.length === 0 || !reasons.every((r) => typeof r === 'string'))
    return { ok: false, error: 'reasons must be a non-empty list of strings' }
  const evidence = v['evidence']
  if (typeof evidence !== 'string') return { ok: false, error: 'evidence must be a string' }
  return { ok: true, verdict: { pass: v['pass'], reasons: reasons as string[], evidence } }
}
