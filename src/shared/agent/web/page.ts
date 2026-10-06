import { Parser } from 'htmlparser2'

// A web page as text a model can read: what a documentation page says, without its scripts, styles,
// navigation, and chrome, blocks on lines of their own, a table a row to a line, and answered a window
// at a time. htmlparser2 reads the markup as it streams past, building no document. It knows where each
// element ends, so chrome is dropped whole however its divs nest, chrome marked only by its role too.

export const PAGE_LIMITS = {
  /** The most of a response that is read. */
  bytes: 2 * 1024 * 1024,
  /** How much is answered per call. */
  chars: 40_000,
}

/** Elements whose content is not the page's words. */
const DROPPED = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'template',
  'iframe',
  'nav',
  'header',
  'footer',
  'aside',
  'dialog',
  'select',
  'button',
])
/**
 * The same chrome built from divs, by the role it is given. `hidden` is not a sign of chrome: React's
 * streamed rendering parks late content in a hidden div until a script moves it into place.
 */
const DROPPED_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search'])
/** Elements that end a line. */
const BLOCKS = new Set([
  'p',
  'div',
  'br',
  'li',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'section',
  'article',
  'main',
  'blockquote',
  'dt',
  'dd',
  'hr',
  'form',
  'fieldset',
])

/** The page's title, then the text of its main element, or of the whole page when no main element has any. */
export function htmlToText(html: string): string {
  let title = ''
  const page: string[] = []
  const main: string[] = []
  // Preformatted blocks keep their line breaks; everything else is collapsed to one line per block.
  const pres: string[] = []
  let pre: string | null = null
  // What each open element began, so its close ends just that.
  const open: ('dropped' | 'main' | null)[] = []
  let dropped = 0
  let inMain = 0
  let inTitle = false
  // A block inside a cell is a space, so its row stays one line: filings wrap each figure in a div.
  let inCell = 0
  let cells = 0
  const emit = (text: string) => {
    page.push(text)
    if (inMain > 0) main.push(text)
  }
  const parser = new Parser({
    onopentag(name, attributes) {
      if (dropped > 0 || DROPPED.has(name) || DROPPED_ROLES.has(attributes.role ?? '')) {
        open.push('dropped')
        dropped++
        return
      }
      const isMain = name === 'main' || attributes.role === 'main'
      open.push(isMain ? 'main' : null)
      if (isMain) inMain++
      if (pre !== null) return
      if (name === 'title') inTitle = true
      else if (name === 'pre') pre = ''
      else if (name === 'td' || name === 'th') {
        if (cells++ > 0) emit(' | ')
        inCell++
      } else if (name === 'tr') {
        cells = 0
        emit('\n')
      } else if (BLOCKS.has(name)) emit(inCell > 0 ? ' ' : '\n')
    },
    ontext(text) {
      if (dropped > 0) return
      if (pre !== null) pre += text
      else if (inTitle) title += text
      else emit(text.replace(/\s+/g, ' '))
    },
    onclosetag(name) {
      const began = open.pop()
      if (began === 'dropped') {
        dropped--
        return
      }
      if (began === 'main') inMain--
      if (pre !== null) {
        if (name !== 'pre') return
        pres.push(pre)
        pre = null
        emit(`\n\u0000${pres.length - 1}\u0000\n`)
      } else if (name === 'title') inTitle = false
      else if (name === 'td' || name === 'th') inCell--
      else if (name === 'tr') emit('\n')
      else if (BLOCKS.has(name)) emit(inCell > 0 ? ' ' : '\n')
    },
  })
  parser.end(html)
  const mainText = main.join('')
  return [title, ...(mainText.trim() ? mainText : page.join('')).split('\n')]
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '' && !/^\|( \|)*$/.test(line))
    .map((line) => line.replace(/^\u0000(\d+)\u0000$/, (_whole, index: string) => pres[Number(index)] ?? ''))
    .join('\n')
}

/** Less text than this, from a page that runs scripts, and its words are taken to be the scripts' to write. */
const THIN = 1_000

/**
 * Whether a page's words are written in the browser by its scripts, which nothing here runs. A
 * documentation site built as one JavaScript app answers every address with the same empty frame, so
 * reading another of its pages gets nothing more: Databento's, Tiingo's, Polygon's, and Tradier's read
 * this way, at 27 to 474 characters, where a page with its words in it gives thousands. A page short in
 * a browser too is called drawn as well, which costs a model one look elsewhere.
 */
export function drawnByScript(html: string, text: string): boolean {
  return text.length < THIN && /<script\b/i.test(html)
}

export interface Slice {
  text: string
  from: number
  to: number
  length: number
  /** Where the next window starts, or null when this one reaches the end. */
  next: number | null
}

export function slice(text: string, offset: number): Slice {
  const from = Math.max(0, Math.min(Math.floor(offset), text.length))
  const to = Math.min(text.length, from + PAGE_LIMITS.chars)
  return { text: text.slice(from, to), from, to, length: text.length, next: to < text.length ? to : null }
}
