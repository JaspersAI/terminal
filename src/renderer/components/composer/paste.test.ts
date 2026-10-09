import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pastedText, type PasteNode } from './paste.ts'

const t = (text: string): PasteNode => ({ nodeType: 3, nodeName: '#text', textContent: text, childNodes: [] })

function el(name: string, attrs: Record<string, string>, ...childNodes: PasteNode[]): PasteNode {
  return {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    get textContent() {
      return childNodes.map((child) => child.textContent ?? '').join('')
    },
    childNodes,
    getAttribute: (key) => attrs[key] ?? null,
  }
}

const a = (href: string, label: string): PasteNode => el('a', { href }, t(label))

test('a link over words keeps its address, as Markdown', () => {
  const body = el('body', {}, t('Read '), a('https://example.com/10-k', 'the filing'), t(' first.'))
  assert.equal(pastedText(body), 'Read [the filing](https://example.com/10-k) first.')
})

test('blocks and line breaks read as one line, scripts and styles as nothing', () => {
  const body = el(
    'body',
    {},
    el('style', {}, t('p { color: red }')),
    el('p', {}, t('One'), el('br', {}), t('two')),
    el('ul', {}, el('li', {}, a('https://a.example/x', 'three')), el('li', {}, t('four'))),
  )
  assert.equal(pastedText(body), 'One two [three](https://a.example/x) four')
})

test('nothing to keep leaves the paste to the field', () => {
  assert.equal(pastedText(el('body', {}, el('b', {}, t('bold')), t(' words'))), null)
  // Words that are the address already say it.
  assert.equal(pastedText(el('body', {}, a('https://example.com/', 'https://example.com'))), null)
  // Only web links are kept; any other is its words.
  assert.equal(pastedText(el('body', {}, a('javascript:alert(1)', 'click'), a('/relative', 'here'))), null)
})

test('an address among kept links stays the address; brackets and parentheses cannot end the link early', () => {
  const body = el(
    'body',
    {},
    a('https://example.com', 'https://example.com'),
    t(' and '),
    a('https://en.example.org/wiki/Foo_(bar)', 'a [draft]'),
  )
  assert.equal(pastedText(body), 'https://example.com and [a \\[draft\\]](https://en.example.org/wiki/Foo_%28bar%29)')
})
