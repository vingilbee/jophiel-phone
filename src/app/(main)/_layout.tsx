import { Stack, useRouter } from 'expo-router'
import { useEffect } from 'react'
import { AppState } from 'react-native'
import { onSignOut } from '@/auth/session'
import { ChatProvider } from '@/chat/ChatProvider'
import { initialTappedMessageId, notifee, onPendingTap, takePendingTap, tappedMessageId } from '@/push/display'
import { startPush, stopPushForSignOut } from '@/push/registration'
import { getSettings } from '@/settings/store'
import { useColors } from '@/theme'

function useNotificationTaps() {
  const router = useRouter()
  useEffect(() => {
    const open = (messageId: string | null) => {
      if (messageId) router.navigate({ pathname: '/', params: { messageId } })
    }
    const openPending = () => void takePendingTap().then(open)
    void initialTappedMessageId().then(open)
    openPending()
    const unsubscribeForeground = notifee.onForegroundEvent((event) => open(tappedMessageId(event)))
    // Background taps: parked by the background handler, opened once the app is in front.
    const unsubscribePending = onPendingTap(() => {
      if (AppState.currentState === 'active') openPending()
    })
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') openPending()
    })
    return () => {
      unsubscribeForeground()
      unsubscribePending()
      appState.remove()
    }
  }, [router])
}

export default function MainLayout() {
  const colors = useColors()
  const router = useRouter()

  useEffect(() => startPush(), [])
  useEffect(() => onSignOut(stopPushForSignOut), [])
  useNotificationTaps()

  // First run after signing in: walk through Setup once (it can be skipped and reopened from Settings).
  useEffect(() => {
    if (!getSettings().setupSeen) {
      const timer = setTimeout(() => router.push('/setup/connection'), 0)
      return () => clearTimeout(timer)
    }
  }, [router])

  return (
    <ChatProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="setup/[step]" />
      </Stack>
    </ChatProvider>
  )
}
