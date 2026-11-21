import { useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  useAnimatedProps,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated'
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from 'react-native-svg'
import type { VoiceState } from '@/chat/frames'
import { useColors, type Palette } from '@/theme'
import { Icon } from './Controls'

/**
 * The voice visualiser: an orb whose *motion* is the state readout. Rebuilt from the web's canvas
 * orb (../app/frontend/src/components/VoiceOrb.tsx, web commit 94987e1) with react-native-svg and
 * Reanimated, same motions and numbers:
 *
 *   off       still                         — nothing is running
 *   idle      slow breathing                — the call is on, nobody talking
 *   listening bars driven by the mic        — your voice is being captured
 *   thinking  arc sweeping around the ring  — working, no audio either way
 *   speaking  bars + outward ripples        — her voice
 *
 * The level comes through a getter: a JS animation-frame loop copies it into a shared value and all
 * the drawing runs on the UI thread, so nothing above this re-renders while the orb moves.
 */

const PHASES: VoiceState[] = ['off', 'idle', 'listening', 'thinking', 'speaking']
/** Peak glow per phase, in PHASES order. */
const GLOW = [0.06, 0.16, 0.32, 0.24, 0.32]
const OFF = 0
const LISTENING = 2
const THINKING = 3
const SPEAKING = 4

const BARS = 72
const TAU = Math.PI * 2
/** Stable per-bar weight, so the ring has a fixed silhouette that pumps. */
const BAR_WEIGHTS = Array.from({ length: BARS }, (_, i) => {
  const n = Math.sin(i * 12.9898) * 43758.5453
  return 0.55 + (n - Math.floor(n)) * 0.45
})

const AnimatedCircle = Animated.createAnimatedComponent(Circle)
const AnimatedPath = Animated.createAnimatedComponent(Path)

/** Warm palette roles per state; the motion, not the color, is what tells them apart. */
function phaseColor(state: VoiceState, colors: Palette): string {
  if (state === 'off') return colors.outline
  if (state === 'thinking') return colors.onSurfaceVariant
  return colors.primary
}

interface Props {
  state: VoiceState
  getLevel: () => number
  size?: number
}

interface Motion {
  phase: SharedValue<number>
  level: SharedValue<number>
  time: SharedValue<number>
  breath: SharedValue<number>
  size: number
  reduced: boolean
}

function radiusOf(m: Motion): number {
  'worklet'
  const breathe = m.reduced || m.phase.value === OFF ? 0 : Math.sin(m.breath.value) * 0.02
  return m.size * 0.24 * (1 + breathe + m.level.value * 0.16)
}

export function VoiceOrb({ state, getLevel, size = 120 }: Props) {
  const colors = useColors()
  const reduced = useReducedMotion()
  const phase = useSharedValue(PHASES.indexOf(state))
  const target = useSharedValue(0)
  const level = useSharedValue(0)
  const time = useSharedValue(0)
  const breath = useSharedValue(0)
  const getLevelRef = useRef(getLevel)
  getLevelRef.current = getLevel

  useEffect(() => {
    phase.value = PHASES.indexOf(state)
  }, [state, phase])

  // The getter reads JS state, so it is sampled on the JS thread once per frame.
  const sampling = state !== 'off' && !reduced
  useEffect(() => {
    if (!sampling) {
      target.value = 0
      return
    }
    let frame = 0
    const tick = () => {
      target.value = getLevelRef.current()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [sampling, target])

  useFrameCallback((info) => {
    // Clamped so a frame after a stall doesn't jump.
    const dt = Math.min((info.timeSincePreviousFrame ?? 16) / 1000, 0.1)
    time.value += dt
    // Fast attack, slow release — the same asymmetry a VU meter uses. Snappy on a syllable, no
    // flicker in the gaps between them.
    const goal = target.value
    level.value += (goal - level.value) * (goal > level.value ? 0.4 : 0.09)
    breath.value += dt * 1.5
  })

  const motion: Motion = { phase, level, time, breath, size, reduced }
  const color = phaseColor(state, colors)
  const c = size / 2

  const haloProps = useAnimatedProps(() => {
    const glow = GLOW[phase.value] ?? 0
    return { opacity: glow * (0.55 + level.value * 0.45) }
  })

  const barsProps = useAnimatedProps(() => {
    const p = phase.value
    if (reduced || (p !== LISTENING && p !== SPEAKING)) return { d: 'M0 0', strokeOpacity: 0 }
    const radius = radiusOf(motion)
    const inner = radius * 1.14
    const t = time.value
    let d = ''
    for (let i = 0; i < BARS; i++) {
      const angle = (i / BARS) * TAU - Math.PI / 2
      const wobble = 0.72 + 0.28 * Math.sin(t * 5 + i * 0.55)
      const len = size * 0.035 * (0.28 + level.value * 2.1 * (BAR_WEIGHTS[i] ?? 1) * wobble)
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      d += `M${(c + cos * inner).toFixed(2)} ${(c + sin * inner).toFixed(2)}L${(c + cos * (inner + len)).toFixed(2)} ${(c + sin * (inner + len)).toFixed(2)}`
    }
    return { d, strokeOpacity: 0.35 + level.value * 0.5 }
  })

  const ringProps = useAnimatedProps(() => ({ r: radiusOf(motion) * 1.08 }))

  const arcProps = useAnimatedProps(() => {
    if (reduced || phase.value !== THINKING) return { d: 'M0 0', strokeOpacity: 0 }
    const r = radiusOf(motion) * 1.08
    const head = time.value * 2.4
    const tail = head + Math.PI * 0.5
    const x1 = c + Math.cos(head) * r
    const y1 = c + Math.sin(head) * r
    const x2 = c + Math.cos(tail) * r
    const y2 = c + Math.sin(tail) * r
    return { d: `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`, strokeOpacity: 0.9 }
  })

  const coreProps = useAnimatedProps(() => ({
    r: radiusOf(motion),
    fillOpacity: phase.value === OFF ? 0.35 : 0.6 + level.value * 0.4,
  }))

  return (
    <View style={{ width: size, height: size }} importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id="orbHalo" cx="50%" cy="50%" r="50%">
            <Stop offset="0.25" stopColor={color} stopOpacity={1} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="orbCore" cx="40%" cy="36%" r="65%">
            <Stop offset="0" stopColor={color} stopOpacity={0.85} />
            <Stop offset="0.7" stopColor={color} stopOpacity={0.3} />
            <Stop offset="1" stopColor={colors.surfaceContainer} stopOpacity={0.75} />
          </RadialGradient>
        </Defs>
        <AnimatedCircle cx={c} cy={c} r={c} fill="url(#orbHalo)" animatedProps={haloProps} />
        {[0, 1, 2].map((k) => (
          <Ripple key={k} index={k} motion={motion} color={color} />
        ))}
        <AnimatedPath stroke={color} strokeWidth={Math.max(1.5, size * 0.008)} strokeLinecap="round" fill="none" animatedProps={barsProps} />
        <AnimatedCircle cx={c} cy={c} stroke={color} strokeOpacity={0.28} strokeWidth={1.5} fill="none" animatedProps={ringProps} />
        <AnimatedPath stroke={color} strokeWidth={2.5} strokeLinecap="round" fill="none" animatedProps={arcProps} />
        <AnimatedCircle cx={c} cy={c} fill="url(#orbCore)" animatedProps={coreProps} />
      </Svg>
      <View style={[StyleSheet.absoluteFill, styles.glyph]} pointerEvents="none">
        <Icon
          name={state === 'off' ? 'microphone-off' : 'microphone'}
          size={Math.round(size * 0.16)}
          color={state === 'off' ? colors.onSurfaceVariant : colors.onSurface}
        />
      </View>
    </View>
  )
}

/** Ripples racing outward while she talks. */
function Ripple({ index, motion, color }: { index: number; motion: Motion; color: string }) {
  const c = motion.size / 2
  const props = useAnimatedProps(() => {
    if (motion.reduced || motion.phase.value !== SPEAKING) return { r: 0, strokeOpacity: 0 }
    const p = (motion.time.value * 0.55 + index / 3) % 1
    return { r: radiusOf(motion) * (1.12 + p * 1.1), strokeOpacity: (1 - p) * 0.22 }
  })
  return <AnimatedCircle cx={c} cy={c} stroke={color} strokeWidth={1.5} fill="none" animatedProps={props} />
}

const styles = StyleSheet.create({
  glyph: { alignItems: 'center', justifyContent: 'center' },
})
