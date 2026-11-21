// Copied verbatim from ../app/frontend/src/audio/pcmRingBuffer.ts at web commit db6ba59. Keep in step with it.
/**
 * The last few hundred milliseconds of microphone audio, kept locally.
 *
 * Barge-in needs it: VAD only confirms speech after `minSpeechMs` of it, and
 * while the assistant is talking the mic isn't being streamed. Without this,
 * the start of "wait, actually…" is heard by the VAD and then thrown away, and
 * the transcript begins mid-word. On a confirmed interruption the session
 * sends the ring from just before the estimated onset, then streams live.
 *
 * Positions are absolute sample counts since the last `clear()`, not array
 * indices, so an onset computed by subtracting a duration from the end stays
 * valid however many times the circular index has wrapped. Nothing here is
 * persisted or logged; it's overwritten continuously.
 */

export interface PcmRingBuffer {
  /** Append one captured frame (oldest samples are overwritten when full). */
  push(pcm: Int16Array): void
  /**
   * A copy of everything from `samplePosition` to the end, clamped to the
   * oldest sample still held. Empty if the position is at or past the end.
   */
  snapshotFrom(samplePosition: number): Int16Array
  clear(): void
  /** Absolute position one past the newest sample. */
  readonly endSamplePosition: number
  /** Absolute position of the oldest sample still held. */
  readonly startSamplePosition: number
}

export function createPcmRingBuffer(capacitySamples: number): PcmRingBuffer {
  if (!Number.isInteger(capacitySamples) || capacitySamples <= 0) {
    throw new Error('Ring capacity must be a positive integer.')
  }
  const data = new Int16Array(capacitySamples)
  let end = 0 // absolute position one past the newest sample

  return {
    push(pcm) {
      // A frame larger than the ring only leaves its tail behind.
      const src = pcm.length > capacitySamples ? pcm.subarray(pcm.length - capacitySamples) : pcm
      const skipped = pcm.length - src.length
      const at = (end + skipped) % capacitySamples
      const first = Math.min(src.length, capacitySamples - at)
      data.set(src.subarray(0, first), at)
      if (first < src.length) data.set(src.subarray(first), 0)
      end += pcm.length
    },
    snapshotFrom(samplePosition) {
      const start = Math.max(Math.floor(samplePosition), end - capacitySamples, 0)
      const length = Math.max(0, end - start)
      // Always a fresh copy: the socket may still be sending it when the
      // next frame overwrites the ring.
      const out = new Int16Array(length)
      if (length === 0) return out
      const at = start % capacitySamples
      const first = Math.min(length, capacitySamples - at)
      out.set(data.subarray(at, at + first), 0)
      if (first < length) out.set(data.subarray(0, length - first), first)
      return out
    },
    clear() {
      end = 0
      data.fill(0)
    },
    get endSamplePosition() {
      return end
    },
    get startSamplePosition() {
      return Math.max(0, end - capacitySamples)
    },
  }
}
