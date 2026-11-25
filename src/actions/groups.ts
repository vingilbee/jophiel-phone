/**
 * Phase 8: Settings → Phone actions has the master switch (phase 7) and one switch per group. All
 * on by default (owner, 2026-11-22). Mirrored natively where native code checks it (Messages, at
 * reply dispatch; Phone control, which ends her control at once when it goes off).
 */
export const ACTION_GROUPS = ['media', 'messages', 'alarms', 'opening', 'control'] as const

export type ActionGroup = (typeof ACTION_GROUPS)[number]

export type ActionGroups = Record<ActionGroup, boolean>

export function defaultActionGroups(): ActionGroups {
  return { media: true, messages: true, alarms: true, opening: true, control: true }
}

/**
 * Which group an action belongs to; null: the master switch alone (navigation, position, ringer,
 * Do Not Disturb, dismissing a notification).
 */
export const ACTION_GROUP: Partial<Record<string, ActionGroup>> = {
  media_control: 'media',
  set_volume: 'media',
  reply_notification: 'messages',
  whatsapp_draft: 'messages',
  set_alarm: 'alarms',
  set_timer: 'alarms',
  open_app: 'opening',
  open_link: 'opening',
  play_music: 'opening',
  // Phase 9: phone control (on by default, PLAN_PHASE_9.md).
  read_screen: 'control',
  tap: 'control',
  long_press: 'control',
  type_text: 'control',
  scroll: 'control',
  tap_point: 'control',
  swipe: 'control',
  press: 'control',
  end_control: 'control',
}
