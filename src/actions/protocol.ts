/**
 * Phase 7, the phone-action channel: she sends an action down (a `phone_action` frame, or an FCM
 * data push when the phone has no socket), the phone does it and answers once with a result (a
 * `phone_action_result` frame, else `POST /api/phone/actions/{id}/result`). Contract:
 * PLAN_PHASE_7.md "The channel". Pure, so it's unit-tested.
 */

/** Without an `expires_at`, an action counts as sent just now and lives this long. */
export const DEFAULT_LIFETIME_MS = 60_000

export type TravelMode = 'drive' | 'two_wheeler' | 'walk' | 'transit' | 'bicycle'

const MODES: readonly TravelMode[] = ['drive', 'two_wheeler', 'walk', 'transit', 'bicycle']

export interface PhoneAction {
  actionId: string
  /** Phase 7's `navigate_to`, `get_position`, `resolve_saved_place`, and phase 8's (see `run.ts`); others answer `failed`, `unknown_action`. */
  action: string
  args: Record<string, unknown>
  /** Epoch ms after which it's dropped as `expired`. */
  expiresAt: number
  /** Developer screen: run here, no result sent anywhere. */
  local?: boolean
}

export type ResultStatus = 'done' | 'notified' | 'refused' | 'expired' | 'failed'

/** `get_position` only: the one position for that lookup. Never stored or logged on the phone. */
export interface PositionData {
  lat: number
  lng: number
  accuracy_m: number
  fix_at: string
}

/** `resolve_saved_place` only: the saved place's stored centre (no live fix). */
export interface PlaceData {
  lat: number
  lng: number
}

/** Phase 8, `open_app`: the app's label as the launcher shows it. */
export interface OpenedData {
  opened: string
}

/** Phase 8, `whatsapp_draft`: into a contact's chat, or WhatsApp's picker (you pick the chat). */
export interface DraftData {
  target: 'contact' | 'picker'
}

/** Phase 9: one item of a screen; numbered ones (`n`) can be acted on. `box`: [x, y, w, h] in screenshot pixels. */
export interface ScreenItem {
  n?: number
  role: string
  text?: string
  label?: string
  hint?: string
  focused?: boolean
  checked?: boolean
  selected?: boolean
  disabled?: boolean
  password?: boolean
  box?: [number, number, number, number]
}

/** Phase 9, `data.screen` (PLAN_PHASE_9.md "The contract"): the screen after an action settled. */
export interface PhoneScreen {
  id: string
  app: string | null
  package: string | null
  keyboard: boolean
  image: { jpeg_base64: string; width: number; height: number } | null
  /** Why there's no picture: `secure`, `not_supported` (below Android 11), `failed`. */
  image_missing: 'secure' | 'not_supported' | 'failed' | null
  items: ScreenItem[]
  truncated?: boolean
}

export interface ScreenData {
  screen: PhoneScreen
}

export interface ActionResult {
  status: ResultStatus
  reason?: string
  data?: PositionData | PlaceData | OpenedData | DraftData | ScreenData
}

export interface PhoneActionResultFrame extends ActionResult {
  type: 'phone_action_result'
  action_id: string
}

/**
 * A `phone_action` from a frame (args an object) or a push (every FCM data value is a string, so
 * args arrive as JSON text). Null when it isn't one (no id, no action name).
 */
export function parseAction(data: Record<string, unknown> | undefined, now: number): PhoneAction | null {
  if (!data) return null
  const actionId = data.action_id
  const action = data.action
  if (typeof actionId !== 'string' || !actionId || typeof action !== 'string' || !action) return null
  let args: unknown = data.args
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = null
    }
  }
  const expires = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN
  return {
    actionId,
    action,
    args: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
    expiresAt: Number.isFinite(expires) ? expires : now + DEFAULT_LIFETIME_MS,
  }
}

export function isExpired(action: PhoneAction, now: number): boolean {
  return now > action.expiresAt
}

export interface NavigateArgs {
  name: string | null
  lat: number | null
  lng: number | null
  query: string | null
  mode: TravelMode
  /** Google's place id, when the backend has it (sharpens the URL fallback). */
  placeId: string | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function inRange(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null
}

/** `navigate_to`'s args, or null with neither coordinates nor a query to go to. Mode defaults to car. */
export function navigateArgs(args: Record<string, unknown>): NavigateArgs | null {
  let lat = inRange(args.lat, 90)
  let lng = inRange(args.lng, 180)
  if (lat === null || lng === null) lat = lng = null
  const query = text(args.query)
  if (lat === null && !query) return null
  const mode = MODES.includes(args.mode as TravelMode) ? (args.mode as TravelMode) : 'drive'
  return { name: text(args.name), lat, lng, query, mode, placeId: text(args.place_id) }
}

export function resultFrame(actionId: string, result: ActionResult): PhoneActionResultFrame {
  return { type: 'phone_action_result', action_id: actionId, ...result }
}

// ---- Phase 8 (PLAN_PHASE_8.md "Actions"): each one's args, or null → `failed`, `bad_args` ----

/** Text she types into someone's chat: no more than this. */
export const MAX_MESSAGE_TEXT = 4_000

function textUpTo(value: unknown, max: number): string | null {
  const t = text(value)
  return t && Array.from(t).length <= max ? t : null
}

export type MediaCommand = 'play' | 'pause' | 'next' | 'previous'

const MEDIA_COMMANDS: readonly MediaCommand[] = ['play', 'pause', 'next', 'previous']

export function mediaArgs(args: Record<string, unknown>): MediaCommand | null {
  return MEDIA_COMMANDS.includes(args.command as MediaCommand) ? (args.command as MediaCommand) : null
}

/** Media volume 0–100 (a number out of range is clamped; anything else is bad). */
export function volumeArgs(args: Record<string, unknown>): number | null {
  const level = args.level
  if (typeof level !== 'number' || !Number.isFinite(level)) return null
  return Math.min(100, Math.max(0, Math.round(level)))
}

export interface AlarmArgs {
  hour: number
  minute: number
  label: string | null
  /** java.util.Calendar days: Sunday 1 … Saturday 7. Empty: once. */
  days: number[]
}

const DAYS: Record<string, number> = { sun: 1, mon: 2, tue: 3, wed: 4, thu: 5, fri: 6, sat: 7 }

/** `time` "HH:MM" (24 h), `label?`, `days?` ("mon", "Monday", …). */
export function alarmArgs(args: Record<string, unknown>): AlarmArgs | null {
  const match = typeof args.time === 'string' ? /^\s*(\d{1,2}):(\d{2})\s*$/.exec(args.time) : null
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  let days: number[] = []
  if (args.days !== undefined && args.days !== null) {
    if (!Array.isArray(args.days)) return null
    for (const day of args.days) {
      const value = typeof day === 'string' ? DAYS[day.trim().slice(0, 3).toLowerCase()] : undefined
      if (value === undefined) return null
      if (!days.includes(value)) days = [...days, value]
    }
    days.sort((a, b) => a - b)
  }
  return { hour, minute, label: textUpTo(args.label, 100), days }
}

/** A timer of 1 s to 24 h. */
export function timerArgs(args: Record<string, unknown>): { seconds: number; label: string | null } | null {
  const seconds = args.seconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  const whole = Math.round(seconds)
  if (whole < 1 || whole > 86_400) return null
  return { seconds: whole, label: textUpTo(args.label, 100) }
}

export type RingerMode = 'normal' | 'vibrate' | 'silent'

export function ringerArgs(args: Record<string, unknown>): RingerMode | null {
  return args.mode === 'normal' || args.mode === 'vibrate' || args.mode === 'silent' ? args.mode : null
}

export function dndArgs(args: Record<string, unknown>): boolean | null {
  return typeof args.on === 'boolean' ? args.on : null
}

/** A notification key the phone made (`n_…`). */
export function keyArgs(args: Record<string, unknown>): string | null {
  return textUpTo(args.key, 200)
}

export interface ReplyArgs {
  key: string
  conversationId: string | null
  revision: number | null
  text: string
}

export function replyArgs(args: Record<string, unknown>): ReplyArgs | null {
  const key = keyArgs(args)
  const body = textUpTo(args.text, MAX_MESSAGE_TEXT)
  if (!key || !body) return null
  const revision = typeof args.revision === 'number' && Number.isInteger(args.revision) && args.revision > 0 ? args.revision : null
  return { key, conversationId: textUpTo(args.conversation_id, 200), revision, text: body }
}

export function openAppArgs(args: Record<string, unknown>): string | null {
  return textUpTo(args.name, 100)
}

/** http(s) only: a link she has, opened by whichever app handles it (Discord, YouTube, a browser). */
export function openLinkArgs(args: Record<string, unknown>): string | null {
  const url = textUpTo(args.url, 2_000)
  if (!url || !/^https?:\/\/[^\s/?#]+\.[^\s]*$/i.test(url)) return null
  return url
}

export function playMusicArgs(args: Record<string, unknown>): string | null {
  return textUpTo(args.query, 200)
}

export function draftArgs(args: Record<string, unknown>): { to: string | null; text: string } | null {
  const body = textUpTo(args.text, MAX_MESSAGE_TEXT)
  return body ? { to: textUpTo(args.to, 100), text: body } : null
}

// ---- Phase 9 (PLAN_PHASE_9.md "Actions"): args are checked natively (modules/jophiel-control) ----

export const CONTROL_ACTIONS: readonly string[] = [
  'read_screen',
  'tap',
  'long_press',
  'type_text',
  'scroll',
  'tap_point',
  'swipe',
  'press',
  'end_control',
]

/** The screen JSON the native side built; null when it isn't one (then the action counts as failed). */
export function parseScreen(json: string | null): PhoneScreen | null {
  if (!json) return null
  try {
    const screen: unknown = JSON.parse(json)
    if (!screen || typeof screen !== 'object') return null
    const s = screen as Record<string, unknown>
    if (typeof s.id !== 'string' || !Array.isArray(s.items)) return null
    return screen as PhoneScreen
  } catch {
    return null
  }
}
