/**
 * The voice half of the chat socket.
 *
 * Ported from the voice half of ../app/frontend/src/hooks/useChatSocket.ts at web commit 2aab645:
 * the same frames, the same turn bookkeeping (`pending`, `voiceTurnId`, `held`, `audioTurnId`)
 * and the same fencing (`fencedTurns`, `dropAudio`, `ignoredNudge`), so a fix on one side can be
 * copied to the other. What differs is only the plumbing: on the phone the chat bubbles come from
 * the chat model (model.ts), which sees every frame, so the voice turn here only tracks what the
 * voice loop needs (its reply text, to know whether audio is coming) and settles cut-off turns in
 * the model through `settleTurn`.
 *
 * Voice turns go outside the text waiting queue: they're live, never retried.
 */
import type { BargeAction, ClientFrame, MessageStatus, ServerFrame, VoiceLatencyReport } from './frames'
import { newTurnId } from './queue'

export interface VoiceTurnResult {
  conversationId: string
  reply: string
  status: MessageStatus
}

/** Callbacks for the voice loop (src/voice/useVoiceSession.ts). */
export interface VoiceEvents {
  /** `unprompted`: she's speaking first (a nudge), not replying. */
  onAudioStart?: (sampleRate: number, unprompted: boolean) => void
  onAudio?: (pcm: Int16Array, sampleRate: number) => void
  onAudioEnd?: () => void
  /** The audio that follows speaks this span of the reply's text. */
  onAudioSegment?: (segment: number, textStart: number, textEnd: number) => void
  /** A held interruption was decided (see `holdVoice`). */
  onBargeResolved?: (action: BargeAction) => void
  /**
   * Something urgent happened: the server cut off the reply in flight because it's out of date,
   * and an unprompted message follows.
   */
  onReplyInterrupted?: () => void
  /** The socket closed. Called before the voice turn in flight is settled. */
  onDisconnect?: () => void
  /** Her hands acted on this phone while a voice reply is pending: she's working, not stuck. */
  onWorking?: () => void
}

/** What the channel needs from the connection. */
export interface VoiceIo {
  /** False when the socket isn't open. */
  send: (frame: ClientFrame) => boolean
  sendBinary: (bytes: Uint8Array) => boolean
  /** Open, and this socket's `history` is in (so the conversation id is known). */
  ready: () => boolean
  /** A turn was cut off here: settle its bubble now rather than waiting for the server's `stopped`. */
  settleTurn: (turnId: string) => void
  /** The chat already shows this message (a nudge seen before). */
  knowsMessage: (messageId: string) => boolean
  conversationId: () => string | null
}

interface Pending {
  resolve: (result: VoiceTurnResult) => void
  reject: (err: Error) => void
  buffer: string
  conversationId: string | null
  turnId: string
}

export class VoiceChannel {
  events: VoiceEvents = {}
  private pending: Pending | null = null
  private audioRate = 32000
  private voiceTurnId: string | null = null
  // The voice turn whose timing marks haven't been reported yet. Separate from voiceTurnId, which
  // is cleared on `done` and replaced by the next utterance before the previous turn's report may
  // have gone out.
  private latencyTurnId: string | null = null
  // Barge-in fencing. Turns the user talked over, so their late audio (the worker can still be
  // mid-chunk, the relay mid-flight) never plays again, and whether the current audio envelope
  // belongs to one of them. Binary frames carry no turn id, so they inherit it from the last
  // `audio_start`.
  private fencedTurns: string[] = []
  // Turns whose audio was lost with a dropped connection: their audio never plays, but their text
  // still streams into the chat (the reconnect replays it).
  private silencedTurns: string[] = []
  private dropAudio = false
  private ignoredNudge = false
  // An open hold: the utterance talking over a paused reply, and the voice turn id to restore if
  // the reply resumes.
  private held: { turnId: string; previousVoiceTurnId: string | null } | null = null
  // The turn whose audio is playing — not the pending turn: a reply's text usually finishes (and
  // settles) while its audio is still being spoken.
  private audioTurnId: string | null = null
  // The turn a finished utterance is waiting on, so turning voice off can settle it.
  private voiceReplyTurnId: string | null = null

  constructor(private readonly io: VoiceIo) {}

  // ---- Incoming ------------------------------------------------------------------------------

  /**
   * A phone action for her arrived (her hands on this screen). While a voice turn waits for its
   * reply, that's proof the turn is alive, even though it has said nothing yet.
   */
  noteWorking() {
    if (this.pending) this.events.onWorking?.()
  }

  /** Streamed TTS audio for the reply being spoken. */
  handleBinary(data: ArrayBuffer) {
    if (this.dropAudio) return
    const samples = data.byteLength >> 1
    if (samples === 0) return
    this.events.onAudio?.(new Int16Array(data, 0, samples), this.audioRate)
  }

  /**
   * Sees every text frame before the chat model does. Returns false for frames the model must not
   * see: audio frames, and late text of a turn that was cut off.
   */
  handleFrame(frame: ServerFrame): boolean {
    switch (frame.type) {
      case 'reply_interrupted':
        // Stop the stale reply where it is (and report what was heard) before its turn is fenced,
        // so the urgent message that follows plays next.
        this.events.onReplyInterrupted?.()
        this.fenceInFlightTurn()
        return true
      case 'nudge_start': {
        const current = this.io.conversationId()
        this.ignoredNudge =
          (current !== null && frame.conversation_id !== current) ||
          (!!frame.message_id && this.io.knowsMessage(frame.message_id))
        return true
      }
      // Audio frames are not tied to the pending turn — a voice turn can be speaking while its
      // text has already settled.
      case 'audio_start':
        // Every reply's audio opens with this frame, so it is also where a fence from a previous
        // interruption is lifted for the next reply.
        this.dropAudio =
          (frame.unprompted === true && this.ignoredNudge) ||
          (!!frame.turn_id && (this.fencedTurns.includes(frame.turn_id) || this.silencedTurns.includes(frame.turn_id)))
        if (this.dropAudio) return false
        this.audioTurnId = frame.turn_id ?? null
        this.audioRate = frame.sample_rate
        this.events.onAudioStart?.(frame.sample_rate, frame.unprompted === true)
        return false
      case 'audio_segment':
        if (!this.dropAudio) this.events.onAudioSegment?.(frame.segment, frame.text_start, frame.text_end)
        return false
      case 'audio_end':
        if (this.dropAudio || (frame.turn_id && this.fencedTurns.includes(frame.turn_id))) return false
        this.events.onAudioEnd?.()
        return false
      case 'barge_resolved':
        // Only for the hold still open; a stale decision changes nothing.
        if (this.held?.turnId === frame.turn_id) this.events.onBargeResolved?.(frame.action)
        return false
      case 'transcript':
        return true
      default:
        break
    }

    // A cut-off turn's late text stays out of the chat (its bubble was settled when it was cut).
    if ((frame.type === 'token' || frame.type === 'sticker') && frame.turn_id && this.fencedTurns.includes(frame.turn_id)) {
      return false
    }

    const pending = this.pending
    if (!pending) return true
    const eventTurnId = 'turn_id' in frame ? frame.turn_id : undefined
    if (eventTurnId && eventTurnId !== pending.turnId) return true
    switch (frame.type) {
      case 'meta':
        pending.conversationId = frame.conversation_id
        return true
      case 'ack':
        pending.conversationId = frame.conversation_id
        return true
      case 'token':
        pending.buffer += frame.content
        return true
      case 'done':
      case 'stopped':
        pending.resolve({
          conversationId: pending.conversationId ?? '',
          reply: pending.buffer,
          status: frame.status ?? (frame.type === 'stopped' ? 'cancelled' : 'completed'),
        })
        if (pending.turnId === this.voiceTurnId) this.voiceTurnId = null
        this.pending = null
        return true
      case 'error':
        pending.reject(new Error(frame.detail || 'Assistant error'))
        this.pending = null
        // "Couldn't transcribe that" and the like are the voice loop's to show; a reply that
        // failed half-way is also the chat's (its bubble says so).
        return !!frame.turn_id
      default:
        return true
    }
  }

  /** The socket closed: the reply being spoken is lost; its text comes back with the reconnect. */
  handleClose() {
    this.events.onDisconnect?.()
    this.held = null
    const lost = [this.pending?.turnId, this.audioTurnId].filter((id): id is string => !!id)
    this.silencedTurns = [...this.silencedTurns, ...lost].slice(-16)
    this.dropAudio = true
    const pending = this.pending
    this.pending = null
    this.voiceTurnId = null
    this.voiceReplyTurnId = null
    this.latencyTurnId = null
    pending?.resolve({ conversationId: pending.conversationId ?? '', reply: pending.buffer, status: 'cancelled' })
  }

  // ---- Outgoing ------------------------------------------------------------------------------

  /** Register the pending voice turn and return the promise the caller awaits. */
  private beginTurn(conversationId: string | null, send: () => void, turnId: string) {
    return new Promise<VoiceTurnResult>((resolve, reject) => {
      if (!this.io.ready()) {
        reject(new Error('Not connected. Reconnecting…'))
        return
      }
      if (this.pending) {
        reject(new Error('A response is already in progress.'))
        return
      }
      this.pending = { resolve, reject, buffer: '', conversationId, turnId }
      send()
    })
  }

  /** Open an utterance. Binary frames sent after this are its audio. */
  startVoice(conversationId: string | null, sampleRate: number): boolean {
    if (!this.io.ready()) return false
    const turnId = newTurnId()
    this.voiceTurnId = turnId
    return this.io.send({ type: 'voice_start', conversation_id: conversationId, turn_id: turnId, sample_rate: sampleRate })
  }

  sendAudio(pcm: Int16Array) {
    if (!this.io.ready()) return
    this.io.sendBinary(new Uint8Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength))
  }

  /** Close the utterance and run the turn. Resolves when her reply's text is done. */
  endVoice(conversationId: string | null): Promise<VoiceTurnResult> {
    const turnId = this.voiceTurnId ?? newTurnId()
    return this.beginTurn(
      conversationId,
      () => {
        this.latencyTurnId = this.voiceTurnId
        this.voiceReplyTurnId = turnId
        this.io.send({ type: 'voice_end', turn_id: this.voiceTurnId })
      },
      turnId,
    )
  }

  /** Send the phone's timing marks for the last voice turn. At most once per turn; measurement only. */
  reportVoiceLatency(report: VoiceLatencyReport) {
    const turnId = this.latencyTurnId
    this.latencyTurnId = null
    if (!turnId) return
    this.io.send({ type: 'voice_latency', turn_id: turnId, ...report })
  }

  /**
   * Discard the open utterance without running a turn. A spoken turn still waiting for its reply is
   * stopped and settled too: otherwise, after a stuck reply and a voice restart, every new
   * utterance was refused as "already in progress".
   */
  cancelVoice() {
    const pending = this.pending
    if (pending && pending.turnId === this.voiceReplyTurnId) {
      this.fenceInFlightTurn()
      this.io.send({ type: 'stop', conversation_id: pending.conversationId, turn_id: pending.turnId })
    }
    this.voiceReplyTurnId = null
    if (!this.io.send({ type: 'voice_cancel' })) return
    this.voiceTurnId = null
  }

  /**
   * Leaving the app ends voice, but not her reply: discard any open utterance (a held one lets
   * the reply carry on server-side), stop following the reply, silence its audio, and let its text
   * keep streaming into the chat.
   */
  leave() {
    this.held = null
    this.pending = null
    this.voiceReplyTurnId = null
    this.latencyTurnId = null
    this.dropAudio = true
    this.io.send({ type: 'voice_cancel' })
    this.voiceTurnId = null
  }

  /** Interrupt the reply currently streaming. */
  stop() {
    this.io.send({
      type: 'stop',
      conversation_id: this.pending?.conversationId ?? this.io.conversationId(),
      turn_id: this.pending?.turnId,
    })
  }

  /**
   * Fence the in-flight turn and settle it locally as cancelled. Returns what the caller needs to
   * tell the server which turn that was.
   */
  private fenceInFlightTurn() {
    const pending = this.pending
    const turnId = pending?.turnId ?? null
    // Silence whatever audio envelope is open now; the next reply's `audio_start` lifts this
    // unless it belongs to a fenced turn.
    this.dropAudio = true
    if (turnId) this.fencedTurns = [...this.fencedTurns, turnId].slice(-16)
    const conversationId = pending?.conversationId ?? null
    if (pending) {
      this.pending = null
      if (pending.turnId === this.voiceTurnId) this.voiceTurnId = null
      pending.resolve({ conversationId: conversationId ?? '', reply: pending.buffer, status: 'cancelled' })
      this.io.settleTurn(pending.turnId)
    }
    return { turnId, conversationId }
  }

  /**
   * Barge-in handoff in one frame: cut off the reply and open a new utterance. Binary frames sent
   * after this belong to the new utterance — WebSocket keeps order, so pre-roll can follow at
   * once. Returns false, changing nothing, when the socket isn't open.
   */
  interruptVoiceStart(conversationId: string | null, sampleRate: number): boolean {
    if (!this.io.ready()) return false
    const cancelled = this.fenceInFlightTurn()
    const newTurn = newTurnId()
    this.voiceTurnId = newTurn
    return this.io.send({
      type: 'voice_interrupt',
      cancel_turn_id: cancelled.turnId,
      new_turn_id: newTurn,
      // The cut-off turn may have just created the thread (its `meta` arrived, but the caller's
      // state hasn't caught up yet). Without this the interruption would land in a new conversation.
      conversation_id: cancelled.conversationId ?? conversationId,
      sample_rate: sampleRate,
    })
  }

  /**
   * Barge-in as a *hold*: open an utterance over the reply without cancelling it. The reply keeps
   * streaming (the caller has paused playback); the server decides once the utterance ends, via
   * `barge_resolved`. Returns false, changing nothing, when the socket isn't open.
   */
  holdVoice(conversationId: string | null, sampleRate: number): boolean {
    if (!this.io.ready()) return false
    const pending = this.pending
    const turnId = newTurnId()
    this.held = { turnId, previousVoiceTurnId: this.voiceTurnId }
    this.voiceTurnId = turnId
    return this.io.send({
      type: 'voice_interrupt',
      tentative: true,
      cancel_turn_id: pending?.turnId ?? null,
      new_turn_id: turnId,
      conversation_id: pending?.conversationId ?? conversationId,
      sample_rate: sampleRate,
    })
  }

  /** The hold is clearly a real turn: cut the reply off now, keep listening. */
  commitHold() {
    const held = this.held
    if (!held) return
    this.held = null
    this.fenceInFlightTurn()
    this.io.send({ type: 'voice_interrupt_commit', turn_id: held.turnId })
  }

  /** The held utterance is over: send it for a decision. */
  endHold(): boolean {
    const held = this.held
    if (!held || !this.io.ready()) return false
    return this.io.send({ type: 'voice_end', turn_id: held.turnId })
  }

  /** Decision `resume`: the reply carries on as the voice turn. */
  resumeHold() {
    const held = this.held
    if (!held) return
    this.held = null
    this.voiceTurnId = held.previousVoiceTurnId
  }

  /** Decision `stop`: the server stopped the reply; settle it here too. */
  stopHold() {
    if (!this.held) return
    this.held = null
    this.fenceInFlightTurn()
    this.voiceTurnId = null
  }

  /**
   * Decision `turn`: fence the held reply and take the held utterance as the pending turn. Its
   * transcript and reply follow `barge_resolved` on the socket, so this must run synchronously from
   * that handler.
   */
  adoptHold(conversationId: string | null): Promise<VoiceTurnResult> {
    const held = this.held
    if (!held) return Promise.reject(new Error('No held utterance.'))
    this.held = null
    const cancelled = this.fenceInFlightTurn()
    this.latencyTurnId = held.turnId
    return this.beginTurn(cancelled.conversationId ?? conversationId, () => {}, held.turnId)
  }

  /**
   * Tell the server how much of the reply being spoken was heard before the user cut it off.
   * Returns that reply's turn id, or null if there's none.
   */
  reportHeard(heardChars: number): string | null {
    const turnId = this.audioTurnId
    if (!turnId) return null
    if (!this.io.send({ type: 'voice_heard', turn_id: turnId, heard_chars: heardChars })) return null
    return turnId
  }
}
