import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HUB_API,
  archiveAddress,
  hubFindings,
  hubSource,
  hubUrl,
  isHandle,
  readClaimed,
  readItemInfo,
  readItemList,
  readMe,
  readPublished,
} from './hub.ts'

/** One item as `GET /v1/items?kind=plugin` answered it on 2026-10-05, with the featured mark Hub adds. */
const SEC = {
  handle: 'jaspers',
  name: 'sec',
  kind: 'plugin',
  official: true,
  version: '1.0.0',
  reviewed: true,
  title: 'SEC EDGAR Filings, Facts, and Insider Forms',
  description:
    "Gets one company's SEC filings, XBRL reported figures, insider forms 3/4/5, and filer profile from SEC EDGAR by ticker or CIK. No key needed.",
  tags: ['sec', 'edgar', 'filings', 'xbrl', 'fundamentals', 'insider-trading', 'free-data'],
  stars: 0,
  downloads: 1,
  updatedAt: '2026-10-05T10:24:51.758Z',
  page: 'https://hub.jsprai.com/jaspers/sec',
  featured: true,
}

test("a listing is read in Hub's own shape, and says whether there is more", () => {
  const read = readItemList({ items: [SEC], page: 1, more: true, semantic: false })
  assert.equal(read.more, true)
  assert.deepEqual(read.items, [
    {
      handle: 'jaspers',
      name: 'sec',
      kind: 'plugin',
      official: true,
      featured: true,
      version: '1.0.0',
      reviewed: true,
      title: 'SEC EDGAR Filings, Facts, and Insider Forms',
      description: SEC.description,
      tags: SEC.tags,
      stars: 0,
      downloads: 1,
      page: 'https://hub.jsprai.com/jaspers/sec',
    },
  ])
  assert.equal(readItemList({ items: [] }).more, false)
})

test('an item without the featured mark, as a Hub from before it answers, is not featured', () => {
  const { featured: _featured, ...unmarked } = SEC
  assert.equal(readItemList({ items: [unmarked], more: false }).items[0]!.featured, false)
})

test('an item that is not the shape is dropped, and the rest are read', () => {
  const bad = [
    null,
    'sec',
    { ...SEC, name: 'Sec' },
    { ...SEC, name: '../sec' },
    { ...SEC, handle: '-x' },
    { ...SEC, kind: 'theme' },
    { ...SEC, official: 'yes' },
    { ...SEC, stars: -1 },
    { ...SEC, tags: 'sec' },
    { ...SEC, page: undefined },
  ]
  assert.deepEqual(
    readItemList({ items: [...bad, { ...SEC, name: 'fred' }] }).items.map((item) => item.name),
    ['fred'],
  )
})

test('an answer that is not a list of items is an error', () => {
  for (const body of [null, [], 'items', { items: 'none' }, { more: true }]) {
    assert.throws(() => readItemList(body), /Hub answered something that is not a list of items\./)
  }
})

test("an item's own answer says who published it, what its archive serves, and where its page is", () => {
  const item = {
    handle: 'jaspers',
    name: 'sec',
    kind: 'plugin',
    official: true,
    stars: 0,
    downloads: 1,
    listed: '1.0.0',
    shown: { handle: 'jaspers', name: 'sec', version: '1.0.0', state: 'approved', sha256: 'ab' },
    versions: [],
    page: 'https://hub.jsprai.com/jaspers/sec',
    archive: 'https://hub-api.jsprai.com/v1/items/jaspers/sec/archive',
  }
  assert.deepEqual(readItemInfo(item), {
    official: true,
    shown: { version: '1.0.0', state: 'approved' },
    page: 'https://hub.jsprai.com/jaspers/sec',
  })
  assert.equal(readItemInfo({ ...item, shown: null }).shown, null)
  for (const body of [
    null,
    { ...item, official: 'yes' },
    { ...item, shown: { version: '1.0.0', state: 'rejected' } },
  ]) {
    assert.throws(() => readItemInfo(body), /Hub answered something that is not an item\./)
  }
})

test("an item's page on the web and its archive on the API are Hub links", () => {
  for (const text of [
    'https://hub.jsprai.com/jaspers/sec',
    'https://hub.jsprai.com/jaspers/sec/',
    'https://hub.jsprai.com/jaspers/sec?tab=files',
    'https://hub.jsprai.com/jaspers/sec#readme',
    'https://hub-api.jsprai.com/v1/items/jaspers/sec/archive',
  ]) {
    assert.deepEqual(hubSource(new URL(text)), { handle: 'jaspers', name: 'sec' }, text)
  }
})

test('anything else is not a Hub link', () => {
  for (const text of [
    'http://hub.jsprai.com/jaspers/sec',
    'https://hub.example.com/jaspers/sec',
    'https://github.com/jaspers/sec',
    'https://hub.jsprai.com/jaspers',
    'https://hub.jsprai.com/jaspers/sec/versions',
    'https://hub.jsprai.com/jaspers/Sec',
    'https://hub.jsprai.com/-x/sec',
    'https://me:pw@hub.jsprai.com/jaspers/sec',
    'https://hub-api.jsprai.com/v1/items/acme',
    'https://hub-api.jsprai.com/v1/items/acme/sec',
    'https://hub-api.jsprai.com/v2/items/acme/sec/archive',
    'https://hub-api.jsprai.com/v1/items/acme/sec/versions/1.0.0/archive',
    'https://hub-api.jsprai.com/v1/items/acme/Sec/archive',
  ]) {
    assert.equal(hubSource(new URL(text)), null, text)
  }
})

test('a handle is lower-case letters, digits, and hyphens, starting with a letter or a digit, at most 39', () => {
  assert.equal(isHandle('jaspers'), true)
  assert.equal(isHandle('acme-2'), true)
  assert.equal(isHandle('a'.repeat(39)), true)
  assert.equal(isHandle('-x'), false)
  assert.equal(isHandle('Acme'), false)
  assert.equal(isHandle('a'.repeat(40)), false)
  assert.equal(isHandle(''), false)
})

test("an item's archive is at its address on the API", () => {
  assert.equal(archiveAddress(HUB_API, 'jaspers', 'sec'), 'https://hub-api.jsprai.com/v1/items/jaspers/sec/archive')
  assert.equal(
    archiveAddress('http://localhost:3400/v1', 'acme', 'demo'),
    'http://localhost:3400/v1/items/acme/demo/archive',
  )
})

test('Hub is the public one unless the environment names another, without a trailing slash', () => {
  assert.equal(hubUrl(undefined), HUB_API)
  assert.equal(hubUrl(''), HUB_API)
  assert.equal(hubUrl('  '), HUB_API)
  assert.equal(hubUrl('http://localhost:3400/v1/'), 'http://localhost:3400/v1')
  assert.equal(hubUrl(' https://hub-api.test.jsprai.com/v1 '), 'https://hub-api.test.jsprai.com/v1')
})

test('an override of Hub that is not an http(s) URL is refused, not fallen back from', () => {
  assert.throws(() => hubUrl('hub-api.jsprai.com/v1'), /JASPERS_HUB_URL is not a URL/)
  assert.throws(() => hubUrl('ftp://hub-api.jsprai.com/v1'), /JASPERS_HUB_URL is not http or https/)
})

test("what Hub holds of the caller: the handle, and each item's versions and how its review stands", () => {
  const version = {
    version: '1.1.0',
    state: 'rejected',
    note: 'It writes outside its folder.',
    analysis: 'done',
    createdAt: '2026-10-05T07:00:40.019Z',
  }
  const item = { handle: 'acme', name: 'demo', kind: 'plugin', listed: '1.0.0', versions: [version] }
  assert.deepEqual(readMe({ handle: 'acme', items: [item], starred: [] }), { handle: 'acme', items: [item] })
  assert.deepEqual(readMe({ handle: null, items: [], starred: [] }), { handle: null, items: [] })
  // What is not the shape is left out, item by item and version by version.
  assert.deepEqual(
    readMe({
      handle: 'acme',
      items: [{ ...item, versions: [version, { ...version, version: 7 }] }, { ...item, kind: 'theme' }, null],
    }).items,
    [item],
  )
  for (const body of [null, { handle: 'acme' }, { handle: 7, items: [] }, { handle: 'Not A Handle', items: [] }]) {
    assert.throws(() => readMe(body), /Hub answered something that is not/)
  }
})

test('a version published says where it went, and a handle claimed is the handle', () => {
  const published = {
    handle: 'acme',
    name: 'demo',
    kind: 'plugin',
    version: '1.0.0',
    state: 'pending',
    sha256: 'ab',
    size: 3,
    page: 'https://hub.jsprai.com/acme/demo',
    archive: 'https://hub-api.jsprai.com/v1/items/acme/demo/archive',
  }
  assert.deepEqual(readPublished(published), {
    handle: 'acme',
    name: 'demo',
    version: '1.0.0',
    page: 'https://hub.jsprai.com/acme/demo',
  })
  assert.throws(() => readPublished({ ...published, version: 1 }), /not a version published/)
  assert.throws(() => readPublished(null), /not a version published/)
  assert.equal(readClaimed({ handle: 'acme' }), 'acme')
  assert.throws(() => readClaimed({ handle: 'Acme' }), /not a handle/)
})

test('what a search found is told to the model by id, title, publisher, review, and what it does', () => {
  const { items } = readItemList({
    items: [
      SEC,
      { ...SEC, handle: 'someone', name: 'edgar-lite', official: false, reviewed: false, title: 'EDGAR lite' },
    ],
    more: false,
  })
  const told = hubFindings('sec filings', items, ['sec'])
  assert.equal(
    told,
    [
      `Jaspers Hub's plugins for "sec filings", best first:`,
      `- sec: SEC EDGAR Filings, Facts, and Insider Forms (by jaspers, official; v1.0.0, reviewed; already installed). ${SEC.description} https://hub.jsprai.com/jaspers/sec`,
      `- edgar-lite: EDGAR lite (by someone; v1.0.0, not reviewed yet). ${SEC.description} https://hub.jsprai.com/jaspers/sec`,
    ].join('\n'),
  )
})

test('a search that found no plugin says Hub has none, so the model may build one', () => {
  assert.equal(hubFindings('weather', []), 'Jaspers Hub has no plugin for "weather".')
  const { items } = readItemList({ items: [{ ...SEC, kind: 'skill' }], more: false })
  assert.equal(hubFindings('sec', items), 'Jaspers Hub has no plugin for "sec".')
})
