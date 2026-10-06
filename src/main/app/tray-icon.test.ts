import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'
import { encodePng, markPixels } from './tray-icon.ts'

test('encodePng writes a PNG of the given size whose pixels inflate back to one filtered row per line', () => {
  const rgba = new Uint8Array(3 * 2 * 4).fill(255)
  const png = encodePng(3, 2, rgba)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.toString('ascii', 12, 16), 'IHDR')
  assert.equal(png.readUInt32BE(16), 3)
  assert.equal(png.readUInt32BE(20), 2)
  const idatAt = png.indexOf('IDAT')
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + png.readUInt32BE(idatAt - 4)))
  assert.equal(raw.length, 2 * (1 + 3 * 4))
  assert.equal(png.toString('ascii', png.length - 8, png.length - 4), 'IEND')
})

test('the template mark is black on transparent: clear corners, solid strokes, the logo crossing in the middle', () => {
  const size = 36
  const rgba = markPixels(size, 'template')
  const alpha = (x: number, y: number): number => rgba[(y * size + x) * 4 + 3]!
  assert.equal(alpha(0, 0), 0)
  assert.equal(alpha(size - 1, size - 1), 0)
  // Where the two arcs meet, just past the middle.
  assert.ok(alpha(18, 18) > 200)
  let colored = 0
  let inked = 0
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] !== 0 || rgba[i + 1] !== 0 || rgba[i + 2] !== 0) colored++
    if (rgba[i + 3]! > 128) inked++
  }
  assert.equal(colored, 0)
  assert.ok(inked > size * size * 0.08 && inked < size * size * 0.4, `${inked} inked pixels`)
})

test('the tile mark is the logo as it is: an opaque black square with the strokes in white', () => {
  const size = 32
  const rgba = markPixels(size, 'tile')
  assert.deepEqual([...rgba.subarray(0, 4)], [0, 0, 0, 255])
  let white = 0
  for (let i = 0; i < rgba.length; i += 4) {
    assert.equal(rgba[i + 3], 255)
    if (rgba[i]! > 200) white++
  }
  assert.ok(white > 20, `${white} white pixels`)
})
