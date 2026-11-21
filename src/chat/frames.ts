/**
 * Chat WebSocket frames: the one hand-written copy of the protocol on the phone.
 * Source of truth: the header of ../app/backend/app/api/routes/chat.py (reference client:
 * ../app/frontend/src/hooks/useChatSocket.ts). Voice/audio, thought and subagent frames are
 * ignored in this milestone.
 */

export type MessageStatus = 'completed' | 'partial' | 'cancelled' | 'failed' | 'silent'

export interface StoredMessage {
  id: string
  turn_id: string | null
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  source_channel: 'web' | 'whatsapp' | 'system' | 'phone'
  created_at: string
  written_at?: string | null
  seen_at?: string | null
  image_ids?: string[] | null
  asset_ids?: string[] | null
}

export type ServerFrame =
  | { type: 'meta'; conversation_id: string }
  | { type: 'history'; conversation_id: string | null; messages: StoredMessage[] }
  | { type: 'ack'; turn_id: string; user_message_id: string; conversation_id: string }
  | { type: 'seen'; message_id: string; conversation_id?: string | null }
  | { type: 'token'; turn_id?: string; message_id?: string; content: string }
  | { type: 'sticker'; turn_id?: string; message_id?: string; sticker: string }
  | { type: 'nudge_start'; conversation_id: string; reason: string; message_id?: string | null }
  | { type: 'nudge_token'; content: string }
  | { type: 'nudge_sticker'; sticker: string }
  | { type: 'nudge_end' }
  | { type: 'reply_interrupted'; reason: string }
  | { type: 'state'; awareness: unknown }
  | { type: 'done'; turn_id?: string; status?: MessageStatus }
  | { type: 'stopped'; turn_id?: string; status?: MessageStatus }
  | { type: 'error'; turn_id?: string; detail: string }

const HANDLED = new Set([
  'meta', 'history', 'ack', 'seen', 'token', 'sticker', 'nudge_start', 'nudge_token', 'nudge_sticker',
  'nudge_end', 'reply_interrupted', 'state', 'done', 'stopped', 'error',
])

/** Parse a text frame; frames this milestone doesn't handle (audio, thought, subagent…) give null. */
export function parseFrame(raw: string): ServerFrame | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const type = (data as { type?: unknown }).type
  return typeof type === 'string' && HANDLED.has(type) ? (data as ServerFrame) : null
}

export interface RunFrame {
  type: 'run'
  conversation_id: string | null
  content: string
  turn_id: string
  written_at: string
  image_ids: string[]
}

export interface SenseFrame {
  type: 'sense'
  client: 'phone'
  timezone: string
  route: string
  activity: 'idle' | 'reading' | 'typing'
  /** Phase 2 presence: the app is on screen. */
  visible: boolean
  last_active_at?: string
}

export type ClientFrame = RunFrame | SenseFrame | { type: 'stop'; conversation_id: string | null }

/** Old stored replies may still carry sticker markers; they are cut out, never shown. */
export const STICKER_MARKER = /\[\[sticker:[a-z0-9-]+\]\]/g

export function stripStickers(text: string): string {
  return text.replace(STICKER_MARKER, '')
}
