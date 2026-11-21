/**
 * Chat WebSocket frames: the one hand-written copy of the protocol on the phone.
 * Source of truth: the header of ../app/backend/app/api/routes/chat.py (reference client:
 * ../app/frontend/src/hooks/useChatSocket.ts). Text and voice share the socket; audio itself moves
 * as binary frames (16-bit mono PCM). Thought and subagent frames are ignored.
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
  /** Interrupted voice replies: characters of `content` the user heard. */
  heard_chars?: number | null
}

/**
 * The server's decision on a held interruption: carry on with the paused reply, drop it and stay
 * quiet, or drop it and answer the new utterance.
 */
export type BargeAction = 'resume' | 'stop' | 'turn'

export type VoiceState = 'off' | 'idle' | 'listening' | 'thinking' | 'speaking'

/** Phone-side timing stages of a voice turn (the backend's voice_latency names them so). */
export type VoiceLatencyStage =
  | 'speech_last_active'
  | 'vad_endpoint'
  | 'voice_end_sent'
  | 'browser_first_audio'
  | 'browser_playback_started'

export interface VoiceLatencyReport {
  outcome: 'audio' | 'no_audio' | 'error' | 'interrupted'
  endpoint: 'vad' | 'manual'
  /** Wall-clock epoch milliseconds per stage. */
  marks: Partial<Record<VoiceLatencyStage, number>>
}

export type ServerFrame =
  | { type: 'meta'; conversation_id: string; turn_id?: string }
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
  | { type: 'transcript'; turn_id?: string; content: string }
  | { type: 'audio_start'; turn_id?: string; sample_rate: number; unprompted?: boolean }
  | { type: 'audio_segment'; turn_id?: string; segment: number; text_start: number; text_end: number }
  | { type: 'audio_end'; turn_id?: string }
  | { type: 'barge_resolved'; turn_id: string; action: BargeAction }

const HANDLED = new Set([
  'meta', 'history', 'ack', 'seen', 'token', 'sticker', 'nudge_start', 'nudge_token', 'nudge_sticker',
  'nudge_end', 'reply_interrupted', 'state', 'done', 'stopped', 'error',
  'transcript', 'audio_start', 'audio_segment', 'audio_end', 'barge_resolved',
])

/** Parse a text frame; frames the phone doesn't handle (thought, subagent…) give null. */
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
  /** `speaking`: the mic is open and capturing your turn. */
  activity: 'idle' | 'reading' | 'typing' | 'speaking'
  /** Phase 2 presence: the app is on screen. */
  visible: boolean
  last_active_at?: string
  /** A voice call is on and the mic isn't muted: she may speak a nudge aloud to this socket. */
  hearing_enabled: boolean
  /** No wake word on the phone yet (phase 9). */
  wake_armed: false
  voice_state: VoiceState
}

export type VoiceFrame =
  | { type: 'voice_start'; conversation_id: string | null; turn_id: string; sample_rate: number }
  | {
      type: 'voice_interrupt'
      cancel_turn_id: string | null
      new_turn_id: string
      conversation_id: string | null
      sample_rate: number
      tentative?: boolean
    }
  | { type: 'voice_interrupt_commit'; turn_id: string }
  | { type: 'voice_heard'; turn_id: string; heard_chars: number }
  | { type: 'voice_end'; turn_id: string | null }
  | { type: 'voice_cancel' }
  | ({ type: 'voice_latency'; turn_id: string } & VoiceLatencyReport)

export type ClientFrame =
  | RunFrame
  | SenseFrame
  | VoiceFrame
  | { type: 'stop'; conversation_id: string | null; turn_id?: string | null }

/**
 * The backend's `created_at` is stored without a time zone and serialized without an offset
 * ("2026-11-21T07:17:00"), though it is UTC; JavaScript would read that as the phone's local time.
 * Times with an offset (`written_at`, `seen_at`, the phone's own) pass through unchanged.
 */
export function serverTime(iso: string): string {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`
}

/** Old stored replies may still carry sticker markers; they are cut out, never shown. */
export const STICKER_MARKER = /\[\[sticker:[a-z0-9-]+\]\]/g

export function stripStickers(text: string): string {
  return text.replace(STICKER_MARKER, '')
}
