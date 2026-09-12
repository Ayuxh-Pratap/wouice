import { describe, expect, it } from 'vitest'
import { parseGpu } from './gpu.js'

describe('reading the GPU', () => {
  it('reads memory, temperature and clock', () => {
    expect(parseGpu('5323, 6144, 79, 1605\r\n')).toEqual({ usedMiB: 5323, totalMiB: 6144, tempC: 79, smMHz: 1605 })
  })

  it('keeps memory when the driver does not report temperature or clock', () => {
    expect(parseGpu('700, 6144, [N/A], [N/A]')).toEqual({ usedMiB: 700, totalMiB: 6144, tempC: null, smMHz: null })
  })

  it('is unknown rather than zero when there is nothing to read', () => {
    expect(parseGpu('')).toBeNull()
    expect(parseGpu('No devices were found')).toBeNull()
  })
})
