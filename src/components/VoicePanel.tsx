import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated'
import type { VoiceSession } from '@/voice/useVoiceSession'
import { radius, space, useColors } from '@/theme'
import { AppText } from './AppText'
import { Icon, type IconName } from './Controls'
import { VoiceOrb } from './VoiceOrb'

/** The state in words, as on the web (plus the phone's "Reconnecting…" and "Paused for a call"). */
export function voiceLabel(session: VoiceSession): string {
  if (session.reconnecting) return 'Reconnecting…'
  if (session.pausedForCall) return 'Paused for a call'
  if (session.muted) return session.state === 'speaking' ? 'Mic muted · Jophiel is speaking' : 'Mic muted'
  switch (session.state) {
    case 'off':
      return 'Voice off'
    case 'idle':
      return 'Ready to listen'
    case 'listening':
      return 'Listening'
    case 'thinking':
      return 'Thinking'
    case 'speaking':
      return 'Speaking'
  }
}

interface PanelButtonProps {
  icon: IconName
  label: string
  onPress: () => void
  tone?: 'tonal' | 'filled' | 'danger'
  pressed?: boolean
  disabled?: boolean
}

function PanelButton({ icon, label, onPress, tone = 'tonal', pressed, disabled }: PanelButtonProps) {
  const colors = useColors()
  const background =
    tone === 'filled' ? colors.primary : tone === 'danger' ? colors.errorContainer : colors.surfaceContainerHigh
  const foreground =
    tone === 'filled' ? colors.onPrimary : tone === 'danger' ? colors.onErrorContainer : colors.onSurface
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: pressed }}
      onPress={onPress}
      disabled={disabled}
      android_ripple={{ color: colors.ripple, foreground: true }}
      style={[styles.button, { backgroundColor: background, opacity: disabled ? 0.38 : 1 }]}
    >
      <Icon name={icon} size={18} color={foreground} />
      <AppText role="labelLarge" style={{ color: foreground }}>
        {label}
      </AppText>
    </Pressable>
  )
}

interface Props {
  session: VoiceSession
  busy: boolean
}

/** Shown above the messages while a call is on. Same controls as the web's voice bar. */
export function VoicePanel({ session, busy }: Props) {
  const colors = useColors()
  const label = voiceLabel(session)
  const blocked = session.reconnecting

  // One context button: what makes sense right now.
  let context: { icon: IconName; label: string; onPress: () => void } | null = null
  if (session.state === 'listening') context = { icon: 'check', label: 'Done talking', onPress: session.endTurn }
  else if (busy) context = { icon: 'hand-back-left-outline', label: 'Interrupt', onPress: session.interrupt }
  else if (session.state === 'idle' && !session.muted) context = { icon: 'microphone', label: 'Talk now', onPress: session.pushToTalk }

  return (
    <Animated.View
      entering={FadeInUp.duration(250)}
      exiting={FadeOutUp.duration(200)}
      style={[styles.panel, { backgroundColor: colors.surface, borderBottomColor: colors.outlineVariant }]}
    >
      <View style={styles.row}>
        <VoiceOrb state={session.muted && !busy ? 'off' : session.state} getLevel={session.getLevel} size={120} />
        <View style={styles.side}>
          <AppText role="titleMedium" accessibilityRole="text" accessibilityLiveRegion="polite">
            {label}
          </AppText>
          {session.route === 'headphones' || session.route === 'bluetooth' ? (
            <View style={styles.route}>
              <Icon name={session.route === 'bluetooth' ? 'bluetooth-audio' : 'headphones'} size={16} color={colors.onSurfaceVariant} />
              <AppText role="bodySmall" color="onSurfaceVariant">
                {session.route === 'bluetooth' ? 'Bluetooth' : 'Headphones'}
              </AppText>
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.actions}>
        {context ? (
          <PanelButton icon={context.icon} label={context.label} onPress={context.onPress} tone="filled" disabled={blocked} />
        ) : null}
        <PanelButton
          icon={session.muted ? 'microphone-off' : 'microphone-outline'}
          label={session.muted ? 'Unmute' : 'Mute'}
          pressed={session.muted}
          onPress={() => session.setMuted(!session.muted)}
        />
        <PanelButton icon="phone-hangup" label="End" tone="danger" onPress={session.disable} />
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  panel: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  side: { flex: 1, gap: space.xs },
  route: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  button: {
    minHeight: 48,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    overflow: 'hidden',
  },
})
