import type { ChatItem } from './model'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function sameDay(a: string, b: string): boolean {
  return dayStart(new Date(a)) === dayStart(new Date(b))
}

/** "Today", "Yesterday", "12 Nov", or "12 Nov 2025" for another year. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`
}

/** 24-hour "09:41". */
export function timeLabel(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** "9 h", "25 min", "2 days": how long a queued message waited before it arrived. */
export function delayLabel(fromIso: string, toIso: string): string {
  const minutes = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} days`
}

export interface ChatRow {
  item: ChatItem
  /** First bubble of a run of consecutive messages from the same sender: shows the picture. */
  firstOfRun: boolean
  lastOfRun: boolean
  /** A date divider goes above this row. */
  dayDivider: string | null
}

/** Group items into rows: runs per sender (broken by a new day) and date dividers. Oldest first. */
export function toRows(items: readonly ChatItem[], now: Date = new Date()): ChatRow[] {
  return items.map((item, index) => {
    const prev = items[index - 1]
    const next = items[index + 1]
    const newDay = !prev || !sameDay(prev.at, item.at)
    const nextNewDay = !next || !sameDay(item.at, next.at)
    return {
      item,
      firstOfRun: newDay || prev?.role !== item.role,
      lastOfRun: nextNewDay || next?.role !== item.role,
      dayDivider: newDay ? dayLabel(item.at, now) : null,
    }
  })
}
