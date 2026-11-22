import { describe, expect, mock, test } from 'bun:test'
import { PhoneSenses, type SensesLink, type SensesNative } from './controller'
import { agoLabel, describeGroup, type LastReported } from './describe'
import { defaultSwitches, groupOf, switchedOff, type SenseSwitches } from './groups'
import { AWAY, checkPlaces, placeName, radiusLabel, reservedPlaceName, unreservedName } from './places'
import { changes, checkFields, checkValue, clip, effective } from './report'

// The settings store persists with AsyncStorage and reads expo-device: stand-ins, so migrate loads under bun.
mock.module('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} },
}))
mock.module('expo-device', () => ({ isDevice: true }))
const { migrate } = await import('../settings/store')

const ALL_ON = defaultSwitches()
const off = (...groups: (keyof SenseSwitches)[]): SenseSwitches => ({ ...ALL_ON, ...Object.fromEntries(groups.map((g) => [g, false])) })

describe('groups', () => {
  test('every field belongs to its group', () => {
    expect(groupOf('screen')).toBe('phoneUse')
    expect(groupOf('wifi_name')).toBe('network')
    expect(groupOf('dnd')).toBe('soundMode')
    expect(groupOf('place')).toBe('places')
  })

  test('switchedOff lists only on → off', () => {
    expect(switchedOff(ALL_ON, off('battery', 'places'))).toEqual(['battery', 'places'])
    expect(switchedOff(off('battery'), ALL_ON)).toEqual([])
  })
})

describe('values against the backend contract', () => {
  test('enums: only the allowed words', () => {
    expect(checkValue('screen', 'on')).toBe('on')
    expect(checkValue('screen', 'dim')).toBeUndefined()
    expect(checkValue('motion', 'vehicle')).toBe('vehicle')
    expect(checkValue('motion', 'tilting')).toBeUndefined()
    expect(checkValue('network', 'ethernet')).toBeUndefined()
  })

  test('booleans stay booleans; null means "no longer known"', () => {
    expect(checkValue('charging', true)).toBe(true)
    expect(checkValue('charging', 'yes')).toBeUndefined()
    expect(checkValue('locked', null)).toBeNull()
  })

  test('battery: an integer 0–100', () => {
    expect(checkValue('battery', 64.4)).toBe(64)
    expect(checkValue('battery', 101)).toBe(100)
    expect(checkValue('battery', -3)).toBe(0)
    expect(checkValue('battery', Number.NaN)).toBeUndefined()
    expect(checkValue('battery', '64')).toBeUndefined()
  })

  test('names: trimmed, cut to the limit by characters, never splitting an emoji', () => {
    expect(checkValue('wifi_name', '  Home  ')).toBe('Home')
    expect(checkValue('wifi_name', '')).toBeNull()
    expect((checkValue('wifi_name', 'x'.repeat(80)) as string).length).toBe(64)
    const emoji = '🏠'.repeat(70)
    const cut = checkValue('place', emoji) as string
    expect(Array.from(cut).length).toBe(60)
    expect(cut).toBe('🏠'.repeat(60))
    expect(clip('ab🏠', 3)).toBe('ab🏠')
  })

  test('checkFields drops unknown names and bad values (extra="forbid" on the server)', () => {
    expect(checkFields({ battery: 50, volume: 3, screen: 'dim', place: 'home' })).toEqual({ battery: 50, place: 'home' })
  })

  test('effective: a switched-off group reads null; unknown fields stay out', () => {
    expect(effective({ battery: 50, charging: true, screen: 'on' }, off('battery'))).toEqual({
      battery: null,
      charging: null,
      screen: 'on',
    })
  })

  test('changes: only what differs from what this socket was sent', () => {
    expect(changes({ battery: 50, charging: true }, { battery: 50 })).toEqual({ charging: true })
    expect(changes({ battery: 50 }, { battery: 49 })).toEqual({ battery: 50 })
    expect(changes({ place: null }, { place: null })).toEqual({})
    expect(changes({ place: null }, {})).toEqual({ place: null })
  })
})

/** A native module driven by hand. */
function fakeNative(snapshot: Record<string, unknown>) {
  let listener: ((fields: Record<string, unknown>, at: number) => void) | null = null
  const calls = { startLive: 0, stopLive: 0, noteSent: [] as unknown[], background: [] as unknown[] }
  const native: SensesNative = {
    snapshot: () => ({ ...snapshot }),
    startLive: () => void calls.startLive++,
    stopLive: () => void calls.stopLive++,
    noteSent: (fields, at) => void calls.noteSent.push({ fields, at }),
    sendInBackground: (fields, at) => void calls.background.push({ fields, at }),
    onChange: (l) => {
      listener = l
      return { remove: () => (listener = null) }
    },
  }
  return {
    native,
    calls,
    snapshot,
    emit: (fields: Record<string, unknown>, at: number) => listener?.(fields, at),
  }
}

/** A socket that sends through the controller like ChatConnection does. */
function fakeLink(senses: () => PhoneSenses) {
  const frames: unknown[] = []
  const state = { open: true, synced: false }
  const link: SensesLink = {
    isOpen: () => state.open,
    sendSense: () => {
      if (!state.open) return
      const full = !state.synced
      const phone = senses().report(full)
      frames.push(phone)
      state.synced = true
      if (phone) senses().markSent(phone, full)
    },
  }
  return { link, frames, state }
}

describe('phone senses controller', () => {
  const T0 = Date.parse('2026-11-21T10:00:00Z')

  function setup(snapshot: Record<string, unknown>, switches = ALL_ON) {
    let now = T0
    const fake = fakeNative(snapshot)
    const senses = new PhoneSenses(fake.native, switches, () => now)
    const socket = fakeLink(() => senses)
    senses.attach(socket.link)
    return { senses, fake, socket, advance: (ms: number) => (now += ms), now: () => now }
  }

  test('connect: the whole state; switched-off groups as null', () => {
    const { senses, socket } = setup({ screen: 'on', locked: false, battery: 64, charging: true, motion: 'walking' }, off('motion'))
    senses.setLive(true)
    socket.link.sendSense()
    expect(socket.frames[0]).toEqual({
      screen: 'on',
      locked: false,
      battery: 64,
      charging: true,
      motion: null,
      observed_at: '2026-11-21T10:00:00.000Z',
    })
  })

  test('afterwards only what changed, with when it was seen; nothing when nothing changed', () => {
    const { senses, fake, socket, advance } = setup({ screen: 'on', battery: 64 })
    senses.setLive(true)
    socket.link.sendSense()
    advance(60_000)
    fake.emit({ battery: 63, screen: 'on' }, Date.parse('2026-11-21T10:00:30Z'))
    expect(socket.frames[1]).toEqual({ battery: 63, observed_at: '2026-11-21T10:00:30.000Z' })
    // Another frame (activity changed): no phone object.
    socket.link.sendSense()
    expect(socket.frames[2]).toBeNull()
  })

  test('a same-value event sends nothing', () => {
    const { senses, fake, socket } = setup({ screen: 'on' })
    senses.setLive(true)
    socket.link.sendSense()
    fake.emit({ screen: 'on' }, T0)
    expect(socket.frames).toHaveLength(1)
  })

  test('sent values are noted for Settings ("last value sent")', () => {
    const { senses, fake, socket } = setup({ battery: 64 })
    senses.setLive(true)
    socket.link.sendSense()
    expect(fake.calls.noteSent).toEqual([{ fields: { battery: 64 }, at: T0 }])
  })

  test('not live: native events are ignored (the background path reports them)', () => {
    const { senses, fake, socket } = setup({ battery: 64 })
    socket.link.sendSense()
    fake.emit({ battery: 10 }, T0)
    expect(socket.frames).toHaveLength(1)
    senses.setLive(true)
    senses.setLive(false)
    expect(fake.calls.startLive).toBe(1)
    expect(fake.calls.stopLive).toBe(1)
  })

  test('live again on the same socket: every known field goes out again, changed or not', () => {
    // Backgrounded briefly (no call), back within the socket's grace: the server only counts as current what
    // the phone sent since it went live, so unchanged headphones must be sent again.
    const { senses, socket, advance } = setup({ battery: 64, headphones: true })
    senses.setLive(true)
    socket.link.sendSense()
    senses.setLive(false)
    advance(20_000)
    senses.setLive(true)
    socket.link.sendSense()
    expect(socket.frames[1]).toEqual({ battery: 64, headphones: true, observed_at: '2026-11-21T10:00:20.000Z' })
    socket.link.sendSense()
    expect(socket.frames[2]).toBeNull()
  })

  test('switching a group off sends null once over the socket', () => {
    const { senses, socket } = setup({ battery: 64, charging: false, screen: 'on' })
    senses.setLive(true)
    socket.link.sendSense()
    senses.setSwitches(off('battery'))
    expect(socket.frames[1]).toEqual({ battery: null, charging: null, observed_at: '2026-11-21T10:00:00.000Z' })
    socket.link.sendSense()
    expect(socket.frames[2]).toBeNull()
  })

  test('…and its new values stop going out', () => {
    const { senses, fake, socket } = setup({ battery: 64 })
    senses.setLive(true)
    socket.link.sendSense()
    senses.setSwitches(off('battery'))
    fake.emit({ battery: 50 }, T0)
    expect(socket.frames).toHaveLength(2)
  })

  test('switching off with no socket: the nulls go by background PUT', () => {
    const { senses, fake, socket } = setup({ battery: 64 })
    socket.state.open = false
    senses.setSwitches(off('places', 'motion'))
    expect(fake.calls.background).toEqual([{ fields: { motion: null, place: null }, at: T0 }])
  })

  test('switching a group back on sends its current values', () => {
    const { senses, socket } = setup({ battery: 64 }, off('battery'))
    senses.setLive(true)
    socket.link.sendSense()
    senses.setSwitches(ALL_ON)
    expect(socket.frames[1]).toEqual({ battery: 64, observed_at: '2026-11-21T10:00:00.000Z' })
  })

  test('a new socket gets the whole state again', () => {
    const { senses, fake, socket } = setup({ battery: 64 })
    senses.setLive(true)
    socket.link.sendSense()
    socket.state.synced = false
    fake.snapshot.battery = 60
    socket.link.sendSense()
    expect(socket.frames[1]).toMatchObject({ battery: 60 })
  })

  // Review of PR #5: privacy switches.
  test('a switch-off clear is stamped now, never older than the reconnect that re-confirmed the value', () => {
    // Arrived home at 10:00; reconnected at 10:30 (whole state, place re-confirmed); Places off at 10:31.
    const { senses, fake, socket, advance } = setup({})
    senses.setLive(true)
    socket.link.sendSense()
    fake.emit({ place: 'home' }, T0)
    advance(30 * 60_000)
    fake.snapshot.place = 'home'
    socket.state.synced = false
    socket.link.sendSense()
    expect(socket.frames[2]).toMatchObject({ place: 'home', observed_at: '2026-11-21T10:30:00.000Z' })
    advance(60_000)
    senses.setSwitches(off('places'))
    expect(socket.frames[3]).toEqual({ place: null, observed_at: '2026-11-21T10:31:00.000Z' })
  })

  test('a reading older than the reconnect snapshot is dropped, not sent as if it were newer', () => {
    // Snapshot at 10:01 reads 64 %; a delayed callback then reports 63 % seen at 10:00.
    const { senses, fake, socket, advance } = setup({ battery: 64 })
    senses.setLive(true)
    advance(60_000)
    socket.link.sendSense()
    expect(socket.frames[0]).toMatchObject({ battery: 64, observed_at: '2026-11-21T10:01:00.000Z' })
    fake.emit({ battery: 63 }, T0)
    expect(socket.frames).toHaveLength(1)
    expect(senses.report(false)).toBeNull()
    // A newer reading still goes out, with its own time.
    advance(60_000)
    fake.emit({ battery: 62 }, T0 + 2 * 60_000)
    expect(socket.frames[1]).toEqual({ battery: 62, observed_at: '2026-11-21T10:02:00.000Z' })
  })

  test('an unchanged value re-read by the snapshot still counts as confirmed then', () => {
    const { senses, fake, socket, advance } = setup({ battery: 64 })
    senses.setLive(true) // 64 % seen at 10:00
    fake.emit({ battery: 64 }, T0)
    advance(60_000)
    socket.link.sendSense() // re-read at 10:01, same value
    fake.emit({ battery: 63 }, T0 + 30_000) // seen at 10:00:30, before that re-read
    expect(socket.frames).toHaveLength(1)
  })

  test('Places back on: the place from before the switch-off is not sent again', () => {
    const { senses, fake, socket } = setup({})
    senses.setLive(true)
    socket.link.sendSense()
    fake.emit({ place: 'home' }, T0)
    senses.setSwitches(off('places'))
    expect(socket.frames.at(-1)).toMatchObject({ place: null })
    // Native forgot it too (configure ran first), so the snapshot has no place.
    senses.setSwitches(ALL_ON)
    // The frame for the switch-on carries no phone object: there's nothing fresh to say.
    expect(socket.frames.at(-1)).toBeNull()
    expect(senses.report(false)).toBeNull()
    // The fresh fix arrives: that's what goes out.
    fake.emit({ place: 'the gym' }, T0 + 1)
    expect(socket.frames.at(-1)).toMatchObject({ place: 'the gym' })
  })

  test('…nor by the next reconnect, when the native side no longer knows it', () => {
    const { senses, fake, socket } = setup({ place: 'home' })
    senses.setLive(true)
    socket.link.sendSense()
    delete fake.snapshot.place
    socket.state.synced = false
    socket.link.sendSense()
    expect(socket.frames.at(-1)).not.toHaveProperty('place')
  })

  test('live fields survive a switch off and on (their readers keep running)', () => {
    const { senses, socket } = setup({ battery: 64 })
    senses.setLive(true)
    socket.link.sendSense()
    senses.setSwitches(off('battery'))
    senses.setSwitches(ALL_ON)
    expect(socket.frames.at(-1)).toMatchObject({ battery: 64 })
  })

  test('no native module (old build): no phone object at all', () => {
    const senses = new PhoneSenses(null, ALL_ON)
    senses.setLive(true)
    expect(senses.report(true)).toBeNull()
    expect(senses.isLive()).toBe(false)
  })

  test('reset (sign-out) stops live and forgets', () => {
    const { senses, fake, socket } = setup({ battery: 64 })
    senses.setLive(true)
    socket.link.sendSense()
    senses.reset()
    expect(senses.isLive()).toBe(false)
    expect(fake.calls.stopLive).toBe(1)
    fake.snapshot.battery = undefined
    delete fake.snapshot.battery
    expect(senses.report(false)).toBeNull()
  })
})

describe('places', () => {
  test('names: trimmed, single spaces, at most 60 characters, empty is no name', () => {
    expect(placeName('  the   gym ')).toBe('the gym')
    expect(placeName('   ')).toBeNull()
    expect(reservedPlaceName('Away')).toBe(true)
    expect(reservedPlaceName('away from home')).toBe(false)
    expect(AWAY).toBe('away')
    expect(unreservedName('home')).toBe('home')
    // A place an older version saved as "away" loads renamed, so entering it is never heard as leaving.
    const [legacy] = checkPlaces([{ id: 'p1', name: 'Away', latitude: 1, longitude: 2, radius: 100 }])
    expect(legacy?.name).toBe('Away (place)')
    expect(placeName('a'.repeat(70))).toHaveLength(60)
  })

  test('stored places: invalid ones and duplicates dropped, sizes kept in range', () => {
    const places = checkPlaces([
      { id: 'a', name: 'home', latitude: -6.2, longitude: 106.8, radius: 150 },
      { id: 'a', name: 'dupe', latitude: 0, longitude: 0, radius: 150 },
      { id: 'b', name: 'far', latitude: 95, longitude: 0, radius: 150 },
      { id: 'c', name: '', latitude: 0, longitude: 0, radius: 150 },
      { id: 'd', name: 'tiny', latitude: 0, longitude: 0, radius: 3 },
      'junk',
    ])
    expect(places).toEqual([
      { id: 'a', name: 'home', latitude: -6.2, longitude: 106.8, radius: 150 },
      { id: 'd', name: 'tiny', latitude: 0, longitude: 0, radius: 50 },
    ])
    expect(checkPlaces('nope')).toEqual([])
  })

  test('size labels', () => {
    expect(radiusLabel(150)).toBe('150 m')
    expect(radiusLabel(1000)).toBe('1 km')
    expect(radiusLabel(1500)).toBe('1.5 km')
  })
})

describe('settings: the phase 6 fields', () => {
  test('defaults: every group on, no places', () => {
    const settings = migrate(null)
    expect(settings.senses).toEqual(ALL_ON)
    expect(settings.places).toEqual([])
  })

  test('older settings get the new fields, and keep theirs', () => {
    const settings = migrate({ version: 1, serverUrl: 'https://mac.ts.net', setupSeen: true })
    expect(settings.serverUrl).toBe('https://mac.ts.net')
    expect(settings.senses).toEqual(ALL_ON)
    expect(settings.places).toEqual([])
  })

  test('stored switches merge over the defaults; junk is ignored', () => {
    const settings = migrate({ senses: { battery: false, motion: 'no', volume: false } })
    expect(settings.senses).toEqual({ ...ALL_ON, battery: false })
    expect(migrate({ senses: [false] }).senses).toEqual(ALL_ON)
  })

  test('stored places are checked one by one', () => {
    const settings = migrate({ places: [{ id: 'a', name: 'home', latitude: 1, longitude: 2, radius: 150 }, { id: 'b' }] })
    expect(settings.places).toEqual([{ id: 'a', name: 'home', latitude: 1, longitude: 2, radius: 150 }])
    expect(migrate({ places: { id: 'a' } }).places).toEqual([])
  })
})

describe('what Settings shows', () => {
  const now = Date.parse('2026-11-21T10:10:00Z')
  const sent = (value: unknown, minutesAgo: number, sinceMinutesAgo = minutesAgo) => ({
    value,
    at: now - minutesAgo * 60_000,
    since: now - sinceMinutesAgo * 60_000,
  })

  test('battery: level, charging, and how long ago', () => {
    const last: LastReported = { battery: sent(64, 2), charging: sent(true, 5) }
    expect(describeGroup('battery', last, now)).toBe('Battery 64 %, charging · 2 min ago')
  })

  test('place: the name and since when', () => {
    const last: LastReported = { place: sent('home', 1, 8) }
    const since = new Date(now - 8 * 60_000)
    const hhmm = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`
    expect(describeGroup('places', last, now)).toBe(`Place: home · since ${hhmm}`)
    expect(describeGroup('places', { place: sent(AWAY, 1) }, now)).toMatch(/^Not at a saved place · since /)
    expect(describeGroup('places', { place: sent(null, 1) }, now)).toMatch(/^Place not known · since /)
  })

  test('network and sound mode in words', () => {
    expect(describeGroup('network', { network: sent('wifi', 0), wifi_name: sent('Home-5G', 0) }, now)).toBe('Wi-Fi “Home-5G” · just now')
    expect(describeGroup('network', { network: sent('cellular', 0), wifi_name: sent(null, 0) }, now)).toBe('Mobile data · just now')
    expect(describeGroup('soundMode', { ringer: sent('vibrate', 3), dnd: sent(true, 3) }, now)).toBe('Vibrate, Do Not Disturb on · 3 min ago')
    expect(describeGroup('phoneUse', { screen: sent('off', 1), locked: sent(true, 1) }, now)).toBe('Screen off, locked · 1 min ago')
  })

  test('nothing sent yet, or only nulls: null', () => {
    expect(describeGroup('battery', {}, now)).toBeNull()
    expect(describeGroup('motion', { motion: sent(null, 1) }, now)).toBeNull()
  })

  test('ago labels', () => {
    expect(agoLabel(now - 20_000, now)).toBe('just now')
    expect(agoLabel(now - 4 * 60_000, now)).toBe('4 min ago')
    expect(agoLabel(now - 3 * 3600_000, now)).toBe('3 h ago')
  })
})
