/**
 * Pure decisions for her notifications (unit-tested): what a data push means, what to show,
 * and how several stack into one group.
 */

export const GROUP_ID = 'jophiel'
export const SUMMARY_ID = 'jophiel-summary'
export const CHANNEL_ID = 'messages'
export const HIDDEN_TEXT = 'Jophiel sent you a message'

export type PushData =
  | { type: 'message'; conversationId: string | null; messageId: string; text: string | null }
  | { type: 'clear'; conversationId: string | null }

/** FCM data payloads are string maps; anything unexpected is ignored. */
export function parsePushData(data: Record<string, unknown> | undefined): PushData | null {
  if (!data) return null
  const str = (value: unknown) => (typeof value === 'string' && value ? value : null)
  if (data.type === 'clear') return { type: 'clear', conversationId: str(data.conversation_id) }
  if (data.type === 'message') {
    const messageId = str(data.message_id)
    if (!messageId) return null
    return { type: 'message', conversationId: str(data.conversation_id), messageId, text: str(data.text) }
  }
  return null
}

export interface MessageNotification {
  id: string
  title: string
  body: string
  data: { message_id: string; conversation_id: string }
}

export function trimText(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

export function messageNotification(push: Extract<PushData, { type: 'message' }>): MessageNotification {
  return {
    id: push.messageId,
    title: 'Jophiel',
    body: push.text ? trimText(push.text) : HIDDEN_TEXT,
    data: { message_id: push.messageId, conversation_id: push.conversationId ?? '' },
  }
}

/**
 * The group summary for the messages showing after this one arrives, or null when one message is
 * alone (Android shows it on its own; a summary appears from two).
 */
export function summaryFor(displayedMessageIds: readonly string[], newId: string): { title: string; count: number } | null {
  const ids = new Set(displayedMessageIds.filter((id) => id !== SUMMARY_ID))
  ids.add(newId)
  if (ids.size < 2) return null
  return { title: `Jophiel · ${ids.size} messages`, count: ids.size }
}
