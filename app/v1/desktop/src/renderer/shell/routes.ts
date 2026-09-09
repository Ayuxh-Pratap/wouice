/**
 * Where you can be in this app.
 *
 * Hash routing, because the renderer already uses the hash to tell the HUD
 * window from the main one and a second mechanism would be one too many. It
 * also means back and forward work, which people expect from anything that
 * looks like this.
 *
 * Pure: parsing and formatting only, so the navigation rules can be tested
 * without rendering anything.
 */

export type RouteId =
  | 'dashboard'
  | 'dictations'
  | 'meetings'
  | 'companion'
  | 'quality'
  | 'settings'

export type IconName =
  | 'gauge'
  | 'transcript'
  | 'meeting'
  | 'companion'
  | 'quality'
  | 'settings'

export interface RouteDef {
  id: RouteId
  path: string
  label: string
  /** Sidebar heading this sits under. */
  group: string
  icon: IconName
  /** One line, shown under the page title. */
  blurb: string
  /**
   * Present in the sidebar but not reachable yet.
   *
   * Listed rather than hidden on purpose: the shape of the finished app is
   * part of what the sidebar communicates, and two more surfaces are coming.
   */
  soon?: boolean
}

export const ROUTES: RouteDef[] = [
  {
    id: 'dashboard',
    path: '/',
    label: 'Dashboard',
    group: 'Overview',
    icon: 'gauge',
    blurb: 'What the machine is doing, and how fast it has been.',
  },
  {
    id: 'dictations',
    path: '/dictations',
    label: 'Dictations',
    group: 'Overview',
    icon: 'transcript',
    blurb: 'Everything you have dictated, searchable.',
  },
  {
    id: 'meetings',
    path: '/meetings',
    label: 'Meetings',
    group: 'Surfaces',
    icon: 'meeting',
    blurb: 'Two-channel capture with Me and Them kept apart.',
  },
  {
    id: 'companion',
    path: '/companion',
    label: 'Companion',
    group: 'Surfaces',
    icon: 'companion',
    blurb: 'A voice loop that answers back.',
    soon: true,
  },
  {
    id: 'quality',
    path: '/quality',
    label: 'Quality',
    group: 'System',
    icon: 'quality',
    blurb: 'Was the text good enough? Acceptance criterion A4, one dictation at a time.',
  },
  {
    id: 'settings',
    path: '/settings',
    label: 'Settings',
    group: 'System',
    icon: 'settings',
    blurb: 'Microphone, models, and everything you can change.',
  },
]

export const DEFAULT_ROUTE: RouteId = 'dashboard'

/** Sidebar groups, in order, each with the routes that belong to it. */
export function groupedRoutes(): { group: string; routes: RouteDef[] }[] {
  const out: { group: string; routes: RouteDef[] }[] = []
  for (const route of ROUTES) {
    const existing = out.find((g) => g.group === route.group)
    if (existing) existing.routes.push(route)
    else out.push({ group: route.group, routes: [route] })
  }
  return out
}

export function routeById(id: RouteId): RouteDef {
  return ROUTES.find((r) => r.id === id) ?? ROUTES[0]!
}

export interface ParsedRoute {
  id: RouteId
  /** The `q=` term, already decoded. Empty when there is none. */
  query: string
}

/**
 * Read a hash.
 *
 * Anything unrecognised lands on the dashboard rather than on a blank screen: a
 * stale bookmark or a typo should not be able to produce a window with nothing
 * in it. A route marked `soon` is not reachable either, for the same reason.
 *
 * The query rides in the hash so that searching from the sidebar is a normal
 * navigation - it lands in history, back returns to where you were, and the
 * page does not need to be told about the rail that sent it there.
 */
export function parseHash(hash: string): ParsedRoute {
  const raw = hash.replace(/^#/, '') || '/'
  const [path = '/', search = ''] = raw.split('?')
  const found = ROUTES.find((r) => r.path === path)
  if (!found || found.soon) return { id: DEFAULT_ROUTE, query: '' }

  let query = ''
  try {
    query = new URLSearchParams(search).get('q') ?? ''
  } catch {
    // A malformed query is not a reason to refuse to navigate.
  }
  return { id: found.id, query }
}

export function hashFor(id: RouteId, query?: string): string {
  const path = routeById(id).path
  const trimmed = query?.trim()
  return trimmed ? `#${path}?q=${encodeURIComponent(trimmed)}` : `#${path}`
}

/** True when this window is the dictation overlay rather than the main one. */
export function isHudHash(hash: string): boolean {
  return hash.replace(/^#/, '') === '/hud'
}
