import JophielAudio, { type AudioRoute, type CallAction } from '../../modules/jophiel-audio'
import { startNativeCapture, type CaptureFrame, type MicCapture } from './capture'
import { createPcmPlayer, type PcmPlayer } from './player'
import { clearTimeout, setTimeout } from './timers'

export type { AudioRoute }

/** The native module is in this build (a build made before phase 4 doesn't have it). */
export const audioAvailable = JophielAudio !== null

function native() {
  if (!JophielAudio) {
    throw Object.assign(new Error('This build has no voice audio. Rebuild the app.'), { code: 'ERR_NO_AUDIO_MODULE' })
  }
  return JophielAudio
}

export function startCapture(onFrame: (frame: CaptureFrame) => void): Promise<MicCapture> {
  const audio = native()
  return startNativeCapture(
    {
      startCapture: () => audio.startCapture(),
      stopCapture: () => audio.stopCapture(),
      setMuted: (muted) => audio.setMuted(muted),
      isCapturing: () => audio.isCapturing(),
      onFrame: (listener) => audio.addListener('onFrame', listener),
    },
    onFrame,
  )
}

export function createPlayer(): PcmPlayer {
  const audio = native()
  return createPcmPlayer({
    enqueue: (pcm, sampleRate, leadFrames) => audio.enqueue(pcm, sampleRate, leadFrames),
    pause: () => audio.pause(),
    resume: () => audio.resume(),
    stopPlayback: () => audio.stopPlayback(),
    playedFrames: () => audio.playedFrames(),
    level: () => audio.level(),
    onDrained: (listener) => audio.addListener('onPlaybackDrained', listener),
    clock: { setTimeout, clearTimeout },
  })
}

const noSubscription = { remove() {} }

/** A call or another app took the audio, or the mic stopped working. */
export function onAudioInterrupted(listener: (reason: 'focus_lost' | 'mic_lost') => void) {
  return JophielAudio ? JophielAudio.addListener('onInterrupted', (event) => listener(event.reason)) : noSubscription
}

export function onRouteChanged(listener: (route: AudioRoute) => void) {
  return JophielAudio ? JophielAudio.addListener('onRouteChanged', (event) => listener(event.route)) : noSubscription
}

export function currentRoute(): AudioRoute {
  return JophielAudio ? JophielAudio.route() : 'none'
}

export type { CallAction }

/** Phase 5: the audio came back after a phone call; the mic is open again. */
export function onFocusRegained(listener: () => void) {
  return JophielAudio ? JophielAudio.addListener('onFocusRegained', () => listener()) : noSubscription
}

/** Phase 5: pressed on the call notification, or the headset button. */
export function onCallAction(listener: (action: CallAction) => void) {
  return JophielAudio ? JophielAudio.addListener('onCallAction', (event) => listener(event.action)) : noSubscription
}

/** Phase 5: the app was swiped away from recents; the call has to end. */
export function onCallEnded(listener: (reason: 'swiped') => void) {
  return JophielAudio ? JophielAudio.addListener('onCallEnded', (event) => listener(event.reason)) : noSubscription
}

/** Phase 5: the foreground service + notification that keeps a call going in the background. */
export function startCallService(): boolean {
  try {
    return JophielAudio?.startCallService() ?? false
  } catch {
    return false
  }
}

export function stopCallService() {
  JophielAudio?.stopCallService()
}

export function updateCallNotification(text: string, primary: 'interrupt' | 'talk' | null, muted: boolean) {
  JophielAudio?.updateCallNotification(text, primary, muted)
}

export function showCallEndedNotification(text: string) {
  JophielAudio?.showCallEndedNotification(text)
}

/** Belt and braces after a call ends: capture and playback off, audio mode and focus given back. */
export function endAudioSession() {
  JophielAudio?.endSession()
}
