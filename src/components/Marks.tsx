import { useEffect } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { useColors, useIsDark } from '@/theme'

interface MarkProps {
  size?: number
}

/** The ✦ drawn as a path (same shape as the app icon), so it's identical on every phone. */
export function Star({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Path
        fill={color}
        d="M512 96 C552 368 656 472 928 512 C656 552 552 656 512 928 C472 656 368 552 96 512 C368 472 472 368 512 96 Z"
      />
    </Svg>
  )
}

const PICTURE = require('../../assets/jophiel-pfp.png')

/** Her picture: the chibi portrait in a circle. `breathing`: a slow pulse while she's thinking. */
export function JophielMark({ size = 32, breathing = false }: MarkProps & { breathing?: boolean }) {
  const colors = useColors()
  const reduceMotion = useReducedMotion()
  const pulse = useSharedValue(0)

  useEffect(() => {
    if (!breathing || reduceMotion) {
      pulse.value = 0
      return
    }
    pulse.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.sin) }), -1, true)
  }, [breathing, reduceMotion, pulse])

  const pictureStyle = useAnimatedStyle(() => ({
    opacity: 1 - 0.35 * pulse.value,
    transform: [{ scale: 1 - 0.08 * pulse.value }],
  }))

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Jophiel"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.primaryContainer }}
    >
      <Animated.View style={pictureStyle}>
        <Image source={PICTURE} style={{ width: size, height: size, borderRadius: size / 2 }} />
      </Animated.View>
    </View>
  )
}

/** Your picture: a plain black circle (with a hairline in dark mode, so it doesn't vanish). */
export function MeMark({ size = 32 }: MarkProps) {
  const isDark = useIsDark()
  const colors = useColors()
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="You"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: '#000',
        borderWidth: isDark ? StyleSheet.hairlineWidth * 2 : 0,
        borderColor: colors.outline,
      }}
    />
  )
}
