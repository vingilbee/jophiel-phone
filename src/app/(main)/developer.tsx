import * as Clipboard from 'expo-clipboard'
import { Redirect, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Image, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { runLocalAction } from '@/actions'
import type { ActionResult, PhoneScreen, ScreenItem } from '@/actions/protocol'
import { AppText } from '@/components/AppText'
import { Button, IconButton, SectionHeader, SwitchRow, TextField } from '@/components/Controls'
import { lastSeenNotification } from '@/notifications'
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

        <SectionHeader title="Phone actions" />
        <ActionsTest onResult={setSnack} />

        <SectionHeader title="Phone control" />
        <ControlTest onResult={setSnack} />

        <View style={[styles.buttons, styles.footer]}>
          <Button label="Reset" variant="text" icon="restore" onPress={() => resetTuning()} />
          <Button label="Copy" variant="tonal" icon="content-copy" onPress={copy} />
        </View>
      </ScrollView>
      <Snackbar message={snack} onDismiss={() => setSnack(null)} />
    </View>
  )
}

/** A known destination for the test: Monas, Central Jakarta. */
const TEST_DESTINATION = { name: 'Monas', lat: -6.1754, lng: 106.8272, mode: 'drive' }
/** Long enough to lock the phone or switch to another app first. */
const DELAYED_MS = 10_000

function resultText(result: ActionResult | null): string {
  if (!result) return 'Already handled'
  const accuracy = result.data && 'accuracy_m' in result.data ? ` (position to ±${result.data.accuracy_m} m, not shown)` : ''
  const opened = result.data && 'opened' in result.data ? ` (opened ${result.data.opened})` : ''
  const target = result.data && 'target' in result.data ? ` (${result.data.target})` : ''
  return `${result.status}${result.reason ? `: ${result.reason}` : ''}${accuracy}${opened}${target}`
}

/** "HH:MM" two minutes from now, for the alarm test. */
function inTwoMinutes(): string {
  const at = new Date(Date.now() + 2 * 60_000)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * Phase 7: run her actions here, as if she had sent them (nothing is answered to the server). The
 * delayed one gives time to lock the phone, put it in a pocket or open another app.
 */
function ActionsTest({ onResult }: { onResult: (text: string) => void }) {
  const [pending, setPending] = useState<string | null>(null)
  const timer = useRef<TimerHandle | null>(null)
  useEffect(() => () => clearNativeTimeout(timer.current), [])

  const run = (label: string, action: string, args: Record<string, unknown>, delayMs = 0) => {
    setPending(label)
    const go = () =>
      void runLocalAction(action, args).then((result) => {
        setPending(null)
        onResult(`${label}: ${resultText(result)}`)
      })
    if (delayMs) timer.current = setNativeTimeout(go, delayMs)
    else go()
  }

  return (
    <View style={styles.block}>
      <AppText role="bodyMedium" color="onSurfaceVariant">
        {pending ? `Running ${pending}…` : 'Runs on this phone only; the server hears nothing.'}
      </AppText>
      <View style={styles.buttons}>
        <Button label="Navigate to Monas" variant="tonal" icon="navigation-variant-outline" disabled={pending !== null} onPress={() => run('navigate_to', 'navigate_to', TEST_DESTINATION)} />
        <Button
          label="Navigate in 10 s"
          variant="tonal"
          icon="timer-outline"
          disabled={pending !== null}
          onPress={() => run('navigate_to in 10 s', 'navigate_to', TEST_DESTINATION, DELAYED_MS)}
        />
        <Button label="Get position" variant="tonal" icon="crosshairs-gps" disabled={pending !== null} onPress={() => run('get_position', 'get_position', {})} />
      </View>
      <Phase8Tests pending={pending} run={run} />
    </View>
  )
}

/**
 * Phase 8: one button per new action, run here before the backend has them. Reply / dismiss use the
 * newest notification that went over the socket while the app was open (post one to yourself first).
 */
function Phase8Tests({ pending, run }: { pending: string | null; run: (label: string, action: string, args: Record<string, unknown>, delayMs?: number) => void }) {
  const [name, setName] = useState('Spotify')
  const [to, setTo] = useState('')
  const busy = pending !== null
  const b = (label: string, icon: Parameters<typeof Button>[0]['icon'], action: string, args: Record<string, unknown>, delayMs = 0) => (
    <Button key={label} label={label} variant="tonal" icon={icon} disabled={busy} onPress={() => run(label, action, args, delayMs)} />
  )
  const latest = () => lastSeenNotification()
  return (
    <>
      <AppText role="titleSmall">Media and sound</AppText>
      <View style={styles.buttons}>
        {b('Pause', 'pause', 'media_control', { command: 'pause' })}
        {b('Play', 'play', 'media_control', { command: 'play' })}
        {b('Next', 'skip-next', 'media_control', { command: 'next' })}
        {b('Volume 30', 'volume-medium', 'set_volume', { level: 30 })}
        {b('Vibrate', 'vibrate', 'set_ringer', { mode: 'vibrate' })}
        {b('Ringer on', 'bell-outline', 'set_ringer', { mode: 'normal' })}
        {b('DND on', 'minus-circle-outline', 'set_dnd', { on: true })}
        {b('DND off', 'minus-circle-off-outline', 'set_dnd', { on: false })}
      </View>
      <AppText role="titleSmall">Clock</AppText>
      <View style={styles.buttons}>
        <Button label="Alarm in 2 min" variant="tonal" icon="alarm" disabled={busy} onPress={() => run('set_alarm', 'set_alarm', { time: inTwoMinutes(), label: 'Jophiel test' })} />
        {b('Timer 60 s', 'timer-outline', 'set_timer', { seconds: 60, label: 'Jophiel test' })}
        {b('Timer in 10 s', 'timer-sand', 'set_timer', { seconds: 60, label: 'Jophiel test' }, DELAYED_MS)}
      </View>
      <AppText role="titleSmall">Notifications</AppText>
      <View style={styles.buttons}>
        <Button
          label="Reply to newest"
          variant="tonal"
          icon="reply-outline"
          disabled={busy}
          onPress={() => {
            const n = latest()
            run(`reply_notification${n ? ` (${n.title})` : ''}`, 'reply_notification', {
              key: n?.key ?? 'none',
              conversation_id: n?.conversationId,
              revision: n?.revision,
              text: 'Test reply from Jophiel (phone half, phase 8)',
            })
          }}
        />
        <Button
          label="Dismiss newest"
          variant="tonal"
          icon="close-circle-outline"
          disabled={busy}
          onPress={() => run('dismiss_notification', 'dismiss_notification', { key: latest()?.key ?? 'none' })}
        />
      </View>
      <AppText role="titleSmall">Opening</AppText>
      <TextField label="App name, link or song" value={name} onChangeText={setName} autoCapitalize="none" />
      <View style={styles.buttons}>
        {b('Open app', 'apps', 'open_app', { name })}
        {b('Open app in 10 s', 'timer-outline', 'open_app', { name }, DELAYED_MS)}
        {b('Open link', 'link-variant', 'open_link', { url: name.startsWith('http') ? name : 'https://discord.com/app' })}
        {b('Play on Spotify', 'spotify', 'play_music', { query: name })}
      </View>
      <TextField label="WhatsApp draft to (empty: picker)" value={to} onChangeText={setTo} />
      <View style={styles.buttons}>
        {b('WhatsApp draft', 'whatsapp', 'whatsapp_draft', { ...(to.trim() ? { to } : {}), text: 'Hi! (a draft from Jophiel, not sent)' })}
      </View>
    </>
  )
}

/** Phase 9: time to switch to the app to test on (inside Jophiel she can only read). */
const CONTROL_DELAY_MS = 5_000
/** The takeover test: reads this far apart, in one turn (touch the screen in between). */
const SAME_TURN_GAP_MS = 4_000

function itemLine(item: ScreenItem): string {
  const words = item.text ?? item.label ?? ''
  const state = [
    item.hint ? `hint “${item.hint}”` : null,
    item.focused ? 'focused' : null,
    item.checked === true ? 'on' : item.checked === false ? 'off' : null,
    item.selected ? 'selected' : null,
    item.disabled ? 'disabled' : null,
  ].filter(Boolean)
  return `${item.n ? `[${item.n}] ` : '    '}${item.role} ${words ? `“${words}”` : ''}${state.length ? ` (${state.join(', ')})` : ''}`
}

/**
 * Phase 9: run phone control here, as if she had sent it. With the delay on, switch to the app to
 * try it in (Settings, Spotify…), wait for the action, then come back to see the screen she'd get.
 * Each press is its own turn, except the takeover test.
 */
function ControlTest({ onResult }: { onResult: (text: string) => void }) {
  const colors = useColors()
  const [screen, setScreen] = useState<PhoneScreen | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [delay, setDelay] = useState(true)
  const [n, setN] = useState('1')
  const [text, setText] = useState('wi-fi')
  const [enter, setEnter] = useState(false)
  const timer = useRef<TimerHandle | null>(null)
  useEffect(() => () => clearNativeTimeout(timer.current), [])

  const run = async (label: string, action: string, args: Record<string, unknown>, turn = `dev-${Date.now()}`) => {
    const result = await runLocalAction(action, { ...args, turn })
    const data = result?.data && 'screen' in result.data ? result.data.screen : null
    if (data) setScreen(data)
    onResult(`${label}: ${resultText(result)}${data ? ` (${data.id}, ${data.items.length} items${data.image_missing ? `, no picture: ${data.image_missing}` : ''})` : ''}`)
  }

  const go = (label: string, action: string, args: Record<string, unknown> = {}) => {
    setPending(label)
    const start = () => void run(label, action, args).finally(() => setPending(null))
    if (delay) timer.current = setNativeTimeout(start, CONTROL_DELAY_MS)
    else start()
  }

  const onScreen = (args: Record<string, unknown>) => ({ screen: screen?.id ?? 'none', ...args })
  const number = Number(n)

  const sameTurn = () => {
    const turn = `dev-${Date.now()}`
    setPending('3 reads, one turn')
    let left = 3
    const step = () => {
      timer.current = setNativeTimeout(() => {
        void run(`read ${4 - left} of 3`, 'read_screen', {}, turn).then(() => {
          left -= 1
          if (left > 0) step()
          else setPending(null)
        })
      }, SAME_TURN_GAP_MS)
    }
    step()
  }

  const busy = pending !== null
  const b = (label: string, icon: Parameters<typeof Button>[0]['icon'], action: string, args: Record<string, unknown> = {}) => (
    <Button key={label} label={label} variant="tonal" icon={icon} disabled={busy} onPress={() => go(label, action, args)} />
  )
  const image = screen?.image
  return (
    <View style={styles.block}>
      <AppText role="bodyMedium" color="onSurfaceVariant">
        {pending ? `Running ${pending}…` : 'Runs on this phone only; the server hears nothing. Turn Jophiel on in Accessibility first.'}
      </AppText>
      <SwitchRow title="Wait 5 s first" supporting="Time to switch to the app to try it in." value={delay} onValueChange={setDelay} />
      <View style={styles.buttons}>
        {b('Read screen', 'monitor-eye', 'read_screen')}
        {b('Scroll down', 'arrow-down', 'scroll', onScreen({ direction: 'down' }))}
        {b('Back', 'arrow-left', 'press', { key: 'back' })}
        {b('Home', 'home-outline', 'press', { key: 'home' })}
        {b('End control', 'stop', 'end_control')}
      </View>
      <TextField label="Number" value={n} onChangeText={setN} keyboardType="number-pad" />
      <View style={styles.buttons}>
        {b(`Tap ${n}`, 'gesture-tap', 'tap', onScreen({ n: number }))}
        {b(`Long press ${n}`, 'gesture-tap-hold', 'long_press', onScreen({ n: number }))}
        {b('Tap the middle', 'crosshairs', 'tap_point', onScreen({ x: Math.floor((image?.width ?? 720) / 2), y: Math.floor((image?.height ?? 1600) / 2) }))}
      </View>
      <TextField label="Text to type" value={text} onChangeText={setText} autoCapitalize="none" />
      <SwitchRow title="Press enter after" value={enter} onValueChange={setEnter} />
      <View style={styles.buttons}>
        {b(`Type into ${n}`, 'keyboard-outline', 'type_text', onScreen({ n: number, text, enter }))}
        <Button label="Takeover test" variant="tonal" icon="hand-back-left-outline" disabled={busy} onPress={sameTurn} />
      </View>
      {screen ? (
        <View style={styles.block}>
          <AppText role="titleSmall">{`${screen.id} · ${screen.app ?? screen.package ?? 'unknown app'}${screen.keyboard ? ' · keyboard up' : ''}${screen.truncated ? ' · truncated' : ''}`}</AppText>
          {image ? (
            <Image
              source={{ uri: `data:image/jpeg;base64,${image.jpeg_base64}` }}
              style={[styles.shot, { aspectRatio: image.width / image.height, borderColor: colors.outlineVariant }]}
              resizeMode="contain"
              accessibilityLabel={`The numbered screenshot of ${screen.app ?? 'the screen'}`}
            />
          ) : (
            <AppText role="bodySmall" color="onSurfaceVariant">{`No picture: ${screen.image_missing ?? 'unknown'}`}</AppText>
          )}
          <AppText role="bodySmall" color="onSurfaceVariant" style={styles.mono}>
            {screen.items.slice(0, 120).map(itemLine).join('\n')}
          </AppText>
        </View>
      ) : null}
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
  shot: { width: '100%', borderWidth: StyleSheet.hairlineWidth },
})
