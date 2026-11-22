import { NativeModule, requireOptionalNativeModule } from 'expo'

/**
 * Phone senses on Android (local Expo module, Kotlin in ./android): reads what the phone knows
 * about itself, and runs the parts that work with the app closed (geofences, activity transitions,
 * Bluetooth headphones, the background `PUT /api/phone/state`). The switches, places and `sense`
 * frames are JS's (src/senses/).
 *
 * Values cross the bridge untyped; JS checks every one against the backend's contract before
 * sending it (src/senses/report.ts).
 */

export type RawFields = Record<string, unknown>

export interface NativePlace {
  id: string
  name: string
  latitude: number
  longitude: number
  /** Meters. */
  radius: number
}

export interface Fix {
  latitude: number
  longitude: number
  /** Meters (68 % confidence). */
  accuracy: number
}

/** Phase 7: her one-off position, or why there is none. */
export type Position =
  | { latitude: number; longitude: number; accuracy: number; /** Epoch ms of the fix. */ fixAt: number; error?: undefined }
  | { error: 'no_permission' | 'location_off' | 'no_fix' }

export interface ReportedValue {
  value: unknown
  /** Epoch ms: when it was last sent. */
  at: number
  /** Epoch ms: since when it's had this value. */
  since: number
}

export type JophielSensesEvents = {
  /** New values (live readers, or a wake-up while live), seen at `at` (epoch ms). */
  onChange: (event: { fields: RawFields; at: number }) => void
}

declare class JophielSensesModule extends NativeModule<JophielSensesEvents> {
  /** Every field's current value; motion and place as last seen (absent when unknown). */
  snapshot(): RawFields
  /** Listen to every field (app visible, or a call keeping it alive) and pass wake-ups to JS. */
  startLive(): void
  stopLive(): void
  /** The switches (group → on) and the places; (re)registers the background parts. */
  configure(groups: Record<string, boolean>, places: NativePlace[]): void
  /** Signed in: where background reports go (token stored encrypted). */
  setReporting(serverUrl: string, token: string): void
  /** Logout: background reports stop, geofences and transitions removed. Places and switches stay. */
  clearReporting(): void
  /** These went out in a `sense` frame (seen at `at`, epoch ms). */
  noteSent(fields: RawFields, at: number): void
  /** No socket: send these with a background PUT. */
  sendInBackground(fields: RawFields, at: number): void
  /** Per field: the last value sent, when, and since when. */
  lastReported(): Record<string, ReportedValue>
  /** One precise fix, or null (no permission, location off, timed out). */
  currentLocation(): Promise<Fix | null>
  /** Phase 7: last known if under 2 min old, else a fresh fix within 10 s. Never stored. */
  positionOnce(): Promise<Position>
  /** Which place you're at now, from one fix; true when it could tell. */
  checkPlaceNow(): Promise<boolean>
}

/** Null in a build made before this module existed: rebuild with `bunx expo run:android`. */
export default requireOptionalNativeModule<JophielSensesModule>('JophielSenses')
