#!/usr/bin/env node
// Render the app mark to a PNG, at the sizes the shell actually uses.
//
//   npx tsx scripts/preview-mark.mjs
//
// WHY. The mark is rasterised by hand in `shared/mark.ts` for the tray and the
// window icon, and the only way to see that drawing is to launch the app and
// look at a 16px corner of the taskbar. That is a slow loop for a shape whose
// whole point is being legible small.
//
// This writes one sheet with every size on it, on a light strip and a dark one,
// because the tray's colour belongs to the user's theme and an icon that only
// works on one of them is half broken.
//
// The PNG encoder is here rather than from a package: PNG is a length, a type,
// the deflated scanlines and a CRC, and this is the only thing in the repo that
// needs to write one.

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { drawMark } from '../desktop/src/shared/mark.ts'
import { V1_ROOT, heading } from './lib/fetch-util.mjs'

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const PAD = 16
const STRIPS = [
  { label: 'light', rgb: [242, 242, 242] },
  { label: 'dark', rgb: [24, 24, 27] },
]

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** `rgba` is width*height*4, straight from `drawMark` or composited by hand. */
function encodePng(rgba, width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  // Every scanline is prefixed with filter type 0: no filtering. The image is
  // tiny and this is a debugging aid, not a shipped asset.
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1
    )
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Source-over, because the whole question is how the mark sits on a background. */
function composite(sheet, sheetW, mark, size, atX, atY) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4
      const a = mark[s + 3] / 255
      if (a === 0) continue
      const d = ((atY + y) * sheetW + (atX + x)) * 4
      for (let c = 0; c < 3; c++) {
        sheet[d + c] = Math.round(mark[s + c] * a + sheet[d + c] * (1 - a))
      }
      sheet[d + 3] = 255
    }
  }
}

const width = SIZES.reduce((n, s) => n + s + PAD, PAD)
const rowHeight = Math.max(...SIZES) + PAD * 2
const height = rowHeight * STRIPS.length
const sheet = new Uint8Array(width * height * 4)

STRIPS.forEach((strip, row) => {
  const top = row * rowHeight
  for (let y = top; y < top + rowHeight; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      sheet[i] = strip.rgb[0]
      sheet[i + 1] = strip.rgb[1]
      sheet[i + 2] = strip.rgb[2]
      sheet[i + 3] = 255
    }
  }

  let x = PAD
  for (const size of SIZES) {
    // Bottom-aligned, so the sizes read as a series rather than a scatter.
    composite(sheet, width, drawMark(size), size, x, top + rowHeight - PAD - size)
    x += size + PAD
  }
})

const out = path.join(V1_ROOT, 'desktop', 'out', 'mark.png')
writeFileSync(out, encodePng(sheet, width, height))

heading('App mark')
console.log(`  sizes  ${SIZES.join(', ')}`)
console.log(`  wrote  ${out}`)
