import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'
import { DEFAULT_VAD } from './vad'

/**
 * Voice tuning, set on the Developer screen and saved on the phone. The defaults are the web app's
 * values (tuned against Chrome's noise suppressor); Samsung's differs, so expect to adjust
 * `speechRatio` / `minThreshold` after the echo test on the S21.
 */
export interface VoiceTuning {
  /** Speech must exceed the noise floor by this ratio (web 2.5). */
  speechRatio: number
  /** Absolute floor for the speech threshold (web 0.012). */
  minThreshold: number
  /** Quiet after speech that ends your turn, ms (web 800). */
  hangoverMs: number
  /** Speech needed to count as an onset, ms (web 150). */
  minSpeechMs: number
  /** While she talks: speech needed to hold her, ms (web BARGE_IN_MIN_SPEECH_MS 250). */
  bargeInMinSpeechMs: number
  /** While she talks: noise-floor multiple that counts as speech (web BARGE_IN_SPEECH_RATIO 2.0). */
  bargeInSpeechRatio: number
  /**
   * Echo fallback 2, output-level gating: while she plays, a mic frame no louder than her own
   * output level × `echoGateRatio` doesn't count as speech.
   */
  outputGating: boolean
  echoGateRatio: number
  /** Echo fallback 3: on the loudspeaker, no spoken barge-in (Interrupt button only). */
  buttonOnlyOnSpeaker: boolean
  /** Phase 5: in the background, the call ends after this long without your speech (30 min). */
  backgroundQuietMs: number
  /** Phase 5: in the background, the call ends after this long without a connection (2 min). */
  backgroundOfflineMs: number
}

export const BACKGROUND_QUIET_MS = 30 * 60_000
export const BACKGROUND_OFFLINE_MS = 2 * 60_000

export const DEFAULT_TUNING: VoiceTuning = {
  speechRatio: DEFAULT_VAD.speechRatio,
  minThreshold: DEFAULT_VAD.minThreshold,
  hangoverMs: DEFAULT_VAD.hangoverMs,
  minSpeechMs: DEFAULT_VAD.minSpeechMs,
  bargeInMinSpeechMs: 250,
  bargeInSpeechRatio: 2.0,
  outputGating: false,
  echoGateRatio: 1.0,
  buttonOnlyOnSpeaker: false,
  backgroundQuietMs: BACKGROUND_QUIET_MS,
  backgroundOfflineMs: BACKGROUND_OFFLINE_MS,
}

const KEY = 'jophiel.voice-tuning'

/** Keeps known fields of the right type; anything else falls back to the default. */
export function sanitizeTuning(raw: unknown): VoiceTuning {
  const out: VoiceTuning = { ...DEFAULT_TUNING }
  if (!raw || typeof raw !== 'object') return out
  const stored = raw as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_TUNING) as Array<keyof VoiceTuning>) {
    const value = stored[key]
    const expected = DEFAULT_TUNING[key]
    if (typeof expected === 'number' && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      ;(out as unknown as Record<string, unknown>)[key] = value
    } else if (typeof expected === 'boolean' && typeof value === 'boolean') {
      ;(out as unknown as Record<string, unknown>)[key] = value
    }
  }
  return out
}

let current: VoiceTuning = { ...DEFAULT_TUNING }
const listeners = new Set<() => void>()

function publish() {
  listeners.forEach((listener) => listener())
  AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {})
}

export async function loadTuning(): Promise<VoiceTuning> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    current = sanitizeTuning(raw ? JSON.parse(raw) : null)
  } catch {
    current = { ...DEFAULT_TUNING }
  }
  listeners.forEach((listener) => listener())
  return current
}

export function getTuning(): VoiceTuning {
  return current
}

export function updateTuning(patch: Partial<VoiceTuning>): VoiceTuning {
  current = sanitizeTuning({ ...current, ...patch })
  publish()
  return current
}

export function resetTuning(): VoiceTuning {
  current = { ...DEFAULT_TUNING }
  publish()
  return current
}

export function subscribeTuning(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTuning(): VoiceTuning {
  return useSyncExternalStore(subscribeTuning, getTuning)
}
