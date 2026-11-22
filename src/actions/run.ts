import { destinationTitle, mapsUrl } from './maps'
import { isExpired, navigateArgs, type ActionResult, type PhoneAction, type PositionData } from './protocol'

export type PositionAnswer =
  | { latitude: number; longitude: number; accuracy: number; fixAt: number; error?: undefined }
  | { error: 'no_permission' | 'location_off' | 'no_fix' | 'not_supported' }

/** Everything an action needs from the phone; stand-ins in tests (src/actions/actions.test.ts). */
export interface ActionDeps {
  now: () => number
  /** First time this action id is seen (a frame and a late push can both bring it). */
  claim: (actionId: string) => Promise<boolean>
  /** Settings → "Let Jophiel act on this phone", and the phase 6 Places group. */
  switches: () => Promise<{ actionsEnabled: boolean; placesOn: boolean }>
  openMaps: (url: string, title: string) => Promise<{ status: 'done' | 'notified' | 'failed'; reason: string | null }>
  position: () => Promise<PositionAnswer>
  /** Hand the result to the backend (socket, else the API); skipped for local actions. */
  deliver: (action: PhoneAction, result: ActionResult) => Promise<void>
}

/**
 * The checks every action passes, in order: too late → `expired`; the master switch → `refused`,
 * `switched_off`; per action (`get_position`: the Places group → `refused`, `places_off`). Null: go
 * ahead. Permission and "location is on" are read natively when the position is taken.
 */
export function precheck(
  action: PhoneAction,
  now: number,
  switches: { actionsEnabled: boolean; placesOn: boolean },
): ActionResult | null {
  if (isExpired(action, now)) return { status: 'expired' }
  if (!switches.actionsEnabled) return { status: 'refused', reason: 'switched_off' }
  if (action.action === 'get_position' && !switches.placesOn) return { status: 'refused', reason: 'places_off' }
  return null
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

/**
 * Run one action and answer it once. A repeat of an id already handled is ignored (no second
 * Maps, no second answer). Never throws: anything unexpected answers `failed`.
 */
export async function runAction(action: PhoneAction, deps: ActionDeps): Promise<ActionResult | null> {
  if (!action.local && !(await deps.claim(action.actionId))) return null
  let result: ActionResult
  try {
    result = precheck(action, deps.now(), await deps.switches()) ?? (await perform(action, deps))
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
