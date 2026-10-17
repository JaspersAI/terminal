// What a paste into a request's field keeps. The field is one line of plain text, so a paste of rich
// text (a page, a mail, a document) arrives as its words alone, and a link written over words loses
// where it pointed: the request says "the filing" and nobody can tell which. When the clipboard's
// HTML holds such a link, the paste is its text with each link as Markdown, `[the filing](https://…)`,
// which the assistant reads as a link. Otherwise the field takes the paste as it always has.

import type { ClipboardEvent } from 'react'

/** The few parts of a parsed node this reads, so the reading runs in a test without a DOM. */
export interface PasteNode {
  nodeType: number
  nodeName: string
  textContent: string | null
  childNodes: ArrayLike<PasteNode>
  getAttribute?: (name: string) => string | null
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** Elements whose words are no part of what was copied. */
const SKIPPED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT'])
/** Elements that end a line where they close; the field is one line, so a space stands for it. */
const BLOCKS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BR',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
])

const WEB = /^https?:\/\//i

/**
 * The text a paste of `body` (the clipboard's HTML, parsed) puts in the field, its links written as
 * Markdown, or null when no link would lose its address, so the field pastes as it does on its own.
 * A link whose words are its address stays the address; one that is not a web link is its words.
 */
export function pastedText(body: PasteNode): string | null {
  let kept = false
  const parts: string[] = []

  function walk(node: PasteNode): void {
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.textContent ?? '')
      return
    }
    if (node.nodeType !== ELEMENT_NODE && node.nodeType !== 9 && node.nodeType !== 11) return
    const name = node.nodeName.toUpperCase()
    if (SKIPPED.has(name)) return
    if (name === 'A') {
      const href = node.getAttribute?.('href')?.trim() ?? ''
      const label = flat(node.textContent ?? '')
      if (WEB.test(href) && !/\s/.test(href)) {
        if (label === '' || label === href || label === href.replace(/\/$/, '')) parts.push(href)
        else {
          parts.push(`[${label.replace(/[[\]]/g, '\\$&')}](${href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`)
          kept = true
        }
        return
      }
    }
    const block = BLOCKS.has(name)
    if (block) parts.push(' ')
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i])
    if (block) parts.push(' ')
  }

  walk(body)
  return kept ? flat(parts.join('')) : null
}

/** Runs of white space, line breaks among them, as one space, as the one-line field would have it. */
function flat(text: string): string {
  return text.replace(/[\s\u00a0]+/g, ' ').trim()
}

/**
 * A request field's paste: rich text with links goes in as `pastedText`, where the selection is, as
 * typing would put it, so the field's own change and undo see it. Anything else is left to the field.
 */
export function pasteLinks(event: ClipboardEvent<HTMLInputElement>): void {
  const html = event.clipboardData.getData('text/html')
  if (!html) return
  const text = pastedText(new DOMParser().parseFromString(html, 'text/html').body)
  if (text === null) return
  event.preventDefault()
  // `insertText` is the edit a keystroke makes: it fires the input event React's `onChange` reads and
  // goes on the field's undo stack, which setting the value would not.
  if (!document.execCommand('insertText', false, text)) {
    const input = event.currentTarget
    input.setRangeText(
      text,
      input.selectionStart ?? input.value.length,
      input.selectionEnd ?? input.value.length,
      'end',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
}
