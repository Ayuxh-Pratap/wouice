import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROUTE,
  ROUTES,
  groupedRoutes,
  hashFor,
  hashForMeeting,
  isHudHash,
  parseHash,
  routeById,
} from './routes.js'

describe('the route table', () => {
  it('has unique ids and paths', () => {
    expect(ROUTES.map((r) => r.id)).toEqual([...new Set(ROUTES.map((r) => r.id))])
    expect(ROUTES.map((r) => r.path)).toEqual([...new Set(ROUTES.map((r) => r.path))])
  })

  it('gives every route a label and a blurb', () => {
    for (const r of ROUTES) {
      expect(r.label.length, r.id).toBeGreaterThan(0)
      expect(r.blurb.length, r.id).toBeGreaterThan(0)
    }
  })

  it('keeps the default route reachable', () => {
    expect(routeById(DEFAULT_ROUTE).soon).toBeUndefined()
  })
})

describe('reading a hash', () => {
  it('maps each real path to its route', () => {
    expect(parseHash('#/').id).toBe('dashboard')
    expect(parseHash('#/dictations').id).toBe('dictations')
    expect(parseHash('#/settings').id).toBe('settings')
  })

  it('treats an empty hash as the dashboard', () => {
    // A window opened without a hash at all, which is the normal first launch.
    expect(parseHash('').id).toBe('dashboard')
    expect(parseHash('#').id).toBe('dashboard')
  })

  it('falls back rather than rendering nothing', () => {
    // A stale bookmark must not produce an empty window.
    expect(parseHash('#/nonsense').id).toBe(DEFAULT_ROUTE)
  })

  it('refuses a route that is not built yet', () => {
    // Listed in the sidebar so the shape of the app is visible, but typing the
    // path should not strand someone on a page that does not exist. Meetings
    // was one of these until Stage 1 shipped, which is why the check is driven
    // by the flag rather than by a list that has to be remembered.
    const unbuilt = ROUTES.filter((r) => r.soon)
    expect(unbuilt.length).toBeGreaterThan(0)
    for (const route of unbuilt) {
      expect(parseHash(`#${route.path}`).id).toBe(DEFAULT_ROUTE)
    }
  })

  it('lets you reach meetings', () => {
    expect(parseHash('#/meetings').id).toBe('meetings')
  })

  it('round-trips every reachable route', () => {
    for (const r of ROUTES.filter((x) => !x.soon)) {
      expect(parseHash(hashFor(r.id)).id).toBe(r.id)
    }
  })
})

describe('carrying a search term', () => {
  it('round-trips a query', () => {
    const parsed = parseHash(hashFor('dictations', 'budget review'))
    expect(parsed.id).toBe('dictations')
    expect(parsed.query).toBe('budget review')
  })

  it('leaves the hash clean when there is nothing to search for', () => {
    expect(hashFor('dictations')).toBe('#/dictations')
    expect(hashFor('dictations', '   ')).toBe('#/dictations')
  })

  it('survives characters that would otherwise break the hash', () => {
    // '#' and '&' in a search term are the obvious way to corrupt a URL.
    for (const term of ['a#b', 'a&b=c', 'नमस्ते', '100% sure']) {
      expect(parseHash(hashFor('dictations', term)).query).toBe(term)
    }
  })

  it('reads a route with no query as an empty term, not undefined', () => {
    expect(parseHash('#/dictations').query).toBe('')
  })

  it('ignores a query on a route that does not use one', () => {
    expect(parseHash('#/settings?q=x')).toEqual({ id: 'settings', query: 'x', meetingId: null })
  })

  it('reads one meeting out of its own address', () => {
    // A meeting gets an address the moment it starts recording: everything
    // about it belongs together and nowhere else.
    expect(parseHash('#/meetings/42')).toEqual({ id: 'meetings', query: '', meetingId: 42 })
    expect(hashForMeeting(42)).toBe('#/meetings/42')
  })

  it('falls back to the list when the id is not a number', () => {
    expect(parseHash('#/meetings/abc').id).toBe(DEFAULT_ROUTE)
    expect(parseHash('#/meetings').meetingId).toBeNull()
  })
})

describe('the hud window', () => {
  it('is recognised by its own hash', () => {
    expect(isHudHash('#/hud')).toBe(true)
    expect(isHudHash('/hud')).toBe(true)
  })

  it('is not confused with any navigable route', () => {
    for (const r of ROUTES) expect(isHudHash(hashFor(r.id))).toBe(false)
  })
})

describe('sidebar grouping', () => {
  it('keeps each group together and in first-seen order', () => {
    const groups = groupedRoutes()
    expect(groups.map((g) => g.group)).toEqual(['Overview', 'Surfaces', 'System'])
    expect(groups[0]!.routes.map((r) => r.id)).toEqual(['dashboard', 'dictations'])
  })

  it('lists every route exactly once', () => {
    const flat = groupedRoutes().flatMap((g) => g.routes)
    expect(flat).toHaveLength(ROUTES.length)
    expect(new Set(flat.map((r) => r.id)).size).toBe(ROUTES.length)
  })
})
