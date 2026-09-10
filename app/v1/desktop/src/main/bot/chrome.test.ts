import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { chromeCandidates, findChrome, installedVersion, newestVersion } from './chrome.js'

describe('finding Chrome', () => {
  it('looks per machine first, then per user', () => {
    const found = chromeCandidates({
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
    })
    expect(found).toEqual([
      path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join('C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join('C:\\Users\\a\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ])
  })

  it('skips a location the environment does not name', () => {
    expect(chromeCandidates({ LOCALAPPDATA: 'C:\\L' })).toHaveLength(1)
  })

  it('returns the first that exists, or nothing', () => {
    expect(findChrome(['a', 'b', 'c'], (f) => f === 'b')).toBe('b')
    expect(findChrome(['a'], () => false)).toBeNull()
  })
})

describe('the installed version', () => {
  it('is the newest version folder, compared as numbers', () => {
    expect(newestVersion(['99.0.1.2', '153.0.8010.36', 'SetupMetrics', '153.0.800.1'])).toBe(
      '153.0.8010.36'
    )
    expect(newestVersion(['SetupMetrics'])).toBeNull()
  })

  it('is nothing when the folder cannot be read', () => {
    expect(
      installedVersion('C:\\x\\chrome.exe', () => {
        throw new Error('gone')
      })
    ).toBeNull()
  })
})
