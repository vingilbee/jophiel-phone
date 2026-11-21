/**
 * The echo test (Developer screen, step 4.2b on the S21): play her voice loudly through the
 * loudspeaker while the mic runs with Android's echo canceller, and measure how much of it still
 * reaches the VAD compared with the threshold that would let it barge in on herself.
 */

/**
 * The loudest level the mic held for `windowMs` in a row (the minimum inside the window, maximised
 * over the run). The VAD needs sustained speech to fire, so this — not the peak — is what decides.
 */
export function sustainedLevel(rms: readonly number[], frameMs: number, windowMs: number): number {
  const width = Math.max(1, Math.round(windowMs / frameMs))
  if (rms.length < width) return 0
  let best = 0
  for (let i = 0; i + width <= rms.length; i++) {
    let low = Infinity
    for (let j = i; j < i + width; j++) low = Math.min(low, rms[j] as number)
    best = Math.max(best, low)
  }
  return best
}

export interface EchoResult {
  /** Loudest single mic frame while she played. */
  peakMic: number
  /** Loudest level the mic held for the barge-in onset time. */
  sustainedMic: number
  /** Loudest output level measured while she played. */
  peakOutput: number
  /** The barge-in threshold at the end of the run (noise floor × ratio, at least the minimum). */
  threshold: number
  /** A VAD with the while-she-talks values, fed the same frames, would have cut in. */
  bargeInFired: boolean
}

/** "Her voice reaches the mic at 42% of the barge-in threshold." */
export function echoVerdict(result: EchoResult): { percent: number; text: string; ok: boolean } {
  const percent = result.threshold > 0 ? Math.round((result.sustainedMic / result.threshold) * 100) : 0
  const ok = !result.bargeInFired && percent < 80
  const text = result.bargeInFired
    ? `Her voice reaches the mic at ${percent}% of the barge-in threshold, and it would interrupt her. Try the fallbacks below, in order.`
    : percent >= 80
      ? `Her voice reaches the mic at ${percent}% of the barge-in threshold: too close. Raise the while-she-talks values or try output gating.`
      : `Her voice reaches the mic at ${percent}% of the barge-in threshold. Echo cancellation is doing its job.`
  return { percent, text, ok }
}

/** Speech-like test signal (a voiced buzz in syllables) for when no reply has been heard yet. */
export function testSignal(sampleRate: number, seconds: number): Int16Array {
  const out = new Int16Array(Math.round(sampleRate * seconds))
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate
    const pitch = 160 + 25 * Math.sin(2 * Math.PI * 0.7 * t)
    let voice = 0
    for (let h = 1; h <= 6; h++) voice += Math.sin(2 * Math.PI * pitch * h * t) / h
    // ~4 syllables a second, with short gaps between words.
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t))
    const word = Math.sin(2 * Math.PI * 0.5 * t) > -0.6 ? 1 : 0
    out[i] = Math.round(Math.max(-1, Math.min(1, voice * 0.35 * syllable * word)) * 0x7fff)
  }
  return out
}
