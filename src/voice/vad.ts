// Copied verbatim from ../app/frontend/src/audio/vad.ts at web commit db6ba59. Keep in step with it.
/**
 * Voice activity detection and utterance endpointing.
 *
 * This is what replaces a fixed listening window. A 20-second timer either cuts
 * the user off mid-sentence or leaves the mic open through 18 seconds of
 * silence; neither feels like talking to something. Instead: speech ends when
 * the user actually stops talking, detected as a run of quiet frames.
 *
 * Deliberately energy-based rather than a neural VAD (Silero et al). With
 * browser noise suppression already upstream, RMS plus an adaptive noise floor
 * is accurate enough for a push-to-talk-adjacent flow, and it costs no model
 * download and no inference on the audio thread. If it proves too eager in
 * noisy rooms, this module is the seam to swap Silero in behind.
 */

export interface VadConfig {
  /** Speech must exceed the noise floor by this ratio to count. */
  speechRatio: number
  /** Absolute floor, so a silent room can't make the threshold ~0. */
  minThreshold: number
  /** Quiet time after speech before the utterance is considered over. */
  hangoverMs: number
  /** Speech must last this long to count as a real onset (rejects clicks). */
  minSpeechMs: number
  /**
   * Before an onset is confirmed, a dip shorter than this doesn't restart the
   * count. Speech dips below the threshold between syllables and words; with
   * 8ms frames, demanding an unbroken run makes a longer `minSpeechMs`
   * almost unreachable for normal talking.
   */
  onsetGapMs: number
}

export const DEFAULT_VAD: VadConfig = {
  speechRatio: 2.5,
  minThreshold: 0.012,
  // ~800ms is the sweet spot: shorter clips people who pause mid-thought,
  // longer and the assistant feels slow to respond.
  hangoverMs: 800,
  minSpeechMs: 150,
  onsetGapMs: 120,
}

export type VadEvent = 'speech-start' | 'speech-end'

export function createVad(
  sampleRate: number,
  /**
   * `ms` dates the event, since both are confirmed only after the fact.
   * For 'speech-start' it is how long ago the confirmed speech began (short
   * dips included), i.e. it began that long before the frame just pushed
   * (barge-in uses it to send pre-roll from the real onset). For 'speech-end'
   * it is how long it has been quiet, i.e. how far back the last speech frame
   * was; timing marks use it to date the real end of speech rather than the
   * moment the hangover expired.
   */
  onEvent: (e: VadEvent, ms: number) => void,
  config: VadConfig = DEFAULT_VAD,
) {
  let noiseFloor = config.minThreshold
  let minSpeechMs = config.minSpeechMs
  let hangoverMs = config.hangoverMs
  let speechRatio = config.speechRatio
  let speaking = false
  let speechMs = 0
  let quietMs = 0
  // Time since the first loud frame of a not-yet-confirmed onset, gaps
  // included: what pre-roll needs to reach back to where speech began.
  let onsetElapsedMs = 0

  return {
    /** Feed one captured frame. `samples` is the frame length. */
    push(rms: number, samples: number) {
      const frameMs = (samples / sampleRate) * 1000
      const threshold = Math.max(noiseFloor * speechRatio, config.minThreshold)
      const loud = rms > threshold

      if (loud) {
        quietMs = 0
        speechMs += frameMs
        if (!speaking) onsetElapsedMs += frameMs
        if (!speaking && speechMs >= minSpeechMs) {
          speaking = true
          onEvent('speech-start', onsetElapsedMs)
          onsetElapsedMs = 0
        }
      } else {
        // Only adapt the noise floor while nobody is talking, or the user's own
        // voice drags the threshold up until they get cut off.
        noiseFloor = noiseFloor * 0.97 + rms * 0.03
        if (speaking) {
          quietMs += frameMs
          if (quietMs >= hangoverMs) {
            const endedAgoMs = quietMs
            speaking = false
            speechMs = 0
            quietMs = 0
            onEvent('speech-end', endedAgoMs)
          }
        } else if (speechMs > 0) {
          quietMs += frameMs
          onsetElapsedMs += frameMs
          if (quietMs > config.onsetGapMs) {
            speechMs = 0
            quietMs = 0
            onsetElapsedMs = 0
          }
        }
      }
    },
    get speaking() {
      return speaking
    },
    /**
     * How much sustained speech confirms an onset. Raised while the assistant
     * talks, so a short "mm-hm" or a burst of her own echo doesn't cut her off.
     */
    setMinSpeechMs(ms: number) {
      minSpeechMs = ms
    },
    /**
     * Quiet time that ends an utterance. Shortened while the assistant is
     * held mid-reply: an "I see" should resume her quickly, and a pause there
     * costs only a resume, not a cut-off question.
     */
    setHangoverMs(ms: number) {
      hangoverMs = ms
    },
    /**
     * How far above the noise floor speech must be. Lowered while the
     * assistant talks: her voice leaking into the mic raises the floor, which
     * would otherwise raise the bar exactly when the user needs to cut in.
     */
    setSpeechRatio(ratio: number) {
      speechRatio = ratio
    },
    /** Internal state, for dev diagnostics only. */
    get stats() {
      return {
        noiseFloor,
        threshold: Math.max(noiseFloor * speechRatio, config.minThreshold),
        speaking,
        speechMs,
        quietMs,
      }
    },
    reset() {
      // Each follow-up starts after audio has played through the speakers.
      // Even with echo cancellation, that residual output can raise the
      // adaptive floor enough that normal speech is missed on the next turn.
      // Start endpointing the new utterance from the configured baseline.
      noiseFloor = config.minThreshold
      speaking = false
      speechMs = 0
      quietMs = 0
      onsetElapsedMs = 0
    },
  }
}

/**
 * Absolute sample position where confirmed speech began, minus `paddingMs` of
 * lead-in so a soft first consonant isn't clipped. `endPosition` is the
 * capture position right after the frame that confirmed speech.
 */
export function speechOnsetPosition(
  endPosition: number,
  speechMs: number,
  sampleRate: number,
  paddingMs: number,
): number {
  const back = Math.ceil(((speechMs + paddingMs) / 1000) * sampleRate)
  return Math.max(0, endPosition - back)
}
