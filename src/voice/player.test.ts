import { describe, expect, test } from 'bun:test'
import { createPcmPlayer, MAX_LEAD_S, START_LEAD_S, type PlaybackNative } from './player'

const RATE = 24_000

/** A native track: queued frames play when the test advances the clock. */
function fakeNative() {
  const state = { accepted: 0, played: 0, paused: false, stops: 0, leads: [] as number[], drained: [] as Array<() => void> }
  const native: PlaybackNative = {
    enqueue(pcm, _rate, leadFrames) {
      state.leads.push(leadFrames)
      const start = state.accepted + leadFrames
      state.accepted = start + pcm.byteLength / 2
      return start
    },
    pause: () => { state.paused = true },
    resume: () => { state.paused = false },
    stopPlayback: () => { state.stops++; state.accepted = 0; state.played = 0; state.paused = false },
    playedFrames: () => state.played,
    level: () => 0.3,
    onDrained(listener) {
      state.drained.push(listener)
      return { remove: () => { state.drained = state.drained.filter((l) => l !== listener) } }
    },
  }
  const advance = (frames: number) => {
    if (state.paused) return
    state.played = Math.min(state.accepted, state.played + frames)
    if (state.played >= state.accepted) state.drained.forEach((l) => l())
  }
  return { native, state, advance }
}

const chunk = (frames: number) => new Int16Array(frames)

describe('pcm player', () => {
  test('first chunk gets the start cushion, the next one plays right behind it', () => {
    const { native, state } = fakeNative()
    const player = createPcmPlayer(native)
    expect(player.enqueue(chunk(2400), RATE)).toBeCloseTo(START_LEAD_S)
    expect(player.enqueue(chunk(2400), RATE)).toBeCloseTo(START_LEAD_S + 0.1)
    expect(state.leads).toEqual([Math.round(START_LEAD_S * RATE), 0])
    expect(player.playing).toBe(true)
  })

  test('an underrun mid-reply doubles the cushion, up to the maximum', () => {
    const { native, state, advance } = fakeNative()
    const player = createPcmPlayer(native)
    let lead = START_LEAD_S
    player.enqueue(chunk(240), RATE)
    for (let i = 0; i < 5; i++) {
      advance(1_000_000)
      player.enqueue(chunk(240), RATE)
      lead = Math.min(lead * 2, MAX_LEAD_S)
      expect(state.leads.at(-1)).toBe(Math.round(lead * RATE))
    }
    expect(lead).toBe(MAX_LEAD_S)
  })

  test('a new reply after a stop starts from the short cushion again', () => {
    const { native, state, advance } = fakeNative()
    const player = createPcmPlayer(native)
    player.enqueue(chunk(240), RATE)
    advance(1_000_000)
    player.enqueue(chunk(240), RATE)
    player.stop()
    player.enqueue(chunk(240), RATE)
    expect(state.leads.at(-1)).toBe(Math.round(START_LEAD_S * RATE))
    expect(state.stops).toBe(1)
  })

  test('heard text follows the clock through segments and freezes while paused', () => {
    const { native, advance } = fakeNative()
    const player = createPcmPlayer(native)
    player.beginSegment(0, 0, 10)
    player.enqueue(chunk(RATE), RATE) // starts after the cushion
    player.beginSegment(1, 10, 30)
    player.enqueue(chunk(RATE), RATE)
    const lead = Math.round(START_LEAD_S * RATE)
    expect(player.heardTextEnd()).toBe(0)
    advance(lead + RATE / 2)
    expect(player.heardTextEnd()).toBe(5)
    advance(RATE / 2 + RATE / 4)
    expect(player.heardTextEnd()).toBe(15)
    player.pause()
    advance(RATE)
    expect(player.heardTextEnd()).toBe(15)
    expect(player.level).toBe(0)
    player.resume()
    expect(player.level).toBe(0.3)
  })

  test('no segment labels: heard is unknown', () => {
    const { native } = fakeNative()
    const player = createPcmPlayer(native)
    player.enqueue(chunk(240), RATE)
    expect(player.heardTextEnd()).toBeNull()
  })

  test('waitUntilDone resolves when the queue drains, or at once after stop', async () => {
    const { native, advance } = fakeNative()
    const player = createPcmPlayer(native)
    expect(player.playing).toBe(false)
    await player.waitUntilDone()
    player.enqueue(chunk(240), RATE)
    let done = false
    void player.waitUntilDone().then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    advance(1_000_000)
    await Promise.resolve()
    expect(done).toBe(true)
    player.enqueue(chunk(240), RATE)
    let stopped = false
    void player.waitUntilDone().then(() => { stopped = true })
    player.stop()
    await Promise.resolve()
    expect(stopped).toBe(true)
    player.close()
  })

  test('empty chunks are ignored', () => {
    const { native, state } = fakeNative()
    const player = createPcmPlayer(native)
    expect(player.enqueue(chunk(0), RATE)).toBeNull()
    expect(state.leads).toEqual([])
  })
})
