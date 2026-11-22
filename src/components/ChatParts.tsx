import { useRef, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View, type TextInputInstance } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import { timeLabel } from '@/chat/format'
import { bannerText, type ConnectionPhase } from '@/connection/state'
import { radius, space, type, useColors } from '@/theme'
import { AppText } from './AppText'
import { Icon } from './Controls'
import { JophielMark } from './Marks'

export function DateDivider({ label }: { label: string }) {
  const colors = useColors()
  return (
    <View style={styles.divider} accessibilityRole="header">
      <View style={[styles.dividerPill, { backgroundColor: colors.surfaceContainerHigh }]}>
        <AppText role="labelMedium" color="onSurfaceVariant">
          {label}
        </AppText>
      </View>
    </View>
  )
}

/**
 * Phase 7: something she did on this phone ("Opened Maps → Kemang Village", "Used your location
 * once"). Not a bubble: a quiet centered line, unlike the date's pill, so it reads as a note in
 * the thread rather than something anyone said.
 */
export function ActivityLine({ text, at }: { text: string; at: string }) {
  const colors = useColors()
  const time = timeLabel(at)
  return (
    <View style={styles.activity} accessible accessibilityLabel={`On your phone: ${text}, ${time}`}>
      <Icon name="cellphone-arrow-down" size={14} color={colors.onSurfaceVariant} />
      <AppText role="labelMedium" color="onSurfaceVariant" style={styles.activityText} numberOfLines={2}>
        {text}
      </AppText>
      <AppText role="labelSmall" color="onSurfaceVariant">
        {time}
      </AppText>
    </View>
  )
}

/** She picked your message up and is thinking: her ✦ breathes where her reply will appear. */
export function ThinkingRow() {
  return (
    <Animated.View
      entering={FadeIn.duration(250)}
      exiting={FadeOut.duration(150)}
      style={styles.thinking}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel="Jophiel is thinking"
    >
      <JophielMark size={32} breathing />
    </Animated.View>
  )
}

export function ConnectionBanner({ phase, onRetry }: { phase: ConnectionPhase; onRetry: () => void }) {
  const colors = useColors()
  const text = bannerText(phase)
  if (!text) return null
  const hard = phase === 'unreachable'
  return (
    <Animated.View
      entering={FadeIn.duration(250)}
      exiting={FadeOut.duration(150)}
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: hard ? colors.warnContainer : colors.surfaceContainerHigh }]}
    >
      <Icon name={hard ? 'lan-disconnect' : 'sync'} size={18} color={hard ? colors.onWarnContainer : colors.onSurfaceVariant} />
      <AppText role="bodyMedium" style={[styles.bannerText, { color: hard ? colors.onWarnContainer : colors.onSurfaceVariant }]}>
        {text}
      </AppText>
      {hard ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          android_ripple={{ color: colors.ripple }}
          hitSlop={8}
          style={styles.bannerAction}
        >
          <AppText role="labelLarge" style={{ color: colors.onWarnContainer }}>
            Try now
          </AppText>
        </Pressable>
      ) : null}
    </Animated.View>
  )
}

interface ComposerProps {
  replying: boolean
  onSend: (text: string) => void
  onStop: () => void
  onTyping: (typing: boolean) => void
}

export function Composer({ replying, onSend, onStop, onTyping }: ComposerProps) {
  const colors = useColors()
  const [text, setText] = useState('')
  const input = useRef<TextInputInstance>(null)
  const canSend = text.trim().length > 0
  // While she replies and you haven't typed, the button stops her. Once you type, it sends
  // (sending also interrupts her reply, server-side).
  const mode: 'send' | 'stop' = replying && !canSend ? 'stop' : 'send'

  const submit = () => {
    if (!canSend) return
    onSend(text)
    setText('')
    onTyping(false)
  }

  return (
    <View style={[styles.composer, { backgroundColor: colors.background }]}>
      <View style={[styles.inputWrap, { backgroundColor: colors.surfaceContainer, borderColor: colors.outlineVariant }]}>
        <TextInput
          ref={input}
          value={text}
          onChangeText={(value) => {
            setText(value)
            onTyping(value.length > 0)
          }}
          placeholder="Message"
          placeholderTextColor={colors.onSurfaceVariant}
          selectionColor={colors.primary}
          cursorColor={colors.primary}
          multiline
          maxLength={8000}
          accessibilityLabel="Message to Jophiel"
          style={[styles.input, type.bodyLarge, { color: colors.onSurface }]}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={mode === 'stop' ? 'Stop her reply' : 'Send'}
        accessibilityState={{ disabled: mode === 'send' && !canSend }}
        onPress={mode === 'stop' ? onStop : submit}
        disabled={mode === 'send' && !canSend}
        android_ripple={{ color: colors.ripple, borderless: false }}
        style={[
          styles.sendButton,
          {
            backgroundColor:
              mode === 'stop' ? colors.surfaceContainerHigh : canSend ? colors.primary : colors.surfaceContainerHigh,
          },
        ]}
      >
        <Icon
          name={mode === 'stop' ? 'stop' : 'send'}
          size={22}
          color={mode === 'stop' ? colors.onSurface : canSend ? colors.onPrimary : colors.onSurfaceVariant}
        />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  divider: { alignItems: 'center', paddingTop: space.lg, paddingBottom: space.xs },
  dividerPill: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 4 },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
  },
  activityText: { flexShrink: 1, textAlign: 'center' },
  thinking: { paddingHorizontal: space.sm, paddingTop: space.md, flexDirection: 'row' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    minHeight: 40,
  },
  bannerText: { flex: 1 },
  bannerAction: { minHeight: 40, justifyContent: 'center', paddingHorizontal: space.sm },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  inputWrap: {
    flex: 1,
    minHeight: 48,
    maxHeight: 160,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth * 2,
    justifyContent: 'center',
  },
  input: { paddingHorizontal: space.lg, paddingTop: 12, paddingBottom: 12, textAlignVertical: 'center' },
  sendButton: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
})
