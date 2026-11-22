import { describe, expect, test } from 'bun:test'
import { parsePushData } from '../push/plan'
import { destinationTitle, mapsUrl } from './maps'
import { DEFAULT_LIFETIME_MS, isExpired, navigateArgs, parseAction, resultFrame, type ActionResult, type NavigateArgs, type PhoneAction } from './protocol'
import { SEEN_KEEP, seenIds, type SeenStorage } from './seen'
import { precheck, retryDelay, RETRY_DELAYS_MS, runAction, type ActionDeps, type PositionAnswer } from './run'

const NOW = Date.parse('2026-11-21T10:00:00.000Z')
const LATER = '2026-11-21T10:01:00.000Z'

function action(partial: Partial<PhoneAction> = {}): PhoneAction {
  return { actionId: 'a1', action: 'navigate_to', args: { name: 'Kemang Village', lat: -6.26, lng: 106.81, mode: 'drive' }, expiresAt: NOW + 60_000, ...partial }
}

function nav(partial: Partial<NavigateArgs> = {}): NavigateArgs {
  return { name: 'Kemang Village', lat: -6.26, lng: 106.81, query: null, mode: 'drive', placeId: null, ...partial }
}

describe('parseAction', () => {
  test('a frame: args as an object, expires_at read', () => {
    const parsed = parseAction({ type: 'phone_action', action_id: 'a1', action: 'navigate_to', args: { lat: 1, lng: 2 }, expires_at: LATER }, NOW)
    expect(parsed).toEqual({ actionId: 'a1', action: 'navigate_to', args: { lat: 1, lng: 2 }, expiresAt: Date.parse(LATER) })
  })

  test('a push: every value a string, args as JSON text', () => {
    const push = parsePushData(
      { type: 'phone_action', action_id: 'a2', action: 'get_position', args: '{}', expires_at: LATER },
      NOW,
    )
    expect(push).toEqual({ type: 'phone_action', action: { actionId: 'a2', action: 'get_position', args: {}, expiresAt: Date.parse(LATER) } })
  })

  test('broken args become empty; no expires_at lives a minute from now', () => {
    expect(parseAction({ action_id: 'a3', action: 'navigate_to', args: '{nope' }, NOW)).toEqual({
      actionId: 'a3',
      action: 'navigate_to',
      args: {},
      expiresAt: NOW + DEFAULT_LIFETIME_MS,
    })
  })

  test('no id or no action name is not an action', () => {
    expect(parseAction({ action: 'navigate_to' }, NOW)).toBeNull()
    expect(parseAction({ action_id: 'a4', action: '' }, NOW)).toBeNull()
    expect(parsePushData({ type: 'phone_action', action: 'navigate_to' }, NOW)).toBeNull()
  })

  test('message pushes still parse as before', () => {
    expect(parsePushData({ type: 'message', message_id: 'm1', conversation_id: 'c1' })).toEqual({
      type: 'message',
      conversationId: 'c1',
      messageId: 'm1',
      text: null,
    })
  })

  test('expiry is strictly after expires_at', () => {
    expect(isExpired(action(), NOW + 60_000)).toBe(false)
    expect(isExpired(action(), NOW + 60_001)).toBe(true)
  })

  test('the result frame', () => {
    expect(resultFrame('a1', { status: 'notified', reason: 'locked' })).toEqual({
      type: 'phone_action_result',
      action_id: 'a1',
      status: 'notified',
      reason: 'locked',
    })
  })
})

describe('navigateArgs', () => {
  test('coordinates, name, mode', () => {
    expect(navigateArgs({ name: ' Kemang Village ', lat: -6.26, lng: 106.81, mode: 'walk', place_id: 'ChIJ1' })).toEqual(
      nav({ mode: 'walk', placeId: 'ChIJ1' }),
    )
  })

  test('car when the mode is missing or unknown', () => {
    expect(navigateArgs({ lat: 1, lng: 2 })?.mode).toBe('drive')
    expect(navigateArgs({ lat: 1, lng: 2, mode: 'rocket' })?.mode).toBe('drive')
  })

  test('a query alone is enough; half a coordinate is dropped', () => {
    expect(navigateArgs({ query: 'Kimia Farma Kemang', lat: 1 })).toEqual(nav({ name: null, lat: null, lng: null, query: 'Kimia Farma Kemang' }))
  })

  test('nothing to go to', () => {
    expect(navigateArgs({ name: 'x' })).toBeNull()
    expect(navigateArgs({ lat: 91, lng: 0 })).toBeNull()
    expect(navigateArgs({ lat: Number.NaN, lng: 0, query: '  ' })).toBeNull()
  })
})

describe('mapsUrl', () => {
  test('turn-by-turn per mode', () => {
    expect(mapsUrl(nav())).toBe('google.navigation:q=-6.26,106.81&mode=d')
    expect(mapsUrl(nav({ mode: 'two_wheeler' }))).toBe('google.navigation:q=-6.26,106.81&mode=l')
    expect(mapsUrl(nav({ mode: 'walk' }))).toBe('google.navigation:q=-6.26,106.81&mode=w')
    expect(mapsUrl(nav({ mode: 'bicycle' }))).toBe('google.navigation:q=-6.26,106.81&mode=b')
  })

  test('transit goes through a Maps URL, with the place id when known', () => {
    expect(mapsUrl(nav({ mode: 'transit', placeId: 'ChIJ1' }))).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=-6.26%2C106.81&destination_place_id=ChIJ1&travelmode=transit&dir_action=navigate',
    )
  })

  test('a text destination without coordinates', () => {
    expect(mapsUrl(nav({ lat: null, lng: null, query: 'Kimia Farma & Co', mode: 'two_wheeler' }))).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=Kimia%20Farma%20%26%20Co&travelmode=two-wheeler&dir_action=navigate',
    )
  })

  test('the notification names the place, else the query', () => {
    expect(destinationTitle(nav())).toBe('Kemang Village')
    expect(destinationTitle(nav({ name: null, query: 'the pharmacy' }))).toBe('the pharmacy')
  })
})

describe('precheck', () => {
  const on = { actionsEnabled: true, placesOn: true }

  test('in order: expired, the master switch, the Places group', () => {
    expect(precheck(action(), NOW + 61_000, { actionsEnabled: false, placesOn: false })).toEqual({ status: 'expired' })
    expect(precheck(action({ action: 'get_position' }), NOW, { actionsEnabled: false, placesOn: false })).toEqual({
      status: 'refused',
      reason: 'switched_off',
    })
    expect(precheck(action({ action: 'get_position' }), NOW, { actionsEnabled: true, placesOn: false })).toEqual({
      status: 'refused',
      reason: 'places_off',
    })
  })

  test('the Places group does not block navigation', () => {
    expect(precheck(action(), NOW, { actionsEnabled: true, placesOn: false })).toBeNull()
    expect(precheck(action({ action: 'get_position' }), NOW, on)).toBeNull()
  })
})

function fakeDeps(partial: Partial<ActionDeps> = {}) {
  const delivered: [string, ActionResult][] = []
  const opened: [string, string][] = []
  const claimed = new Set<string>()
  const deps: ActionDeps = {
    now: () => NOW,
    claim: async (id) => {
      if (claimed.has(id)) return false
      claimed.add(id)
      return true
    },
    switches: async () => ({ actionsEnabled: true, placesOn: true }),
    openMaps: async (url, title) => {
      opened.push([url, title])
      return { status: 'done', reason: null }
    },
    position: async (): Promise<PositionAnswer> => ({ latitude: -6.2, longitude: 106.8, accuracy: 12.4, fixAt: NOW - 5_000 }),
    places: async () => [
      { id: 'p1', name: 'Work', latitude: 49.21, longitude: -123.1, radius: 150 },
      { id: 'p2', name: 'Gym', latitude: 49.2, longitude: -123.11, radius: 150 },
      { id: 'p3', name: 'gym ', latitude: 49.3, longitude: -123.2, radius: 150 },
    ],
    deliver: async (a, result) => {
      delivered.push([a.actionId, result])
    },
    ...partial,
  }
  return { deps, delivered, opened }
}

describe('runAction', () => {
  test('navigate_to opens Maps and answers done once; a repeat is ignored', async () => {
    const { deps, delivered, opened } = fakeDeps()
    expect(await runAction(action(), deps)).toEqual({ status: 'done' })
    expect(await runAction(action(), deps)).toBeNull()
    expect(opened).toEqual([['google.navigation:q=-6.26,106.81&mode=d', 'Kemang Village']])
    expect(delivered).toEqual([['a1', { status: 'done' }]])
  })

  test('a notification instead of Maps keeps its reason', async () => {
    const { deps, delivered } = fakeDeps({ openMaps: async () => ({ status: 'notified', reason: 'locked' }) })
    await runAction(action(), deps)
    expect(delivered).toEqual([['a1', { status: 'notified', reason: 'locked' }]])
  })

  test('switched off: nothing opens, refused', async () => {
    const { deps, delivered, opened } = fakeDeps({ switches: async () => ({ actionsEnabled: false, placesOn: true }) })
    await runAction(action(), deps)
    expect(opened).toEqual([])
    expect(delivered).toEqual([['a1', { status: 'refused', reason: 'switched_off' }]])
  })

  test('a late push is answered expired, Maps stays closed', async () => {
    const { deps, delivered, opened } = fakeDeps({ now: () => NOW + 120_000 })
    await runAction(action(), deps)
    expect(opened).toEqual([])
    expect(delivered).toEqual([['a1', { status: 'expired' }]])
  })

  test('get_position answers the fix (rounded accuracy, ISO time)', async () => {
    const { deps, delivered } = fakeDeps()
    await runAction(action({ action: 'get_position', args: {} }), deps)
    expect(delivered).toEqual([
      ['a1', { status: 'done', data: { lat: -6.2, lng: 106.8, accuracy_m: 12, fix_at: new Date(NOW - 5_000).toISOString() } }],
    ])
  })

  test('get_position: no permission and location off are refusals, no fix a failure', async () => {
    for (const [error, status] of [
      ['no_permission', 'refused'],
      ['location_off', 'refused'],
      ['no_fix', 'failed'],
    ] as const) {
      const { deps, delivered } = fakeDeps({ position: async () => ({ error }) })
      await runAction(action({ action: 'get_position', args: {} }), deps)
      expect(delivered).toEqual([['a1', { status, reason: error }]])
    }
  })

  test('resolve_saved_place: the centre of the one match, else not_found / ambiguous', async () => {
    const resolve = (name: unknown) => action({ action: 'resolve_saved_place', args: { name } })
    for (const [name, result] of [
      ['  WORK ', { status: 'done', data: { lat: 49.21, lng: -123.1 } }],
      ['school', { status: 'failed', reason: 'not_found' }],
      ['Gym', { status: 'failed', reason: 'ambiguous' }],
      ['  ', { status: 'failed', reason: 'bad_args' }],
      [undefined, { status: 'failed', reason: 'bad_args' }],
    ] as const) {
      const { deps, delivered } = fakeDeps()
      await runAction(resolve(name), deps)
      expect(delivered).toEqual([['a1', result]])
    }
  })

  test('resolve_saved_place is refused with Places off', async () => {
    const { deps, delivered } = fakeDeps({ switches: async () => ({ actionsEnabled: true, placesOn: false }) })
    await runAction(action({ action: 'resolve_saved_place', args: { name: 'work' } }), deps)
    expect(delivered).toEqual([['a1', { status: 'refused', reason: 'places_off' }]])
  })

  test('unknown actions and bad args fail; a throw fails too', async () => {
    const unknown = fakeDeps()
    await runAction(action({ action: 'play_music' }), unknown.deps)
    expect(unknown.delivered).toEqual([['a1', { status: 'failed', reason: 'unknown_action' }]])

    const bad = fakeDeps()
    await runAction(action({ args: { name: 'nowhere' } }), bad.deps)
    expect(bad.delivered).toEqual([['a1', { status: 'failed', reason: 'bad_args' }]])

    const throwing = fakeDeps({ openMaps: async () => Promise.reject(new Error('boom')) })
    await runAction(action(), throwing.deps)
    expect(throwing.delivered).toEqual([['a1', { status: 'failed', reason: 'error' }]])
  })

  test('expiry is checked after the settings load, not before', async () => {
    let clock = NOW
    const { deps, delivered, opened } = fakeDeps({
      now: () => clock,
      switches: async () => {
        clock = NOW + 120_000 // a slow cold start, past the action's 60 s
        return { actionsEnabled: true, placesOn: true }
      },
    })
    await runAction(action(), deps)
    expect(opened).toEqual([])
    expect(delivered).toEqual([['a1', { status: 'expired' }]])
  })

  test('a local (developer) action is never claimed or answered', async () => {
    const { deps, delivered, opened } = fakeDeps()
    expect(await runAction(action({ local: true }), deps)).toEqual({ status: 'done' })
    expect(await runAction(action({ local: true }), deps)).toEqual({ status: 'done' })
    expect(opened).toHaveLength(2)
    expect(delivered).toEqual([])
  })
})

function memoryStorage(initial: string | null = null) {
  let value = initial
  const writes: string[] = []
  const storage: SeenStorage = {
    getItem: async () => {
      await Promise.resolve()
      return value
    },
    setItem: async (_key, next) => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      value = next
      writes.push(next)
    },
  }
  return { storage, value: () => value, writes }
}

describe('seenIds', () => {
  test('two different ids claimed together are both kept', async () => {
    const memory = memoryStorage()
    const claim = seenIds(memory.storage)
    expect(await Promise.all([claim('a'), claim('b')])).toEqual([true, true])
    expect(JSON.parse(memory.value() ?? '[]')).toEqual(['a', 'b'])
  })

  test('the same id twice, now or from an earlier run, passes once', async () => {
    const claim = seenIds(memoryStorage().storage)
    expect(await Promise.all([claim('a'), claim('a')])).toEqual([true, false])
    const later = seenIds(memoryStorage(JSON.stringify(['a'])).storage)
    expect(await later('a')).toBe(false)
    expect(await later('b')).toBe(true)
  })

  test(`keeps the last ${SEEN_KEEP}; unreadable storage starts empty`, async () => {
    const memory = memoryStorage(JSON.stringify(Array.from({ length: SEEN_KEEP }, (_, i) => `old${i}`)))
    await seenIds(memory.storage)('new')
    const kept = JSON.parse(memory.value() ?? '[]') as string[]
    expect(kept).toHaveLength(SEEN_KEEP)
    expect(kept.at(-1)).toBe('new')
    expect(kept).not.toContain('old0')
    expect(await seenIds(memoryStorage('not json').storage)('a')).toBe(true)
  })
})

describe('retryDelay', () => {
  test('backs off, then gives up', () => {
    expect(RETRY_DELAYS_MS.map((_, i) => retryDelay(i, NOW, NOW + 600_000))).toEqual(RETRY_DELAYS_MS)
    expect(retryDelay(RETRY_DELAYS_MS.length, NOW, NOW + 600_000)).toBeNull()
  })

  test('never past the expiry', () => {
    expect(retryDelay(2, NOW, NOW + 3_000)).toBeNull()
    expect(retryDelay(0, NOW, NOW + 3_000)).toBe(1_000)
  })
})
