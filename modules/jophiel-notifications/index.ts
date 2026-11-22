import { NativeModule, requireOptionalNativeModule } from 'expo'

/**
 * Phase 8 on Android (local Expo module, Kotlin in ./android): notifications from every app as a
 * sense (with removals, now playing and the Maps trip, which go out as phone state), and the
 * actions that need the notification listener: reply through a notification's reply button,
 * dismiss, media control. Switches, the socket and the action channel are JS's.
 */

export interface ListenerAnswer {
  status: 'done' | 'refused' | 'failed'
  reason: string | null
}

export interface NotificationsStatus {
  /** "Notification access" is on. */
  access: boolean
  /** Android has the listener bound right now. */
  connected: boolean
  /** Notifications she was told about that are still on the phone. */
  known: number
  /** Epoch ms of the last batch sent (0: never). */
  lastSentAt: number
}

export type JophielNotificationsEvents = {
  /** While live: a `phone_notifications` frame (JSON text) for the socket. */
  onNotifications: (event: { body: string }) => void
}

declare class JophielNotificationsModule extends NativeModule<JophielNotificationsEvents> {
  hasAccess(): boolean
  openAccessSettings(): void
  /** The Notifications sense switch and the Messages (replies + drafts) switch. */
  configure(enabled: boolean, messagesOn: boolean): void
  setReporting(serverUrl: string, token: string): void
  clearReporting(): void
  startLive(): void
  stopLive(): void
  /** No socket: send this batch with a background POST. */
  queue(body: string): void
  status(): NotificationsStatus
  reply(key: string, conversationId: string | null, revision: number | null, text: string): Promise<ListenerAnswer>
  dismiss(key: string): Promise<ListenerAnswer>
  mediaControl(command: 'play' | 'pause' | 'next' | 'previous'): Promise<ListenerAnswer>
}

/** Null in a build made before this module existed: rebuild with `bunx expo run:android`. */
export default requireOptionalNativeModule<JophielNotificationsModule>('JophielNotifications')
