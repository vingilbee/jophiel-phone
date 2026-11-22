import AsyncStorage from '@react-native-async-storage/async-storage'
import JophielActions from '../../modules/jophiel-actions'
import JophielSenses from '../../modules/jophiel-senses'
import { ApiError } from '@/api/client'
import { postActionResult } from '@/api/phone'
import { loadSettings } from '@/settings/store'
import { setTimeout as setNativeTimeout } from '@/voice/timers'
import { resultFrame, type ActionResult, type PhoneAction, type PhoneActionResultFrame } from './protocol'
import { retryDelay, runAction, type ActionDeps } from './run'

export { parseAction, type PhoneAction } from './protocol'

/** The native module is in this build (one made before phase 7 doesn't have it). */
export const actionsAvailable = JophielActions !== null

/** The chat socket, while the chat is mounted: results go over it when it's open. */
export interface ActionsSocket {
  /** False when the socket isn't open (the result then goes to the API). */
  send: (frame: PhoneActionResultFrame) => boolean
}

let socket: ActionsSocket | null = null

export function attachActionsSocket(link: ActionsSocket) {
  socket = link
}

export function detachActionsSocket(link: ActionsSocket) {
  if (socket === link) socket = null
}

// ---- Each action once ----

const SEEN_KEY = 'jophiel.actions.seen'
const SEEN_KEEP = 50
const seen = new Set<string>()
let stored: Promise<string[]> | null = null

function storedIds(): Promise<string[]> {
  stored ??= AsyncStorage.getItem(SEEN_KEY)
    .then((raw) => {
      const ids: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    })
    .catch(() => [])
  return stored
}

/**
 * True the first time an id is seen, here or in an earlier run of the app (a push that arrived
 * after the app was swiped away and opened again). Marked before any await, so a frame and a push
 * racing in the same runtime can't both pass.
 */
async function claim(actionId: string): Promise<boolean> {
  if (seen.has(actionId)) return false
  seen.add(actionId)
  const ids = await storedIds()
  if (ids.includes(actionId)) return false
  const next = [...ids, actionId].slice(-SEEN_KEEP)
  stored = Promise.resolve(next)
  await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(next)).catch(() => {})
  return true
}

// ---- Answering ----

function wait(ms: number) {
  return new Promise<void>((resolve) => setNativeTimeout(resolve, ms))
}

/** A refusal the server won't change its mind on (unknown or already-answered action, signed out). */
function final(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  if (error.kind === 'unauthorized') return true
  return error.kind === 'http' && error.status !== undefined && error.status >= 400 && error.status < 500
}

/** Over the socket when it's open, else `POST`, tried again with backoff while the action is alive. */
async function deliver(action: PhoneAction, result: ActionResult) {
  const frame = resultFrame(action.actionId, result)
  if (socket?.send(frame)) return
  await loadSettings()
  for (let attempt = 0; ; attempt++) {
    try {
      await postActionResult(action.actionId, result)
      return
    } catch (error) {
      if (final(error)) return
      const delay = retryDelay(attempt, Date.now(), action.expiresAt)
      if (delay === null) return
      await wait(delay)
      // Reconnected meanwhile: the socket is quicker.
      if (socket?.send(frame)) return
    }
  }
}

const deps: ActionDeps = {
  now: () => Date.now(),
  claim,
  switches: async () => {
    // A push may have started the app headless: the settings aren't loaded yet.
    const settings = await loadSettings()
    return { actionsEnabled: settings.actionsEnabled, placesOn: settings.senses.places }
  },
  openMaps: async (url, title) => {
    if (!JophielActions) return { status: 'failed', reason: 'not_supported' }
    return JophielActions.openMaps(url, title)
  },
  position: async () => {
    if (!JophielSenses) return { error: 'not_supported' }
    return JophielSenses.positionOnce()
  },
  deliver,
}

/** One entry for both paths (frame or push). Resolves once it's answered. */
export function dispatchAction(action: PhoneAction): Promise<ActionResult | null> {
  return runAction(action, deps)
}

/** Developer screen: run an action here, as if she had sent it; nothing is answered. */
export function runLocalAction(action: string, args: Record<string, unknown>): Promise<ActionResult | null> {
  return runAction({ actionId: `local-${Date.now()}`, action, args, expiresAt: Date.now() + 60_000, local: true }, deps)
}

// ---- Permissions (Setup, Settings) ----

export function canDrawOverlays(): boolean | null {
  try {
    return JophielActions?.canDrawOverlays() ?? null
  } catch {
    return null
  }
}

/** Null: not in this build. Always true below Android 14. */
export function canUseFullScreenIntent(): boolean | null {
  try {
    return JophielActions?.canUseFullScreenIntent() ?? null
  } catch {
    return null
  }
}

export function openOverlaySettings() {
  JophielActions?.openOverlaySettings()
}

export function openFullScreenIntentSettings() {
  JophielActions?.openFullScreenIntentSettings()
}
