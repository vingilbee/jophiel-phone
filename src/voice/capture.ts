/**
 * Microphone capture at 16 kHz, 16-bit mono PCM, from the native module.
 *
 * Same `MicCapture` interface as ../app/frontend/src/audio/capture.ts (web commit bf823f6). There
 * the browser's echoCancellation / noiseSuppression / autoGainControl run on the stream; here
 * Android's AcousticEchoCanceler / NoiseSuppressor / AutomaticGainControl run on a
 * VOICE_COMMUNICATION recorder that shares its session with the reply playback. Echo cancellation
 * is not optional: the mic stays open while she speaks so barge-in works.
 */
import { decodePcm16 } from './base64'

export const CAPTURE_SAMPLE_RATE = 16000

export interface CaptureFrame {
  pcm: Int16Array
  rms: number
}

export interface MicCapture {
  stop: () => void
  setMuted: (muted: boolean) => void
  resume: () => Promise<boolean>
  readonly sampleRate: number
  readonly active: boolean
}

/** The native half (modules/jophiel-audio); injected so this can be tested without a phone. */
export interface CaptureNative {
  startCapture: () => Promise<number>
  stopCapture: () => void
  setMuted: (muted: boolean) => void
  isCapturing: () => boolean
  onFrame: (listener: (event: { pcm: string; rms: number }) => void) => { remove: () => void }
}

export async function startNativeCapture(
  native: CaptureNative,
  onFrame: (frame: CaptureFrame) => void,
): Promise<MicCapture> {
  let stopped = false
  // Subscribed before the mic opens, so the first frames aren't lost.
  const subscription = native.onFrame((event) => {
    if (stopped) return
    onFrame({ pcm: decodePcm16(event.pcm), rms: event.rms })
  })
  let sampleRate: number
  try {
    sampleRate = await native.startCapture()
  } catch (err) {
    subscription.remove()
    throw err
  }
  return {
    setMuted(muted) {
      native.setMuted(muted)
    },
    sampleRate,
    get active() {
      return !stopped && native.isCapturing()
    },
    async resume() {
      return !stopped && native.isCapturing()
    },
    stop() {
      if (stopped) return
      stopped = true
      subscription.remove()
      native.stopCapture()
    },
  }
}
