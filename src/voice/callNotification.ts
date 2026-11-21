import type { VoiceSession } from './useVoiceSession'

/** Phase 5: the call notification's text: the state in words. */
export function callNotificationText(session: Pick<VoiceSession, 'state' | 'muted' | 'reconnecting' | 'pausedForCall'>): string {
  if (session.reconnecting) return 'Reconnecting…'
  if (session.pausedForCall) return 'Paused for a call'
  if (session.muted) return 'Muted'
  switch (session.state) {
    case 'listening':
      return 'Listening'
    case 'thinking':
      return 'Thinking'
    case 'speaking':
      return 'Speaking'
    default:
      return 'Ready to listen'
  }
}

/** Phase 5: the notification's one context action: Interrupt while she's busy, Talk now when idle. */
export function callNotificationAction(
  session: Pick<VoiceSession, 'state' | 'muted' | 'reconnecting' | 'pausedForCall' | 'holding'>,
): 'interrupt' | 'talk' | null {
  if (session.reconnecting || session.pausedForCall) return null
  if (session.state === 'thinking' || session.state === 'speaking' || session.holding) return 'interrupt'
  if (session.state === 'idle' && !session.muted) return 'talk'
  return null
}
