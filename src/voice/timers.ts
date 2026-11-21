import JophielAudio from '../../modules/jophiel-audio'
import { createClock, jsClock, type Clock } from './clock'

export type { TimerHandle } from './clock'

/**
 * Phase 5: the call's clock (see ./clock). Same shape as the global `setTimeout` / `clearTimeout`,
 * so swapping them in is an import change. Timers here fire with the app in the background and the
 * screen off.
 */
const clock: Clock = JophielAudio
  ? createClock({
      setTimer: (id, ms) => JophielAudio!.setTimer(id, ms),
      clearTimer: (id) => JophielAudio!.clearTimer(id),
      onTimer: (listener) => JophielAudio!.addListener('onTimer', (event) => listener(event.id)),
    })
  : jsClock()

export const setTimeout = clock.setTimeout
export const clearTimeout = clock.clearTimeout
