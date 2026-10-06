import { crc32, deflateSync } from 'node:zlib'

// The menu bar icon, drawn from the logo's geometry rather than shipped as an image: two arcs crossing,
// as in src/renderer/assets/jaspers-logo-black.png, measured in that image's pixels (1434 × 1416). The
// strokes are drawn a little heavier than the logo's, since at 16 px its own weight is under a pixel.
// No Electron here, so a test can read the pixels.

/** Each arc: its circle, and the part of the plane its flat ends cut it to. */
const ARCS = [
  { cx: 396, cy: 390, r: 604, keep: (x: number, y: number): boolean => x >= 396 && y >= 390 },
  { cx: 1221, cy: 1222, r: 508, keep: (x: number, y: number): boolean => x <= 1237 && y <= 1225 },
]

/** The mark's bounds in the logo, squared around its middle. */
const BOX = { x: 394, y: 385, size: 845 }

/** Samples per pixel along each axis, for smooth edges. */
const SAMPLES = 4

/** template: black on transparent, for a macOS menu bar, which colors it. tile: the logo itself, white strokes on a black square. */
export type MarkStyle = 'template' | 'tile'

/** The mark as RGBA pixels, `size` by `size`. */
export function markPixels(size: number, style: MarkStyle): Uint8Array {
  const rgba = new Uint8Array(size * size * 4)
  // The template fills the icon, a pixel in from each edge; the tile keeps the logo's margin around the mark.
  const glyph = style === 'template' ? size - 2 : size * 0.62
  const scale = glyph / BOX.size
  const offset = (size - glyph) / 2
  const halfStroke = (style === 'template' ? size / 11 : size / 12) / scale / 2
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = BOX.x + (px + (sx + 0.5) / SAMPLES - offset) / scale
          const y = BOX.y + (py + (sy + 0.5) / SAMPLES - offset) / scale
          if (ARCS.some((arc) => arc.keep(x, y) && Math.abs(Math.hypot(x - arc.cx, y - arc.cy) - arc.r) <= halfStroke))
            hits++
        }
      }
      const coverage = Math.round((hits / (SAMPLES * SAMPLES)) * 255)
      const i = (py * size + px) * 4
      if (style === 'template') {
        rgba[i + 3] = coverage
      } else {
        rgba[i] = coverage
        rgba[i + 1] = coverage
        rgba[i + 2] = coverage
        rgba[i + 3] = 255
      }
    }
  }
  return rgba
}

/** RGBA pixels as a PNG: 8-bit color with alpha, every row unfiltered. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
