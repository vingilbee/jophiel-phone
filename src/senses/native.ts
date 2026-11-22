import JophielSenses, { type Fix, type NativePlace } from '../../modules/jophiel-senses'
import { getSettings } from '@/settings/store'
import { PhoneSenses, type SensesNative } from './controller'
import type { LastReported } from './describe'
import type { SenseSwitches } from './groups'
import type { Place } from './places'

export type { Fix }

/** The native module is in this build (one made before phase 6 doesn't have it). */
export const sensesAvailable = JophielSenses !== null

const native: SensesNative | null = JophielSenses
  ? {
      snapshot: () => JophielSenses!.snapshot(),
      startLive: () => JophielSenses!.startLive(),
      stopLive: () => JophielSenses!.stopLive(),
      noteSent: (fields, at) => JophielSenses!.noteSent(fields, at),
      sendInBackground: (fields, at) => JophielSenses!.sendInBackground(fields, at),
      onChange: (listener) => JophielSenses!.addListener('onChange', (event) => listener(event.fields, event.at)),
    }
  : null

/** The one controller: the chat socket asks it what to send, the senses bridge feeds it settings. */
export const phoneSenses = new PhoneSenses(native, getSettings().senses)

/** Push the switches and places to the module (it registers geofences / transitions to match). */
export function configureNative(switches: SenseSwitches, places: readonly Place[]) {
  const nativePlaces: NativePlace[] = places.map(({ id, name, latitude, longitude, radius }) => ({ id, name, latitude, longitude, radius }))
  JophielSenses?.configure({ ...switches }, nativePlaces)
}

export function setReporting(serverUrl: string, token: string) {
  JophielSenses?.setReporting(serverUrl, token)
}

export function clearReporting() {
  JophielSenses?.clearReporting()
}

export function lastReported(): LastReported {
  try {
    return (JophielSenses?.lastReported() ?? {}) as LastReported
  } catch {
    return {}
  }
}

/** One precise fix for "I'm here now"; null without permission, with location off, or timed out. */
export async function currentLocation(): Promise<Fix | null> {
  try {
    return (await JophielSenses?.currentLocation()) ?? null
  } catch {
    return null
  }
}

/** Which saved place you're at, from one fix. */
export async function checkPlaceNow(): Promise<boolean> {
  try {
    return (await JophielSenses?.checkPlaceNow()) ?? false
  } catch {
    return false
  }
}
