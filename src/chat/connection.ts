import { fetchMe } from '@/api/auth'
import { notifyUnauthorized, wsUrl } from '@/api/client'
import { getToken } from '@/auth/token'
import { reconnectDelay } from '@/connection/state'
// Phase 5: ack and reconnect timers run on the native clock, so a call's socket recovers in the background.
import { clearTimeout, setTimeout } from '@/voice/timers'
import { parseFrame, type ClientFrame, type PhoneStateReport, type SenseFrame, type ServerFrame } from './frames'
import type { QueuedMessage } from './model'
import { ACK_TIMEOUT_MS, addStrike, pickNextSend, type InFlight } from './queue'
import { VoiceChannel } from './voice'

const POLICY_VIOLATION = 1008

/** React Native's constructor (the DOM typings in scope lack its third, `headers`, argument). */
type RNWebSocket = new (url: string, protocols: string | string[] | null, options: { headers: Record<string, string> }) => WebSocket

export interface ConnectionEvents {
  onFrame: (frame: ServerFrame) => void
  onOpenChange: (open: boolean) => void
  /** A message ran out of tries (rejected, or never confirmed on a live connection). */
  onSendFailed: (turnId: string) => void
  /** Open and this socket's history is in: voice can start (it needs the conversation id). */
  onReadyChange: (ready: boolean) => void
  /** A voice reply was cut off: settle its bubble now. */
  onSettleTurn: (turnId: string) => void
  /** Phase 7: she sent this phone an action. */
  onPhoneAction: (frame: Extract<ServerFrame, { type: 'phone_action' }>) => void
}

export interface ConnectionSource {
  queue: () => readonly QueuedMessage[]
  conversationId: () => string | null
  /** The turn still streaming when the socket dropped, to resume its conversation. */
  resumeTurnId: () => string | null
  sense: () => Omit<SenseFrame, 'type' | 'client' | 'phone'>
  /** Phase 6: the `phone` object for this frame (`full`: first on this socket), or null for none. */
  phone: (full: boolean) => PhoneStateReport | null
  /** That `phone` object went out. */
  phoneSent: (report: PhoneStateReport, full: boolean) => void
  /** The chat already has this saved message. */
  knowsMessage: (messageId: string) => boolean
}

/**
 * One persistent socket to /api/chat/ws, authenticated by the bearer header. Reconnects with
 * backoff while wanted; drains the waiting queue one message at a time.
 */
export class ChatConnection {
  private ws: WebSocket | null = null
  private wanted = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight: InFlight | null = null
  private generation = 0
  /**
   * Nothing is sent until this socket's `history` frame names the primary conversation: a `run`
   * without a conversation id would start a new one.
   */
  private historyReceived = false
  /** This socket was sent the phone's whole state (its first `sense` frame); afterwards only changes. */
  private phoneSynced = false
  /** Failed tries per message; connection drops don't count. */
  private readonly strikes = new Map<string, number>()
  open = false
  ready = false
  /** Voice turns, audio and barge-in on the same socket (see voice.ts). */
  readonly voice: VoiceChannel

  constructor(
    private readonly events: ConnectionEvents,
    private readonly source: ConnectionSource,
  ) {
    this.voice = new VoiceChannel({
      send: (frame) => this.send(frame),
      sendBinary: (bytes) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
        this.ws.send(bytes)
        return true
      },
      ready: () => this.ready,
      settleTurn: (turnId) => this.events.onSettleTurn(turnId),
      knowsMessage: (messageId) => this.source.knowsMessage(messageId),
      conversationId: () => this.source.conversationId(),
    })
  }

  /** Connect now (app in the foreground), or retry immediately if a backoff is pending. */
  start() {
    this.wanted = true
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.clearReconnect()
    void this.connect()
  }

  /** "Try now": connect immediately and restart the backoff from its shortest delay. */
  retryNow() {
    this.attempt = 0
    this.stop()
    this.start()
  }

  /** Close and stop reconnecting (app in the background, or signed out). */
  stop() {
    this.wanted = false
    this.clearReconnect()
    this.clearAck()
    this.generation++
    const ws = this.ws
    this.ws = null
    ws?.close(1000)
    if (ws) this.voice.handleClose()
    this.setReady(false)
    this.setOpen(false)
  }

  send(frame: ClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(frame))
    return true
  }

  sendSense() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const full = !this.phoneSynced
    const phone = this.source.phone(full)
    const frame: SenseFrame = { type: 'sense', client: 'phone', ...this.source.sense(), ...(phone ? { phone } : {}) }
    if (!this.send(frame)) return
    this.phoneSynced = true
    if (phone) this.source.phoneSent(phone, full)
  }

  stopReply() {
    this.send({ type: 'stop', conversation_id: this.source.conversationId() })
  }

  /** Put the next waiting message on the wire, if it's time. Call after any queue change. */
  pump() {
    if (!this.open || !this.historyReceived) return
    const next = pickNextSend(this.source.queue(), this.inFlight, Date.now())
    if (!next) return
    const sent = this.send({
      type: 'run',
      conversation_id: this.source.conversationId(),
      content: next.content,
      turn_id: next.turnId,
      written_at: next.writtenAt,
      image_ids: [],
    })
    if (!sent) return
    this.inFlight = { turnId: next.turnId, sentAt: Date.now() }
    this.clearAck()
    // No ack in time on a live socket → a strike, then resend the same id (the backend dedupes).
    this.ackTimer = setTimeout(() => {
      if (this.open && this.inFlight?.turnId === next.turnId) this.strike(next.turnId)
      this.pump()
    }, ACK_TIMEOUT_MS + 50)
  }

  /** One failed try. After the last, the message is marked failed and the queue moves past it. */
  private strike(turnId: string) {
    if (!addStrike(this.strikes, turnId)) return
    if (this.inFlight?.turnId === turnId) this.inFlight = null
    this.clearAck()
    this.events.onSendFailed(turnId)
  }

  private async connect() {
    const generation = ++this.generation
    const token = await getToken()
    if (generation !== this.generation || !this.wanted) return
    if (!token) {
      notifyUnauthorized()
      return
    }
    const resume = this.source.resumeTurnId()
    const query = resume ? `?resume_turn_id=${encodeURIComponent(resume)}` : ''
    let ws: WebSocket
    try {
      // React Native's WebSocket takes headers on Android: the bearer token, no Origin.
      ws = new (WebSocket as unknown as RNWebSocket)(wsUrl(`/api/chat/ws${query}`), null, {
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch {
      this.scheduleReconnect()
      return
    }
    // Her voice arrives as binary frames of PCM.
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    const current = () => this.ws === ws && generation === this.generation

    ws.onopen = () => {
      if (!current()) return
      this.attempt = 0
      this.inFlight = null
      this.historyReceived = false
      this.phoneSynced = false
      this.setOpen(true)
      this.sendSense()
      this.pump()
    }
    ws.onmessage = (event) => {
      if (!current()) return
      if (typeof event.data !== 'string') {
        if (event.data instanceof ArrayBuffer) this.voice.handleBinary(event.data)
        return
      }
      const frame = parseFrame(event.data)
      if (!frame) return
      if (frame.type === 'phone_action') {
        this.voice.noteWorking()
        this.events.onPhoneAction(frame)
        return
      }
      if (frame.type === 'history') {
        this.historyReceived = true
        // Dispatched first, so voice reads the snapshot's conversation id once it's told it's ready.
        this.events.onFrame(frame)
        this.setReady(true)
        queueMicrotask(() => this.pump())
        return
      }
      if (frame.type === 'ack') {
        this.strikes.delete(frame.turn_id)
        if (this.inFlight?.turnId === frame.turn_id) {
          this.inFlight = null
          this.clearAck()
        }
      }
      // Voice sees every frame first: audio frames are its alone, and so is an error that answers
      // the utterance it just closed ("Couldn't transcribe that.").
      if (!this.voice.handleFrame(frame)) return
      // The backend rejects a `run` with an error that names no turn ("Invalid message payload.",
      // "Couldn't save that message."). One arriving while a message waits for its ack is that
      // message's rejection: a strike, then try again. Not her reply failing, so no snackbar.
      if (frame.type === 'error' && !frame.turn_id && this.inFlight) {
        const rejected = this.inFlight.turnId
        this.inFlight = null
        this.clearAck()
        this.strike(rejected)
        queueMicrotask(() => this.pump())
        return
      }
      this.events.onFrame(frame)
      if (frame.type === 'ack') queueMicrotask(() => this.pump())
    }
    ws.onerror = () => {
      // onclose follows; it decides what to do.
    }
    ws.onclose = (event) => {
      if (!current()) return
      this.ws = null
      this.clearAck()
      this.voice.handleClose()
      this.setReady(false)
      this.setOpen(false)
      if (event.code === POLICY_VIOLATION) {
        // The session was revoked or expired.
        notifyUnauthorized()
        return
      }
      if (this.wanted) {
        // A handshake refused before accept looks like a network error here; asking REST tells a
        // dead session (401 → sign out) apart from an unreachable server.
        fetchMe().catch(() => {})
        this.scheduleReconnect()
      }
    }
  }

  private scheduleReconnect() {
    if (!this.wanted) return
    this.clearReconnect()
    const delay = reconnectDelay(this.attempt++)
    this.reconnectTimer = setTimeout(() => void this.connect(), delay)
  }

  private setReady(ready: boolean) {
    if (this.ready === ready) return
    this.ready = ready
    this.events.onReadyChange(ready)
  }

  private setOpen(open: boolean) {
    if (this.open === open) return
    this.open = open
    this.events.onOpenChange(open)
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearAck() {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
  }
}
