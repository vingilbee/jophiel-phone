import * as Clipboard from 'expo-clipboard'
import { memo, useEffect } from 'react'
import { Image, Pressable, StyleSheet, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated'
import { baseUrl } from '@/api/client'
import { stripStickers } from '@/chat/frames'
import { delayLabel, timeLabel, type ChatRow } from '@/chat/format'
import type { Tick } from '@/chat/model'
import { radius, space, useColors, type Palette } from '@/theme'
import { AppText } from './AppText'
import { Icon } from './Controls'
import { JophielMark, MeMark } from './Marks'
import { Markdown } from './Markdown'

const AVATAR = 32

function TickIcon({ tick, colors }: { tick: Tick; colors: Palette }) {
  if (tick === 'failed') return <Icon name="alert-circle-outline" size={16} color={colors.error} />
  if (tick === 'waiting') return <Icon name="clock-outline" size={14} color={colors.onPrimaryContainerVariant} />
  if (tick === 'saved') return <Icon name="check" size={16} color={colors.onPrimaryContainerVariant} />
  // She picked it up: the one place the accent appears on your bubble.
  return <Icon name="check-all" size={16} color={colors.primary} />
}

const TICK_LABEL: Record<Tick, string> = {
  waiting: 'waiting to send',
  failed: 'not sent',
  saved: 'sent',
  seen: 'she picked it up',
}

interface Props {
  row: ChatRow
  token: string | null
  highlighted: boolean
  onCopied: () => void
  /** Tapped a message that couldn't be sent: offer to try again or delete it. */
  onFailedPress: (turnId: string) => void
}

export const Bubble = memo(function Bubble({ row, token, highlighted, onCopied, onFailedPress }: Props) {
  const colors = useColors()
  const { item, firstOfRun } = row
  const mine = item.role === 'user'
  const text = stripStickers(item.text).trim()
  const flash = useSharedValue(0)

  useEffect(() => {
    if (!highlighted) return
    flash.value = withTiming(1, { duration: 200 }, () => {
      flash.value = withDelay(900, withTiming(0, { duration: 600 }))
    })
  }, [highlighted, flash])

  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.value * 0.16 }))

  const background = mine ? colors.primaryContainer : colors.surfaceContainer
  const ink = mine ? colors.onPrimaryContainer : colors.onSurface
  const meta = mine ? colors.onPrimaryContainerVariant : colors.onSurfaceVariant

  const corners = mine
    ? { borderTopRightRadius: firstOfRun ? radius.bubbleTight : radius.bubble }
    : { borderTopLeftRadius: firstOfRun ? radius.bubbleTight : radius.bubble }

  const statusNote =
    item.role === 'assistant' && !item.streaming
      ? item.status === 'partial' || item.status === 'cancelled'
        ? 'stopped'
        : item.status === 'failed'
          ? "didn't finish"
          : null
      : null

  const failed = item.tick === 'failed'
  const time = timeLabel(item.at)
  const waited = mine && item.arrivedAt ? `waited ${delayLabel(item.at, item.arrivedAt)} on the phone` : null
  const a11y = [
    mine ? 'You' : 'Jophiel',
    text,
    time,
    item.tick ? TICK_LABEL[item.tick] : null,
    waited,
    statusNote,
  ]
    .filter(Boolean)
    .join(', ')

  const imageSources = [
    ...item.imageIds.map((id) => `${baseUrl()}/api/images/${id}/raw`),
    ...item.assetIds.map((id) => `${baseUrl()}/api/assets/${id}/raw`),
  ]

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowHers, { marginTop: firstOfRun ? space.md : 2 }]}>
      {!mine ? <View style={styles.avatarSlot}>{firstOfRun ? <JophielMark size={AVATAR} /> : null}</View> : null}
      <Pressable
        accessible
        accessibilityLabel={a11y}
        accessibilityHint={failed ? 'Opens Try again and Delete' : text ? 'Long press to copy' : undefined}
        onPress={failed && item.turnId ? () => onFailedPress(item.turnId as string) : undefined}
        onLongPress={
          text
            ? () => {
                void Clipboard.setStringAsync(text).then(onCopied)
              }
            : undefined
        }
        delayLongPress={350}
        style={[styles.bubble, corners, { backgroundColor: background }]}
      >
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.flash, corners, { backgroundColor: colors.primary }, flashStyle]}
        />
        {imageSources.map((uri) => (
          <Image
            key={uri}
            accessibilityIgnoresInvertColors
            source={{ uri, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
            style={[styles.image, { backgroundColor: colors.surfaceContainerHigh }]}
            resizeMode="cover"
          />
        ))}
        {text ? (
          <Markdown
            source={text}
            colors={colors}
            ink={ink}
            linkColor={colors.primary}
            codeBackground={mine ? colors.background : colors.surfaceContainerHigh}
          />
        ) : null}
        <View style={styles.meta} importantForAccessibility="no-hide-descendants">
          {failed ? (
            <AppText role="labelSmall" style={{ color: colors.error }}>
              Not sent · tap for options ·
            </AppText>
          ) : null}
          {waited ? (
            <AppText role="labelSmall" style={{ color: meta }}>
              {waited} ·
            </AppText>
          ) : null}
          {statusNote ? (
            <AppText role="labelSmall" style={{ color: meta }}>
              {statusNote} ·
            </AppText>
          ) : null}
          <AppText role="labelSmall" style={{ color: meta, fontVariant: ['tabular-nums'] }}>
            {time}
          </AppText>
          {item.tick ? <TickIcon tick={item.tick} colors={colors} /> : null}
        </View>
      </Pressable>
      {mine ? <View style={styles.avatarSlot}>{firstOfRun ? <MeMark size={AVATAR} /> : null}</View> : null}
    </View>
  )
})

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.sm },
  rowMine: { justifyContent: 'flex-end', paddingLeft: 56 },
  rowHers: { justifyContent: 'flex-start', paddingRight: 56 },
  avatarSlot: { width: AVATAR },
  bubble: {
    flexShrink: 1,
    borderRadius: radius.bubble,
    paddingHorizontal: space.md + 2,
    paddingTop: space.sm + 2,
    paddingBottom: space.xs + 2,
    overflow: 'hidden',
    gap: space.xs,
  },
  flash: { opacity: 0 },
  image: { width: 220, height: 220, borderRadius: radius.field, marginTop: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: 4, marginTop: -2 },
})
