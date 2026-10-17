/**
 * An error's words, cut into plain text and the https links in it, so a link a service wrote into a
 * refusal can be clicked: Account's "Add credits at https://account.jsprai.com/auth/account." is the
 * way to buy more, and as plain text it could only be copied out by hand. The punctuation that ends a
 * sentence is not part of the link. Only https, the only links main opens.
 */
export type Piece = { text: string; href?: undefined } | { text: string; href: string }

const LINK = /https:\/\/[^\s<>"'`]+/g
/** What a sentence puts after a link, which the link does not end with. */
const TRAILING = /[.,;:!?)\]}]+$/

export function linkPieces(text: string): Piece[] {
  const pieces: Piece[] = []
  let at = 0
  for (const match of text.matchAll(LINK)) {
    const href = match[0].replace(TRAILING, '')
    if (href.length <= 'https://'.length) continue
    const start = match.index
    if (start > at) pieces.push({ text: text.slice(at, start) })
    pieces.push({ text: href, href })
    at = start + href.length
  }
  if (at < text.length) pieces.push({ text: text.slice(at) })
  return pieces
}
