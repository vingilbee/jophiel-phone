import { PHONE_FIELDS, type PhoneField, type PhoneStateReport } from '@/chat/frames'
import { GROUP_FIELDS, sameSwitches, switchedOff, type SenseSwitches } from './groups'
import { changes, checkFields, effective, fieldsOf, isEmpty, type Known } from './report'

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
   * once; the caller sends a `sense` frame right after, which carries what changed meanwhile.
   */
  setLive(on: boolean) {
    if (on === this.live || !this.native) return
    this.live = on
    if (on) {
      this.native.startLive()
      this.ingest(this.native.snapshot(), this.now())
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
      this.ingest(this.native.snapshot(), this.now())
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
    const at = report.observed_at ? Date.parse(report.observed_at) : this.now()
    this.native?.noteSent(fields, Number.isFinite(at) ? at : this.now())
  }

  /** Sign-out: off, and nothing about this account kept. */
  reset() {
    this.setLive(false)
    this.known = {}
    this.seenAt = {}
    this.sent = {}
  }

  /** Take in native values. True when one of them changed. */
  private ingest(raw: Record<string, unknown>, at: number): boolean {
    const fields = checkFields(raw)
    let changed = false
    for (const field of PHONE_FIELDS) {
      if (!(field in fields)) continue
      const value = fields[field]
      if (this.known[field] === value) continue
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
