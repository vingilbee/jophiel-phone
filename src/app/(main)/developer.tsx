import * as Clipboard from 'expo-clipboard'
import { Redirect, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/components/AppText'
import { Button, IconButton, SectionHeader, SwitchRow } from '@/components/Controls'
import { Snackbar } from '@/components/Snackbar'
import { microphonePermission, requestMicrophonePermission } from '@/setup/permissions'
import { radius, space, useColors } from '@/theme'
import { audioAvailable, createPlayer, currentRoute, startCapture, type AudioRoute } from '@/voice/audio'
import { CAPTURE_SAMPLE_RATE, type MicCapture } from '@/voice/capture'
import { echoVerdict, sustainedLevel, testSignal, type EchoResult } from '@/voice/echoTest'
import type { PcmPlayer } from '@/voice/player'
import { replyClip } from '@/voice/replyClip'
import { clearTimeout as clearNativeTimeout, setTimeout as setNativeTimeout, type TimerHandle } from '@/voice/timers'
import { DEFAULT_TUNING, getTuning, resetTuning, updateTuning, useTuning, type VoiceTuning } from '@/voice/tuning'
import { createVad } from '@/voice/vad'
import { useVoice } from '@/voice/VoiceProvider'

/** Settings → Developer. Dev builds only: release builds never show or open it. */
export default function DeveloperRoute() {
  if (!__DEV__) return <Redirect href="/settings" />
  return <DeveloperScreen />
}

const FRAME_MS = (320 / CAPTURE_SAMPLE_RATE) * 1000
/** Room tone measured before she plays, so the noise floor settles first. */
const QUIET_MS = 1000
const MAX_CLIP_SECONDS = 8

type Mode = 'off' | 'meter' | 'echo'

interface Reading {
  rms: number
  floor: number
  threshold: number
  speaking: boolean
  output: number
}

const ZERO: Reading = { rms: 0, floor: 0, threshold: 0, speaking: false, output: 0 }

function vadFor(tuning: VoiceTuning, whileSheTalks: boolean, onStart: () => void) {
  const vad = createVad(
    CAPTURE_SAMPLE_RATE,
    (event) => {
      if (event === 'speech-start') onStart()
    },
    {
      speechRatio: tuning.speechRatio,
      minThreshold: tuning.minThreshold,
      hangoverMs: tuning.hangoverMs,
      minSpeechMs: tuning.minSpeechMs,
      onsetGapMs: 120,
    },
  )
  if (whileSheTalks) {
    vad.setMinSpeechMs(tuning.bargeInMinSpeechMs)
    vad.setSpeechRatio(tuning.bargeInSpeechRatio)
  }
  return vad
}

function DeveloperScreen() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const voice = useVoice()
  const tuning = useTuning()
  const [mode, setMode] = useState<Mode>('off')
  const [reading, setReading] = useState<Reading>(ZERO)
  const [echoStep, setEchoStep] = useState<string | null>(null)
  const [result, setResult] = useState<EchoResult | null>(null)
  const [route, setRoute] = useState<AudioRoute>('none')
  const [snack, setSnack] = useState<string | null>(null)
  const bench = useRef<{ capture: MicCapture | null; player: PcmPlayer | null; timer: ReturnType<typeof setInterval> | null; cancelled: boolean } | null>(null)
  const latest = useRef<Reading>(ZERO)

  const stopBench = useCallback(() => {
    const current = bench.current
    bench.current = null
    if (current) {
      current.cancelled = true
      if (current.timer) clearInterval(current.timer)
      current.capture?.stop()
      current.player?.close()
    }
    latest.current = ZERO
    setReading(ZERO)
    setMode('off')
    setEchoStep(null)
  }, [])

  useEffect(() => stopBench, [stopBench])

  const ensureMic = useCallback(async () => {
    if (!audioAvailable) {
      setSnack('This build has no voice audio. Rebuild the app.')
      return false
    }
    if (voice.live) {
      setSnack('End the voice call first.')
      return false
    }
    let permission = await microphonePermission()
    if (permission !== 'granted') permission = await requestMicrophonePermission()
    if (permission !== 'granted') {
      setSnack('The microphone permission is off.')
      return false
    }
    return true
  }, [voice.live])

  const startMeter = useCallback(async () => {
    if (!(await ensureMic())) return
    const vad = vadFor(getTuning(), false, () => {})
    const state = { capture: null as MicCapture | null, player: null, timer: null as ReturnType<typeof setInterval> | null, cancelled: false }
    bench.current = state
    try {
      const capture = await startCapture(({ pcm, rms }) => {
        vad.push(rms, pcm.length)
        const s = vad.stats
        latest.current = { rms, floor: s.noiseFloor, threshold: s.threshold, speaking: s.speaking, output: 0 }
      })
      if (state.cancelled) {
        capture.stop()
        return
      }
      state.capture = capture
      state.timer = setInterval(() => setReading(latest.current), 100)
      setRoute(currentRoute())
      setMode('meter')
    } catch {
      bench.current = null
      setSnack('Could not start the microphone.')
    }
  }, [ensureMic])

  const runEcho = useCallback(async () => {
    if (!(await ensureMic())) return
    const t = getTuning()
    let playing = false
    let fired = false
    const micDuring: number[] = []
    let peakOutput = 0
    let player: PcmPlayer | null = null
    const vad = vadFor(t, true, () => {
      if (playing) fired = true
    })
    const state = { capture: null as MicCapture | null, player: null as PcmPlayer | null, timer: null as ReturnType<typeof setInterval> | null, cancelled: false }
    bench.current = state
    setResult(null)
    setMode('echo')
    setEchoStep('Listening to the room…')
    try {
      const capture = await startCapture(({ pcm, rms }) => {
        let vadRms = rms
        if (playing) {
          const output = player?.level ?? 0
          peakOutput = Math.max(peakOutput, output)
          micDuring.push(rms)
          // Same rule as the call: output-level gating, when it's on.
          if (t.outputGating && output > 0 && rms <= output * t.echoGateRatio) {
            vadRms = Math.min(rms, vad.stats.threshold * 0.999)
          }
        }
        vad.push(vadRms, pcm.length)
        const s = vad.stats
        latest.current = { rms, floor: s.noiseFloor, threshold: s.threshold, speaking: s.speaking, output: player?.level ?? 0 }
      })
      state.capture = capture
      state.timer = setInterval(() => setReading(latest.current), 100)
      setRoute(currentRoute())
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS))
      if (state.cancelled) return
      const stored = replyClip()
      const clip = stored ?? { sampleRate: 24000, pcm: testSignal(24000, 5) }
      const pcm = clip.pcm.subarray(0, clip.sampleRate * MAX_CLIP_SECONDS)
      player = createPlayer()
      state.player = player
      setEchoStep(stored ? 'Playing her last reply…' : 'Playing a test signal (no reply heard yet)…')
      playing = true
      player.enqueue(pcm, clip.sampleRate)
      await player.waitUntilDone()
      playing = false
      if (state.cancelled) return
      setResult({
        peakMic: micDuring.reduce((a, b) => Math.max(a, b), 0),
        sustainedMic: sustainedLevel(micDuring, FRAME_MS, t.bargeInMinSpeechMs),
        peakOutput,
        threshold: vad.stats.threshold,
        bargeInFired: fired,
      })
    } catch {
      setSnack('The echo test could not run.')
    } finally {
      if (bench.current === state) stopBench()
    }
  }, [ensureMic, stopBench])

  const copy = useCallback(() => {
    void Clipboard.setStringAsync(JSON.stringify(getTuning(), null, 2)).then(() => setSnack('Tuning copied'))
  }, [])

  const verdict = result ? echoVerdict(result) : null
  const meterScale = Math.max(reading.threshold * 2, 0.05)

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.appBar, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        <IconButton icon="arrow-left" label="Back" onPress={() => router.back()} color={colors.onSurface} />
        <AppText role="titleLarge" accessibilityRole="header">
          Developer
        </AppText>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
        <SectionHeader title="Microphone" />
        <View style={styles.block}>
          <Meter label="Mic" value={reading.rms} scale={meterScale} marker={reading.threshold} color={colors.primary} />
          {mode === 'echo' ? <Meter label="Her output" value={reading.output} scale={0.5} color={colors.onSurfaceVariant} /> : null}
          <AppText role="bodySmall" color="onSurfaceVariant" style={styles.mono}>
            {`rms ${reading.rms.toFixed(4)} · floor ${reading.floor.toFixed(4)} · threshold ${reading.threshold.toFixed(4)} · ${reading.speaking ? 'speaking' : 'quiet'} · ${route}`}
          </AppText>
          <View style={styles.buttons}>
            {mode === 'meter' ? (
              <Button label="Stop" variant="tonal" icon="stop" onPress={stopBench} />
            ) : (
              <Button label="Mic meter" variant="tonal" icon="microphone" onPress={() => void startMeter()} disabled={mode !== 'off'} />
            )}
          </View>
        </View>

        <SectionHeader title="Echo test" />
        <View style={styles.block}>
          <AppText role="bodyMedium" color="onSurfaceVariant">
            Plays her last reply (or a test signal) through the loudspeaker while the mic listens with echo cancellation on,
            using the while-she-talks values. Unplug headphones and turn the volume up first.
          </AppText>
          {echoStep ? (
            <AppText role="bodyMedium" accessibilityLiveRegion="polite">
              {echoStep}
            </AppText>
          ) : null}
          {result && verdict ? (
            <View style={[styles.verdict, { backgroundColor: verdict.ok ? colors.primaryContainer : colors.warnContainer }]} accessibilityLiveRegion="polite">
              <AppText role="bodyMedium" style={{ color: verdict.ok ? colors.onPrimaryContainer : colors.onWarnContainer }}>
                {verdict.text}
              </AppText>
              <AppText role="bodySmall" style={[styles.mono, { color: verdict.ok ? colors.onPrimaryContainer : colors.onWarnContainer }]}>
                {`mic peak ${result.peakMic.toFixed(4)} · sustained ${result.sustainedMic.toFixed(4)} · output peak ${result.peakOutput.toFixed(4)} · threshold ${result.threshold.toFixed(4)}`}
              </AppText>
            </View>
          ) : null}
          <View style={styles.buttons}>
            {mode === 'echo' ? (
              <Button label="Stop" variant="tonal" icon="stop" onPress={stopBench} />
            ) : (
              <Button label="Run echo test" icon="volume-high" onPress={() => void runEcho()} disabled={mode !== 'off'} />
            )}
          </View>
        </View>

        <SectionHeader title="VAD tuning" />
        <AppText role="bodySmall" color="onSurfaceVariant" style={styles.note}>
          Saved on this phone and used by the next frame of a call. Defaults are the web app&apos;s values.
        </AppText>
        <Stepper label="Speech ratio" field="speechRatio" step={0.1} digits={1} min={1} tuning={tuning} />
        <Stepper label="Min threshold" field="minThreshold" step={0.001} digits={3} min={0.001} tuning={tuning} />
        <Stepper label="Hangover (ms)" field="hangoverMs" step={50} digits={0} min={100} tuning={tuning} />
        <Stepper label="Min speech (ms)" field="minSpeechMs" step={10} digits={0} min={20} tuning={tuning} />
        <Stepper label="While she talks: min speech (ms)" field="bargeInMinSpeechMs" step={10} digits={0} min={20} tuning={tuning} />
        <Stepper label="While she talks: speech ratio" field="bargeInSpeechRatio" step={0.1} digits={1} min={1} tuning={tuning} />

        <SectionHeader title="Echo fallbacks" />
        <SwitchRow
          title="Output-level gating"
          supporting="While she plays, mic sound no louder than her own output doesn't count as speech."
          value={tuning.outputGating}
          onValueChange={(outputGating) => updateTuning({ outputGating })}
        />
        {tuning.outputGating ? (
          <Stepper label="Gate: mic must beat output ×" field="echoGateRatio" step={0.1} digits={1} min={0.1} tuning={tuning} />
        ) : null}
        <SwitchRow
          title="Interrupt button only on the loudspeaker"
          supporting="Last resort: talking over her doesn't cut in on the loudspeaker. With headphones it still does."
          value={tuning.buttonOnlyOnSpeaker}
          onValueChange={(buttonOnlyOnSpeaker) => updateTuning({ buttonOnlyOnSpeaker })}
        />

        <SectionHeader title="Background calls" />
        <AppText role="bodySmall" color="onSurfaceVariant" style={styles.note}>
          Shorten these to try the limits. They apply only with the app in the background.
        </AppText>
        <Stepper label="Quiet limit (ms)" field="backgroundQuietMs" step={60_000} digits={0} min={60_000} tuning={tuning} />
        <Stepper label="No-connection limit (ms)" field="backgroundOfflineMs" step={15_000} digits={0} min={15_000} tuning={tuning} />
        <ClockTest />

        <View style={[styles.buttons, styles.footer]}>
          <Button label="Reset" variant="text" icon="restore" onPress={() => resetTuning()} />
          <Button label="Copy" variant="tonal" icon="content-copy" onPress={copy} />
        </View>
      </ScrollView>
      <Snackbar message={snack} onDismiss={() => setSnack(null)} />
    </View>
  )
}

const CLOCK_TICK_MS = 5_000

/**
 * Phase 5: the native clock keeps firing with the screen off. Start it, lock the phone for a while,
 * come back: the tick count should match the time that passed.
 */
function ClockTest() {
  const [run, setRun] = useState<{ startedAt: number; ticks: number; lastAt: number } | null>(null)
  const timer = useRef<TimerHandle | null>(null)

  const stop = useCallback(() => {
    clearNativeTimeout(timer.current)
    timer.current = null
    setRun(null)
  }, [])

  const start = useCallback(() => {
    const startedAt = Date.now()
    setRun({ startedAt, ticks: 0, lastAt: startedAt })
    const tick = () => {
      timer.current = setNativeTimeout(() => {
        setRun((current) => (current ? { ...current, ticks: current.ticks + 1, lastAt: Date.now() } : current))
        tick()
      }, CLOCK_TICK_MS)
    }
    tick()
  }, [])

  useEffect(() => () => clearNativeTimeout(timer.current), [])

  const expected = run ? Math.floor((Date.now() - run.startedAt) / CLOCK_TICK_MS) : 0
  return (
    <View style={styles.block}>
      <AppText role="bodyMedium" color="onSurfaceVariant">
        Native clock: one tick every 5 s, also with the screen off.
      </AppText>
      {run ? (
        <AppText role="bodySmall" color="onSurfaceVariant" style={styles.mono} accessibilityLiveRegion="polite">
          {`ticks ${run.ticks} · expected ~${expected} · last ${new Date(run.lastAt).toLocaleTimeString()}`}
        </AppText>
      ) : null}
      <View style={styles.buttons}>
        {run ? (
          <Button label="Stop clock test" variant="tonal" icon="stop" onPress={stop} />
        ) : (
          <Button label="Clock test" variant="tonal" icon="timer-outline" onPress={start} />
        )}
      </View>
    </View>
  )
}

function Meter({ label, value, scale, marker, color }: { label: string; value: number; scale: number; marker?: number; color: string }) {
  const colors = useColors()
  const fraction = Math.min(1, value / scale)
  return (
    <View style={styles.meterRow} accessible accessibilityLabel={`${label} level ${value.toFixed(3)}`}>
      <AppText role="labelMedium" color="onSurfaceVariant" style={styles.meterLabel}>
        {label}
      </AppText>
      <View style={[styles.meterTrack, { backgroundColor: colors.surfaceContainerHigh }]}>
        <View style={[styles.meterFill, { width: `${fraction * 100}%`, backgroundColor: color }]} />
        {marker ? <View style={[styles.meterMarker, { left: `${Math.min(1, marker / scale) * 100}%`, backgroundColor: colors.onSurface }]} /> : null}
      </View>
    </View>
  )
}

type NumberField = { [K in keyof VoiceTuning]: VoiceTuning[K] extends number ? K : never }[keyof VoiceTuning]

function Stepper({ label, field, step, digits, min, tuning }: { label: string; field: NumberField; step: number; digits: number; min: number; tuning: VoiceTuning }) {
  const value = tuning[field]
  const changed = value !== DEFAULT_TUNING[field]
  const set = (next: number) => updateTuning({ [field]: Math.max(min, Number(next.toFixed(Math.max(digits, 0) + 1))) })
  return (
    <View style={styles.stepper}>
      <View style={styles.stepperText}>
        <AppText role="bodyLarge">{label}</AppText>
        <AppText role="bodyMedium" color={changed ? 'primary' : 'onSurfaceVariant'} style={styles.mono}>
          {value.toFixed(digits)}
          {changed ? ` (web ${DEFAULT_TUNING[field].toFixed(digits)})` : ''}
        </AppText>
      </View>
      <IconButton icon="minus" label={`Lower ${label}`} onPress={() => set(value - step)} />
      <IconButton icon="plus" label={`Raise ${label}`} onPress={() => set(value + step)} />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  appBar: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.xs, minHeight: 64 },
  block: { paddingHorizontal: space.lg, gap: space.md },
  note: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  buttons: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
  footer: { paddingHorizontal: space.lg, paddingTop: space.lg, justifyContent: 'flex-end' },
  mono: { fontFamily: 'monospace', fontVariant: ['tabular-nums'] },
  verdict: { borderRadius: radius.field, padding: space.lg, gap: space.sm },
  meterRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  meterLabel: { width: 72 },
  meterTrack: { flex: 1, height: 12, borderRadius: 6, overflow: 'hidden' },
  meterFill: { height: '100%' },
  meterMarker: { position: 'absolute', top: 0, bottom: 0, width: 2 },
  stepper: { flexDirection: 'row', alignItems: 'center', paddingLeft: space.lg, paddingRight: space.xs, minHeight: 56, gap: space.xs },
  stepperText: { flex: 1, gap: 2 },
})
