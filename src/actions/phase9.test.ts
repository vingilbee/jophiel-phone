import { describe, expect, test } from 'bun:test'
import { fakeDeps, recordingDevice, sw } from './testing'
import { ACTION_GROUP, defaultActionGroups } from './groups'
import { CONTROL_ACTIONS, parseScreen, type PhoneAction, type PhoneScreen } from './protocol'
import { precheck, runAction, type DeviceAnswer } from './run'

const NOW = Date.parse('2026-11-24T19:00:00.000Z')

function act(name: string, args: Record<string, unknown> = {}): PhoneAction {
  return { actionId: `id-${name}-${Math.random()}`, action: name, args, expiresAt: NOW + 60_000 }
}

const SCREEN: PhoneScreen = {
  id: 's7',
  app: 'Spotify',
  package: 'com.spotify.music',
  keyboard: false,
  image: { jpeg_base64: 'AAAA', width: 720, height: 1600 },
  image_missing: null,
  items: [
    { n: 1, role: 'text_field', text: '', hint: 'What do you want to listen to?', focused: true, box: [24, 180, 672, 96] },
    { role: 'text', text: 'Recent searches' },
  ],
}

/** Every control action answers `answer`; the rest as `recordingDevice`. */
function controlDeps(answer: DeviceAnswer, calls: [string, unknown[]][] = []) {
  const device = recordingDevice(calls)
  device.control = async (...args) => {
    calls.push(['control', args])
    return answer
  }
  return fakeDeps({ device, now: () => NOW })
}

describe('phase 9: phone control over the channel', () => {
  test('every control action is in the Phone control group', () => {
    for (const action of CONTROL_ACTIONS) expect(ACTION_GROUP[action]).toBe('control')
    expect(defaultActionGroups().control).toBe(true)
  })

  test('Phone control or the master switch off → switched_off, before the phone is touched', async () => {
    const groups = { ...defaultActionGroups(), control: false }
    expect(precheck(act('tap'), NOW, { ...sw(true, true), groups })).toEqual({ status: 'refused', reason: 'switched_off' })
    expect(precheck(act('read_screen'), NOW, sw(false, true))).toEqual({ status: 'refused', reason: 'switched_off' })

    const calls: [string, unknown[]][] = []
    const { deps, delivered } = controlDeps({ status: 'done', reason: null, screen: SCREEN }, calls)
    deps.switches = async () => ({ ...sw(true, true), groups })
    const result = await runAction(act('read_screen'), deps)
    expect(result).toEqual({ status: 'refused', reason: 'switched_off' })
    expect(calls).toEqual([])
    expect(delivered).toHaveLength(1)
  })

  test('done carries the screen as data.screen; args go to native as she sent them', async () => {
    const calls: [string, unknown[]][] = []
    const { deps, delivered } = controlDeps({ status: 'done', reason: null, screen: SCREEN }, calls)
    const args = { screen: 's6', n: 3, turn: 't1' }
    const result = await runAction(act('tap', args), deps)
    expect(result).toEqual({ status: 'done', data: { screen: SCREEN } })
    expect(calls).toEqual([['control', ['tap', args]]])
    expect(delivered[0]?.[1]).toEqual({ status: 'done', data: { screen: SCREEN } })
  })

  test('refusals and failures pass their reason, without a screen', async () => {
    for (const reason of ['taken_over', 'locked', 'own_app', 'no_accessibility']) {
      const { deps } = controlDeps({ status: 'refused', reason, screen: SCREEN })
      expect(await runAction(act('tap', { screen: 's1', n: 1 }), deps)).toEqual({ status: 'refused', reason })
    }
    const { deps } = controlDeps({ status: 'failed', reason: 'stale_screen', screen: null })
    expect(await runAction(act('tap', { screen: 's1', n: 1 }), deps)).toEqual({ status: 'failed', reason: 'stale_screen' })
  })

  test('end_control is done with nothing; any other done without a screen failed', async () => {
    const { deps } = controlDeps({ status: 'done', reason: null, screen: null })
    expect(await runAction(act('end_control'), deps)).toEqual({ status: 'done' })
    expect(await runAction(act('read_screen'), deps)).toEqual({ status: 'failed', reason: 'error' })
  })

  test('the screen JSON from native', () => {
    expect(parseScreen(JSON.stringify(SCREEN))).toEqual(SCREEN)
    expect(parseScreen(null)).toBeNull()
    expect(parseScreen('not json')).toBeNull()
    expect(parseScreen('{"id":3,"items":[]}')).toBeNull()
    expect(parseScreen('{"id":"s1"}')).toBeNull()
  })
})
