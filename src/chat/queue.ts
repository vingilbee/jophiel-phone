import AsyncStorage from '@react-native-async-storage/async-storage'
import type { QueuedMessage } from './model'

/**
 * The waiting queue: every message you write lands here first and stays until the backend's `ack`.
 * It survives the app closing and the phone restarting. Sending is one at a time, in order; a
 * missing `ack` resends the same turn id (the backend dedupes, so a message never doubles).
 */

const KEY = 'jophiel.send-queue'
export const ACK_TIMEOUT_MS = 10_000
/** Sends without an ack on a live connection (or rejections) before a message is marked failed. */
export const MAX_STRIKES = 3

export async function loadQueue(): Promise<QueuedMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isQueuedMessage) : []
  } catch {
    return []
  }
}

export async function saveQueue(queue: QueuedMessage[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(queue))
}

export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(KEY)
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.turnId === 'string' &&
    typeof v.content === 'string' &&
    typeof v.writtenAt === 'string' &&
    (v.failed === undefined || typeof v.failed === 'boolean')
  )
}

export interface InFlight {
  turnId: string
  sentAt: number
}

/**
 * Which message to put on the wire now, if any: the first one that hasn't failed, unless it was sent
 * less than `ACK_TIMEOUT_MS` ago and is still waiting for its `ack`. A failed message never blocks
 * the ones written after it.
 */
export function pickNextSend(queue: readonly QueuedMessage[], inFlight: InFlight | null, now: number): QueuedMessage | null {
  const head = queue.find((q) => !q.failed)
  if (!head) return null
  if (inFlight && inFlight.turnId === head.turnId && now - inFlight.sentAt < ACK_TIMEOUT_MS) return null
  return head
}

/** RFC 4122 v4, from Math.random: turn ids only need to be unique per user. */
export function newTurnId(): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Count one strike against a message (no ack in time on a live connection, or a rejection while it
 * was in flight). Returns true when it has run out of tries and should be marked failed.
 */
export function addStrike(strikes: Map<string, number>, turnId: string): boolean {
  const count = (strikes.get(turnId) ?? 0) + 1
  if (count >= MAX_STRIKES) {
    strikes.delete(turnId)
    return true
  }
  strikes.set(turnId, count)
  return false
}
