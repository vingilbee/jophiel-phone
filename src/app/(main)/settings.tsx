import { useQuery } from '@tanstack/react-query'
import * as Application from 'expo-application'
import { useRouter } from 'expo-router'
import { Alert, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { actionsAvailable, controlAvailable, openAccessibilitySettings, openDndSettings, openFullScreenIntentSettings, openOverlaySettings } from '@/actions'
import { ACTION_GROUPS, type ActionGroup } from '@/actions/groups'
import { notificationsAvailable, openNotificationAccessSettings } from '@/notifications'
import { fetchCapabilities } from '@/api/auth'
import { useSession } from '@/auth/session'
import { useChat } from '@/chat/ChatProvider'
import { dayLabel, timeLabel } from '@/chat/format'
import { AppText } from '@/components/AppText'
import { IconButton, ListRow, SectionHeader, SwitchRow } from '@/components/Controls'
import type { ConnectionPhase } from '@/connection/state'
import { pushEnabled } from '@/push/config'
import { SENSE_GROUPS } from '@/senses/groups'
import {
  hasActivityPermission,
  hasBackgroundLocationPermission,
  hasFullScreenPermission,
  hasNearbyPermission,
  openAppSettings,
  openNotificationSettings,
} from '@/setup/permissions'
import { usePermissions, type Permissions } from '@/setup/usePermissions'
import { updateSettings, useSettings } from '@/settings/store'
import { space, useColors } from '@/theme'

/** Settings → Her actions: one switch per group under the master switch (phase 8). */
const ACTION_GROUP_TEXT: Record<ActionGroup, { title: string; on: string; off: string }> = {
  media: { title: 'Media', on: 'Play, pause, skip, and media volume.', off: 'Off: she can’t control music or volume.' },
  messages: {
    title: 'Messages',
    on: 'Replies through a notification’s reply button, and WhatsApp drafts you send yourself.',
    off: 'Paused: no replies or drafts, even ones you ask for. She’s told they’re paused.',
  },
  alarms: { title: 'Alarms & timers', on: 'Sets them in the clock app (she can’t see or delete them afterwards).', off: 'Off: she can’t set alarms or timers.' },
  opening: { title: 'Opening apps', on: 'Any app or link, and Spotify by song name, only while she’s talking with you.', off: 'Off: she can’t open apps, links or Spotify.' },
  control: {
    title: 'Phone control',
    on: 'She sees your screen and taps, types and scrolls, only while she’s talking with you. A banner shows while she works; touch the screen to stop her.',
    off: 'Off: she can’t see or use your screen.',
  },
}

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

/** Settings → Permissions → Location, in words. */
function locationText(p: Permissions): string {
  if (p.location === 'unknown') return 'Checking…'
  if (p.location !== 'granted') {
    return p.approximateOnly
      ? 'Approximate only. Tap to allow precise location (places, Wi-Fi name).'
      : 'Off. Tap to allow it in Android (places, Wi-Fi name).'
  }
  if (!hasBackgroundLocationPermission || p.backgroundLocation === 'granted') return 'Precise, all the time: arrivals and departures with the app closed.'
  return 'Precise, only while using the app: places update when you open it. Tap to allow all the time.'
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

        <SectionHeader title="Voice" />
        <SwitchRow
          title="Keep listening in the background"
          supporting={
            settings.keepListeningInBackground
              ? 'A call keeps going when you leave the app or lock the screen. It ends after 30 min without you speaking.'
              : 'Leaving the app ends the call; her reply finishes as text.'
          }
          value={settings.keepListeningInBackground}
          onValueChange={(keepListeningInBackground) => updateSettings({ keepListeningInBackground })}
        />

        <SectionHeader title="Her senses" />
        <ListRow
          icon="cellphone-information"
          title="Phone senses"
          supporting={(() => {
            const on = SENSE_GROUPS.filter((group) => settings.senses[group]).length
            return on === SENSE_GROUPS.length
              ? 'All on: phone use, battery, headphones, network, sound, motion, places, notifications'
              : `${on} of ${SENSE_GROUPS.length} on`
          })()}
          onPress={() => router.push('/senses')}
        />

        <SectionHeader title="Her actions" />
        <SwitchRow
          title="Let Jophiel act on this phone"
          supporting={
            settings.actionsEnabled
              ? 'Navigation, your position for one lookup, silent mode and Do Not Disturb, dismissing a notification, and the groups below. Each action leaves a line in the chat.'
              : 'Off: she can’t do anything on this phone. She’ll say so if she tries.'
          }
          value={settings.actionsEnabled}
          onValueChange={(actionsEnabled) => updateSettings({ actionsEnabled })}
        />
        {ACTION_GROUPS.map((group) => {
          const on = settings.actionGroups[group]
          return (
            <SwitchRow
              key={group}
              title={ACTION_GROUP_TEXT[group].title}
              supporting={on ? ACTION_GROUP_TEXT[group].on : ACTION_GROUP_TEXT[group].off}
              value={on}
              disabled={!settings.actionsEnabled}
              onValueChange={(value) => updateSettings({ actionGroups: { ...settings.actionGroups, [group]: value } })}
            />
          )
        })}

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
        <ListRow
          icon={permissions.location === 'granted' ? 'map-marker-outline' : 'map-marker-off-outline'}
          title="Location"
          supporting={locationText(permissions)}
          onPress={() => void openAppSettings()}
        />
        {hasActivityPermission ? (
          <ListRow
            icon="walk"
            title="Physical activity"
            supporting={
              permissions.activity === 'granted'
                ? 'Allowed, for motion (walking, in a vehicle…).'
                : permissions.activity === 'unknown'
                  ? 'Checking…'
                  : 'Off. Tap to allow it in Android (needed for motion).'
            }
            onPress={() => void openAppSettings()}
          />
        ) : null}
        {hasNearbyPermission ? (
          <ListRow
            icon={permissions.nearby === 'granted' ? 'bluetooth' : 'bluetooth-off'}
            title="Nearby devices"
            supporting={
              permissions.nearby === 'granted'
                ? 'Allowed, to notice Bluetooth headphones with the app closed.'
                : permissions.nearby === 'unknown'
                  ? 'Checking…'
                  : 'Off. Tap to allow it in Android (Bluetooth headphones with the app closed).'
            }
            onPress={() => void openAppSettings()}
          />
        ) : null}
        {actionsAvailable ? (
          <ListRow
            icon="layers-outline"
            title="Display over other apps"
            supporting={
              permissions.overlay === 'granted'
                ? 'Allowed: she can open Maps while you’re in another app.'
                : permissions.overlay === 'unknown'
                  ? 'Checking…'
                  : 'Off. Tap to allow it (otherwise she sends a “Tap to start navigation” notification).'
            }
            onPress={() => openOverlaySettings()}
          />
        ) : null}
        {actionsAvailable && hasFullScreenPermission ? (
          <ListRow
            icon="cellphone-screenshot"
            title="Full-screen notifications"
            supporting={
              permissions.fullScreen === 'granted'
                ? 'Allowed: she can wake the screen to start navigation from your pocket.'
                : permissions.fullScreen === 'unknown'
                  ? 'Checking…'
                  : 'Off. Tap to allow it (navigation from your pocket).'
            }
            onPress={() => openFullScreenIntentSettings()}
          />
        ) : null}
        {notificationsAvailable ? (
          <ListRow
            icon={permissions.notificationAccess === 'granted' ? 'bell-ring-outline' : 'bell-off-outline'}
            title="Notification access"
            supporting={
              permissions.notificationAccess === 'granted'
                ? 'Allowed: notifications, replies, now playing, the Maps trip.'
                : permissions.notificationAccess === 'unknown'
                  ? 'Checking…'
                  : 'Off. Tap to allow it (Android 13+: allow restricted settings in App info first).'
            }
            onPress={() => openNotificationAccessSettings()}
          />
        ) : null}
        {controlAvailable ? (
          <ListRow
            icon="gesture-tap"
            title="Accessibility"
            supporting={
              permissions.accessibility === 'granted'
                ? 'On: phone control works (while she’s talking with you).'
                : permissions.accessibility === 'unknown'
                  ? 'Checking…'
                  : 'Off. Tap to turn Jophiel on (Android 13+: allow restricted settings in App info first). Samsung turns it off after a crash or reinstall.'
            }
            onPress={() => openAccessibilitySettings()}
          />
        ) : null}
        {actionsAvailable ? (
          <ListRow
            icon="minus-circle-outline"
            title="Do Not Disturb access"
            supporting={
              permissions.dndAccess === 'granted'
                ? 'Allowed: she can switch silent mode and Do Not Disturb.'
                : permissions.dndAccess === 'unknown'
                  ? 'Checking…'
                  : 'Off. Tap to allow it (silent mode, Do Not Disturb).'
            }
            onPress={() => openDndSettings()}
          />
        ) : null}
        <ListRow
          icon={permissions.contacts === 'granted' ? 'account-multiple-outline' : 'account-off-outline'}
          title="Contacts"
          supporting={
            permissions.contacts === 'granted'
              ? 'Allowed: who’s a contact (never the number), WhatsApp drafts by name.'
              : permissions.contacts === 'unknown'
                ? 'Checking…'
                : 'Off. Tap to allow it in Android (contacts vs strangers, drafts by name).'
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
              title="Voice tuning and phone actions"
              supporting="Mic meter, echo check, VAD values, echo fallbacks, phone action tests"
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
