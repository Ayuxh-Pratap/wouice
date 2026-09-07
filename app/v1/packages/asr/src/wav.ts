/**
 * Encode 16 kHz mono Float32 PCM as a 16-bit WAV.
 *
 * whisper-server takes an audio *file* over multipart, not raw samples, so this
 * sits between our internal audio format and the wire. It is the only place in
 * the app that converts out of Float32, per the "one internal format" rule.
 *
 * Kept pure and separate from the HTTP client so the byte layout can be tested
 * without a server running. Header bugs here are miserable to diagnose through
 * a transcription that merely comes back wrong rather than failing.
 */

export const SAMPLE_RATE = 16_000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const HEADER_BYTES = 44

/**
 * Float [-1, 1] to signed 16-bit.
 *
 * The asymmetric scaling is deliberate: two's complement gives one more step
 * below zero than above (-32768 vs +32767), so scaling both directions by 32768
 * clips every full-scale positive peak. This is the standard fix and it is the
 * kind of thing that shows up as faint distortion nobody traces back.
 */
function toInt16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
}

export function encodeWav(pcm: Float32Array, sampleRate: number = SAMPLE_RATE): Buffer {
  const dataBytes = pcm.length * 2
  const buf = Buffer.allocUnsafe(HEADER_BYTES + dataBytes)

  const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4) // size of everything after this field
  buf.write('WAVE', 8, 'ascii')

  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt chunk size, 16 for PCM
  buf.writeUInt16LE(1, 20) // audio format: 1 = uncompressed PCM
  buf.writeUInt16LE(CHANNELS, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(blockAlign, 32)
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34)

  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)

  let offset = HEADER_BYTES
  for (let i = 0; i < pcm.length; i++) {
    buf.writeInt16LE(toInt16(pcm[i] ?? 0), offset)
    offset += 2
  }

  return buf
}

/** Duration of a PCM buffer in milliseconds. */
export function durationMs(pcm: Float32Array, sampleRate: number = SAMPLE_RATE): number {
  return Math.round((pcm.length / sampleRate) * 1000)
}
