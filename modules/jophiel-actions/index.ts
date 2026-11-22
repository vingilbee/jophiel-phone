import { requireOptionalNativeModule } from 'expo'

/**
 * Phone actions on Android (local Expo module, Kotlin in ./android): opening Google Maps from
 * wherever the phone is, the "Tap to start navigation" fallback notification, and the two
 * permissions that make it work from the background. The channel itself is JS's (src/actions/).
 */

export type MapsStatus = 'done' | 'notified' | 'failed'

export interface MapsOutcome {
  status: MapsStatus
  /** Why it wasn't `done`: locked, background, no_full_screen, keyguard, no_wake, maps_missing, notifications_off, open_failed. */
  reason: string | null
}

declare class JophielActionsModule {
  /** Open Maps at `url` (a Maps navigation intent or URL); `title` names the destination in the notification. */
  openMaps(url: string, title: string): Promise<MapsOutcome>
  mapsInstalled(): boolean
  /** "Display over other apps". */
  canDrawOverlays(): boolean
  /** Full-screen notifications (Android 14+; always true below). */
  canUseFullScreenIntent(): boolean
  openOverlaySettings(): void
  openFullScreenIntentSettings(): void
}

/** Null in a build made before this module existed: rebuild with `bunx expo run:android`. */
export default requireOptionalNativeModule<JophielActionsModule>('JophielActions')
