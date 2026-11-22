import { requireOptionalNativeModule } from 'expo'

/**
 * Phone actions on Android (local Expo module, Kotlin in ./android): opening Google Maps from
 * wherever the phone is, the "Tap to start navigation" fallback notification, and the two
 * permissions that make it work from the background (phase 7); volume, ringer, Do Not Disturb,
 * alarms, timers, opening apps and links, Spotify and WhatsApp drafts (phase 8). The channel
 * itself is JS's (src/actions/).
 */

export type MapsStatus = 'done' | 'notified' | 'failed'

export interface MapsOutcome {
  status: MapsStatus
  /** Why it wasn't `done`: locked, background, no_full_screen, keyguard, no_wake, maps_missing, notifications_off, open_failed. */
  reason: string | null
}

/** Phase 8: what a device action came to (`data`: `opened` for open_app, `target` for whatsapp_draft). */
export interface DeviceOutcome {
  status: 'done' | 'notified' | 'refused' | 'failed'
  reason: string | null
  data: { opened?: string; target?: 'contact' | 'picker' } | null
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
  // ---- Phase 8 ----
  /** Media volume, 0–100. */
  setVolume(level: number): Promise<DeviceOutcome>
  setRinger(mode: 'normal' | 'vibrate' | 'silent'): Promise<DeviceOutcome>
  setDnd(on: boolean): Promise<DeviceOutcome>
  /** `days`: java.util.Calendar days (Sunday 1 … Saturday 7); empty for a one-off. */
  setAlarm(hour: number, minute: number, label: string | null, days: number[]): Promise<DeviceOutcome>
  setTimer(seconds: number, label: string | null): Promise<DeviceOutcome>
  openApp(name: string): Promise<DeviceOutcome>
  openLink(url: string): Promise<DeviceOutcome>
  playMusic(query: string): Promise<DeviceOutcome>
  whatsappDraft(to: string | null, text: string): Promise<DeviceOutcome>
  hasDndAccess(): boolean
  openDndSettings(): void
}

/** Null in a build made before this module existed: rebuild with `bunx expo run:android`. */
export default requireOptionalNativeModule<JophielActionsModule>('JophielActions')
