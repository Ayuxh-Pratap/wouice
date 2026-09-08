import { zoomLabel } from '../../shared/settings.js'
import { hashFor } from './routes.js'

/**
 * The window's own title bar.
 *
 * WHY IT IS OURS. The native Windows caption is a light strip with a 16px icon
 * and the app's name in Segoe UI, sitting directly above a dark interface that
 * shares none of those things. It reads as a frame the app is running inside
 * rather than as part of the app.
 *
 * THE BUTTONS ARE STILL WINDOWS'. `titleBarStyle: 'hidden'` with a coloured
 * overlay keeps minimise, maximise and close native, which keeps the Windows 11
 * snap-layouts flyout that appears on hover over maximise and every
 * accessibility affordance attached to them, while handing us the strip they
 * sit in. Redrawing those three by hand is the version of this that looks the
 * same and behaves worse.
 *
 * The strip is sized from `env(titlebar-area-*)` rather than from a constant,
 * so the app never has to know how wide that button cluster is: Windows says,
 * and the layout follows. The fallbacks are for the preview harness, which is
 * an ordinary browser tab with no overlay at all.
 */

/** The whole strip is a drag handle, so anything clickable must opt out. */
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

export function TitleBar({ zoom }: { zoom: number }): React.JSX.Element {
  return (
    <div
      className="flex shrink-0 items-center gap-2 bg-neutral-950 pr-2 pl-3.5"
      style={
        {
          WebkitAppRegion: 'drag',
          height: 'env(titlebar-area-height, 40px)',
          // Everything left of the buttons, whatever Windows has made that.
          width: 'env(titlebar-area-width, 100%)',
        } as React.CSSProperties
      }
    >
      <Mark />
      <span className="text-[13px] font-semibold tracking-tight text-neutral-300 select-none">
        Wouice
      </span>

      {/*
        Shown only when it is not 100%. A scale indicator that is always on
        screen is a permanent reminder of a setting almost nobody changes twice;
        one that appears the moment you are not at 100% is how you find your way
        back from a stray Ctrl+scroll. A link rather than a label, because "why
        is everything huge" and "where do I fix that" are the same thought.
      */}
      {Math.abs(zoom - 1) > 1e-6 && (
        <a
          href={hashFor('settings')}
          title="Interface scale - open settings"
          style={NO_DRAG}
          className="ml-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 tabular-nums transition hover:bg-white/5 hover:text-neutral-300"
        >
          {zoomLabel(zoom)}
        </a>
      )}
    </div>
  )
}

/**
 * The app mark.
 *
 * Inline rather than an image file: it is five strokes, and an asset would be
 * one more thing to keep in step with the theme every time the greys move.
 */
function Mark(): React.JSX.Element {
  return (
    <span className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-gradient-to-b from-neutral-600 to-neutral-800 text-neutral-100 ring-1 ring-white/10">
      <svg viewBox="0 0 24 24" className="size-3" fill="none" aria-hidden="true">
        <path
          d="M12 4v16M7.5 8.5v7M16.5 8.5v7M3.5 11v2M20.5 11v2"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}
