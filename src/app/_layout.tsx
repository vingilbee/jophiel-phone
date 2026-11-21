import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SystemUI from 'expo-system-ui'
import { useEffect } from 'react'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { SessionProvider, useSession } from '@/auth/session'
import { useColors, useIsDark } from '@/theme'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

function RootStack() {
  const { status } = useSession()
  const colors = useColors()
  const isDark = useIsDark()

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background)
  }, [colors.background])

  // Keep the splash-colored ground until we know whether a token is stored.
  if (status === 'loading') return null

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'fade_from_bottom',
        }}
      >
        <Stack.Protected guard={status === 'signedIn'}>
          <Stack.Screen name="(main)" />
        </Stack.Protected>
        <Stack.Protected guard={status !== 'signedIn'}>
          <Stack.Screen name="(auth)/login" />
        </Stack.Protected>
      </Stack>
    </>
  )
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <RootStack />
          </SessionProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}
