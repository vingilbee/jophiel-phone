import JophielNotifications, { type NotificationsStatus } from '../../modules/jophiel-notifications'
import type { PhoneNotificationsFrame } from '@/chat/frames'

/**
 * Phase 8, notifications as a sense. The native listener reads, filters, coalesces and builds the
 * `phone_notifications` frames (modules/jophiel-notifications); while JS is live they come here
 * and go over the chat socket, and when the socket is down they go back for a background POST.
 * With JS not live the native side POSTs them itself.
 */

export type { NotificationsStatus }

/** The native module is in this build (one made before phase 8 doesn't have it). */
export const notificationsAvailable = JophielNotifications !== null

export interface NotificationsSocket {
  /** False when the socket isn't open. */
  send: (frame: PhoneNotificationsFrame) => boolean
}

let socket: NotificationsSocket | null = null
let live = false

export function attachNotificationsSocket(link: NotificationsSocket) {
  socket = link
}

export function detachNotificationsSocket(link: NotificationsSocket) {
  if (socket === link) socket = null
}

/** A frame from native: well-formed enough to pass on (the native side built it). */
export function parseNotificationsFrame(body: string): PhoneNotificationsFrame | null {
  try {
    const frame: unknown = JSON.parse(body)
    if (!frame || typeof frame !== 'object') return null
    const f = frame as Record<string, unknown>
    if (f.type !== 'phone_notifications' || !Array.isArray(f.posted) || !Array.isArray(f.removed)) return null
    return frame as PhoneNotificationsFrame
  } catch {
    return null
  }
}

/** Developer screen: the newest notification with a reply button that passed through JS (to test reply / dismiss). */
export interface SeenNotification {
  key: string
  revision: number | null
  conversationId: string | null
  title: string
  canReply: boolean
}

let newest: SeenNotification | null = null

export function lastSeenNotification(): SeenNotification | null {
  return newest
}

function remember(frame: PhoneNotificationsFrame) {
  for (const item of frame.posted) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    if (typeof p.key !== 'string') continue
    newest = {
      key: p.key,
      revision: typeof p.revision === 'number' ? p.revision : null,
      conversationId: typeof p.conversation_id === 'string' ? p.conversation_id : null,
      title: typeof p.title === 'string' ? p.title : typeof p.app === 'string' ? p.app : '',
      canReply: p.can_reply === true,
    }
  }
  if (newest && frame.removed.some((r) => r.key === newest?.key)) newest = null
}

// Native hands one batch at a time and holds the next until this one is settled, so a batch that
// falls back to the background POST never lands after a later one sent over the socket.
JophielNotifications?.addListener('onNotifications', ({ id, body }) => {
  // Arrived after native gave up on it (JS was stalled): it already went the background way.
  if (!JophielNotifications?.claim(id)) return
  const frame = parseNotificationsFrame(body)
  let sent = false
  try {
    if (frame) {
      if (__DEV__) remember(frame)
      sent = socket?.send(frame) ?? false
    }
  } finally {
    JophielNotifications?.settled(id, sent)
  }
})

/** Same rule as the senses: live while the app is on screen or a call keeps it alive. */
export function setNotificationsLive(on: boolean) {
  if (!JophielNotifications || on === live) return
  live = on
  if (on) JophielNotifications.startLive()
  else JophielNotifications.stopLive()
}

/** The Notifications sense switch, and whether replies / drafts may go out (checked again at dispatch). */
export function configureNotifications(enabled: boolean, messagesOn: boolean) {
  JophielNotifications?.configure(enabled, messagesOn)
}

export function setNotificationsReporting(serverUrl: string, token: string) {
  JophielNotifications?.setReporting(serverUrl, token)
}

export function clearNotificationsReporting() {
  JophielNotifications?.clearReporting()
}

/** "Notification access" for Jophiel; null: not in this build. */
export function notificationAccess(): boolean | null {
  try {
    return JophielNotifications?.hasAccess() ?? null
  } catch {
    return null
  }
}

export function openNotificationAccessSettings() {
  JophielNotifications?.openAccessSettings()
}

export function notificationsStatus(): NotificationsStatus | null {
  try {
    return JophielNotifications?.status() ?? null
  } catch {
    return null
  }
}
