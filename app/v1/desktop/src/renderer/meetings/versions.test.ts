import type { VersionRecord } from '@wouice/store'
import { describe, expect, it } from 'vitest'
import { isImproved, mainVersion, versionLabel } from './versions.js'

const version = (over: Partial<VersionRecord>): VersionRecord => ({
  id: 1,
  meetingId: 1,
  source: 'live',
  createdAt: 0,
  notesMd: null,
  diagnostics: {},
  segments: 10,
  main: true,
  ...over,
})

describe('naming versions', () => {
  it('names them by where the transcript came from', () => {
    expect(versionLabel('live')).toBe('First pass')
    expect(versionLabel('large-v3')).toBe('Improved')
  })

  it('says improved only when the careful pass is the main version', () => {
    expect(isImproved({ versions: [version({})] })).toBe(false)
    const improved = [version({ main: false }), version({ id: 2, source: 'large-v3', main: true })]
    expect(isImproved({ versions: improved })).toBe(true)
    expect(mainVersion({ versions: improved })?.id).toBe(2)
    expect(isImproved({ versions: [] })).toBe(false)
  })
})
