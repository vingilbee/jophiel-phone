import { jsClock, type Clock, type TimerHandle } from './clock'

/**
 * Gapless playback of streamed PCM, with instant cancellation for barge-in.
 *
 * Ported from ../app/frontend/src/audio/playback.ts at web commit bf823f6: same interface, same
 * jitter cushion, segment and heard-text math. Only the audio I/O changed: instead of Web Audio
 * buffers scheduled on `AudioContext.currentTime`, chunks go to the native streaming track
 * (modules/jophiel-audio) and the clock is the track's played-frame count. Positions here are in
 * frames of the current track; `stop()` starts a new track, so they restart at 0.
 */

/** The native half (modules/jophiel-audio); injected so the logic can be tested without a phone. */
export interface PlaybackNative {
  /** Returns the frame position where the audio starts (after `leadFrames` of silence), or -1. */
  enqueue: (pcm: Uint8Array, sampleRate: number, leadFrames: number) => number
  pause: () => void
  resume: () => void
  stopPlayback: () => void
  playedFrames: () => number
  level: () => number
  onDrained: (listener: () => void) => { remove: () => void }
  /** Phone (phase 5): the clock for the done backstop; the native one in the app (./timers). */
  clock?: Clock
}

export interface PcmPlayer {
  /**
   * Queue a chunk of 16-bit mono PCM at `sampleRate`. Returns how many seconds from now it is
   * scheduled to start (0 = immediately), or null if the chunk was empty. Excludes the output
   * device's own latency.
   */
  enqueue: (pcm: Int16Array, sampleRate: number) => number | null
  /** Kill everything queued and playing. Used for barge-in. */
  stop: () => void
  /**
   * Freeze playback where it is, keeping everything queued (chunks enqueued meanwhile queue up
   * behind it). Used to hold the reply while the user talks over it, so a mere "I see" can resume
   * from the same word.
   */
  pause: () => void
  /** Continue after `pause()`. */
  resume: () => void
  /**
   * Chunks enqueued from now on speak characters [textStart, textEnd) of the reply. Segment 0
   * starts a new reply and forgets the previous one's.
   */
  beginSegment: (segment: number, textStart: number, textEnd: number) => void
  /**
   * How many characters of the reply have been heard so far: whole segments that finished
   * playing, plus the played fraction of the one playing now. Null when the audio carried no
   * segment labels. Read it *before* stop().
   */
  heardTextEnd: () => number | null
  /** Resolves once the queue has drained (or immediately after stop()). */
  waitUntilDone: () => Promise<void>
  close: () => void
  readonly playing: boolean
  /** RMS of what's coming out of the speakers right now (0 when silent). */
  readonly level: number
}

/** Jitter cushion added whenever playback (re)starts from an empty queue. */
export const START_LEAD_S = 0.12
/**
 * If the queue runs dry mid-reply, the audio is arriving barely in real time: the cushion doubles
 * (up to this) for the rest of the reply, trading one slightly longer pause for a run of short
 * stutters.
 */
export const MAX_LEAD_S = 0.6
/** Backstop for the native "drained" event while someone waits for the end. */
const DONE_POLL_MS = 250

export function createPcmPlayer(native: PlaybackNative): PcmPlayer {
  // Frame position right after the last queued chunk, on the current track.
  let cursor = 0
  let rate = 0
  let doneResolvers: Array<() => void> = []
  let paused = false
  let lead = START_LEAD_S
  // True until the first chunk of a reply is scheduled: running dry before that is just the reply
  // starting, not an underrun.
  let fresh = true
  // Which span of reply text each stretch of queued audio speaks, in track frames, so an
  // interruption can tell how much was heard.
  type Segment = { textStart: number; textEnd: number; startAt: number | null; endAt: number }
  let segments: Segment[] = []
  let current: Segment | null = null
  const clock = native.clock ?? jsClock()
  let poll: TimerHandle | null = null
  let closed = false

  const isPlaying = () => cursor > 0 && cursor > native.playedFrames()

  const settle = () => {
    if (isPlaying()) return
    const resolvers = doneResolvers
    doneResolvers = []
    if (poll !== null) clock.clearTimeout(poll)
    poll = null
    resolvers.forEach((r) => r())
  }

  // Repeats while someone waits; a chain of timeouts, since the native clock has no interval.
  const schedulePoll = () => {
    poll = clock.setTimeout(() => {
      poll = null
      settle()
      if (doneResolvers.length > 0 && poll === null) schedulePoll()
    }, DONE_POLL_MS)
  }

  const drained = native.onDrained(settle)

  const player: PcmPlayer = {
    get playing() {
      return isPlaying()
    },

    get level() {
      if (paused || !isPlaying()) return 0
      return native.level()
    },

    enqueue(pcm, sampleRate) {
      if (pcm.length === 0 || closed) return null
      // One track plays one rate. The server speaks every reply at one rate, so this only happens
      // if that setting changes mid-session: start over on a new track.
      if (rate !== 0 && sampleRate !== rate && cursor > 0) {
        native.stopPlayback()
        cursor = 0
        segments = []
        current = null
      }
      rate = sampleRate

      // Never schedule in the past: if the queue drained while we waited for the next chunk,
      // restart from now — plus a little lead, so a busy JS thread (a long render while text
      // streams) delays the next chunk into this cushion instead of into an audible gap.
      const played = native.playedFrames()
      const underrun = cursor <= played
      if (underrun && !fresh) lead = Math.min(lead * 2, MAX_LEAD_S)
      fresh = false
      const leadFrames = underrun ? Math.round(lead * sampleRate) : 0
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      const startAt = native.enqueue(bytes, sampleRate, leadFrames)
      if (startAt < 0) return null
      cursor = startAt + pcm.length
      if (current) {
        current.startAt ??= startAt
        current.endAt = cursor
      }
      return Math.max(0, startAt - played) / sampleRate
    },

    stop() {
      native.stopPlayback()
      cursor = 0
      fresh = true
      lead = START_LEAD_S
      segments = []
      current = null
      paused = false
      settle()
    },

    pause() {
      if (paused) return
      paused = true
      native.pause()
    },

    resume() {
      if (!paused) return
      paused = false
      native.resume()
    },

    beginSegment(segment, textStart, textEnd) {
      if (segment === 0) {
        segments = []
        if (!isPlaying()) {
          fresh = true
          lead = START_LEAD_S
        }
      }
      current = { textStart, textEnd, startAt: null, endAt: 0 }
      segments.push(current)
    },

    heardTextEnd() {
      if (segments.length === 0) return null
      // Frozen while paused, so a held reply reports where it was held.
      const now = native.playedFrames()
      let heard = 0
      for (const s of segments) {
        if (s.startAt === null || now <= s.startAt) break
        if (now >= s.endAt) {
          heard = s.textEnd
          continue
        }
        // No word timings from the voice engine: assume the text is spread evenly over the
        // clause's audio. The server snaps to a word.
        const fraction = (now - s.startAt) / (s.endAt - s.startAt)
        heard = s.textStart + Math.floor(fraction * (s.textEnd - s.textStart))
        break
      }
      return heard
    },

    waitUntilDone() {
      if (!isPlaying()) return Promise.resolve()
      if (poll === null) schedulePoll()
      return new Promise<void>((resolve) => doneResolvers.push(resolve))
    },

    close() {
      player.stop()
      closed = true
      drained.remove()
    },
  }
  return player
}
