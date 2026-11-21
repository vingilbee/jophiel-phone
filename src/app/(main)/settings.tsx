import { useQuery } from '@tanstack/react-query'
import * as Application from 'expo-application'
import { useRouter } from 'expo-router'
import { Alert, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { fetchCapabilities } from '@/api/auth'
import { useSession } from '@/auth/session'
import { useChat } from '@/chat/ChatProvider'
import { dayLabel, timeLabel } from '@/chat/format'
import { AppText } from '@/components/AppText'
import { IconButton, ListRow, SectionHeader } from '@/components/Controls'
import type { ConnectionPhase } from '@/connection/state'
import { pushEnabled } from '@/push/config'
import { openAppSettings, openNotificationSettings } from '@/setup/permissions'
import { usePermissions } from '@/setup/usePermissions'
import { useSettings } from '@/settings/store'
import { space, useColors } from '@/theme'

const PHASE_LABEL: Record<ConnectionPhase, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  unreachable: "Can't reach the server",
}

function lastConnected(iso: string | null): string {
  if (!iso) return 'Never'
  return `${dayLabel(iso)}, ${timeLabel(iso)}`
}

export default function Settings() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { user, signOut } = useSession()
  const chat = useChat()
  const settings = useSettings()
  const [permissions] = usePermissions()
  const capabilities = useQuery({ queryKey: ['capabilities', settings.serverUrl], queryFn: fetchCapabilities })

  const confirmSignOut = () => {
    Alert.alert('Log out?', 'This phone stops getting her messages until you sign in again. Messages still waiting to send are dropped.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => void signOut() },
    ])
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.appBar, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        <IconButton icon="arrow-left" label="Back" onPress={() => router.back()} color={colors.onSurface} />
        <AppText role="titleLarge" accessibilityRole="header">
          Settings
        </AppText>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
        <SectionHeader title="Connection" />
        <ListRow icon="server-network" title="Server address" supporting={settings.serverUrl || 'Not set'} />
        <ListRow
          icon={chat.phase === 'connected' ? 'lan-connect' : 'lan-disconnect'}
          title={PHASE_LABEL[chat.phase]}
          supporting={`Last connected: ${lastConnected(settings.lastConnectedAt)}`}
          trailing={
            chat.phase === 'unreachable' ? (
              <IconButton icon="refresh" label="Try to connect now" onPress={chat.retryNow} />
            ) : null
          }
        />
        <AppText role="bodySmall" color="onSurfaceVariant" style={styles.note}>
          To use another server, log out and sign in with its address.
        </AppText>

        <SectionHeader title="Account" />
        <ListRow icon="account-outline" title={user?.name ?? 'Signed in'} supporting={user?.email} />
        <ListRow icon="logout" title="Log out" danger onPress={confirmSignOut} />

        <SectionHeader title="Permissions" />
        {pushEnabled ? (
          <ListRow
            icon={permissions.notifications === 'granted' ? 'bell-outline' : 'bell-off-outline'}
            title="Notifications"
            supporting={
              permissions.notifications === 'granted'
                ? 'Allowed. Tap to change them in Android.'
                : permissions.notifications === 'unknown'
                  ? 'Checking…'
                  : 'Off. Tap to turn them on in Android.'
            }
            onPress={() => void openNotificationSettings()}
          />
        ) : null}
        <ListRow
          icon={permissions.microphone === 'granted' ? 'microphone-outline' : 'microphone-off'}
          title="Microphone"
          supporting={
            permissions.microphone === 'granted'
              ? 'Allowed, for voice calls with her.'
              : permissions.microphone === 'unknown'
                ? 'Checking…'
                : 'Off. Tap to allow it in Android (needed for voice calls).'
          }
          onPress={() => void openAppSettings()}
        />
        {permissions.battery ? (
          <ListRow
            icon="battery-heart-variant"
            title="Battery"
            supporting={permissions.battery === 'granted' ? 'Unrestricted' : 'Optimized: Samsung may put Jophiel to sleep'}
          />
        ) : null}
        <ListRow icon="playlist-check" title="Open Setup again" onPress={() => router.push('/setup/connection')} />

        {__DEV__ ? (
          <>
            <SectionHeader title="Developer" />
            <ListRow
              icon="tune-vertical"
              title="Voice: echo test and tuning"
              supporting="Mic meter, echo check, VAD values, echo fallbacks"
              onPress={() => router.push('/developer')}
            />
          </>
        ) : null}

        <SectionHeader title="About" />
        <ListRow
          icon="cellphone"
          title="App version"
          supporting={`${Application.nativeApplicationVersion ?? '—'} (${Application.nativeBuildVersion ?? '—'})`}
        />
        <ListRow
          icon="server"
          title="Server version"
          supporting={
            capabilities.isPending ? 'Checking…' : capabilities.data?.version ?? (capabilities.isError ? "Couldn't reach the server" : 'Not reported')
          }
        />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  appBar: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.xs, minHeight: 64 },
  note: { paddingHorizontal: space.lg, paddingBottom: space.sm },
})
