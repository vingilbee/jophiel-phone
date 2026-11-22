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
  /** `navigate_to`, `get_position`; others (phase 8) answer `failed`, `unknown_action` until supported. */
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

export interface ActionResult {
  status: ResultStatus
  reason?: string
  data?: PositionData
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
