import { PHONE_FIELDS, type PhoneField, type PhoneState, type PhoneStateReport } from '@/chat/frames'
import { groupOf, type SenseSwitches } from './groups'

/**
 * The pure half of phone senses: checking native values against the backend's contract, and
 * deciding what goes in a `sense` frame (everything on connect, afterwards only what changed).
 */

export type Known = Partial<PhoneState>

const ENUMS: Partial<Record<PhoneField, readonly string[]>> = {
  screen: ['on', 'off'],
  network: ['wifi', 'cellular', 'none'],
  ringer: ['normal', 'vibrate', 'silent'],
  motion: ['still', 'walking', 'running', 'cycling', 'vehicle'],
}

const BOOLEANS: readonly PhoneField[] = ['locked', 'charging', 'headphones', 'dnd']

const MAX_LENGTH: Partial<Record<PhoneField, number>> = { wifi_name: 64, place: 60 }

/** Cut to `max` characters (code points, as the server counts them), never inside a surrogate pair. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/**
 * The value as the server accepts it, or undefined when it can't be sent: one bad value would make
 * the server reject the whole `sense` frame (its presence and voice state too).
 */
export function checkValue<F extends PhoneField>(field: F, value: unknown): PhoneState[F] | undefined {
  if (value === null) return null as PhoneState[F]
  const allowed = ENUMS[field]
  if (allowed) return typeof value === 'string' && allowed.includes(value) ? (value as PhoneState[F]) : undefined
  if (BOOLEANS.includes(field)) return typeof value === 'boolean' ? (value as PhoneState[F]) : undefined
  if (field === 'battery') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.min(100, Math.max(0, Math.round(value))) as PhoneState[F]
  }
  const max = MAX_LENGTH[field]
  if (max !== undefined) {
    if (typeof value !== 'string') return undefined
    const text = clip(value.trim(), max)
    return (text === '' ? null : text) as PhoneState[F]
  }
  return undefined
}

/** Only the known field names, each checked; anything else is dropped. */
export function checkFields(raw: Record<string, unknown>): Known {
  const out: Record<string, unknown> = {}
  for (const field of PHONE_FIELDS) {
    if (!(field in raw)) continue
    const value = checkValue(field, raw[field])
    if (value !== undefined) out[field] = value
  }
  return out as Known
}

/** What she should know right now: a group switched off reads null ("no longer known"). */
export function effective(known: Known, switches: SenseSwitches): Known {
  const out: Record<string, unknown> = {}
  for (const field of PHONE_FIELDS) {
    if (!switches[groupOf(field)]) out[field] = null
    else if (known[field] !== undefined) out[field] = known[field]
  }
  return out as Known
}

/** The fields whose value differs from what this socket was last sent. */
export function changes(current: Known, sent: Known): Known {
  const out: Record<string, unknown> = {}
  for (const field of PHONE_FIELDS) {
    const value = current[field]
    if (value === undefined) continue
    if (!(field in sent) || sent[field] !== value) out[field] = value
  }
  return out as Known
}

export function isEmpty(fields: Known): boolean {
  return Object.keys(fields).length === 0
}

/** The fields of a report, without `observed_at`. */
export function fieldsOf(report: PhoneStateReport): Known {
  const { observed_at: _ignored, ...fields } = report
  return fields
}
