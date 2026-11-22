import type { ActionResult } from './protocol'
import { defaultActionGroups } from './groups'
import type { ActionDeps, ActionSwitches, DeviceDeps, PositionAnswer } from './run'

/** Stand-ins for the action tests (src/actions/*.test.ts). */

export const TEST_NOW = Date.parse('2026-11-21T10:00:00.000Z')

/** Phase 7's two switches; phase 8's all on. */
export function sw(actionsEnabled: boolean, placesOn: boolean): ActionSwitches {
  return { actionsEnabled, placesOn, notificationsOn: true, groups: defaultActionGroups() }
}

/** Every device action answers done and is recorded. */
export function recordingDevice(calls: [string, unknown[]][]): DeviceDeps {
  const answer = (name: string) => async (...args: unknown[]) => {
    calls.push([name, args])
    return { status: 'done' as const, reason: null }
  }
  return {
    mediaControl: answer('mediaControl'),
    setVolume: answer('setVolume'),
    setAlarm: answer('setAlarm'),
    setTimer: answer('setTimer'),
    setRinger: answer('setRinger'),
    setDnd: answer('setDnd'),
    dismiss: answer('dismiss'),
    reply: answer('reply'),
    openApp: answer('openApp'),
    openLink: answer('openLink'),
    playMusic: answer('playMusic'),
    whatsappDraft: answer('whatsappDraft'),
  }
}

export function fakeDeps(partial: Partial<ActionDeps> = {}) {
  const delivered: [string, ActionResult][] = []
  const opened: [string, string][] = []
  const claimed = new Set<string>()
  const deps: ActionDeps = {
    now: () => TEST_NOW,
    claim: async (id) => {
      if (claimed.has(id)) return false
      claimed.add(id)
      return true
    },
    switches: async () => (sw(true, true)),
    openMaps: async (url, title) => {
      opened.push([url, title])
      return { status: 'done', reason: null }
    },
    position: async (): Promise<PositionAnswer> => ({ latitude: -6.2, longitude: 106.8, accuracy: 12.4, fixAt: TEST_NOW - 5_000 }),
    places: async () => [
      { id: 'p1', name: 'Work', latitude: 49.21, longitude: -123.1, radius: 150 },
      { id: 'p2', name: 'Gym', latitude: 49.2, longitude: -123.11, radius: 150 },
      { id: 'p3', name: 'gym ', latitude: 49.3, longitude: -123.2, radius: 150 },
    ],
    device: recordingDevice([]),
    deliver: async (a, result) => {
      delivered.push([a.actionId, result])
    },
    ...partial,
  }
  return { deps, delivered, opened }
}

