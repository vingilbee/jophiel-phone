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
  /** A batch for the socket; answer with `settled(id, sent)`. */
  onNotifications: (event: { id: string; body: string }) => void
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
  /** JS sent batch `id` over the socket, or couldn't (`sent` false: native POSTs it). Native holds the next until then. */
  /** Before sending batch `id`: false means it timed out natively (already queued), so don't send it. */
  claim(id: string): boolean
  settled(id: string, sent: boolean): void
  status(): NotificationsStatus
  reply(key: string, conversationId: string | null, revision: number | null, text: string): Promise<ListenerAnswer>
  dismiss(key: string): Promise<ListenerAnswer>
  mediaControl(command: 'play' | 'pause' | 'next' | 'previous'): Promise<ListenerAnswer>
  /** Top hit for `query` through the app's media session (no app opened); `no_media_session` when it has none. */
  playFromSearch(packageName: string, query: string): Promise<ListenerAnswer>
}

/** Null in a build made before this module existed: rebuild with `bunx expo run:android`. */
export default requireOptionalNativeModule<JophielNotificationsModule>('JophielNotifications')
