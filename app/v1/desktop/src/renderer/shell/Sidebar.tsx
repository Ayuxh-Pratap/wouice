import { useEffect, useRef, useState } from 'react'
import { MARK_BARS, MARK_STROKE, MARK_VIEWBOX } from '../../shared/mark.js'
import { zoomLabel } from '../../shared/settings.js'
import { jobColour, useMeetingJobs } from '../meetings/jobs.js'
import { Icon } from './Icon.js'
import { groupedRoutes, hashFor, type RouteDef, type RouteId } from './routes.js'

/**
 * The navigation rail.
 *
 * NO SURFACE OF ITS OWN. It shares the application ground, so the only raised
 * thing on screen is the content panel beside it. Giving the rail a background
 * and a border too would make the window read as two documents rather than one
 * page with navigation.
 *
 * Collapses to icons, because this window sits next to whatever you are
 * actually working in and the labels stop earning their width once you know
 * where things are. The collapsed state is per-machine UI preference and lives
 * in localStorage - it is not a decision about how the app behaves, and routing
 * it through the main process would make a toggle wait on IPC for no reason.
 *
 * IT CARRIES THE WORDMARK, and starts at the very top of the window. An earlier
 * version put the name in a separate strip across the whole width, which made
 * it read as a band the app was sitting under rather than as the app's own
 * heading. Here it occupies the same top band as Windows' caption buttons on
 * the far side, in the rail's own column, and the panel beside it begins below
 * the two of them.
 *
 * THE CHROME LIVES AT THE BOTTOM. The collapse toggle used to sit alone at the
 * top right of the rail, where it cost a row of its own and drew the eye to the
 * least interesting control on the screen. It and the interface-scale readout
 * are housekeeping, so they are in a footer, out of the way of the navigation
 * and still one click from anywhere.
 *
 * Two routes are listed and not reachable. That is deliberate: the rail is
 * where the shape of the finished app is communicated, and Meetings and
 * Companion are the next two surfaces.
 */

/**
 * The app mark.
 *
 * Inline rather than an image file: it is five strokes, and an asset would be
 * one more thing to keep in step with the theme every time the greys move.
 */
function Mark(): React.JSX.Element {
  const mid = MARK_VIEWBOX / 2
  return (
    <span className="grid size-[22px] shrink-0 place-items-center rounded-[6px] bg-gradient-to-b from-neutral-500 to-neutral-800 text-neutral-50 ring-1 ring-white/15">
      <svg
        viewBox={`0 0 ${MARK_VIEWBOX} ${MARK_VIEWBOX}`}
        className="size-3.5"
        fill="none"
        aria-hidden="true"
      >
        {/* Built from the shared geometry rather than a literal path, so this
            and the tray and taskbar icons drawn in main are one logo and not
            two that happen to look alike today. */}
        <path
          d={MARK_BARS.map((b) => `M${b.x} ${mid - b.half}v${b.half * 2}`).join('')}
          stroke="currentColor"
          strokeWidth={MARK_STROKE}
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}

function Item({
  route,
  active,
  collapsed,
  dot,
}: {
  route: RouteDef
  active: boolean
  collapsed: boolean
  /** A colour when something is running here, shown on the icon from anywhere in the app. */
  dot?: string | null
}): React.JSX.Element {
  const shared = [
    'flex w-full items-center rounded-lg transition',
    collapsed ? 'justify-center px-0 py-2' : 'gap-3 px-3 py-2',
  ].join(' ')

  if (route.soon) {
    return (
      <div
        title={`${route.label} — ${route.blurb}`}
        className={`${shared} cursor-default text-neutral-700`}
      >
        <Icon name={route.icon} />
        {!collapsed && (
          <>
            <span className="flex-1 text-left text-[13px]">{route.label}</span>
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] tracking-wide text-neutral-600 uppercase">
              Soon
            </span>
          </>
        )}
      </div>
    )
  }

  return (
    <a
      href={hashFor(route.id)}
      title={collapsed ? route.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={[
        shared,
        active
          ? 'lift-active bg-white/[0.07] text-neutral-100 ring-1 ring-white/[0.08]'
          : 'text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300',
      ].join(' ')}
    >
      <span className="relative flex">
        <Icon name={route.icon} />
        {dot ? (
          <span
            className="absolute -top-0.5 -right-0.5 size-1.5 animate-pulse rounded-full ring-2 ring-black/60"
            style={{ backgroundColor: dot }}
          />
        ) : null}
      </span>
      {!collapsed && <span className="flex-1 text-left text-[13px]">{route.label}</span>}
    </a>
  )
}

/**
 * Search, which means searching your dictations.
 *
 * It navigates rather than filtering in place: the results are a page that
 * already exists, and sending you there means back works and the URL says what
 * you searched for.
 */
function Search({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const [term, setTerm] = useState('')
  const input = useRef<HTMLInputElement>(null)

  // Ctrl+K from anywhere in the window, because that is where every other app
  // has put it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const go = (): void => {
    if (term.trim()) window.location.hash = hashFor('dictations', term)
  }

  if (collapsed) {
    return (
      <a
        href={hashFor('dictations')}
        title="Search dictations"
        className="mx-auto flex size-9 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-white/[0.04] hover:text-neutral-300"
      >
        <Icon name="search" />
      </a>
    )
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-neutral-600">
        <Icon name="search" className="size-3.5" />
      </span>
      <input
        ref={input}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go()
          if (e.key === 'Escape') {
            setTerm('')
            input.current?.blur()
          }
        }}
        placeholder="Search"
        aria-label="Search dictations"
        className="w-full rounded-md bg-black/25 py-1 pr-9 pl-8 shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)] text-[12px] text-neutral-300 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-600 focus:ring-white/20"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded bg-white/5 px-1 py-0.5 font-mono text-[9px] text-neutral-600">
        ⌃K
      </kbd>
    </div>
  )
}

export function Sidebar({
  active,
  collapsed,
  onToggle,
  zoom,
}: {
  active: RouteId
  collapsed: boolean
  onToggle(): void
  zoom: number
}): React.JSX.Element {
  // A meeting being written up or improved, visible from Dictation or Settings:
  // the work takes minutes, and it should not take opening Meetings to see it.
  const jobs = useMeetingJobs()
  const meetingDot = jobs.running
    ? jobColour(jobs.running.kind)
    : jobs.queued.length > 0
      ? '#737373'
      : null

  return (
    <nav
      className={[
        'flex shrink-0 flex-col transition-[width] duration-150',
        collapsed ? 'w-[4.5rem]' : 'w-60',
      ].join(' ')}
    >
      {/*
        The same height as the strip above the content panel, so the wordmark
        and the top of the panel sit on one line. Draggable, like the rest of
        the band: there is nothing clickable in it to get in the way.
      */}
      <header
        className={`flex h-[var(--band)] shrink-0 items-center ${collapsed ? 'justify-center' : 'px-2.5'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {/* Flush with the left edge of the search field and the nav rows, not
            with the icons inside them: the mark is the rail's own heading, so
            it lines up with the rail's content, not with a nested indent. */}
        <div className="flex items-center gap-2.5">
          <Mark />
          {/* The largest type in the rail, by design: nothing else here should
              out-rank the name of the app. */}
          {!collapsed && (
            <span className="text-[15px] font-semibold tracking-tight text-neutral-50 select-none">
              Wouice
            </span>
          )}
        </div>
      </header>

      <div className={collapsed ? 'px-2.5 pb-2' : 'px-2.5 pb-3'}>
        <Search collapsed={collapsed} />
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-2.5 pb-4">
        {groupedRoutes().map(({ group, routes }) => (
          <div key={group}>
            {collapsed ? (
              <div className="mx-auto mb-2 h-px w-6 bg-white/[0.06]" />
            ) : (
              <div className="mb-1 px-3 text-[10px] font-medium tracking-widest text-neutral-600 uppercase">
                {group}
              </div>
            )}
            <div className="space-y-0.5">
              {routes.map((r) => (
                <Item
                  key={r.id}
                  route={r}
                  active={r.id === active}
                  collapsed={collapsed}
                  dot={r.id === 'meetings' ? meetingDot : null}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/*
        Housekeeping. The scale appears only when it is not 100%: an indicator
        that is always on screen is a permanent reminder of a setting almost
        nobody changes twice, and one that appears the moment you are not at
        100% is how you find your way back from a stray Ctrl+scroll. It links to
        Settings because "why is everything huge" and "where do I fix that" are
        the same thought.
      */}
      <footer
        className={`flex shrink-0 items-center gap-1 px-2.5 pb-2.5 ${
          collapsed ? 'justify-center' : 'justify-between'
        }`}
      >
        {!collapsed &&
          (Math.abs(zoom - 1) > 1e-6 ? (
            <a
              href={hashFor('settings')}
              title="Interface scale - open settings"
              className="rounded px-2 py-1 font-mono text-[10px] text-neutral-600 tabular-nums transition hover:bg-white/5 hover:text-neutral-300"
            >
              {zoomLabel(zoom)}
            </a>
          ) : (
            <span />
          ))}
        <button
          onClick={onToggle}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="rounded-md p-1.5 text-neutral-600 transition hover:bg-white/5 hover:text-neutral-300"
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} className="size-4" />
        </button>
      </footer>
    </nav>
  )
}
