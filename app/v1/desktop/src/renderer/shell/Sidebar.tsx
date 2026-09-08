import { useEffect, useRef, useState } from 'react'
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
 * Two routes are listed and not reachable. That is deliberate: the rail is
 * where the shape of the finished app is communicated, and Meetings and
 * Companion are the next two surfaces.
 */

function Item({
  route,
  active,
  collapsed,
}: {
  route: RouteDef
  active: boolean
  collapsed: boolean
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
      <Icon name={route.icon} />
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
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-neutral-600">
        <Icon name="search" className="size-4" />
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
        className="w-full rounded-lg bg-black/25 py-2 pr-12 pl-9 shadow-[inset_0_1px_2px_rgb(0_0_0/0.35)] text-[13px] text-neutral-200 ring-1 ring-white/[0.06] outline-none placeholder:text-neutral-600 focus:ring-white/20"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600">
        ⌃K
      </kbd>
    </div>
  )
}

export function Sidebar({
  active,
  collapsed,
  onToggle,
}: {
  active: RouteId
  collapsed: boolean
  onToggle(): void
}): React.JSX.Element {
  return (
    <nav
      className={[
        'flex shrink-0 flex-col transition-[width] duration-150',
        collapsed ? 'w-[4.5rem]' : 'w-60',
      ].join(' ')}
    >
      {/* No wordmark here any more: the title bar carries the app's name, and
          two of them stacked ten pixels apart was the same word twice. */}
      <header
        className={`flex h-9 items-center ${collapsed ? 'justify-center' : 'justify-end px-2.5'}`}
      >
        <button
          onClick={onToggle}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="rounded-md p-1 text-neutral-600 transition hover:bg-white/5 hover:text-neutral-300"
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} className="size-4" />
        </button>
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
                <Item key={r.id} route={r} active={r.id === active} collapsed={collapsed} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </nav>
  )
}
