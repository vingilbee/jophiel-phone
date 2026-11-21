import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, StyleSheet, View } from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { useAnimatedStyle } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { getToken } from '@/auth/token'
import { useChat } from '@/chat/ChatProvider'
import { toRows, type ChatRow } from '@/chat/format'
import { AppText } from '@/components/AppText'
import { Bubble } from '@/components/Bubble'
import { Composer, ConnectionBanner, DateDivider, ThinkingRow } from '@/components/ChatParts'
import { IconButton } from '@/components/Controls'
import { JophielMark } from '@/components/Marks'
import { Snackbar } from '@/components/Snackbar'
import { space, useColors } from '@/theme'

type ListEntry = { kind: 'row'; row: ChatRow } | { kind: 'thinking' }

function useBearer() {
  const [token, setToken] = useState<string | null>(null)
  useEffect(() => {
    void getToken().then(setToken)
  }, [])
  return token
}

export default function ChatScreen() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const chat = useChat()
  const token = useBearer()
  const { messageId } = useLocalSearchParams<{ messageId?: string }>()
  const list = useRef<FlatList<ListEntry>>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [snack, setSnack] = useState<string | null>(null)

  // Newest first, for the inverted list (it keeps the conversation anchored to the composer).
  const entries = useMemo<ListEntry[]>(() => {
    const rows = toRows(chat.items).map((row): ListEntry => ({ kind: 'row', row }))
    if (chat.thinking) rows.push({ kind: 'thinking' })
    return rows.reverse()
  }, [chat.items, chat.thinking])

  // Opened from a notification: scroll to that message and flash it.
  useEffect(() => {
    if (!messageId || !chat.state.historyLoaded) return
    const index = entries.findIndex((e) => e.kind === 'row' && e.row.item.id === messageId)
    if (index < 0) return
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true })
    setHighlight(messageId)
    router.setParams({ messageId: undefined })
  }, [messageId, entries, chat.state.historyLoaded, router])

  const { height: keyboardHeight } = useReanimatedKeyboardAnimation()
  const bottomInset = insets.bottom
  const keyboardStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(bottomInset, -keyboardHeight.value),
  }))

  const status = chat.replying
    ? 'writing…'
    : chat.thinking
      ? 'thinking…'
      : chat.phase === 'unreachable'
        ? 'offline'
        : chat.phase !== 'connected'
          ? 'connecting…'
          : null

  const onCopied = useCallback(() => setSnack('Copied'), [])
  const dismissSnack = useCallback(() => setSnack(null), [])
  const { retryMessage, deleteMessage } = chat
  const onFailedPress = useCallback(
    (turnId: string) => {
      Alert.alert('Not sent', "The server didn't accept this message.", [
        { text: 'Delete', style: 'destructive', onPress: () => deleteMessage(turnId) },
        { text: 'Cancel', style: 'cancel' },
        { text: 'Try again', onPress: () => retryMessage(turnId) },
      ])
    },
    [retryMessage, deleteMessage],
  )

  const renderItem = useCallback(
    ({ item }: { item: ListEntry }) => {
      if (item.kind === 'thinking') return <ThinkingRow />
      const { row } = item
      return (
        <View>
          {row.dayDivider ? <DateDivider label={row.dayDivider} /> : null}
          <Bubble row={row} token={token} highlighted={highlight === row.item.id} onCopied={onCopied} onFailedPress={onFailedPress} />
        </View>
      )
    },
    [token, highlight, onCopied, onFailedPress],
  )

  const empty = chat.state.historyLoaded && chat.items.length === 0
  const loading = !chat.state.historyLoaded && chat.items.length === 0

  return (
    <Animated.View style={[styles.screen, { backgroundColor: colors.background }, keyboardStyle]}>
      <View style={[styles.appBar, { paddingTop: insets.top, backgroundColor: colors.surface, borderBottomColor: colors.outlineVariant }]}>
        <View style={styles.identity} accessible accessibilityRole="header" accessibilityLabel={`Jophiel${status ? `, ${status}` : ''}`}>
          <JophielMark size={40} breathing={chat.thinking} />
          <View>
            <AppText role="titleMedium">Jophiel</AppText>
            {status ? (
              <AppText role="bodySmall" color={chat.replying || chat.thinking ? 'primary' : 'onSurfaceVariant'}>
                {status}
              </AppText>
            ) : null}
          </View>
        </View>
        <IconButton icon="cog-outline" label="Settings" onPress={() => router.push('/settings')} />
      </View>

      <ConnectionBanner phase={chat.phase} onRetry={chat.retryNow} />

      <View style={styles.thread}>
        {empty ? (
          <View style={styles.center}>
            <JophielMark size={56} />
            <AppText role="bodyLarge" color="onSurfaceVariant" style={styles.centerText}>
              Nothing here yet. Say hi.
            </AppText>
          </View>
        ) : loading ? (
          <View style={styles.center}>
            {chat.phase === 'connected' ? <ActivityIndicator color={colors.primary} /> : null}
          </View>
        ) : (
          <FlatList
            ref={list}
            inverted
            data={entries}
            keyExtractor={(entry) => (entry.kind === 'thinking' ? 'thinking' : entry.row.item.key)}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false })
              setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5 }), 120)
            }}
            windowSize={11}
          />
        )}
        <Snackbar message={snack} onDismiss={dismissSnack} />
        <Snackbar
          message={chat.state.error ? `She couldn't finish that reply. ${chat.state.error}` : null}
          onDismiss={chat.dismissError}
          durationMs={6000}
          action={{ label: 'OK', onPress: chat.dismissError }}
        />
      </View>

      <Composer
        replying={chat.replying || chat.thinking}
        onSend={chat.send}
        onStop={chat.stop}
        onTyping={(typing) => chat.setActivity(typing ? 'typing' : 'reading')}
      />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  appBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: space.lg,
    paddingRight: space.xs,
    minHeight: 64,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, flex: 1 },
  thread: { flex: 1 },
  listContent: { paddingTop: space.md, paddingBottom: space.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
  centerText: { textAlign: 'center' },
})
