/**
 * Ported from ../app/frontend/src/hooks/useVoiceSession.ts at web commit bf823f6. The logic (state
 * machine, VAD use, barge-in hold, fencing epochs, timers) is the web's, line for line, so a fix on
 * one side can be copied to the other. Mechanical swaps: `window.setTimeout` → `setTimeout`,
 * `import.meta.env.DEV` → `__DEV__`, wall clock → `Date.now()`, browser capture/playback → the
 * native-backed `startCapture` / `createPlayer` (src/voice/audio.ts), no wake word (phase 9).
 *
 * Deliberate differences from the web, each marked "Phone:" below:
 *  - VAD values come from the Developer screen's tuning store (defaults = the web's constants).
 *  - Leaving the app ends voice, but not her reply: audio stops, what you heard is reported, and the
 *    text finishes in the chat (`leave`). Same when a call or another app takes the audio.
 *  - A dropped connection keeps the call open ("Reconnecting…") and listens again by itself once
 *    the socket is back (the web stands down to idle and waits for "Talk now").
 *  - Echo fallbacks from the Developer screen: output-level gating, and button-only interrupt on
 *    the loudspeaker.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { BargeAction, VoiceLatencyReport, VoiceState } from '@/chat/frames'
import type { VoiceTurnResult } from '@/chat/voice'
import {
  audioAvailable,
  createPlayer,
  currentRoute,
  onAudioInterrupted,
  onRouteChanged,
  startCapture,
  type AudioRoute,
} from './audio'
import { CAPTURE_SAMPLE_RATE, type MicCapture } from './capture'
import { createPcmRingBuffer, type PcmRingBuffer } from './pcmRingBuffer'
import type { PcmPlayer } from './player'
import { getTuning, subscribeTuning, type VoiceTuning } from './tuning'
import { createVad, speechOnsetPosition, type VadConfig } from './vad'

export type { VoiceState }

/**
 * The conversational loop: listen -> think -> speak -> listen again.
 *
 *  - The end of your turn is decided by silence (VAD), not a timer, so you're never cut off
 *    mid-sentence and there's no dead air after you finish.
 *  - Barge-in matters more than any of the above: talking over the assistant holds it at once,
 *    which is most of what makes it feel responsive.
 */

// How long 'thinking' may last with no reply and no audio before giving up.
const NO_ANSWER_TIMEOUT_MS = 60_000
/**
 * Mic audio kept locally while not streaming, for barge-in pre-roll. Covers the barge-in
 * confirmation delay plus padding with room to spare.
 */
const PREROLL_RING_MS = 800
/** Lead-in before the estimated onset, so a soft first consonant survives. */
const PREROLL_PADDING_MS = 150
/**
 * While the reply is held, this much quiet ends the utterance (vs 800ms normally): an "I see"
 * should get her talking again quickly.
 */
const HOLD_HANGOVER_MS = 400
/**
 * This much actual (loud) speech over a held reply is clearly a real turn, not "mm-hm": cancel the
 * reply now instead of waiting for the user to finish. Counted from the VAD's loud frames only —
 * wall time would also count the hangover after they stop, which pushed "I see" past the limit.
 */
const HOLD_COMMIT_SPEECH_MS = 1000
/** No decision from the server in this long → carry on with the reply. */
const HOLD_DECISION_TIMEOUT_MS = 8000
/** Cut off for an urgent message that then doesn't come: listen again after this. */
const YIELD_LISTEN_AGAIN_MS = 6000
/** The safety net for a reply with no audio at all. */
const AUDIO_GRACE_MS = 4000

type Timer = ReturnType<typeof setTimeout>

export interface VoiceSession {
  state: VoiceState
  muted: boolean
  setMuted: (muted: boolean) => void
  pauseForText: () => void
  /**
   * The user is talking over a reply that is paused, not yet cancelled (shown as 'listening'). If
   * it turns out to be "I see", the reply resumes.
   */
  holding: boolean
  /** Always false on the phone until phase 9 (push-to-talk / open mic only). */
  wakeWordAvailable: boolean
  /** Phone: the socket dropped mid-call; it listens again by itself once it's back. */
  reconnecting: boolean
  /** Phone: where her voice comes out (loudspeaker unless headphones are connected). */
  route: AudioRoute
  error: string | null
  clearError: () => void
  /** Turn voice mode on (needs the mic permission). */
  enable: () => Promise<void>
  disable: () => void
  /** Phone: end the call but let her reply finish as text (leaving the app, audio taken away). */
  leave: (message?: string) => void
  /** Start an utterance now. */
  pushToTalk: () => void
  /** End the current utterance immediately instead of waiting for silence. */
  endTurn: () => void
  /** Cut the assistant off and start listening again (button barge-in). */
  interrupt: () => void
  /**
   * Current audio level, 0–1: the mic while listening, the speakers while speaking. Read from an
   * animation loop — it's a getter, not state, so a 60 Hz visualiser doesn't re-render the screen.
   */
  getLevel: () => number
  /**
   * She's about to speak first (unprompted). If the mic is open but nobody has started talking,
   * close that empty utterance so her audio plays, then listen again afterwards. If the user is
   * mid-sentence, do nothing: her words still show as text, and she never talks over them.
   */
  beginUnpromptedSpeech: () => void
  /**
   * The server cut off the reply because something urgent happened: stop it where it is
   * (recording what was heard) and stand by for her message about it.
   */
  yieldToEvent: () => void
  /** Feed streamed reply audio in. Wire to the socket's onAudio. */
  handleAudio: (pcm: Int16Array, sampleRate: number) => void
  /** Reply audio finished streaming. Wire to the socket's onAudioEnd. */
  handleAudioEnd: () => void
  /** The server decided a held interruption. Wire to onBargeResolved. */
  handleBargeResolved: (action: BargeAction) => void
  /** Labels the reply audio that follows. Wire to onAudioSegment. */
  handleAudioSegment: (segment: number, textStart: number, textEnd: number) => void
  /** Phone: the socket closed. Wire to onDisconnect. */
  handleDisconnect: () => void
}

interface Options {
  conversationId: string | null
  /** Whether the shared socket is open (and its history in); clears a stale "Not connected." */
  connected: boolean
  /** A reply was cut off after the user heard `heardChars` of its text. */
  onHeard?: (turnId: string, heardChars: number) => void
  socket: {
    startVoice: (conversationId: string | null, sampleRate: number) => boolean
    sendAudio: (pcm: Int16Array) => void
    endVoice: (conversationId: string | null) => Promise<VoiceTurnResult>
    cancelVoice: () => void
    /** Phone: stop following the reply without cancelling it (see `leave`). */
    leave: () => void
    /**
     * Button barge-in: stop and settle the in-flight turn now, fencing its late events, and open a
     * new utterance in the same frame.
     */
    interruptVoiceStart: (conversationId: string | null, sampleRate: number) => boolean
    /** Spoken barge-in: open an utterance over the reply without cancelling it. */
    holdVoice: (conversationId: string | null, sampleRate: number) => boolean
    commitHold: () => void
    endHold: () => boolean
    resumeHold: () => void
    stopHold: () => void
    adoptHold: (conversationId: string | null) => Promise<VoiceTurnResult>
    /** Report heard progress for the reply being spoken; returns its turn id. */
    reportHeard: (heardChars: number) => string | null
    /** Timing marks for the turn just ended (measurement only). */
    reportVoiceLatency?: (report: VoiceLatencyReport) => void
  }
}

const NOT_CONNECTED = 'Not connected.'

/** Wall-clock ms, comparable with the server's marks. */
const wallNow = () => Date.now()

function vadConfigFrom(tuning: VoiceTuning): VadConfig {
  return {
    speechRatio: tuning.speechRatio,
    minThreshold: tuning.minThreshold,
    hangoverMs: tuning.hangoverMs,
    minSpeechMs: tuning.minSpeechMs,
    onsetGapMs: 120,
  }
}

function errorCode(e: unknown): string | null {
  return e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : null
}

export function useVoiceSession(opts: Options): VoiceSession {
  const [state, setState] = useState<VoiceState>('off')
  const [error, setError] = useState<string | null>(null)
  const [holding, setHolding] = useState(false)
  const [muted, updateMuted] = useState(false)
  const [reconnecting, updateReconnecting] = useState(false)
  const [route, setRoute] = useState<AudioRoute>('none')
  const mutedRef = useRef(false)
  const enablingRef = useRef(false)
  const reconnectingRef = useRef(false)
  const routeRef = useRef<AudioRoute>('none')

  const captureRef = useRef<MicCapture | null>(null)
  const playerRef = useRef<PcmPlayer | null>(null)
  const vadRef = useRef<ReturnType<typeof createVad> | null>(null)
  // Phone: the VAD reads `minThreshold` and `onsetGapMs` from this object on every frame, so
  // tuning changes made during a call reach it without a restart.
  const vadConfigRef = useRef<VadConfig>(vadConfigFrom(getTuning()))
  const ringRef = useRef<PcmRingBuffer | null>(null)
  const timerRef = useRef<Timer | null>(null)
  const micLevelRef = useRef(0)
  const vadDebugRef = useRef({ peak: 0, lastLog: 0 })
  // Do not submit room tone (or residual speaker echo) to Whisper. Short empty recordings are prone
  // to confident hallucinations such as "you", which can otherwise start a self-sustaining loop.
  const speechDetectedRef = useRef(false)
  // State is read from callbacks that outlive a render; mirror it in a ref.
  const stateRef = useRef<VoiceState>('off')
  const optsRef = useRef(opts)
  optsRef.current = opts

  const audioArrivedRef = useRef(false)
  // `audio_end` is sent before the server's final `done` frame. Re-opening the mic after playback
  // alone can therefore cancel the still-finishing turn and leave the pending response stuck
  // forever. A follow-up is safe only after both halves of the voice reply have completed.
  const replyDoneRef = useRef(false)
  const playbackDoneRef = useRef(false)
  const audioGraceTimerRef = useRef<Timer | null>(null)
  // Bumped whenever the in-flight reply is abandoned (barge-in, disable). Async continuations
  // capture it and do nothing if it moved: a cancelled turn settling late must not re-open the mic
  // mid-way through the user's interruption, which would discard the audio already streamed for it.
  const epochRef = useRef(0)
  // A held interruption. 'listening': the user is still talking and audio streams; 'deciding':
  // their utterance was sent and the server is working out whether it was "I see", "stop", or a
  // real turn.
  const holdRef = useRef<{
    stage: 'listening' | 'deciding'
    timer: Timer | null
  } | null>(null)
  // Timing marks for the in-flight voice turn, reported once when its first audio is scheduled (or
  // when it ends without any). See voice_latency.py.
  const vadEndRef = useRef<{ speechLastActive: number; vadEndpoint: number } | null>(null)
  const latencyRef = useRef<Omit<VoiceLatencyReport, 'outcome'> | null>(null)

  const setReconnecting = useCallback((next: boolean) => {
    reconnectingRef.current = next
    updateReconnecting(next)
  }, [])

  const reportLatency = useCallback((outcome: VoiceLatencyReport['outcome']) => {
    const trace = latencyRef.current
    if (!trace) return
    latencyRef.current = null
    optsRef.current.socket.reportVoiceLatency?.({ ...trace, outcome })
  }, [])

  const clearAudioGraceTimer = useCallback(() => {
    if (audioGraceTimerRef.current !== null) {
      clearTimeout(audioGraceTimerRef.current)
      audioGraceTimerRef.current = null
    }
  }, [])

  // Phone: the values while she talks come from the tuning store.
  const applyPhaseTuning = useCallback((phase: VoiceState) => {
    const tuning = getTuning()
    const speaking = phase === 'speaking'
    vadRef.current?.setMinSpeechMs(speaking ? tuning.bargeInMinSpeechMs : tuning.minSpeechMs)
    vadRef.current?.setSpeechRatio(speaking ? tuning.bargeInSpeechRatio : tuning.speechRatio)
  }, [])

  const setPhase = useCallback((next: VoiceState) => {
    stateRef.current = next
    setState(next)
    applyPhaseTuning(next)
  }, [applyPhaseTuning])

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /**
   * Switch to streaming mic audio into the utterance just opened. With `speechInProgress` (a
   * barge-in the VAD already confirmed) the VAD keeps its state: resetting it would forget the
   * speech under way, and that utterance would then never see a speech-start nor be allowed to
   * commit.
   */
  const enterListening = useCallback((speechInProgress: boolean) => {
    if (!speechInProgress) vadRef.current?.reset()
    speechDetectedRef.current = speechInProgress
    setPhase('listening')
    clearTimer()
  }, [clearTimer, setPhase])

  /** Open an utterance and start streaming mic audio to the server. */
  const beginUtterance = useCallback(() => {
    if (mutedRef.current) {
      setPhase('idle')
      return
    }
    const { conversationId, socket } = optsRef.current
    if (!socket.startVoice(conversationId, CAPTURE_SAMPLE_RATE)) {
      // Stand down to idle rather than staying in whatever phase called us: a turn that failed
      // because the socket dropped would otherwise sit in 'thinking' forever.
      clearAudioGraceTimer()
      playerRef.current?.stop()
      // Phone: while reconnecting the call shows "Reconnecting…" and listens again by itself.
      if (!reconnectingRef.current) setError(NOT_CONNECTED)
      setPhase('idle')
      return
    }
    setError((current) => (current === NOT_CONNECTED ? null : current))
    enterListening(false)
  }, [clearAudioGraceTimer, enterListening, setPhase])

  /**
   * Wait for the reply to the utterance just closed, then re-arm for a follow-up. `request` must
   * be called before the first await: for an adopted hold it registers the pending turn, and the
   * reply's frames are already arriving right behind the decision.
   */
  const awaitReply = useCallback(async (
    request: () => Promise<VoiceTurnResult>,
  ) => {
    clearTimer()
    setPhase('thinking')
    audioArrivedRef.current = false
    // Safety net: if nothing at all comes back, don't think forever. Give up on the turn (fencing
    // any late reply), say so, and listen again.
    const turnEpoch = epochRef.current
    const noAnswer = setTimeout(() => {
      if (epochRef.current !== turnEpoch || stateRef.current !== 'thinking' || audioArrivedRef.current) return
      if (holdRef.current) return
      epochRef.current += 1
      const { conversationId, socket } = optsRef.current
      if (mutedRef.current) {
        socket.cancelVoice()
        setError('No answer came back. Please try again.')
        setPhase('idle')
        return
      }
      // Settles the stuck turn and opens a new utterance.
      if (!socket.interruptVoiceStart(conversationId, CAPTURE_SAMPLE_RATE)) {
        setError(NOT_CONNECTED)
        setPhase('idle')
        return
      }
      setError('No answer came back. Please try again.')
      enterListening(false)
    }, NO_ANSWER_TIMEOUT_MS)
    replyDoneRef.current = false
    playbackDoneRef.current = false
    const epoch = epochRef.current
    const vadEnd = vadEndRef.current
    vadEndRef.current = null
    latencyRef.current = {
      endpoint: vadEnd ? 'vad' : 'manual',
      marks: {
        ...(vadEnd
          ? { speech_last_active: vadEnd.speechLastActive, vad_endpoint: vadEnd.vadEndpoint }
          : {}),
        voice_end_sent: wallNow(),
      },
    }
    const reply = request()
    reply.finally(() => clearTimeout(noAnswer)).catch(() => {})
    try {
      const result = await reply
      // Superseded by a barge-in: change nothing (the chat model keeps the thread id itself).
      if (epochRef.current !== epoch) return
      replyDoneRef.current = true
      // Nothing to say (an empty transcript, or an interruption that was only "stop"): no audio is
      // coming, so don't sit out the 4s grace window.
      if (!result.reply.trim() && !audioArrivedRef.current) {
        reportLatency('no_audio')
        if (stateRef.current === 'thinking') beginUtterance()
        return
      }
    } catch (e) {
      if (epochRef.current !== epoch) return
      reportLatency('error')
      setError(e instanceof Error ? e.message : 'Voice turn failed.')
      if (stateRef.current === 'thinking') beginUtterance()
      return
    }
    if (audioArrivedRef.current && playbackDoneRef.current) {
      // During a hold the reply is paused; resuming re-checks this.
      if (!holdRef.current) beginUtterance()
      return
    }
    // Don't decide synchronously here — the first audio chunk may not have arrived yet even on a
    // normal turn (measured first-chunk latency is ~1.9s). Give it a grace window; if nothing
    // shows up, TTS is genuinely down for this turn, so re-arm ourselves instead of stalling.
    if (stateRef.current === 'thinking' && !audioArrivedRef.current) {
      clearAudioGraceTimer()
      audioGraceTimerRef.current = setTimeout(() => {
        if (epochRef.current !== epoch) return
        if (stateRef.current === 'thinking' && !audioArrivedRef.current) {
          reportLatency('no_audio')
          beginUtterance()
        }
      }, AUDIO_GRACE_MS)
    }
  }, [beginUtterance, clearAudioGraceTimer, clearTimer, enterListening, reportLatency, setPhase])

  /** Close the utterance, run the turn, then re-arm for a follow-up. */
  const finishUtterance = useCallback(() => {
    const { conversationId, socket } = optsRef.current
    return awaitReply(() => socket.endVoice(conversationId))
  }, [awaitReply])

  /** Report how much of the reply was heard (before the player forgets what was scheduled). */
  const reportHeardNow = useCallback(() => {
    const heard = playerRef.current?.heardTextEnd() ?? null
    if (heard === null) return
    const { socket, onHeard } = optsRef.current
    const turnId = socket.reportHeard(heard)
    if (turnId) onHeard?.(turnId, heard)
  }, [])

  /**
   * Cut the reply off for good: record how much of it was heard, then stop audio and fence its
   * late events. Not used when a hold resumes — the user will hear the rest after all.
   */
  const abandonReply = useCallback(() => {
    reportLatency('interrupted')
    epochRef.current += 1
    clearAudioGraceTimer()
    // Before stop(), which forgets what was scheduled.
    reportHeardNow()
    playerRef.current?.stop()
  }, [clearAudioGraceTimer, reportHeardNow, reportLatency])

  const handleAudioSegment = useCallback(
    (segment: number, textStart: number, textEnd: number) => {
      playerRef.current?.beginSegment(segment, textStart, textEnd)
    },
    [],
  )

  /**
   * Button barge-in: stop the assistant and open a new utterance in one handoff. No pre-roll and a
   * fresh VAD — there is no speech yet, and the ring would only hold room tone and echo.
   */
  const hardInterrupt = useCallback(() => {
    const phase = stateRef.current
    if (phase !== 'speaking' && phase !== 'thinking') return
    abandonReply()
    const { conversationId, socket } = optsRef.current
    if (mutedRef.current) {
      socket.cancelVoice()
      setPhase('idle')
      return
    }
    if (!socket.interruptVoiceStart(conversationId, CAPTURE_SAMPLE_RATE)) {
      setError(NOT_CONNECTED)
      setPhase('idle')
      return
    }
    enterListening(false)
  }, [abandonReply, enterListening, setPhase])

  const clearHold = useCallback(() => {
    const hold = holdRef.current
    if (hold?.timer != null) clearTimeout(hold.timer)
    holdRef.current = null
    setHolding(false)
    vadRef.current?.setHangoverMs(getTuning().hangoverMs)
  }, [])

  /**
   * Spoken barge-in: pause the reply (don't cancel it) and stream the user's speech, starting from
   * just before it began. `speechMs` is how much speech the VAD needed to confirm it; the ring is
   * sent from that far back, plus padding, so the first word isn't clipped.
   */
  const startHold = useCallback(
    (speechMs: number) => {
      const phase = stateRef.current
      if (phase !== 'speaking' && phase !== 'thinking') return
      if (holdRef.current) return
      const { conversationId, socket } = optsRef.current
      // Not connected: she keeps talking, which beats silence that can't be resolved by anyone.
      if (!socket.holdVoice(conversationId, CAPTURE_SAMPLE_RATE)) return
      playerRef.current?.pause()
      clearAudioGraceTimer()
      holdRef.current = { stage: 'listening', timer: null }
      setHolding(true)
      const ring = ringRef.current
      if (ring) {
        const onset = speechOnsetPosition(
          ring.endSamplePosition, speechMs, CAPTURE_SAMPLE_RATE, PREROLL_PADDING_MS,
        )
        // Sent once, here. The frame that confirmed the speech is already in the ring, and
        // handleFrame won't stream it again (see there).
        const preRoll = ring.snapshotFrom(onset)
        if (preRoll.length) socket.sendAudio(preRoll)
        if (__DEV__) {
          console.debug(
            `[vad] hold in ${phase} after ${Math.round(speechMs)}ms: pre-roll ` +
              `${Math.round((preRoll.length / CAPTURE_SAMPLE_RATE) * 1000)}ms`,
          )
        }
      }
      // Keep the VAD's speech state: the utterance is already under way.
      enterListening(true)
      vadRef.current?.setHangoverMs(HOLD_HANGOVER_MS)
    },
    [clearAudioGraceTimer, enterListening],
  )

  /** Long enough to be a real turn: cancel the reply, keep listening. */
  const commitHold = useCallback(() => {
    if (holdRef.current?.stage !== 'listening') return
    if (__DEV__) console.debug('[vad] hold committed: real turn')
    clearHold()
    abandonReply()
    optsRef.current.socket.commitHold()
  }, [abandonReply, clearHold])

  /** Return to the paused reply exactly where it left off. */
  const resumeAfterHold = useCallback(() => {
    if (audioArrivedRef.current) {
      setPhase('speaking')
      playerRef.current?.resume()
    } else {
      setPhase('thinking')
    }
    // The reply may have finished arriving while it was held.
    if (replyDoneRef.current && (!audioArrivedRef.current || playbackDoneRef.current)) {
      beginUtterance()
      return
    }
    // The user may have kept talking while the hold was being decided; the VAD is still
    // mid-speech, so no fresh speech-start will come for it.
    const vad = vadRef.current
    if (vad?.speaking) startHold(vad.stats.speechMs)
  }, [beginUtterance, setPhase, startHold])

  const resolveHold = useCallback(
    (action: BargeAction) => {
      if (!holdRef.current) return
      if (__DEV__) console.debug(`[vad] hold resolved: ${action}`)
      clearHold()
      const { conversationId, socket } = optsRef.current
      if (action === 'resume') {
        socket.resumeHold()
        resumeAfterHold()
        return
      }
      abandonReply()
      if (action === 'stop') {
        socket.stopHold()
        beginUtterance()
        return
      }
      void awaitReply(() => socket.adoptHold(conversationId))
    },
    [abandonReply, awaitReply, beginUtterance, clearHold, resumeAfterHold],
  )

  /** The held utterance ended: send it off for a decision. */
  const endHold = useCallback(() => {
    const hold = holdRef.current
    if (hold?.stage !== 'listening') return
    if (!optsRef.current.socket.endHold()) {
      resolveHold('resume')
      return
    }
    hold.stage = 'deciding'
    vadRef.current?.setHangoverMs(getTuning().hangoverMs)
    hold.timer = setTimeout(() => resolveHold('resume'), HOLD_DECISION_TIMEOUT_MS)
  }, [resolveHold])

  /** The stop button: commits a hold, or cuts the reply off outright. */
  const interrupt = useCallback(() => {
    const hold = holdRef.current
    if (hold) {
      if (hold.stage === 'listening') commitHold()
      return
    }
    hardInterrupt()
  }, [commitHold, hardInterrupt])

  const handleFrame = useCallback(
    ({ pcm, rms }: { pcm: Int16Array; rms: number }) => {
      const phase = stateRef.current
      if (phase === 'off' || mutedRef.current) return

      // Smoothed so the visualiser doesn't strobe on single frames.
      micLevelRef.current = micLevelRef.current * 0.7 + rms * 0.3
      // Into the ring before the VAD: a barge-in confirmed by this very frame snapshots the ring
      // synchronously and must find the frame in it.
      ringRef.current?.push(pcm)
      // Phone, echo fallback 2: while she plays, a frame no louder than her own output doesn't
      // count as speech (it's fed to the VAD as quiet, just under its threshold).
      let vadRms = rms
      const tuning = getTuning()
      if (tuning.outputGating && phase === 'speaking' && !holdRef.current && vadRef.current) {
        const output = playerRef.current?.level ?? 0
        if (output > 0 && rms <= output * tuning.echoGateRatio) {
          vadRms = Math.min(rms, vadRef.current.stats.threshold * 0.999)
        }
      }
      vadRef.current?.push(vadRms, pcm.length)

      // `phase` was read before the VAD ran. If this frame triggered a barge-in, the state is now
      // 'listening' but the frame went out as pre-roll — checking the stale phase is what keeps it
      // from being sent twice.
      const hold = holdRef.current
      if (phase === 'listening' && hold?.stage !== 'deciding') {
        optsRef.current.socket.sendAudio(pcm)
      }
      const vad = vadRef.current
      if (
        hold?.stage === 'listening' &&
        vad?.speaking &&
        vad.stats.speechMs >= HOLD_COMMIT_SPEECH_MS
      ) {
        commitHold()
      }

      // Dev diagnostics for "stuck listening": every 500ms, the loudest frame vs the VAD
      // threshold. Speech that never beats the threshold never starts; a room that never drops
      // below it never ends.
      if (__DEV__ && (phase === 'listening' || phase === 'speaking') && vadRef.current) {
        const dbg = vadDebugRef.current
        dbg.peak = Math.max(dbg.peak, rms)
        const now = Date.now()
        if (now - dbg.lastLog >= 500) {
          const s = vadRef.current.stats
          console.debug(
            `[vad] ${phase} peak=${dbg.peak.toFixed(4)} threshold=${s.threshold.toFixed(4)} ` +
              `floor=${s.noiseFloor.toFixed(4)} speaking=${s.speaking} ` +
              `speechMs=${Math.round(s.speechMs)} quietMs=${Math.round(s.quietMs)} ` +
              `heard=${speechDetectedRef.current}`,
          )
          dbg.peak = 0
          dbg.lastLog = now
        }
      }
    },
    [commitHold],
  )

  const handleVad = useCallback(
    (e: 'speech-start' | 'speech-end', ms: number) => {
      const phase = stateRef.current
      if (__DEV__) console.debug(`[vad] ${e} in ${phase}`)

      if (e === 'speech-start') {
        // Barge-in: talking over the assistant holds it immediately.
        if (phase === 'speaking' || phase === 'thinking') {
          // Phone, echo fallback 3: on the loudspeaker, only the Interrupt button cuts in.
          if (getTuning().buttonOnlyOnSpeaker && routeRef.current === 'speaker') return
          startHold(ms)
          return
        }
        if (phase === 'listening') speechDetectedRef.current = true
        return
      }

      // speech-end: the VAD hangover elapsed, so the turn is genuinely over.
      if (phase === 'listening' && holdRef.current) {
        endHold()
        return
      }
      if (phase === 'listening') {
        const now = wallNow()
        vadEndRef.current = { speechLastActive: now - ms, vadEndpoint: now }
        void finishUtterance()
      }
    },
    [endHold, finishUtterance, startHold],
  )

  const enable = useCallback(async () => {
    if (stateRef.current !== 'off' || enablingRef.current) return
    enablingRef.current = true
    const enableEpoch = epochRef.current
    mutedRef.current = false
    updateMuted(false)
    setReconnecting(false)
    setError(null)
    try {
      if (!audioAvailable) throw Object.assign(new Error('no audio module'), { code: 'ERR_NO_AUDIO_MODULE' })
      playerRef.current = createPlayer()
      vadConfigRef.current = vadConfigFrom(getTuning())
      vadRef.current = createVad(CAPTURE_SAMPLE_RATE, handleVad, vadConfigRef.current)
      ringRef.current = createPcmRingBuffer(
        Math.round((CAPTURE_SAMPLE_RATE * PREROLL_RING_MS) / 1000),
      )
      const capture = await startCapture(handleFrame)
      if (epochRef.current !== enableEpoch) { capture.stop(); return }
      captureRef.current = capture
      routeRef.current = currentRoute()
      setRoute(routeRef.current)
      setPhase('idle')
      beginUtterance()
    } catch (e) {
      if (epochRef.current !== enableEpoch) return
      const code = errorCode(e)
      setError(
        code === 'ERR_MIC_PERMISSION'
          ? 'Microphone permission denied.'
          : code === 'ERR_AUDIO_BUSY'
            ? 'Another app is using the audio (a call?).'
            : code === 'ERR_NO_AUDIO_MODULE'
              ? 'This build has no voice audio yet. Rebuild the app.'
              : 'Could not start the microphone.',
      )
      captureRef.current?.stop()
      captureRef.current = null
      playerRef.current?.close()
      playerRef.current = null
      setPhase('off')
    } finally {
      enablingRef.current = false
    }
  }, [beginUtterance, handleFrame, handleVad, setPhase, setReconnecting])

  /** Release the mic and the player, back to 'off'. */
  const tearDown = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    playerRef.current?.close()
    playerRef.current = null
    vadRef.current = null
    ringRef.current = null
    vadEndRef.current = null
    latencyRef.current = null
    micLevelRef.current = 0
    mutedRef.current = false
    updateMuted(false)
    setReconnecting(false)
    setPhase('off')
  }, [setPhase, setReconnecting])

  const disable = useCallback(() => {
    clearHold()
    epochRef.current += 1
    clearTimer()
    clearAudioGraceTimer()
    optsRef.current.socket.cancelVoice()
    tearDown()
  }, [clearAudioGraceTimer, clearHold, clearTimer, tearDown])

  /**
   * Phone: leaving the app (or losing the audio to a call) ends voice, but not her reply. Its audio
   * stops and what was heard is reported; the text keeps streaming and finishes in the chat, the
   * unheard part faded.
   */
  const leave = useCallback((message?: string) => {
    if (stateRef.current === 'off') return
    // Only a reply still sounding (or held) was cut short; a finished one was heard in full.
    if (playerRef.current?.playing) reportHeardNow()
    clearHold()
    epochRef.current += 1
    clearTimer()
    clearAudioGraceTimer()
    optsRef.current.socket.leave()
    tearDown()
    if (message) setError(message)
  }, [clearAudioGraceTimer, clearHold, clearTimer, reportHeardNow, tearDown])

  /**
   * Phone: the socket closed mid-call. The reply being spoken is lost (the server treats it as cut
   * off); the call stays open and listens again once the connection is back.
   */
  const handleDisconnect = useCallback(() => {
    if (stateRef.current === 'off') return
    clearHold()
    epochRef.current += 1
    clearTimer()
    clearAudioGraceTimer()
    playerRef.current?.stop()
    latencyRef.current = null
    vadEndRef.current = null
    setReconnecting(true)
    setPhase('idle')
  }, [clearAudioGraceTimer, clearHold, clearTimer, setPhase, setReconnecting])

  const pushToTalk = useCallback(() => {
    if (stateRef.current === 'idle') beginUtterance()
  }, [beginUtterance])

  const endTurn = useCallback(() => {
    if (stateRef.current !== 'listening') return
    if (holdRef.current) {
      endHold()
      return
    }
    if (!speechDetectedRef.current) {
      optsRef.current.socket.cancelVoice()
      setPhase('idle')
      return
    }
    void finishUtterance()
  }, [endHold, finishUtterance, setPhase])

  const setMuted = useCallback((next: boolean) => {
    if (stateRef.current === 'off' || mutedRef.current === next) return
    mutedRef.current = next
    updateMuted(next)
    captureRef.current?.setMuted(next)
    micLevelRef.current = 0
    vadRef.current?.reset()
    ringRef.current?.clear()
    if (next) {
      // Muting must not interrupt her reply. Resume an uncommitted barge-in.
      if (holdRef.current) {
        clearHold()
        optsRef.current.socket.resumeHold()
        resumeAfterHold()
      } else if (stateRef.current === 'listening') {
        endTurn()
      }
    } else if (stateRef.current === 'idle') {
      beginUtterance()
    }
  }, [beginUtterance, clearHold, endTurn, resumeAfterHold])

  const pauseForText = useCallback(() => {
    if (stateRef.current === 'off') return
    mutedRef.current = true
    updateMuted(true)
    captureRef.current?.setMuted(true)
    clearHold()
    clearTimer()
    abandonReply()
    optsRef.current.socket.cancelVoice()
    vadRef.current?.reset()
    ringRef.current?.clear()
    micLevelRef.current = 0
    setPhase('idle')
  }, [abandonReply, clearHold, clearTimer, setPhase])

  /**
   * Normalised for display, not analysis: the square root spreads out the bottom of the range,
   * where speech actually lives, so the orb moves with normal talking instead of only shouting.
   */
  const getLevel = useCallback(() => {
    const phase = stateRef.current
    if (phase === 'off' || phase === 'thinking') return 0
    const raw =
      phase === 'speaking' ? (playerRef.current?.level ?? 0) : micLevelRef.current
    const level = Math.min(1, Math.sqrt(raw / 0.2))
    // Armed-but-not-listening shouldn't look like an open mic; damp room noise.
    return phase === 'idle' ? level * 0.35 : level
  }, [])

  const yieldToEvent = useCallback(() => {
    if (holdRef.current) {
      // The user is talking over the (paused) reply: drop the reply, keep their turn going. Her
      // message then shows as text, not over them.
      clearHold()
      optsRef.current.socket.stopHold()
      abandonReply()
      beginUtterance()
      return
    }
    const phase = stateRef.current
    if (phase !== 'speaking' && phase !== 'thinking') return
    clearTimer()
    abandonReply()
    setPhase('idle')
    // Her message about it plays from idle. If none comes, listen again.
    timerRef.current = setTimeout(() => {
      if (stateRef.current === 'idle' && !mutedRef.current) beginUtterance()
    }, YIELD_LISTEN_AGAIN_MS)
  }, [abandonReply, beginUtterance, clearHold, clearTimer, setPhase])

  const beginUnpromptedSpeech = useCallback(() => {
    const phase = stateRef.current
    if (phase === 'off' || holdRef.current) return
    if (phase === 'listening') {
      if (speechDetectedRef.current || vadRef.current?.speaking) return
      clearTimer()
      optsRef.current.socket.cancelVoice()
    } else if (phase !== 'idle') {
      return // replying already: this audio isn't for now
    }
    // Same bookkeeping as a reply, so playback re-arms listening when done.
    epochRef.current += 1
    audioArrivedRef.current = false
    playbackDoneRef.current = false
    replyDoneRef.current = true
    setPhase('speaking')
  }, [clearTimer, setPhase])

  const handleAudio = useCallback(
    (pcm: Int16Array, sampleRate: number) => {
      // Reply audio only belongs to thinking/speaking (or a nudge while idle). Anything arriving
      // while listening is a superseded reply leaking past the fence; playing it would also feed
      // her voice into the open mic. A held reply keeps arriving into the paused player.
      if (stateRef.current === 'off') return
      if (stateRef.current === 'listening' && !holdRef.current) return
      // Phone: while reconnecting nothing is hers to play.
      if (reconnectingRef.current) return
      audioArrivedRef.current = true
      clearAudioGraceTimer()
      // 'thinking' is a reply to something we asked. 'idle' can only be the assistant speaking
      // first — it still has to show as speaking, or the orb sits still while she talks.
      const phase = stateRef.current
      if (phase === 'thinking' || phase === 'idle') setPhase('speaking')
      const startsInSeconds = playerRef.current?.enqueue(pcm, sampleRate) ?? null
      const trace = latencyRef.current
      if (trace) {
        const now = wallNow()
        trace.marks.browser_first_audio = now
        if (startsInSeconds !== null) {
          trace.marks.browser_playback_started = now + startsInSeconds * 1000
        }
        reportLatency('audio')
      }
    },
    [clearAudioGraceTimer, reportLatency, setPhase],
  )

  const handleAudioEnd = useCallback(() => {
    // The server has finished *sending*; the queue is still draining. Re-arm only once it's
    // actually silent, or the follow-up window would open while she is still talking and
    // immediately trip on her own voice.
    const epoch = epochRef.current
    void playerRef.current?.waitUntilDone().then(() => {
      if (epochRef.current !== epoch) return
      playbackDoneRef.current = true
      const phase = stateRef.current
      if ((phase === 'speaking' || phase === 'thinking') && replyDoneRef.current) {
        beginUtterance()
      }
    })
  }, [beginUtterance])

  const clearError = useCallback(() => setError(null), [])

  useEffect(() => disable, [disable])

  useEffect(() => {
    if (opts.connected) setError((current) => (current === NOT_CONNECTED ? null : current))
  }, [opts.connected])

  // Phone: back from a dropped connection, listen again by itself.
  useEffect(() => {
    if (!opts.connected || !reconnectingRef.current) return
    setReconnecting(false)
    if (stateRef.current === 'idle' && !mutedRef.current) beginUtterance()
  }, [opts.connected, beginUtterance, setReconnecting])

  // Phone: tuning from the Developer screen reaches a call in progress.
  useEffect(
    () =>
      subscribeTuning(() => {
        const tuning = getTuning()
        Object.assign(vadConfigRef.current, vadConfigFrom(tuning))
        applyPhaseTuning(stateRef.current)
        if (!holdRef.current) vadRef.current?.setHangoverMs(tuning.hangoverMs)
      }),
    [applyPhaseTuning],
  )

  // Phone: the web recovers a suspended mic on `visibilitychange`; on the phone leaving the app
  // ends voice (background listening is phase 5). Her reply finishes as text.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') leave()
    })
    return () => subscription.remove()
  }, [leave])

  // Phone: a call or another app took the audio, or the mic died: stand down, same as an error.
  useEffect(() => {
    const interrupted = onAudioInterrupted((reason) => {
      if (stateRef.current === 'off') return
      leave(reason === 'focus_lost' ? 'Voice ended: another app took the audio.' : 'Voice ended: the microphone stopped.')
    })
    const routed = onRouteChanged((next) => {
      routeRef.current = next
      setRoute(next)
    })
    return () => {
      interrupted.remove()
      routed.remove()
    }
  }, [leave])

  return {
    state,
    muted,
    setMuted,
    pauseForText,
    holding,
    wakeWordAvailable: false,
    reconnecting,
    route,
    error,
    clearError,
    enable,
    disable,
    leave,
    pushToTalk,
    endTurn,
    interrupt,
    getLevel,
    beginUnpromptedSpeech,
    yieldToEvent,
    handleAudio,
    handleAudioEnd,
    handleBargeResolved: resolveHold,
    handleAudioSegment,
    handleDisconnect,
  }
}
