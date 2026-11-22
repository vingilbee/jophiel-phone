import { useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/components/AppText'
import { Button, Icon, IconButton, ListRow, SwitchRow } from '@/components/Controls'
import { notificationsStatus } from '@/notifications'
import { agoLabel, describeGroup, type LastReported } from '@/senses/describe'
import { SENSE_GROUPS, type SenseGroup } from '@/senses/groups'
import { lastReported, sensesAvailable } from '@/senses/native'
import type { PermissionState } from '@/setup/permissions'
import { askSensePermission, type SensePermission } from '@/setup/sensePermissions'
import { usePermissions, type Permissions } from '@/setup/usePermissions'
import { updateSettings, useSettings } from '@/settings/store'
import { radius, space, useColors } from '@/theme'

const GROUP_TEXT: Record<SenseGroup, { title: string; what: string }> = {
  phoneUse: { title: 'Phone use', what: 'Screen on or off, locked or unlocked' },
  battery: { title: 'Battery', what: 'Battery level, and whether it’s charging' },
  headphones: { title: 'Headphones', what: 'Wired or Bluetooth headphones connected' },
  network: { title: 'Network', what: 'Wi-Fi and its name, or mobile data' },
  soundMode: { title: 'Sound mode', what: 'Ringer, vibrate or silent, and Do Not Disturb' },
  motion: { title: 'Motion', what: 'Still, walking, running, cycling or in a vehicle' },
  places: { title: 'Places', what: 'Arriving at and leaving your saved places, by name' },
  notifications: {
    title: 'Notifications',
    what: 'Notifications from every app and when they go away, what’s playing, and the next turn while Google Maps navigates',
  },
}

interface Need {
  permission: SensePermission
  state: PermissionState
  text: string
}

/** What a group is missing, or null. "unknown" (still reading) shows nothing rather than flicker. */
function needFor(group: SenseGroup, p: Permissions): Need | null {
  const missing = (state: PermissionState) => state === 'denied' || state === 'blocked'
  switch (group) {
    case 'headphones':
      return missing(p.nearby)
        ? { permission: 'nearby', state: p.nearby, text: 'Needs permission: Nearby devices. Without it she only notices Bluetooth headphones while the app is open.' }
        : null
    case 'network':
      return missing(p.location)
        ? { permission: 'location', state: p.location, text: 'Needs permission: precise location, for the Wi-Fi name. Wi-Fi or mobile data works without it.' }
        : null
    case 'motion':
      return missing(p.activity) ? { permission: 'activity', state: p.activity, text: 'Needs permission: Physical activity.' } : null
    case 'places':
      if (missing(p.location)) {
        return {
          permission: 'location',
          state: p.location,
          text: p.approximateOnly ? 'Needs permission: precise location (approximate is allowed now).' : 'Needs permission: precise location.',
        }
      }
      return missing(p.backgroundLocation)
        ? {
            permission: 'backgroundLocation',
            state: p.backgroundLocation,
            text: 'Only when you open the app. For arrivals and departures with the app closed, set location to “Allow all the time”.',
          }
        : null
    case 'notifications':
      return p.notificationAccess === 'denied'
        ? {
            permission: 'notificationAccess',
            state: p.notificationAccess,
            text: 'Needs Notification access (Android 13+: allow restricted settings in App info first).',
          }
        : null
    default:
      return null
  }
}

/** The notifications themselves: how many she knows of, and when the last ones went out. */
function notificationsLine(now: number): string | null {
  const status = notificationsStatus()
  if (!status || !status.access) return null
  if (!status.connected) return 'Android hasn’t started the listener yet'
  const count = status.known === 1 ? '1 notification' : `${status.known} notifications`
  return status.lastSentAt > 0 ? `${count} on the phone · last sent ${agoLabel(status.lastSentAt, now)}` : count
}

export default function Senses() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const settings = useSettings()
  const [permissions, refresh, learn] = usePermissions()
  const [last, setLast] = useState<LastReported>({})
  const [now, setNow] = useState(() => Date.now())

  // What she was told, read again every few seconds while this screen is open.
  useFocusEffect(
    useCallback(() => {
      const read = () => {
        setLast(lastReported())
        setNow(Date.now())
      }
      read()
      const timer = setInterval(read, 5_000)
      return () => clearInterval(timer)
    }, []),
  )

  const toggle = (group: SenseGroup, on: boolean) => {
    updateSettings({ senses: { ...settings.senses, [group]: on } })
  }

  const ask = async (need: Need) => {
    const result = await askSensePermission(need.permission, need.state)
    if (result !== 'unknown' && need.permission !== 'notificationAccess') learn(need.permission, result)
    refresh()
  }

  const placeCount = settings.places.length

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.appBar, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        <IconButton icon="arrow-left" label="Back" onPress={() => router.back()} color={colors.onSurface} />
        <AppText role="titleLarge" accessibilityRole="header">
          Phone senses
        </AppText>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
        <AppText role="bodyMedium" color="onSurfaceVariant" style={styles.intro}>
          What this phone tells her about itself, so she can notice and react. She gets them while the app is open or a call is
          on. With the app closed, only places, motion, Bluetooth headphones and notifications still reach her.
        </AppText>

        {!sensesAvailable ? (
          <View style={[styles.panel, { backgroundColor: colors.warnContainer }]}>
            <AppText role="bodyMedium" style={{ color: colors.onWarnContainer }}>
              This build of the app has no phone senses yet. Rebuild it to turn them on.
            </AppText>
          </View>
        ) : null}

        {SENSE_GROUPS.map((group) => {
          const on = settings.senses[group]
          const need = on ? needFor(group, permissions) : null
          const state = describeGroup(group, last, now)
          const told = group === 'notifications' ? [notificationsLine(now), state].filter(Boolean).join('; ') || null : state
          return (
            <View key={group} style={[styles.group, { borderBottomColor: colors.outlineVariant }]}>
              <SwitchRow title={GROUP_TEXT[group].title} supporting={GROUP_TEXT[group].what} value={on} onValueChange={(value) => toggle(group, value)} />
              <AppText role="bodySmall" color="onSurfaceVariant" style={styles.told} accessibilityLiveRegion="polite">
                {on ? (told ? `She knows: ${told}` : 'Nothing sent yet') : 'Off: she doesn’t get this'}
              </AppText>
              {need ? (
                <View style={[styles.panel, { backgroundColor: colors.warnContainer }]}>
                  <AppText role="bodyMedium" style={{ color: colors.onWarnContainer }}>
                    {need.text}
                  </AppText>
                  <Button
                    label={
                      need.permission === 'notificationAccess'
                        ? 'Open notification access'
                        : need.state === 'blocked'
                          ? 'Open app settings'
                          : need.permission === 'backgroundLocation'
                            ? 'Open location settings'
                            : 'Allow'
                    }
                    variant="tonal"
                    onPress={() => void ask(need)}
                    style={styles.panelButton}
                  />
                </View>
              ) : null}
              {group === 'places' ? (
                <ListRow
                  icon="map-marker-outline"
                  title="Saved places"
                  supporting={placeCount === 0 ? 'None yet. Add one where you are.' : placeCount === 1 ? '1 place' : `${placeCount} places`}
                  onPress={() => router.push('/places')}
                  trailing={<Icon name="chevron-right" color={colors.onSurfaceVariant} />}
                />
              ) : null}
            </View>
          )
        })}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  appBar: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.xs, minHeight: 64 },
  intro: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm },
  group: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: space.sm },
  told: { paddingHorizontal: space.lg, marginTop: -space.xs },
  panel: { borderRadius: radius.field, padding: space.lg, marginHorizontal: space.lg, marginTop: space.sm, gap: space.md },
  panelButton: { alignSelf: 'flex-start' },
})
