import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discardRecording } from './remove.js'

/**
 * Removing a meeting's recording.
 *
 * The case that matters is the one that was broken: a removed meeting has to
 * stay removed, which means its directory has to leave the place startup looks.
 * The rest is making sure a stored path can never bin anything else.
 */

let root: string
let trashed: string[]
const trash = async (target: string): Promise<void> => {
  trashed.push(target)
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wouice-remove-'))
  trashed = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('removing a recording', () => {
  it('moves the meeting directory to the bin', async () => {
    const dir = path.join(root, '2026-09-10T10-00-00-000Z')
    mkdirSync(dir)
    expect(await discardRecording(root, dir, trash)).toBeNull()
    expect(trashed).toEqual([dir])
  })

  it('refuses anything that is not a meeting directory', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'wouice-outside-'))
    const nested = path.join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    try {
      expect(await discardRecording(root, outside, trash)).toMatch(/not a meeting recording/)
      expect(await discardRecording(root, root, trash)).toMatch(/not a meeting recording/)
      expect(await discardRecording(root, path.join(root, '..'), trash)).toMatch(
        /not a meeting recording/
      )
      expect(await discardRecording(root, nested, trash)).toMatch(/not a meeting recording/)
      expect(trashed).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('has nothing to do when the directory is already gone', async () => {
    expect(await discardRecording(root, path.join(root, 'gone'), trash)).toBeNull()
    expect(trashed).toEqual([])
  })

  it('says why when the bin refuses, and leaves the recording where it was', async () => {
    const dir = path.join(root, 'open-in-a-player')
    mkdirSync(dir)
    const problem = await discardRecording(root, dir, async () => {
      throw new Error('file in use')
    })
    expect(problem).toMatch(/file in use/)
    expect(existsSync(dir)).toBe(true)
  })
})
