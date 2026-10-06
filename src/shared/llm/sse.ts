// Server-sent events, the part that is only string handling. All three model providers stream in
// this format, so the framing is written once here and tested here; the fetch and the reader that
// feed it are in main's http.ts, which is where the network belongs.
//
// No Node and no DOM.

/**
 * Whole frames out of what has arrived so far, and whatever is left over to keep for the next chunk.
 *
 * A frame ends at a blank line. Its `data:` lines join with newlines, as the format says, and every
 * other field (`event:`, `id:`, `retry:`, a `:` comment) is ignored: each provider repeats the event
 * name inside the JSON, so nothing here needs to read the envelope. A frame with no data at all is
 * a keep-alive and yields nothing.
 */
export function sseFrames(buffer: string): { data: string[]; rest: string } {
  // A CRLF split across two chunks leaves a stray \r at the end of a line, which the trim below takes.
  const text = buffer.replace(/\r\n/g, '\n')
  const data: string[] = []
  let rest = text
  for (;;) {
    const end = rest.indexOf('\n\n')
    if (end === -1) break
    const frame = dataOf(rest.slice(0, end))
    rest = rest.slice(end + 2)
    if (frame !== null) data.push(frame)
  }
  return { data, rest }
}

/** The last frame, when the stream ended without the blank line that would have closed it. */
export function sseTail(buffer: string): string | null {
  return dataOf(buffer.replace(/\r\n/g, '\n'))
}

/** `data: {…}` is the payload; one space after the colon is part of the format and not of the value. */
function dataOf(frame: string): string | null {
  const parts: string[] = []
  for (const line of frame.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    if (!trimmed.startsWith('data:')) continue
    parts.push(trimmed.slice(5).replace(/^ /, ''))
  }
  return parts.length ? parts.join('\n') : null
}

/** The line that says a stream is over, which Chat Completions sends and the other two do not. */
export const SSE_DONE = '[DONE]'
