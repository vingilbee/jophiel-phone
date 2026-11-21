// Copied verbatim from ../app/frontend/src/audio/vad.test.ts at web commit db6ba59. Keep in step with it.
import { describe, expect, test } from 'bun:test'
import { createVad, DEFAULT_VAD, type VadEvent } from './vad'

const RATE = 16_000
const FRAME = 128 // 8ms

function harness(minSpeechMs: number) {
  const events: Array<[VadEvent, number]> = []
  const vad = createVad(RATE, (e, ms) => events.push([e, ms]))
  vad.setMinSpeechMs(minSpeechMs)
  const feed = (ms: number, rms: number) => {
    for (let t = 0; t < ms; t += 8) vad.push(rms, FRAME)
  }
  return { vad, events, loud: (ms: number) => feed(ms, 0.2), quiet: (ms: number) => feed(ms, 0) }
}

describe('vad onset', () => {
  test('short dips between syllables do not restart the count', () => {
    const { events, loud, quiet } = harness(250)
    // Syllables of ~100ms with ~60ms dips: never 250ms unbroken.
    for (let i = 0; i < 3; i++) {
      loud(96)
      quiet(56)
    }
    expect(events.map(([e]) => e)).toEqual(['speech-start'])
  })

  test('a long enough gap does restart it', () => {
    const { events, loud, quiet } = harness(250)
    loud(160)
    quiet(DEFAULT_VAD.onsetGapMs + 16)
    loud(160)
    expect(events).toEqual([])
  })

  test('speech-start reports elapsed time since speech began, gaps included', () => {
    const { events, loud, quiet } = harness(250)
    loud(96)
    quiet(56)
    loud(96)
    quiet(56)
    loud(64) // 256ms loud in total; confirmed on this run
    const [[, ms]] = events
    expect(ms).toBeGreaterThanOrEqual(96 + 56 + 96 + 56 + 56)
    expect(ms).toBeLessThanOrEqual(96 + 56 + 96 + 56 + 64)
  })
})
