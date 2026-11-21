import JophielAudio, { type AudioRoute } from '../../modules/jophiel-audio'
import { startNativeCapture, type CaptureFrame, type MicCapture } from './capture'
import { createPcmPlayer, type PcmPlayer } from './player'

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

/** Belt and braces after a call ends: capture and playback off, audio mode and focus given back. */
export function endAudioSession() {
  JophielAudio?.endSession()
}
