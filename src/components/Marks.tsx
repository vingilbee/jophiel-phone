import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
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

/** Her picture: the ✦ glyph in terracotta on a warm disc. */
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

  const glyphStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + 0.45 * (1 - pulse.value),
    transform: [{ scale: 0.86 + 0.14 * (1 - pulse.value) }, { rotate: `${pulse.value * 45}deg` }],
  }))

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Jophiel"
      style={[styles.disc, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors.primaryContainer }]}
    >
      <Animated.View style={glyphStyle}>
        <Star size={size * 0.56} color={colors.primary} />
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

const styles = StyleSheet.create({
  disc: { alignItems: 'center', justifyContent: 'center' },
})
