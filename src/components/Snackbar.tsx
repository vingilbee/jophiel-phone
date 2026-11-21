import { useEffect } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import { radius, space, useColors, useIsDark } from '@/theme'
import { AppText } from './AppText'

interface Props {
  message: string | null
  onDismiss: () => void
  action?: { label: string; onPress: () => void }
  durationMs?: number
}

/** Material snackbar: short feedback above the composer, inverse colors. */
export function Snackbar({ message, onDismiss, action, durationMs = 3000 }: Props) {
  const colors = useColors()
  const isDark = useIsDark()
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDismiss, durationMs)
    return () => clearTimeout(timer)
  }, [message, onDismiss, durationMs])
  if (!message) return null
  // Inverse surface, Material's snackbar treatment.
  const background = colors.onSurface
  const foreground = colors.surface
  return (
    <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOutDown.duration(150)} style={styles.wrap} pointerEvents="box-none">
      <View style={[styles.bar, { backgroundColor: background }]} accessibilityLiveRegion="polite">
        <AppText role="bodyMedium" style={[styles.text, { color: foreground }]}>
          {message}
        </AppText>
        {action ? (
          <Pressable accessibilityRole="button" onPress={action.onPress} style={styles.action} hitSlop={8}>
            <AppText role="labelLarge" style={{ color: isDark ? colors.onPrimary : colors.primaryContainer }}>
              {action.label}
            </AppText>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space.md, right: space.md, bottom: space.md },
  bar: {
    minHeight: 48,
    borderRadius: radius.field - 8,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    elevation: 3,
  },
  text: { flex: 1 },
  action: { minHeight: 40, justifyContent: 'center' },
})
