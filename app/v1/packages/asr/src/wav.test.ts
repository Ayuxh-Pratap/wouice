import { describe, expect, it } from 'vitest'
import { encodeWav, durationMs, SAMPLE_RATE } from './wav.js'

/**
 * A wrong header byte does not throw. It produces a file whisper reads as
 * garbage, which surfaces as a transcript that is merely wrong, and nobody
 * traces that back to the encoder. So the layout is asserted byte by byte.
 */
describe('encodeWav header', () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1])
  const wav = encodeWav(pcm)

  it('is 44 bytes of header plus 2 bytes per sample', () => {
    expect(wav.length).toBe(44 + pcm.length * 2)
  })

  it('starts with RIFF....WAVE', () => {
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
  })

  it('declares RIFF size as everything after byte 8', () => {
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
  })

  it('declares an uncompressed PCM fmt chunk', () => {
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16) // fmt chunk size for PCM
    expect(wav.readUInt16LE(20)).toBe(1) // 1 = PCM
  })

  it('is 16 kHz mono 16-bit', () => {
    expect(wav.readUInt16LE(22)).toBe(1) // channels
    expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE)
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
  })

  it('has byteRate and blockAlign consistent with the format', () => {
    // Players and decoders trust these; an inconsistent pair plays at the
    // wrong speed rather than failing.
    expect(wav.readUInt32LE(28)).toBe(SAMPLE_RATE * 1 * 2) // byteRate
    expect(wav.readUInt16LE(32)).toBe(1 * 2) // blockAlign
  })

  it('declares the data chunk size in bytes, not samples', () => {
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(pcm.length * 2)
  })
})

describe('encodeWav samples', () => {
  it('maps silence to zero', () => {
    const wav = encodeWav(new Float32Array([0, 0]))
    expect(wav.readInt16LE(44)).toBe(0)
    expect(wav.readInt16LE(46)).toBe(0)
  })

  it('maps full scale without clipping either peak', () => {
    // The asymmetric scaling exists for exactly this: two's complement has one
    // more step below zero, so scaling both ways by 32768 clips +1.0.
    const wav = encodeWav(new Float32Array([1, -1]))
    expect(wav.readInt16LE(44)).toBe(32767)
    expect(wav.readInt16LE(46)).toBe(-32768)
  })

  it('clamps out-of-range input instead of wrapping', () => {
    // A wrapped sample is a loud click. Clamping is merely distortion.
    const wav = encodeWav(new Float32Array([2, -2]))
    expect(wav.readInt16LE(44)).toBe(32767)
    expect(wav.readInt16LE(46)).toBe(-32768)
  })

  it('round-trips a mid-scale value within one quantisation step', () => {
    const wav = encodeWav(new Float32Array([0.5]))
    expect(wav.readInt16LE(44) / 32767).toBeCloseTo(0.5, 4)
  })

  it('handles an empty buffer without producing an invalid file', () => {
    const wav = encodeWav(new Float32Array(0))
    expect(wav.length).toBe(44)
    expect(wav.readUInt32LE(40)).toBe(0)
    expect(wav.readUInt32LE(4)).toBe(36)
  })
})

describe('durationMs', () => {
  it('converts sample count to milliseconds', () => {
    expect(durationMs(new Float32Array(SAMPLE_RATE))).toBe(1000)
    expect(durationMs(new Float32Array(SAMPLE_RATE * 3))).toBe(3000)
    expect(durationMs(new Float32Array(SAMPLE_RATE / 2))).toBe(500)
  })

  it('is zero for an empty buffer', () => {
    expect(durationMs(new Float32Array(0))).toBe(0)
  })
})
