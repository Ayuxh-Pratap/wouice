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
const BITS_PER_SAMPLE = 16
export const WAV_HEADER_BYTES = 44

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
/**
 * Just the 44 header bytes, for a file written in pieces.
 *
 * A one hour two-channel meeting is 57.6 million frames per channel. Building
 * that as one buffer costs the better part of a gigabyte for something that is
 * about to be handed straight to the filesystem, so the merge writes a header
 * first and streams blocks after it. The frame count has to be known up front
 * either way - it is in the header twice - which is why this takes it rather
 * than counting.
 */
export function wavHeader(
  frames: number,
  channels: number,
  sampleRate: number = SAMPLE_RATE
): Uint8Array<ArrayBuffer> {
  const dataBytes = frames * channels * (BITS_PER_SAMPLE / 8)
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES)
  const view = new DataView(buffer)

  const byteRate = (sampleRate * channels * BITS_PER_SAMPLE) / 8
  const blockAlign = (channels * BITS_PER_SAMPLE) / 8

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // size of everything after this field
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size, 16 for PCM
  view.setUint16(20, 1, true) // audio format: 1 = uncompressed PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, BITS_PER_SAMPLE, true)

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  return new Uint8Array(buffer)
}

/**
 * Two mono blocks to one interleaved 16-bit stereo block.
 *
 * Left is the microphone and right is the system channel, which is what makes
 * the saved audio readable by ear: your side in one can, theirs in the other.
 * The blocks must already be the same length - padding and alignment are the
 * caller's business, and doing it here would hide a mismatch that matters.
 */
export function interleaveToPcm16(
  left: Float32Array,
  right: Float32Array
): Uint8Array<ArrayBuffer> {
  if (left.length !== right.length) {
    throw new Error(`channel length mismatch: ${left.length} vs ${right.length}`)
  }
  const buffer = new ArrayBuffer(left.length * 4)
  const view = new DataView(buffer)
  let offset = 0
  for (let i = 0; i < left.length; i++) {
    view.setInt16(offset, toInt16(left[i] ?? 0), true)
    view.setInt16(offset + 2, toInt16(right[i] ?? 0), true)
    offset += 4
  }
  return new Uint8Array(buffer)
}

export function encodeWav(pcm: Float32Array, sampleRate: number = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const header = wavHeader(pcm.length, 1, sampleRate)
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + pcm.length * 2)
  const bytes = new Uint8Array(buffer)
  bytes.set(header, 0)

  const view = new DataView(buffer)
  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(offset, toInt16(pcm[i] ?? 0), true)
    offset += 2
  }

  return bytes
}

/** Duration of a PCM buffer in milliseconds. */
export function durationMs(pcm: Float32Array, sampleRate: number = SAMPLE_RATE): number {
  return Math.round((pcm.length / sampleRate) * 1000)
}
