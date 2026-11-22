import { destinationTitle, mapsUrl } from './maps'
import type { Place } from '@/senses/places'
import { ACTION_GROUP, type ActionGroups } from './groups'
import {
  alarmArgs,
  dndArgs,
  draftArgs,
  isExpired,
  keyArgs,
  mediaArgs,
  navigateArgs,
  openAppArgs,
  openLinkArgs,
  playMusicArgs,
  replyArgs,
  ringerArgs,
  timerArgs,
  volumeArgs,
  type ActionResult,
  type AlarmArgs,
  type MediaCommand,
  type PhoneAction,
  type PositionData,
  type ReplyArgs,
  type RingerMode,
} from './protocol'

export type PositionAnswer =
  | { latitude: number; longitude: number; accuracy: number; fixAt: number; error?: undefined }
  | { error: 'no_permission' | 'location_off' | 'no_fix' | 'not_supported' }

/** What a native device action answered (`data`: `opened` / `target`). */
export interface DeviceAnswer {
  status: 'done' | 'notified' | 'refused' | 'failed'
  reason: string | null
  data?: { opened?: string; target?: 'contact' | 'picker' } | null
}

/** Phase 8's device actions (modules/jophiel-actions and jophiel-notifications); args already checked. */
export interface DeviceDeps {
  mediaControl: (command: MediaCommand) => Promise<DeviceAnswer>
  setVolume: (level: number) => Promise<DeviceAnswer>
  setAlarm: (args: AlarmArgs) => Promise<DeviceAnswer>
  setTimer: (seconds: number, label: string | null) => Promise<DeviceAnswer>
  setRinger: (mode: RingerMode) => Promise<DeviceAnswer>
  setDnd: (on: boolean) => Promise<DeviceAnswer>
  dismiss: (key: string) => Promise<DeviceAnswer>
  reply: (args: ReplyArgs) => Promise<DeviceAnswer>
  openApp: (name: string) => Promise<DeviceAnswer>
  openLink: (url: string) => Promise<DeviceAnswer>
  playMusic: (query: string) => Promise<DeviceAnswer>
  whatsappDraft: (to: string | null, text: string) => Promise<DeviceAnswer>
}

/** The switches an action is checked against (read when it arrives). */
export interface ActionSwitches {
  /** Settings → "Let Jophiel act on this phone" (the master switch). */
  actionsEnabled: boolean
  /** Phase 6's Places group. */
  placesOn: boolean
  /** Phase 8: the Notifications sense (without it she knows no notification to reply to or dismiss). */
  notificationsOn: boolean
  /** Phase 8: Media, Messages, Alarms & timers, Opening apps. */
  groups: ActionGroups
}

/** Everything an action needs from the phone; stand-ins in tests (src/actions/actions.test.ts). */
export interface ActionDeps {
  now: () => number
  /** First time this action id is seen (a frame and a late push can both bring it). */
  claim: (actionId: string) => Promise<boolean>
  switches: () => Promise<ActionSwitches>
  openMaps: (url: string, title: string) => Promise<{ status: 'done' | 'notified' | 'failed'; reason: string | null }>
  position: () => Promise<PositionAnswer>
  /** Settings → Places (phase 6), for `resolve_saved_place`. */
  places: () => Promise<Place[]>
  device: DeviceDeps
  /** Hand the result to the backend (socket, else the API); skipped for local actions. */
  deliver: (action: PhoneAction, result: ActionResult) => Promise<void>
}

/** Need a notification she was told about. */
const USES_NOTIFICATIONS = new Set(['reply_notification', 'dismiss_notification'])

/**
 * The checks every action passes, in order: too late → `expired`; the master switch → `refused`,
 * `switched_off`; per action: `get_position` / `resolve_saved_place` need the Places group
 * (`places_off`); phase 8's groups (the Messages switch off → `replies_paused`, any other →
 * `switched_off`); replying to or dismissing a notification needs the Notifications sense
 * (`switched_off`). Null: go ahead. Permissions are read natively when the action runs.
 */
export function precheck(action: PhoneAction, now: number, switches: ActionSwitches): ActionResult | null {
  if (isExpired(action, now)) return { status: 'expired' }
  if (!switches.actionsEnabled) return { status: 'refused', reason: 'switched_off' }
  const usesPlaces = action.action === 'get_position' || action.action === 'resolve_saved_place'
  if (usesPlaces && !switches.placesOn) return { status: 'refused', reason: 'places_off' }
  const group = ACTION_GROUP[action.action]
  if (group && !switches.groups[group]) return { status: 'refused', reason: group === 'messages' ? 'replies_paused' : 'switched_off' }
  if (USES_NOTIFICATIONS.has(action.action) && !switches.notificationsOn) return { status: 'refused', reason: 'switched_off' }
  return null
}

function answered(answer: DeviceAnswer): ActionResult {
  const result: ActionResult = { status: answer.status }
  if (answer.reason) result.reason = answer.reason
  // The backend takes `data` only with `done` (a `notified` open_app carrying `opened` is rejected whole).
  if (answer.status !== 'done') return result
  if (answer.data?.opened) result.data = { opened: answer.data.opened }
  else if (answer.data?.target) result.data = { target: answer.data.target }
  return result
}

const BAD_ARGS: ActionResult = { status: 'failed', reason: 'bad_args' }

/** Phase 8: check the args, then hand it to the native side. */
async function device<T>(args: T | null, run: (args: T) => Promise<DeviceAnswer>): Promise<ActionResult> {
  if (args === null) return BAD_ARGS
  return answered(await run(args))
}

async function navigate(action: PhoneAction, deps: ActionDeps): Promise<ActionResult> {
  const args = navigateArgs(action.args)
  if (!args) return { status: 'failed', reason: 'bad_args' }
  const outcome = await deps.openMaps(mapsUrl(args), destinationTitle(args))
  return outcome.reason ? { status: outcome.status, reason: outcome.reason } : { status: outcome.status }
}

async function getPosition(deps: ActionDeps): Promise<ActionResult> {
  const answer = await deps.position()
  if (answer.error === 'no_permission' || answer.error === 'location_off') return { status: 'refused', reason: answer.error }
  if (answer.error) return { status: 'failed', reason: answer.error }
  const data: PositionData = {
    lat: answer.latitude,
    lng: answer.longitude,
    accuracy_m: Math.round(answer.accuracy),
    fix_at: new Date(answer.fixAt).toISOString(),
  }
  return { status: 'done', data }
}

/** Trimmed, case-insensitive, inner spaces collapsed: "  Work " is "work". */
function placeKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** "From work to …": a saved place's centre by its name. None → `not_found`, several → `ambiguous`. */
async function resolveSavedPlace(action: PhoneAction, deps: ActionDeps): Promise<ActionResult> {
  const name = action.args.name
  if (typeof name !== 'string' || !name.trim()) return { status: 'failed', reason: 'bad_args' }
  const key = placeKey(name)
  const matches = (await deps.places()).filter((place) => placeKey(place.name) === key)
  const [place, other] = matches
  if (!place) return { status: 'failed', reason: 'not_found' }
  if (other) return { status: 'failed', reason: 'ambiguous' }
  return { status: 'done', data: { lat: place.latitude, lng: place.longitude } }
}

/**
 * Run one action and answer it once. A repeat of an id already handled is ignored (no second
 * Maps, no second answer). Never throws: anything unexpected answers `failed`.
 */
export async function runAction(action: PhoneAction, deps: ActionDeps): Promise<ActionResult | null> {
  if (!action.local && !(await deps.claim(action.actionId))) return null
  let result: ActionResult
  try {
    // The clock is read after the settings load (slow on a push-started app), not before.
    const switches = await deps.switches()
    result = precheck(action, deps.now(), switches) ?? (await perform(action, deps))
  } catch {
    result = { status: 'failed', reason: 'error' }
  }
  if (!action.local) await deps.deliver(action, result).catch(() => {})
  return result
}

function perform(action: PhoneAction, deps: ActionDeps): Promise<ActionResult> {
  switch (action.action) {
    case 'navigate_to':
      return navigate(action, deps)
    case 'get_position':
      return getPosition(deps)
    case 'resolve_saved_place':
      return resolveSavedPlace(action, deps)
    // ---- Phase 8 ----
    case 'media_control':
      return device(mediaArgs(action.args), deps.device.mediaControl)
    case 'set_volume':
      return device(volumeArgs(action.args), deps.device.setVolume)
    case 'set_alarm':
      return device(alarmArgs(action.args), deps.device.setAlarm)
    case 'set_timer':
      return device(timerArgs(action.args), (a) => deps.device.setTimer(a.seconds, a.label))
    case 'set_ringer':
      return device(ringerArgs(action.args), deps.device.setRinger)
    case 'set_dnd':
      return device(dndArgs(action.args), deps.device.setDnd)
    case 'dismiss_notification':
      return device(keyArgs(action.args), deps.device.dismiss)
    case 'reply_notification':
      return device(replyArgs(action.args), deps.device.reply)
    case 'open_app':
      return device(openAppArgs(action.args), deps.device.openApp)
    case 'open_link':
      return device(openLinkArgs(action.args), deps.device.openLink)
    case 'play_music':
      return device(playMusicArgs(action.args), deps.device.playMusic)
    case 'whatsapp_draft':
      return device(draftArgs(action.args), (a) => deps.device.whatsappDraft(a.to, a.text))
    default:
      return Promise.resolve({ status: 'failed', reason: 'unknown_action' })
  }
}

/** Waits between POST tries while the action is still alive (answers only matter briefly). */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

/** The delay before try `attempt` (0-based, after the first), or null: give up (out of tries, or past `expiresAt`). */
export function retryDelay(attempt: number, now: number, expiresAt: number): number | null {
  const delay = RETRY_DELAYS_MS[attempt]
  if (delay === undefined || now + delay > expiresAt) return null
  return delay
}
