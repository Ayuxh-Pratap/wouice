import { nativeImage } from 'electron'
import { drawMark } from '../shared/mark.js'

/**
 * The app mark, as images the shell can use.
 *
 * The drawing itself is in `shared/mark.ts`, next to the geometry it reads and
 * with no Electron import, so it can be rendered to a PNG and looked at without
 * launching the app. This file is only the wrapper that turns those pixels into
 * a `nativeImage`.
 *
 * NO ICON FILE ON DISK. Windows wants a bitmap for the taskbar, the window
 * corner and the tray, and `nativeImage` cannot decode SVG - so the mark the
 * sidebar draws in the DOM is unavailable to main however it is stored. The
 * alternatives were a build step that rasterises an SVG (a native dependency,
 * or driving a headless Electron to screenshot itself) or a committed set of
 * PNGs that would silently fall out of step with the sidebar. Five round-capped
 * bars on a rounded square is a shape whose whole definition is
 * distance-to-a-segment, which is cheaper to compute than to install.
 */

function image(size: number): Electron.NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(drawMark(size)), { width: size, height: size })
}

/**
 * The window and taskbar icon.
 *
 * Drawn at 256 rather than at each size Windows might ask for: the mark is five
 * bars and a rounded square, so it downsamples cleanly, and generating it once
 * keeps this to one call rather than a table of representations whose scale
 * factors would be guesses about how Windows picks.
 */
export function appIcon(): Electron.NativeImage {
  return image(256)
}

/**
 * The tray glyph.
 *
 * Drawn at its final 16px rather than scaled down from the big one, so the
 * anti-aliasing is computed against the pixels it will actually occupy. At this
 * size that is the difference between five bars and a grey smudge.
 */
export function trayIcon(): Electron.NativeImage {
  return image(16)
}
