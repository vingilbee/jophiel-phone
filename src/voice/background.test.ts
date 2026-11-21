import { describe, expect, mock, test } from 'bun:test'
import { callNotificationAction, callNotificationText } from './callNotification'
import { createClock, type NativeClock } from './clock'
import { createPcmPlayer, type PlaybackNative } from './player'

// The settings and tuning stores persist with AsyncStorage and read expo-device: stand-ins, so the
// pure parts (migrate, sanitize) load under bun.
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}))
mock.module('expo-device', () => ({ isDevice: true }))
const { migrate } = await import('../settings/store')
const { DEFAULT_TUNING, sanitizeTuning } = await import('./tuning')

/** A native clock driven by hand: `advance(ms)` fires what's due, in order. */
function fakeNative() {
  let now = 0
  const due = new Map<number, number>()
  let listener: ((id: number) => void) | null = null
  const native: NativeClock = {
    setTimer: (id, ms) => due.set(id, now + ms),
    clearTimer: (id) => due.delete(id),
    onTimer: (l) => {
      listener = l
      return { remove: () => (listener = null) }
    },
  }
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const next = [...due.entries()].filter(([, at]) => at <= until).sort((a, b) => a[1] - b[1])[0]
      if (!next) break
      now = next[1]
      due.delete(next[0])
      listener?.(next[0])
    }
    now = until
  }
  return { native, advance, pending: () => due.size }
}

describe('native clock', () => {
  test('fires once after the delay', () => {
    const { native, advance } = fakeNative()
    const clock = createClock(native)
    let fired = 0
    clock.setTimeout(() => fired++, 1000)
    advance(999)
    expect(fired).toBe(0)
    advance(1)
    expect(fired).toBe(1)
    advance(5000)
    expect(fired).toBe(1)
  })

  test('clearTimeout cancels, also natively', () => {
    const { native, advance, pending } = fakeNative()
    const clock = createClock(native)
    let fired = false
    const handle = clock.setTimeout(() => (fired = true), 100)
    clock.clearTimeout(handle)
    expect(pending()).toBe(0)
    advance(1000)
    expect(fired).toBe(false)
    clock.clearTimeout(null)
    clock.clearTimeout(handle)
  })

  test('a timer set from a callback runs (a chain)', () => {
    const { native, advance } = fakeNative()
    const clock = createClock(native)
    let ticks = 0
    const tick = () => clock.setTimeout(() => {
      ticks++
      tick()
    }, 5000)
    tick()
    advance(30_000)
    expect(ticks).toBe(6)
  })

  test('handles are distinct', () => {
    const { native, advance } = fakeNative()
    const clock = createClock(native)
    const order: string[] = []
    const a = clock.setTimeout(() => order.push('a'), 10)
    clock.setTimeout(() => order.push('b'), 20)
    expect(a).not.toBe(clock.setTimeout(() => order.push('c'), 5))
    advance(30)
    expect(order).toEqual(['c', 'a', 'b'])
  })
})

describe('player done backstop on the injected clock', () => {
  test('waitUntilDone resolves from the poll when no drained event comes', async () => {
    const { native: clockNative, advance } = fakeNative()
    let played = 0
    const native: PlaybackNative = {
      enqueue: (pcm, _rate, lead) => lead,
      pause: () => {},
      resume: () => {},
      stopPlayback: () => {},
      playedFrames: () => played,
      level: () => 0,
      onDrained: () => ({ remove: () => {} }),
      clock: createClock(clockNative),
    }
    const player = createPcmPlayer(native)
    player.enqueue(new Int16Array(2400), 24000)
    let done = false
    void player.waitUntilDone().then(() => (done = true))
    advance(1000)
    await Promise.resolve()
    expect(done).toBe(false)
    played = 1_000_000
    advance(250)
    await Promise.resolve()
    expect(done).toBe(true)
  })
})

describe('call notification', () => {
  const base = { state: 'idle' as const, muted: false, reconnecting: false, pausedForCall: false, holding: false }

  test('state in words', () => {
    expect(callNotificationText({ ...base, state: 'listening' })).toBe('Listening')
    expect(callNotificationText({ ...base, state: 'thinking' })).toBe('Thinking')
    expect(callNotificationText({ ...base, state: 'speaking' })).toBe('Speaking')
    expect(callNotificationText({ ...base, muted: true })).toBe('Muted')
    expect(callNotificationText({ ...base, reconnecting: true, muted: true })).toBe('Reconnecting…')
    expect(callNotificationText({ ...base, pausedForCall: true, muted: true })).toBe('Paused for a call')
  })

  test('one context action, hidden while listening', () => {
    expect(callNotificationAction({ ...base, state: 'speaking' })).toBe('interrupt')
    expect(callNotificationAction({ ...base, state: 'thinking' })).toBe('interrupt')
    expect(callNotificationAction({ ...base, state: 'listening', holding: true })).toBe('interrupt')
    expect(callNotificationAction(base)).toBe('talk')
    expect(callNotificationAction({ ...base, muted: true })).toBeNull()
    expect(callNotificationAction({ ...base, state: 'listening' })).toBeNull()
    expect(callNotificationAction({ ...base, pausedForCall: true })).toBeNull()
    expect(callNotificationAction({ ...base, reconnecting: true })).toBeNull()
  })
})

describe('phase 5 settings', () => {
  test('new fields get their defaults on stored phase 4 settings', () => {
    const settings = migrate({ version: 1, serverUrl: 'http://x', setupSeen: true, lastConnectedAt: null })
    expect(settings.keepListeningInBackground).toBe(true)
    expect(settings.batteryPromptShown).toBe(false)
    expect(settings.serverUrl).toBe('http://x')
  })

  test('stored values are kept', () => {
    const settings = migrate({ version: 1, keepListeningInBackground: false, batteryPromptShown: true })
    expect(settings.keepListeningInBackground).toBe(false)
    expect(settings.batteryPromptShown).toBe(true)
  })

  test('background limits default to 30 min and 2 min', () => {
    expect(DEFAULT_TUNING.backgroundQuietMs).toBe(30 * 60_000)
    expect(DEFAULT_TUNING.backgroundOfflineMs).toBe(2 * 60_000)
    expect(sanitizeTuning({ backgroundQuietMs: 60_000 }).backgroundQuietMs).toBe(60_000)
  })
})
