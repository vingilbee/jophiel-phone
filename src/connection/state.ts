/** Reconnect backoff: 1, 2, 5, 10, then every 30 s. */
const DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export function reconnectDelay(attempt: number): number {
  return DELAYS_MS[Math.min(Math.max(attempt, 0), DELAYS_MS.length - 1)] as number
}

export type ConnectionPhase = 'connected' | 'connecting' | 'reconnecting' | 'unreachable'

/** Below this the banner stays hidden, so a quick reconnect doesn't flash. */
export const BANNER_GRACE_MS = 2_000
/** After this long without a connection, say plainly that the Mac can't be reached. */
export const UNREACHABLE_AFTER_MS = 15_000

/**
 * What the connection banner says. `downSince` is when the socket was last lost (or first tried),
 * null while connected.
 */
export function connectionPhase(open: boolean, downSince: number | null, now: number, everConnected: boolean): ConnectionPhase {
  if (open || downSince === null) return 'connected'
  const down = now - downSince
  if (down >= UNREACHABLE_AFTER_MS) return 'unreachable'
  if (down < BANNER_GRACE_MS) return 'connected'
  return everConnected ? 'reconnecting' : 'connecting'
}

export function bannerText(phase: ConnectionPhase): string | null {
  switch (phase) {
    case 'connected':
      return null
    case 'connecting':
      return 'Connecting…'
    case 'reconnecting':
      return 'Reconnecting…'
    case 'unreachable':
      return "Can't reach Jophiel. Is the Mac on and Tailscale connected?"
  }
}
