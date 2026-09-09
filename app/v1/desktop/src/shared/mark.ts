/**
 * The Wouice mark: five vertical bars, a waveform at rest.
 *
 * DEFINED AS NUMBERS AND DRAWN HERE, not stored as an SVG path, because it has
 * to be produced twice by two things that cannot share a renderer. The sidebar
 * draws it as SVG in the DOM; the tray and the window icon are `nativeImage`
 * buffers built in main, where there is no SVG support at all - Chromium's
 * `nativeImage` will not decode one, so a path string would be useless there.
 *
 * Two drawings of one logo is exactly the sort of thing that drifts: someone
 * nudges the sidebar mark and the taskbar keeps the old one for a year. The
 * geometry lives here, and so does the rasteriser, so both read the same five
 * numbers.
 *
 * Coordinates are on a 24x24 grid, centred on y = 12.
 */

export interface MarkBar {
  /** Centre of the bar on the x axis. */
  x: number
  /** Half its length, so the bar runs from `12 - half` to `12 + half`. */
  half: number
}

/** Outermost first. Symmetric, rising to the centre - a voice, mid-syllable. */
export const MARK_BARS: readonly MarkBar[] = [
  { x: 3.5, half: 1 },
  { x: 7.5, half: 3.5 },
  { x: 12, half: 8 },
  { x: 16.5, half: 3.5 },
  { x: 20.5, half: 1 },
]

/** Bar thickness on the same 24-unit grid. Round-capped, so also the cap radius. */
export const MARK_STROKE = 2.4

/** The grid the numbers above are expressed in. */
export const MARK_VIEWBOX = 24

/**
 * The mark's colours, written out for the rasteriser.
 *
 * The sidebar gets these from Tailwind (`from-neutral-500 to-neutral-800` on
 * `text-neutral-50`), but a buffer of pixels in main has no stylesheet, so the
 * same three values are stated here.
 */
export const MARK_COLOURS = {
  from: { r: 115, g: 115, b: 115 },
  to: { r: 38, g: 38, b: 38 },
  bar: { r: 250, g: 250, b: 250 },
} as const

/**
 * Anti-aliasing, by supersampling.
 *
 * The icon is seen at 16px in a tray, where a hard-edged bar is a staircase.
 * Every pixel is sampled on a 3x3 grid and the coverage averaged, which is
 * enough at these sizes and is the whole of the quality story here.
 */
const SAMPLES = 3

/** Distance from a point to a vertical segment, which is what a round-capped bar is. */
function distanceToBar(px: number, py: number, x: number, top: number, bottom: number): number {
  const dy = py < top ? top - py : py > bottom ? py - bottom : 0
  const dx = px - x
  return Math.sqrt(dx * dx + dy * dy)
}

function insideBars(px: number, py: number): boolean {
  const radius = MARK_STROKE / 2
  const mid = MARK_VIEWBOX / 2
  for (const bar of MARK_BARS) {
    if (distanceToBar(px, py, bar.x, mid - bar.half, mid + bar.half) <= radius) return true
  }
  return false
}

/** The rounded square behind the bars. */
function insidePlate(px: number, py: number, inset: number, radius: number): boolean {
  const lo = inset
  const hi = MARK_VIEWBOX - inset
  if (px < lo || px > hi || py < lo || py > hi) return false
  // Only the corner quadrants need the distance test.
  const cx = px < lo + radius ? lo + radius : px > hi - radius ? hi - radius : px
  const cy = py < lo + radius ? lo + radius : py > hi - radius ? hi - radius : py
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= radius * radius
}

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

/**
 * The mark as RGBA pixels, `size` by `size`.
 *
 * THE PLATE IS ALWAYS DRAWN. Bars alone would be near-white, which is fine on
 * this app's own surfaces and invisible on a light Windows taskbar - and the
 * taskbar's colour is the user's to choose, not ours to assume.
 *
 * Pure, and free of any Electron import, so it can be rendered to a file and
 * looked at without launching the app. `scripts/preview-mark.mjs` does exactly
 * that; `main/brand.ts` wraps the same buffer in a `nativeImage`.
 */
export function drawMark(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4)
  const scale = MARK_VIEWBOX / size
  const step = 1 / SAMPLES
  const total = SAMPLES * SAMPLES
  // A plate filling the grid edge to edge loses its corners to the rounding
  // Windows applies to taskbar icons under some themes.
  const inset = MARK_VIEWBOX * 0.055
  const radius = MARK_VIEWBOX * 0.24
  const { from, to, bar } = MARK_COLOURS

  for (let y = 0; y < size; y++) {
    // Top-to-bottom gradient, driven by row, so it reads the same at every size.
    const t = y / Math.max(size - 1, 1)
    const plateR = mix(from.r, to.r, t)
    const plateG = mix(from.g, to.g, t)
    const plateB = mix(from.b, to.b, t)

    for (let x = 0; x < size; x++) {
      let barHits = 0
      let plateHits = 0

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = (x + (sx + 0.5) * step) * scale
          const py = (y + (sy + 0.5) * step) * scale
          if (insideBars(px, py)) barHits++
          else if (insidePlate(px, py, inset, radius)) plateHits++
        }
      }

      const alpha = (barHits + plateHits) / total
      if (alpha === 0) continue

      // Bars sit on top, so where they cover a pixel they own its colour.
      const share = barHits / (barHits + plateHits)
      const i = (y * size + x) * 4
      pixels[i] = mix(plateR, bar.r, share)
      pixels[i + 1] = mix(plateG, bar.g, share)
      pixels[i + 2] = mix(plateB, bar.b, share)
      pixels[i + 3] = Math.round(alpha * 255)
    }
  }

  return pixels
}
