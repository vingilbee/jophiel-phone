import type { PhoneField, PhoneState } from '@/chat/frames'
import { dayLabel, timeLabel } from '@/chat/format'
import { GROUP_FIELDS, type SenseGroup } from './groups'
import { checkValue } from './report'
import { AWAY } from './places'

/** Per field: the last value that reached her, when it was sent, since when it's had it (epoch ms). */
export type LastReported = Partial<Record<PhoneField, { value: unknown; at: number; since: number }>>

const MOTION: Record<NonNullable<PhoneState['motion']>, string> = {
  still: 'Still',
  walking: 'Walking',
  running: 'Running',
  cycling: 'Cycling',
  vehicle: 'In a vehicle',
}

const RINGER: Record<NonNullable<PhoneState['ringer']>, string> = {
  normal: 'Ringer on',
  vibrate: 'Vibrate',
  silent: 'Silent',
}

/** "just now", "4 min ago", "3 h ago", "Yesterday, 18:02". */
export function agoLabel(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 12) return `${hours} h ago`
  const iso = new Date(at).toISOString()
  return `${dayLabel(iso, new Date(now))}, ${timeLabel(iso)}`
}

/** "since 18:02", or "since Yesterday, 18:02" / "since 12 Nov, 18:02" for another day. */
export function sinceLabel(at: number, now: number): string {
  const iso = new Date(at).toISOString()
  const day = dayLabel(iso, new Date(now))
  return day === 'Today' ? `since ${timeLabel(iso)}` : `since ${day}, ${timeLabel(iso)}`
}

function value<F extends PhoneField>(last: LastReported, field: F): PhoneState[F] | undefined {
  const entry = last[field]
  return entry ? checkValue(field, entry.value) : undefined
}

/** The value in words, or null when nothing (known) was sent for this group. */
function words(group: SenseGroup, last: LastReported): string | null {
  switch (group) {
    case 'phoneUse': {
      const screen = value(last, 'screen')
      const locked = value(last, 'locked')
      const parts = [screen === 'on' ? 'Screen on' : screen === 'off' ? 'Screen off' : null, locked === true ? 'locked' : locked === false ? 'unlocked' : null]
      const text = parts.filter(Boolean).join(', ')
      return text ? text.charAt(0).toUpperCase() + text.slice(1) : null
    }
    case 'battery': {
      const battery = value(last, 'battery')
      const charging = value(last, 'charging')
      if (battery == null && charging == null) return null
      const level = battery != null ? `Battery ${battery} %` : 'Battery'
      return charging == null ? level : `${level}, ${charging ? 'charging' : 'not charging'}`
    }
    case 'headphones': {
      const headphones = value(last, 'headphones')
      return headphones == null ? null : headphones ? 'Headphones connected' : 'No headphones'
    }
    case 'network': {
      const network = value(last, 'network')
      const name = value(last, 'wifi_name')
      if (network == null) return null
      if (network === 'wifi') return name ? `Wi-Fi “${name}”` : 'Wi-Fi'
      return network === 'cellular' ? 'Mobile data' : 'No network'
    }
    case 'soundMode': {
      const ringer = value(last, 'ringer')
      const dnd = value(last, 'dnd')
      const parts = [ringer ? RINGER[ringer] : null, dnd === true ? 'Do Not Disturb on' : dnd === false ? 'Do Not Disturb off' : null]
      const text = parts.filter(Boolean).join(', ')
      return text || null
    }
    case 'motion': {
      const motion = value(last, 'motion')
      return motion ? MOTION[motion] : null
    }
    case 'notifications': {
      const media = value(last, 'media')
      const navigation = value(last, 'navigation')
      const parts = [
        media ? `${media.state === 'playing' ? 'Playing' : 'Paused'}: ${media.title}${media.artist ? ` – ${media.artist}` : ''} (${media.app})` : null,
        navigation ? `Navigating: ${navigation.next_step}${navigation.eta_text ? ` · ${navigation.eta_text}` : ''}` : null,
        value(last, 'messages_on') === false ? 'Replies paused' : null,
      ]
      const text = parts.filter(Boolean).join('; ')
      return text || null
    }
    case 'places': {
      const entry = last.place
      if (!entry) return null
      const place = value(last, 'place')
      return place === AWAY ? 'Not at a saved place' : place ? `Place: ${place}` : 'Place not known'
    }
  }
}

/**
 * What she was last told for this group, and when: "Battery 64 %, charging · 2 min ago",
 * "Place: home · since 18:02". Null when nothing was sent yet.
 */
export function describeGroup(group: SenseGroup, last: LastReported, now: number): string | null {
  const text = words(group, last)
  if (!text) return null
  const entries = GROUP_FIELDS[group].map((field) => last[field]).filter((entry) => entry !== undefined)
  // Places and motion are states that last: say since when. The rest: when it was last sent.
  if (group === 'places' || group === 'motion') {
    const since = Math.max(...entries.map((entry) => entry.since))
    return `${text} · ${sinceLabel(since, now)}`
  }
  const at = Math.max(...entries.map((entry) => entry.at))
  return `${text} · ${agoLabel(at, now)}`
}
