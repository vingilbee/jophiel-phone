/**
 * Base64 → bytes for the mic frames the native module sends (events carry strings, not binary).
 * 50 frames a second of 640 bytes: a lookup table is plenty fast.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Uint8Array(128)
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i

export function decodeBase64(input: string): Uint8Array {
  let end = input.length
  while (end > 0 && input.charCodeAt(end - 1) === 61 /* = */) end--
  const out = new Uint8Array(Math.floor((end * 3) / 4))
  let o = 0
  let i = 0
  for (; i + 4 <= end; i += 4) {
    const n =
      ((LOOKUP[input.charCodeAt(i)] ?? 0) << 18) |
      ((LOOKUP[input.charCodeAt(i + 1)] ?? 0) << 12) |
      ((LOOKUP[input.charCodeAt(i + 2)] ?? 0) << 6) |
      (LOOKUP[input.charCodeAt(i + 3)] ?? 0)
    out[o++] = (n >> 16) & 0xff
    out[o++] = (n >> 8) & 0xff
    out[o++] = n & 0xff
  }
  const rest = end - i
  if (rest >= 2) {
    const n = ((LOOKUP[input.charCodeAt(i)] ?? 0) << 18) | ((LOOKUP[input.charCodeAt(i + 1)] ?? 0) << 12) |
      (rest === 3 ? (LOOKUP[input.charCodeAt(i + 2)] ?? 0) << 6 : 0)
    out[o++] = (n >> 16) & 0xff
    if (rest === 3) out[o++] = (n >> 8) & 0xff
  }
  return out
}

/** 16-bit little-endian PCM from base64. An odd trailing byte is dropped. */
export function decodePcm16(input: string): Int16Array {
  const bytes = decodeBase64(input)
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
}
