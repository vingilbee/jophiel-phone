import type { PhoneField } from '@/chat/frames'

/** The seven switch groups of Settings → Phone senses (the native module uses the same names). */
export const SENSE_GROUPS = ['phoneUse', 'battery', 'headphones', 'network', 'soundMode', 'motion', 'places'] as const

export type SenseGroup = (typeof SENSE_GROUPS)[number]

export type SenseSwitches = Record<SenseGroup, boolean>

export const GROUP_FIELDS: Record<SenseGroup, readonly PhoneField[]> = {
  phoneUse: ['screen', 'locked'],
  battery: ['battery', 'charging'],
  headphones: ['headphones'],
  network: ['network', 'wifi_name'],
  soundMode: ['dnd', 'ringer'],
  motion: ['motion'],
  places: ['place'],
}

const FIELD_GROUP = Object.fromEntries(
  SENSE_GROUPS.flatMap((group) => GROUP_FIELDS[group].map((field) => [field, group] as const)),
) as Record<PhoneField, SenseGroup>

export function groupOf(field: PhoneField): SenseGroup {
  return FIELD_GROUP[field]
}

/** All on by default (owner, 2026-11-21). */
export function defaultSwitches(): SenseSwitches {
  return { phoneUse: true, battery: true, headphones: true, network: true, soundMode: true, motion: true, places: true }
}

/** The groups that went from on to off. */
export function switchedOff(before: SenseSwitches, after: SenseSwitches): SenseGroup[] {
  return SENSE_GROUPS.filter((group) => before[group] && !after[group])
}

export function sameSwitches(a: SenseSwitches, b: SenseSwitches): boolean {
  return SENSE_GROUPS.every((group) => a[group] === b[group])
}
