/**
 * Encode 16 kHz mono Float32 PCM as a 16-bit WAV.
 *
 * whisper-server takes an audio *file* over multipart, not raw samples, so this
 * sits between our internal audio format and the wire. It is the only place in
 * the app that converts out of Float32, per the "one internal format" rule.
 *
 * Built on ArrayBuffer and DataView rather than Node's Buffer on purpose. The
 * result then satisfies `BlobPart` directly (a Buffer is a Uint8Array over
 * ArrayBufferLike, which the DOM rejects because it might be a SharedArrayBuffer)
 * and the package stays runnable in a renderer as well as in main.
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

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

// The explicit <ArrayBuffer> matters: since TypeScript 5.7 typed arrays are
// generic over their backing buffer, and a bare `Uint8Array` means
// `Uint8Array<ArrayBufferLike>`, which BlobPart rejects because it could be a
// SharedArrayBuffer. We allocate a real ArrayBuffer, so say so.
export function encodeWav(pcm: Float32Array, sampleRate: number = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const dataBytes = pcm.length * 2
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  const byteRate = (sampleRate * CHANNELS * BITS_PER_SAMPLE) / 8
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // size of everything after this field
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size, 16 for PCM
  view.setUint16(20, 1, true) // audio format: 1 = uncompressed PCM
  view.setUint16(22, CHANNELS, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, BITS_PER_SAMPLE, true)

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = HEADER_BYTES
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(offset, toInt16(pcm[i] ?? 0), true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

/** Duration of a PCM buffer in milliseconds. */
export function durationMs(pcm: Float32Array, sampleRate: number = SAMPLE_RATE): number {
  return Math.round((pcm.length / sampleRate) * 1000)
}
