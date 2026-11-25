import { requireOptionalNativeModule } from 'expo'

/**
 * Phase 9 on Android (local Expo module, Kotlin in ./android): phone control through Android's
 * accessibility service. She reads the screen (a numbered screenshot plus the same screen as
 * text) and taps, types, scrolls, swipes and presses back / home, one action at a time, with a
 * banner up and your touch stopping her. The channel and the switches are JS's (src/actions/).
 */

export interface ControlAnswer {
  status: 'done' | 'refused' | 'failed'
  reason: string | null
  /** `data.screen` as JSON text, only with `done` (none for `end_control`). */
  screen: string | null
}

declare class JophielControlModule {
  /** Turned on in Settings → Accessibility. */
  isEnabled(): boolean
  /** Android has the service bound right now. */
  isConnected(): boolean
  openSettings(): void
  /** The master switch and Phone control: false ends her control at once. */
  setAllowed(on: boolean): void
  /** One control action (`read_screen`, `tap`, …); args as she sent them (checked natively). */
  perform(action: string, args: Record<string, unknown>): Promise<ControlAnswer>
}

/** Null in a build made before this module existed: rebuild with `bunx expo run:android`. */
export default requireOptionalNativeModule<JophielControlModule>('JophielControl')
