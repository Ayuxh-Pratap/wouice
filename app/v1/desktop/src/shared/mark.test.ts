import { describe, expect, it } from 'vitest'
import { MARK_ART_SCALE, MARK_BARS, MARK_VIEWBOX, drawMark } from './mark.js'

/** Alpha of one pixel, 0-255. */
function alphaAt(pixels: Uint8Array, size: number, x: number, y: number): number {
  return pixels[(y * size + x) * 4 + 3]!
}

/** How white a pixel is. The bars are near-white; the plate is mid to dark grey. */
function brightness(pixels: Uint8Array, size: number, x: number, y: number): number {
  const i = (y * size + x) * 4
  return (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3
}

describe('the app mark', () => {
  it('is symmetric, because the logo is', () => {
    // Not decoration: the tray icon is drawn independently of the sidebar's SVG,
    // and a lopsided rasteriser would be invisible at 16px and obvious at 256.
    const size = 64
    const pixels = drawMark(size)
    for (let y = 0; y < size; y += 7) {
      for (let x = 0; x < size / 2; x++) {
        expect(alphaAt(pixels, size, x, y)).toBe(alphaAt(pixels, size, size - 1 - x, y))
      }
    }
  })

  it('puts the tallest bar in the middle', () => {
    const size = 96
    const pixels = drawMark(size)
    const scale = size / MARK_VIEWBOX
    const centreX = Math.round((MARK_BARS[2]?.x ?? 12) * scale)
    const outerX = Math.round((MARK_BARS[0]?.x ?? 3.5) * scale)

    // A row inside the tall centre bar but clear of the short outer ones.
    // Derived from the art scale rather than a fixed offset: the bars are drawn
    // smaller than the grid so they sit inside the plate's padding, and a
    // hardcoded row silently walks off the top of the bar when that changes.
    const centreHalf = (MARK_BARS[2]?.half ?? 8) * MARK_ART_SCALE
    const y = Math.round((MARK_VIEWBOX / 2 - centreHalf * 0.6) * scale)
    expect(brightness(pixels, size, centreX, y)).toBeGreaterThan(200)
    expect(brightness(pixels, size, outerX, y)).toBeLessThan(150)
  })

  it('is opaque in the middle and clear at the corners', () => {
    // The plate is a rounded square, so the very corner has to be transparent
    // or the icon reads as a hard tile against the taskbar.
    const size = 64
    const pixels = drawMark(size)
    expect(alphaAt(pixels, size, size / 2, size / 2)).toBe(255)
    expect(alphaAt(pixels, size, 0, 0)).toBe(0)
    expect(alphaAt(pixels, size, size - 1, size - 1)).toBe(0)
  })

  it('anti-aliases rather than stepping', () => {
    // Somewhere down the left edge of the plate there must be a partly covered
    // pixel. Without one, every curve in the mark is a staircase at 16px.
    const size = 64
    const pixels = drawMark(size)
    let partial = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = alphaAt(pixels, size, x, y)
        if (a > 0 && a < 255) partial++
      }
    }
    expect(partial).toBeGreaterThan(size)
  })

  it('draws at any size the shell asks for, tray included', () => {
    for (const size of [16, 24, 32, 256]) {
      const pixels = drawMark(size)
      expect(pixels).toHaveLength(size * size * 4)

      // The bars have to stand off the plate at every size, and at 16px that is
      // the whole question: the centre bar is 1.6px wide there and lands
      // wherever the grid happens to put it, so no single coordinate is a
      // reliable probe. The brightest pixel in the middle row is a bar; the
      // median opaque pixel is plate, because the bars are a small minority of
      // the plate's area at every size.
      const middle = Math.floor(size / 2)
      const lit = Math.max(
        ...Array.from({ length: size }, (_, x) => brightness(pixels, size, x, middle))
      )

      const opaque: number[] = []
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (alphaAt(pixels, size, x, y) === 255) opaque.push(brightness(pixels, size, x, y))
        }
      }
      opaque.sort((a, b) => a - b)
      const plate = opaque[Math.floor(opaque.length / 2)]!

      expect(lit).toBeGreaterThan(180)
      expect(lit - plate).toBeGreaterThan(80)
    }
  })
})
