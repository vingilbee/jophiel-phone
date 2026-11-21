import { NativeModule, requireOptionalNativeModule } from 'expo'

/**
 * Voice audio on Android (local Expo module, Kotlin in ./android): mic capture and reply playback
 * in one voice-communication session, so Android's echo canceller removes her voice from the mic.
 * All the logic (VAD, barge-in, segments, jitter cushion) lives in JS under src/voice/.
 */

export type AudioRoute = 'speaker' | 'headphones' | 'bluetooth' | 'earpiece' | 'none'

export type JophielAudioEvents = {
  /** One 20 ms mic frame: 16 kHz mono 16-bit PCM (little endian, base64) and its RMS (0–1). */
  onFrame: (event: { pcm: string; rms: number }) => void
  /** Everything queued has played. */
  onPlaybackDrained: () => void
  /** A call or another app took the audio (`focus_lost`), or the mic stopped working (`mic_lost`). */
  onInterrupted: (event: { reason: 'focus_lost' | 'mic_lost' }) => void
  /** Output moved (headphones plugged in or out). */
  onRouteChanged: (event: { route: AudioRoute }) => void
  /** Phase 5: the audio came back after `focus_lost` (the phone call ended); the mic is open again. */
  onFocusRegained: () => void
  /** Phase 5: a native timer (`setTimer`) fired. */
  onTimer: (event: { id: number }) => void
  /** Phase 5: pressed on the call notification, or the headset button (`button`). */
  onCallAction: (event: { action: CallAction }) => void
  /** Phase 5: the call has to end (`swiped`: the app was swiped away from recents). */
  onCallEnded: (event: { reason: 'swiped' }) => void
  /**
   * Phase 5: Android promoted the call service to the foreground (`running: true`), refused to, or
   * it stopped (`false`). `startCallService` only submits the request; this is the answer.
   */
  onCallServiceState: (event: { running: boolean }) => void
}

export type CallAction = 'interrupt' | 'talk' | 'mute' | 'unmute' | 'end' | 'button'

declare class JophielAudioModule extends NativeModule<JophielAudioEvents> {
  /** Opens the mic and the voice session. Resolves with the capture sample rate (16000). */
  startCapture(): Promise<number>
  stopCapture(): void
  /** Stops delivering frames without tearing the mic down. */
  setMuted(muted: boolean): void
  isCapturing(): boolean
  /**
   * Queues PCM at `sampleRate` after `leadFrames` of silence. Returns the frame position where the
   * audio starts, or -1 if nothing was queued.
   */
  enqueue(pcm: Uint8Array, sampleRate: number, leadFrames: number): number
  pause(): void
  resume(): void
  /** Drops everything queued and playing; the next audio starts a new track (positions from 0). */
  stopPlayback(): void
  /** Frames of the current track that have played (the playback clock). */
  playedFrames(): number
  /** RMS of the audio playing right now, 0 when paused or silent. */
  level(): number
  route(): AudioRoute
  /** Stops capture and playback and gives the audio mode and focus back to Android. */
  endSession(): void
  /** Phase 5: fires `onTimer({ id })` once after `ms`, also with the app in the background. */
  setTimer(id: number, ms: number): void
  clearTimer(id: number): void
  /**
   * Phase 5: the foreground service that keeps a call going in the background. Start it while the
   * app is visible (Android 14 refuses otherwise). False if the request itself was refused; whether
   * Android then promotes it comes as `onCallServiceState`.
   */
  startCallService(): boolean
  stopCallService(): void
  isCallServiceRunning(): boolean
  /** The call notification's text, its context action (null = none) and the Mute/Unmute action. */
  updateCallNotification(text: string, primary: 'interrupt' | 'talk' | null, muted: boolean): void
  /** A note after the call ended by itself in the background. */
  showCallEndedNotification(text: string): void
}

/** Null in a build made before this module existed: rebuild with `bunx expo run:android`. */
export default requireOptionalNativeModule<JophielAudioModule>('JophielAudio')
