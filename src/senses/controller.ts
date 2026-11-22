import { PHONE_FIELDS, type PhoneField, type PhoneStateReport } from '@/chat/frames'
import { GROUP_FIELDS, SENSE_GROUPS, sameSwitches, switchedOff, type SenseSwitches } from './groups'
import { changes, checkFields, effective, fieldsOf, isEmpty, sameValue, type Known } from './report'

/**
 * Fields that come from wake-ups (geofences, activity transitions), not from live readers. The
 * native module is their source of truth: it forgets them when their group is switched off, and its
 * snapshot leaves them out until a fresh reading arrives.
 */
const WAKE_UP_FIELDS: readonly PhoneField[] = ['motion', 'place', 'media', 'navigation']

/** Fields JS itself knows (a setting), not the native module: a snapshot never clears them. */
const LOCAL_FIELDS: readonly PhoneField[] = ['replies_paused']

/** What the controller needs from the native module (a stand-in in tests; null in an old build). */
export interface SensesNative {
  snapshot(): Record<string, unknown>
  startLive(): void
  stopLive(): void
  noteSent(fields: Record<string, unknown>, at: number): void
  sendInBackground(fields: Record<string, unknown>, at: number): void
  onChange(listener: (fields: Record<string, unknown>, at: number) => void): { remove(): void }
}

/** The chat socket, as the controller sees it. */
export interface SensesLink {
  /** Send a `sense` frame now (it asks `report` what goes in it). */
  sendSense(): void
  isOpen(): boolean
}

/**
 * Phone senses on the JS side. Keeps the latest value of every field (from the native live readers
 * while the app is visible or a call is on) and what the current socket was sent, and answers
 * what the next `sense` frame carries: everything on connect, afterwards only what changed.
 */
export class PhoneSenses {
  private known: Known = {}
  /** When each known value was seen (epoch ms). */
  private seenAt: Partial<Record<PhoneField, number>> = {}
  /** What this socket was sent. */
  private sent: Known = {}
  private live = false
  private link: SensesLink | null = null
  private switches: SenseSwitches

  constructor(
    private readonly native: SensesNative | null,
    initialSwitches: SenseSwitches,
    private readonly now: () => number = Date.now,
  ) {
    this.switches = { ...initialSwitches }
    native?.onChange((fields, at) => {
      if (!this.live) return
      if (this.ingest(fields, at)) this.flush()
    })
  }

  attach(link: SensesLink) {
    this.link = link
  }

  detach(link: SensesLink) {
    if (this.link === link) this.link = null
  }

  isLive(): boolean {
    return this.live
  }

  /**
   * Live readers on (app visible, or a call keeping it alive) or off. Turning on reads everything
   * once and forgets what this socket was sent, so the `sense` frame the caller sends right after
   * carries every known field again, changed or not: the server confirms as current only what the
   * phone sent since it last went live (backend `phone_state.report`, `confirm`), so an unchanged
   * value left out would be said to be old while the app is watching it.
   */
  setLive(on: boolean) {
    if (on === this.live || !this.native) return
    this.live = on
    if (on) {
      this.native.startLive()
      this.ingestSnapshot()
      this.sent = {}
    } else {
      this.native.stopLive()
    }
  }

  /**
   * The switches changed. A group switched off sends null once for its fields (over the socket, or a
   * background PUT when there's none); one switched on sends its current values.
   */
  setSwitches(next: SenseSwitches) {
    if (sameSwitches(this.switches, next)) return
    const off = switchedOff(this.switches, next)
    const now = this.now()
    for (const group of SENSE_GROUPS) {
      if (this.switches[group] === next[group]) continue
      for (const field of GROUP_FIELDS[group]) {
        // The change happened now: a null sent for it must not carry an older sighting's time (the
        // server keeps whichever observation is newer, so an old-stamped clear would be ignored).
        this.seenAt[field] = now
        // A place or motion from before the switch-off is stale by the time it's back on: wait for
        // a fresh reading (the native side forgot it too).
        if (!next[group] && WAKE_UP_FIELDS.includes(field)) delete this.known[field]
      }
    }
    this.switches = { ...next }
    if (this.link?.isOpen()) {
      this.link.sendSense()
      return
    }
    if (off.length === 0 || !this.native) return
    const nulls: Record<string, null> = {}
    for (const group of off) for (const field of GROUP_FIELDS[group]) nulls[field] = null
    this.native.sendInBackground(nulls, this.now())
  }

  /**
   * The `phone` object for the next `sense` frame, or null when there's nothing to say. `full`: a
   * new socket, so everything (re-read now); otherwise only what changed since this socket's last.
   */
  report(full: boolean): PhoneStateReport | null {
    if (!this.native) return null
    if (full) {
      this.ingestSnapshot()
      const fields = effective(this.known, this.switches)
      return isEmpty(fields) ? null : { ...fields, observed_at: new Date(this.now()).toISOString() }
    }
    const fields = changes(effective(this.known, this.switches), this.sent)
    if (isEmpty(fields)) return null
    // The newest sighting among them (a switch turned off is "now").
    const now = this.now()
    let at = 0
    for (const field of Object.keys(fields) as PhoneField[]) at = Math.max(at, this.seenAt[field] ?? now)
    return { ...fields, observed_at: new Date(Math.min(at, now)).toISOString() }
  }

  /** The frame with this report went out. */
  markSent(report: PhoneStateReport, full: boolean) {
    const fields = fieldsOf(report)
    this.sent = full ? { ...fields } : { ...this.sent, ...fields }
    const parsed = report.observed_at ? Date.parse(report.observed_at) : Number.NaN
    this.native?.noteSent(fields, Number.isFinite(parsed) ? parsed : this.now())
  }

  /**
   * A field JS knows itself (phase 8: `replies_paused`, from Settings). `send`: it just changed, so
   * tell her now (the socket if open, else a background PUT); otherwise the next `sense` frame
   * carries it.
   */
  setLocal(fields: Known, send: boolean) {
    const now = this.now()
    let changed = false
    for (const field of LOCAL_FIELDS) {
      if (!(field in fields)) continue
      const value = fields[field]
      this.seenAt[field] = now
      if (sameValue(this.known[field], value)) continue
      ;(this.known as Record<string, unknown>)[field] = value
      changed = true
    }
    if (!changed || !send) return
    if (this.link?.isOpen()) {
      this.flush()
      return
    }
    const out = effective(this.known, this.switches)
    const background: Record<string, unknown> = {}
    for (const field of LOCAL_FIELDS) if (field in fields && field in out) background[field] = out[field]
    if (this.native && !isEmpty(background as Known)) this.native.sendInBackground(background, now)
  }

  /** Sign-out: off, and nothing about this account kept. */
  reset() {
    this.setLive(false)
    this.known = {}
    this.seenAt = {}
    this.sent = {}
  }

  /** Read everything now. Place and motion missing from the snapshot are unknown, not "as before". */
  private ingestSnapshot() {
    const raw = this.native!.snapshot()
    for (const field of WAKE_UP_FIELDS) {
      if (!(field in raw)) {
        delete this.known[field]
        delete this.seenAt[field]
      }
    }
    this.ingest(raw, this.now())
  }

  /**
   * Take in native values seen at `at`. True when one of them changed. An observation older than
   * the field's latest (a callback arriving after a snapshot re-read it, or after its switch
   * changed) is dropped: sent with its own time the server would ignore it anyway, and sent with a
   * newer one it would replace a newer reading.
   */
  private ingest(raw: Record<string, unknown>, at: number): boolean {
    const fields = checkFields(raw)
    let changed = false
    for (const field of PHONE_FIELDS) {
      if (!(field in fields)) continue
      const seen = this.seenAt[field]
      if (seen !== undefined && at < seen) continue
      const value = fields[field]
      if (sameValue(this.known[field], value)) {
        // Re-confirmed: later stragglers must be newer than this.
        this.seenAt[field] = at
        continue
      }
      ;(this.known as Record<string, unknown>)[field] = value
      this.seenAt[field] = at
      changed = true
    }
    return changed
  }

  /** Something changed while live: send it if the socket is up (otherwise the next connect does). */
  private flush() {
    if (!this.link?.isOpen()) return
    if (isEmpty(changes(effective(this.known, this.switches), this.sent))) return
    this.link.sendSense()
  }
}
