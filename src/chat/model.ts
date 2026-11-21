import { serverTime, stripStickers, type MessageStatus, type ServerFrame, type StoredMessage } from './frames'

/**
 * 🕓 written, not yet saved · ✓ saved by the backend · ✓✓ her chat worker picked it up ·
 * failed: the backend wouldn't take it (waits for you: try again or delete).
 */
export type Tick = 'waiting' | 'saved' | 'seen' | 'failed'

export interface ChatItem {
  /** Stable list key. */
  key: string
  /** Server message id, once known. */
  id: string | null
  turnId: string | null
  role: 'user' | 'assistant'
  text: string
  /** Shown time: when you wrote it (your messages) or when it was saved (hers). */
  at: string
  /** Your messages: when the backend saved it, if that was much later than `at`. */
  arrivedAt: string | null
  tick: Tick | null
  status: MessageStatus
  streaming: boolean
  unprompted: boolean
  imageIds: string[]
  assetIds: string[]
}

/** A message written on the phone and not yet saved by the backend. Persisted. */
export interface QueuedMessage {
  turnId: string
  content: string
  writtenAt: string
  /** The backend rejected it, or never confirmed it after several tries. Not resent by itself. */
  failed?: boolean
}

export interface ChatState {
  conversationId: string | null
  /** Saved messages in the backend's order. */
  messages: ChatItem[]
  /** Her replies and unprompted messages while they stream in. */
  live: ChatItem[]
  queue: QueuedMessage[]
  /** The nudge currently streaming, if any. */
  nudgeKey: string | null
  /** Ids the backend reported as seen: kept across a history snapshot that raced the `seen` frame. */
  seenIds: string[]
  /** Turns saved this session whose reply hasn't settled (done / stopped / error). */
  activeTurns: string[]
  /**
   * Active turns a fresh history snapshot couldn't settle. The backend replays a running turn's
   * stream right after history; any of these that shows no sign of life before
   * `expireUnconfirmedTurns` is dropped, so "Thinking…" can't hang on a turn that ended unseen.
   */
  unconfirmedTurns: string[]
  historyLoaded: boolean
  error: string | null
}

export type ChatAction =
  | { type: 'frame'; frame: ServerFrame; now: string }
  | { type: 'enqueue'; message: QueuedMessage }
  | { type: 'restoreQueue'; queue: QueuedMessage[] }
  | { type: 'expireUnconfirmedTurns' }
  | { type: 'sendFailed'; turnId: string }
  | { type: 'retryQueued'; turnId: string }
  | { type: 'deleteQueued'; turnId: string }
  | { type: 'clearError' }
  | { type: 'reset' }

export const initialChatState: ChatState = {
  conversationId: null,
  messages: [],
  live: [],
  queue: [],
  nudgeKey: null,
  seenIds: [],
  activeTurns: [],
  unconfirmedTurns: [],
  historyLoaded: false,
  error: null,
}

function hasContent(item: { text: string; imageIds: string[]; assetIds: string[] }) {
  return stripStickers(item.text).trim().length > 0 || item.imageIds.length > 0 || item.assetIds.length > 0
}

/** A wait longer than this between writing and saving is worth showing ("waited 9 h on the phone"). */
export const LATE_AFTER_MS = 2 * 60_000

/** `savedAt` when the message reached the backend noticeably after it was written, else null. */
export function arrivedLate(writtenAt: string | null | undefined, savedAt: string): string | null {
  if (!writtenAt) return null
  return Date.parse(savedAt) - Date.parse(writtenAt) > LATE_AFTER_MS ? savedAt : null
}

export function fromStored(message: StoredMessage, seenIds: ReadonlySet<string> = new Set()): ChatItem {
  const isUser = message.role === 'user'
  const createdAt = serverTime(message.created_at)
  const writtenAt = message.written_at ? serverTime(message.written_at) : null
  const at = (isUser && writtenAt) || createdAt
  return {
    key: `m:${message.id}`,
    id: message.id,
    turnId: message.turn_id,
    role: message.role,
    text: message.content,
    at,
    arrivedAt: isUser ? arrivedLate(writtenAt, createdAt) : null,
    tick: isUser ? (message.seen_at || seenIds.has(message.id) ? 'seen' : 'saved') : null,
    status: message.status,
    streaming: false,
    unprompted: false,
    imageIds: message.image_ids ?? [],
    assetIds: message.asset_ids ?? [],
  }
}

function liveItem(key: string, now: string, fields: Partial<ChatItem> = {}): ChatItem {
  return {
    key,
    id: null,
    turnId: null,
    role: 'assistant',
    text: '',
    at: now,
    arrivedAt: null,
    tick: null,
    status: 'completed',
    streaming: true,
    unprompted: false,
    imageIds: [],
    assetIds: [],
    ...fields,
  }
}

/** Move finished live items into the saved list (replacing a copy with the same id). */
function promote(state: ChatState, done: (item: ChatItem) => boolean, status?: MessageStatus): ChatState {
  const finished = state.live.filter(done)
  if (finished.length === 0) return state
  let messages = state.messages
  for (const item of finished) {
    const settled: ChatItem = { ...item, streaming: false, status: status ?? item.status }
    if (settled.status === 'silent' || !hasContent(settled)) continue
    const index = settled.id ? messages.findIndex((m) => m.id === settled.id) : -1
    messages = index >= 0 ? messages.map((m, i) => (i === index ? settled : m)) : [...messages, settled]
  }
  return {
    ...state,
    messages,
    live: state.live.filter((item) => !done(item)),
    nudgeKey: finished.some((item) => item.key === state.nudgeKey) ? null : state.nudgeKey,
  }
}

function appendLive(state: ChatState, key: string, now: string, chunk: string, fields: Partial<ChatItem>): ChatState {
  const existing = state.live.find((item) => item.key === key)
  if (existing) {
    return {
      ...state,
      live: state.live.map((item) => (item.key === key ? { ...item, text: item.text + chunk } : item)),
    }
  }
  return { ...state, live: [...state.live, liveItem(key, now, { ...fields, text: chunk })] }
}

function applyFrame(state: ChatState, frame: ServerFrame, now: string): ChatState {
  switch (frame.type) {
    case 'meta':
      return { ...state, conversationId: frame.conversation_id }

    case 'history': {
      // The snapshot is the truth. Live streams are dropped: the backend replays a running turn's
      // stream from its start right after this, which rebuilds them without doubling text.
      const seen = new Set(state.seenIds)
      const messages = frame.messages
        .map((message) => fromStored(message, seen))
        .filter((item) => item.status !== 'silent' && hasContent(item))
      const savedTurns = new Set(
        frame.messages.filter((m) => m.role === 'user' && m.turn_id).map((m) => m.turn_id as string),
      )
      // Read from the raw snapshot, before silent replies are filtered out: a turn she answered with
      // silence (or that failed) is settled too.
      const answeredTurns = new Set(
        frame.messages.filter((m) => m.role === 'assistant' && m.turn_id).map((m) => m.turn_id as string),
      )
      const activeTurns = state.activeTurns.filter((turn) => !answeredTurns.has(turn))
      return {
        ...state,
        activeTurns,
        unconfirmedTurns: activeTurns,
        conversationId: frame.conversation_id ?? state.conversationId,
        messages,
        live: [],
        nudgeKey: null,
        queue: state.queue.filter((queued) => !savedTurns.has(queued.turnId)),
        historyLoaded: true,
      }
    }

    case 'ack': {
      const queued = state.queue.find((q) => q.turnId === frame.turn_id)
      const already = state.messages.some((m) => m.id === frame.user_message_id)
      // A repeated ack (a resend the backend deduped) changes nothing: above all it must not settle
      // the reply that's streaming right now.
      if (!queued && (already || state.activeTurns.includes(frame.turn_id))) return state
      // Sending while she replies stops that reply: whatever streamed so far is settled above it.
      let next = promote(state, (item) => !item.unprompted)
      next = {
        ...next,
        conversationId: frame.conversation_id ?? next.conversationId,
        queue: next.queue.filter((q) => q.turnId !== frame.turn_id),
        activeTurns: next.activeTurns.includes(frame.turn_id) ? next.activeTurns : [...next.activeTurns, frame.turn_id],
      }
      if (!queued || already) return next
      const item: ChatItem = {
        key: `m:${frame.user_message_id}`,
        id: frame.user_message_id,
        turnId: frame.turn_id,
        role: 'user',
        text: queued.content,
        at: queued.writtenAt,
        arrivedAt: arrivedLate(queued.writtenAt, now),
        tick: next.seenIds.includes(frame.user_message_id) ? 'seen' : 'saved',
        status: 'completed',
        streaming: false,
        unprompted: false,
        imageIds: [],
        assetIds: [],
      }
      return { ...next, messages: [...next.messages, item] }
    }

    case 'seen':
      return {
        ...state,
        seenIds: state.seenIds.includes(frame.message_id) ? state.seenIds : [...state.seenIds.slice(-199), frame.message_id],
        messages: state.messages.map((m) => (m.id === frame.message_id ? { ...m, tick: 'seen' } : m)),
      }

    case 'token': {
      // Its replayed stream is the sign of life a running turn owes after a history snapshot.
      const confirmed =
        frame.turn_id && state.unconfirmedTurns.includes(frame.turn_id)
          ? { ...state, unconfirmedTurns: state.unconfirmedTurns.filter((t) => t !== frame.turn_id) }
          : state
      if (frame.message_id && confirmed.messages.some((m) => m.id === frame.message_id)) return confirmed
      const key = frame.message_id ? `m:${frame.message_id}` : `t:${frame.turn_id ?? 'reply'}`
      return appendLive(confirmed, key, now, frame.content, {
        id: frame.message_id ?? null,
        turnId: frame.turn_id ?? null,
      })
    }

    case 'done':
    case 'stopped': {
      const status = frame.status ?? (frame.type === 'stopped' ? 'cancelled' : 'completed')
      const matches = (item: ChatItem) =>
        !item.unprompted && (frame.turn_id ? item.turnId === frame.turn_id || item.turnId === null : true)
      const settled = promote(state, matches, status === 'cancelled' ? 'partial' : status)
      return {
        ...settled,
        activeTurns: frame.turn_id ? settled.activeTurns.filter((t) => t !== frame.turn_id) : [],
        unconfirmedTurns: frame.turn_id ? settled.unconfirmedTurns.filter((t) => t !== frame.turn_id) : [],
      }
    }

    case 'error': {
      const settled = promote(state, (item) => !item.unprompted, 'failed')
      return {
        ...settled,
        error: frame.detail,
        activeTurns: frame.turn_id ? settled.activeTurns.filter((t) => t !== frame.turn_id) : [],
        unconfirmedTurns: frame.turn_id ? settled.unconfirmedTurns.filter((t) => t !== frame.turn_id) : [],
      }
    }

    case 'nudge_start': {
      const key = `n:${frame.message_id ?? now}`
      if (frame.message_id && state.messages.some((m) => m.id === frame.message_id)) {
        return { ...state, nudgeKey: null }
      }
      const live = state.live.some((item) => item.key === key)
        ? state.live
        : [...state.live, liveItem(key, now, { id: frame.message_id ?? null, unprompted: true })]
      return { ...state, live, nudgeKey: key }
    }

    case 'nudge_token':
      if (!state.nudgeKey) return state
      return appendLive(state, state.nudgeKey, now, frame.content, { unprompted: true })

    case 'nudge_end': {
      const key = state.nudgeKey
      if (!key) return state
      return promote(state, (item) => item.key === key)
    }

    default:
      return state
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'frame':
      return applyFrame(state, action.frame, action.now)
    case 'enqueue':
      return { ...state, queue: [...state.queue, action.message] }
    case 'restoreQueue': {
      const known = new Set(state.queue.map((q) => q.turnId))
      const saved = new Set(state.messages.map((m) => m.turnId).filter(Boolean))
      const restored = action.queue.filter((q) => !known.has(q.turnId) && !saved.has(q.turnId))
      return { ...state, queue: [...restored, ...state.queue] }
    }
    case 'sendFailed':
      return { ...state, queue: state.queue.map((q) => (q.turnId === action.turnId ? { ...q, failed: true } : q)) }
    case 'retryQueued': {
      // Back in line at the end: it goes out after everything already sent or waiting, which is
      // where the chat shows it. It keeps when it was written, so a long delay is still visible
      // to her ("written … before it arrived") and to you ("waited … on the phone").
      const retried = state.queue.find((q) => q.turnId === action.turnId)
      if (!retried) return state
      return {
        ...state,
        queue: [
          ...state.queue.filter((q) => q.turnId !== action.turnId),
          { turnId: retried.turnId, content: retried.content, writtenAt: retried.writtenAt },
        ],
      }
    }
    case 'deleteQueued':
      return { ...state, queue: state.queue.filter((q) => q.turnId !== action.turnId) }
    case 'expireUnconfirmedTurns': {
      if (state.unconfirmedTurns.length === 0) return state
      const expired = new Set(state.unconfirmedTurns)
      return { ...state, activeTurns: state.activeTurns.filter((t) => !expired.has(t)), unconfirmedTurns: [] }
    }
    case 'clearError':
      return { ...state, error: null }
    case 'reset':
      return initialChatState
  }
}

function queuedItem(queued: QueuedMessage): ChatItem {
  return {
    key: `q:${queued.turnId}`,
    id: null,
    turnId: queued.turnId,
    role: 'user',
    text: queued.content,
    at: queued.writtenAt,
    arrivedAt: null,
    tick: queued.failed ? 'failed' : 'waiting',
    status: 'completed',
    streaming: false,
    unprompted: false,
    imageIds: [],
    assetIds: [],
  }
}

/** Everything the chat shows, oldest first: saved, then streaming, then still waiting on the phone. */
export function visibleItems(state: ChatState): ChatItem[] {
  return [...state.messages, ...state.live, ...state.queue.map(queuedItem)]
}

/** She is writing right now: a reply or an unprompted message is streaming. */
export function isReplying(state: ChatState): boolean {
  return state.live.some((item) => item.streaming && !item.unprompted)
}

/** She picked your message up and nothing has streamed back yet. */
export function isThinking(state: ChatState): boolean {
  if (state.live.length > 0 || state.activeTurns.length === 0) return false
  const turn = state.activeTurns[state.activeTurns.length - 1]
  return state.messages.some((m) => m.turnId === turn && m.role === 'user' && m.tick === 'seen')
}
