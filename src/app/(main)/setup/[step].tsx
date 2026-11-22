import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { checkHealth } from '@/api/auth'
import { AppText } from '@/components/AppText'
import { Button, Icon, type IconName } from '@/components/Controls'
import { pushEnabled } from '@/push/config'
import { registerNow } from '@/push/registration'
import {
  hasActivityPermission,
  hasBackgroundLocationPermission,
  hasNearbyPermission,
  openAppSettings,
  openBatterySettings,
  requestMicrophonePermission,
  requestNotificationPermission,
  showsBatteryStep,
} from '@/setup/permissions'
import { askSensePermission } from '@/setup/sensePermissions'
import { usePermissions, type Permissions } from '@/setup/usePermissions'
import { getSettings, updateSettings } from '@/settings/store'
import { radius, space, useColors } from '@/theme'

const STEP_IDS = [
  'connection',
  'notifications',
  'microphone',
  'location',
  'location-always',
  'activity',
  'nearby',
  'battery',
] as const

type StepId = (typeof STEP_IDS)[number]

function isStep(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value)
}

/**
 * The steps this phone shows. "Allow all the time" only follows a granted location (Android can't
 * grant it without); the step on screen always counts, so its number never jumps away.
 */
function steps(p: Permissions, current: StepId): StepId[] {
  const shown = (id: StepId): boolean => {
    switch (id) {
      case 'notifications':
        return pushEnabled
      case 'location-always':
        return hasBackgroundLocationPermission && (current === id || (p.location !== 'denied' && p.location !== 'blocked'))
      case 'activity':
        return hasActivityPermission
      case 'nearby':
        return hasNearbyPermission
      case 'battery':
        return showsBatteryStep()
      default:
        return true
    }
  }
  return STEP_IDS.filter((id) => id === current || shown(id))
}

type Check = 'idle' | 'checking' | 'ok' | 'failed'

export default function SetupStep() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { step } = useLocalSearchParams<{ step: string }>()
  const current: StepId = isStep(step) ? step : 'connection'
  const [permissions, refresh, learn] = usePermissions()
  const all = steps(permissions, current)
  const index = Math.max(0, all.indexOf(current))
  const [check, setCheck] = useState<Check>('idle')
  // Android only says "won't ask again" in answer to a request; a later check reads plain "denied".
  const [micBlocked, setMicBlocked] = useState(false)
  const microphone = micBlocked && permissions.microphone !== 'granted' ? 'blocked' : permissions.microphone

  // Opening Setup once is enough for it to stop opening by itself.
  useEffect(() => {
    if (!getSettings().setupSeen) updateSettings({ setupSeen: true })
  }, [])

  const runCheck = useCallback(async () => {
    setCheck('checking')
    try {
      const health = await checkHealth(getSettings().serverUrl)
      setCheck(health?.status === 'ok' ? 'ok' : 'failed')
    } catch {
      setCheck('failed')
    }
  }, [])

  useEffect(() => {
    if (current === 'connection') void runCheck()
  }, [current, runCheck])

  const next = () => {
    const following = all[index + 1]
    if (following) router.replace(`/setup/${following}`)
    else if (router.canGoBack()) router.back()
    else router.replace('/')
  }

  const done = (() => {
    switch (current) {
      case 'connection':
        return check === 'ok'
      case 'notifications':
        return permissions.notifications === 'granted'
      case 'microphone':
        return microphone === 'granted'
      case 'location':
        return permissions.location === 'granted'
      case 'location-always':
        return permissions.backgroundLocation === 'granted'
      case 'activity':
        return permissions.activity === 'granted'
      case 'nearby':
        return permissions.nearby === 'granted'
      case 'battery':
        return permissions.battery === 'granted'
    }
  })()

  let icon: IconName
  let title: string
  let body: string
  let action: { label: string; onPress: () => void; loading?: boolean } | null
  let problem: string | null = null

  switch (current) {
    case 'connection':
      icon = 'lan-connect'
      title = 'Reaching your Mac'
      body = `Jophiel lives on your Mac. This phone talks to her at ${getSettings().serverUrl || 'the address you signed in with'}.`
      action = check === 'ok' ? null : { label: 'Check again', onPress: () => void runCheck(), loading: check === 'checking' }
      if (check === 'failed') {
        problem = "Can't reach it right now. Is the Mac on and awake? On your phone, is Tailscale connected? You can carry on; the app keeps trying by itself."
      }
      break
    case 'notifications':
      icon = 'bell-outline'
      title = 'Her messages, when you are away'
      body = "When she says something you haven't seen on the web app or here, your phone shows a notification. You can change or turn them off any time in Android's notification settings."
      action =
        permissions.notifications === 'blocked'
          ? { label: 'Open app settings', onPress: () => void openAppSettings() }
          : done
            ? null
            : {
                label: 'Allow notifications',
                onPress: () =>
                  void requestNotificationPermission().then((result) => {
                    refresh()
                    if (result === 'granted') void registerNow()
                  }),
              }
      if (permissions.notifications === 'blocked') {
        problem = 'Android won\'t ask again. In the app settings, tap Notifications and turn them on.'
      }
      break
    case 'microphone':
      icon = 'microphone-outline'
      title = 'Talking with her'
      body =
        'For voice calls: tap the phone button in the chat, talk, and she answers aloud. The microphone is only on during a call, never by itself.'
      action =
        microphone === 'blocked'
          ? { label: 'Open app settings', onPress: () => void openAppSettings() }
          : done
            ? null
            : {
                label: 'Allow the microphone',
                onPress: () =>
                  void requestMicrophonePermission().then((result) => {
                    setMicBlocked(result === 'blocked')
                    refresh()
                  }),
              }
      if (microphone === 'blocked') {
        problem = "Android won't ask again. In the app settings, tap Permissions → Microphone and allow it."
      }
      break
    case 'location':
      icon = 'map-marker-outline'
      title = 'Where you are, by name'
      body =
        'So she knows when you get home or leave work. You save places (Settings → Phone senses → Places), and she\'s only told their names when you arrive or leave, never your position. It also tells her the Wi-Fi name. In Android\'s prompt, keep “Precise” on.'
      action =
        permissions.location === 'blocked'
          ? { label: 'Open app settings', onPress: () => void openAppSettings() }
          : done
            ? null
            : {
                label: permissions.approximateOnly ? 'Allow precise location' : 'Allow location',
                onPress: () =>
                  void askSensePermission('location', permissions.location).then((result) => {
                    if (result !== 'unknown') learn('location', result)
                    refresh()
                  }),
              }
      if (permissions.location === 'blocked') {
        problem = "Android won't ask again. In the app settings, tap Permissions → Location, allow it and turn on “Use precise location”."
      } else if (!done && permissions.approximateOnly) {
        problem = 'Only approximate location is allowed. Places need precise: tap “Allow precise location”.'
      }
      break
    case 'location-always':
      icon = 'map-marker-radius-outline'
      title = 'Arrivals with the app closed'
      body =
        'For her to hear “Arrived at home” while the app is closed, Android needs location set to “Allow all the time”. Android only offers that on its own page: tap below, choose “Allow all the time”, then come back. Without it, she learns where you are each time you open the app.'
      action =
        permissions.backgroundLocation === 'blocked'
          ? { label: 'Open app settings', onPress: () => void openAppSettings() }
          : done
            ? null
            : {
                label: 'Open location settings',
                onPress: () =>
                  void askSensePermission('backgroundLocation', permissions.backgroundLocation).then((result) => {
                    if (result !== 'unknown') learn('backgroundLocation', result)
                    refresh()
                  }),
              }
      if (permissions.backgroundLocation === 'blocked') {
        problem = "Android won't open it from here again. In the app settings, tap Permissions → Location → Allow all the time."
      }
      break
    case 'activity':
      icon = 'walk'
      title = 'Walking, driving, still'
      body =
        'So she knows whether you\'re still, walking, running, cycling or in a vehicle. Android works it out from the phone\'s motion sensors, and it keeps working with the app closed.'
      action =
        permissions.activity === 'blocked'
          ? { label: 'Open app settings', onPress: () => void openAppSettings() }
          : done
            ? null
            : {
                label: 'Allow physical activity',
                onPress: () =>
                  void askSensePermission('activity', permissions.activity).then((result) => {
                    if (result !== 'unknown') learn('activity', result)
                    refresh()
                  }),
              }
      if (permissions.activity === 'blocked') {
        problem = "Android won't ask again. In the app settings, tap Permissions → Physical activity and allow it."
      }
      break
    case 'nearby':
      icon = 'headphones'
      title = 'Your headphones'
      body =
        'So she notices when you put AirPods or other Bluetooth headphones on, even with the app closed. Android calls this “Nearby devices”; Jophiel only uses it to see headphones connect and disconnect.'
      action =
        permissions.nearby === 'blocked'
          ? { label: 'Open app settings', onPress: () => void openAppSettings() }
          : done
            ? null
            : {
                label: 'Allow nearby devices',
                onPress: () =>
                  void askSensePermission('nearby', permissions.nearby).then((result) => {
                    if (result !== 'unknown') learn('nearby', result)
                    refresh()
                  }),
              }
      if (permissions.nearby === 'blocked') {
        problem = "Android won't ask again. In the app settings, tap Permissions → Nearby devices and allow it."
      }
      break
    case 'battery':
      icon = 'battery-heart-variant'
      title = 'Keep her awake'
      body =
        'Samsung puts apps to sleep to save battery, and sleeping apps get notifications late. In App info, tap Battery and choose Unrestricted. Also make sure Jophiel is not in "Sleeping apps" or "Deep sleeping apps" (Settings → Battery → Background usage limits).'
      action = done ? null : { label: 'Open battery settings', onPress: () => void openBatterySettings() }
      break
  }

  const last = index === all.length - 1

  return (
    <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <AppText role="labelLarge" color="onSurfaceVariant">
          Setup · {index + 1} of {all.length}
        </AppText>
        <View style={[styles.iconDisc, { backgroundColor: colors.primaryContainer }]}>
          <Icon name={icon} size={32} color={colors.primary} />
        </View>
        <AppText role="headlineSmall" accessibilityRole="header">
          {title}
        </AppText>
        <AppText role="bodyLarge" color="onSurfaceVariant">
          {body}
        </AppText>

        {done ? (
          <View style={styles.done} accessibilityLiveRegion="polite">
            <Icon name="check-circle" size={20} color={colors.primary} />
            <AppText role="titleSmall" color="primary">
              Done
            </AppText>
          </View>
        ) : null}

        {problem ? (
          <View style={[styles.problem, { backgroundColor: colors.warnContainer }]} accessibilityLiveRegion="polite">
            <AppText role="bodyMedium" style={{ color: colors.onWarnContainer }}>
              {problem}
            </AppText>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Button label={done ? (last ? 'Finish' : 'Next') : 'Skip'} variant={done ? 'filled' : 'text'} onPress={next} />
        {action ? <Button label={action.label} onPress={action.onPress} loading={action.loading} variant="filled" /> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, padding: space.xl, paddingTop: space.xxl, gap: space.lg },
  iconDisc: { width: 64, height: 64, borderRadius: radius.card, alignItems: 'center', justifyContent: 'center', marginTop: space.lg },
  done: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  problem: { borderRadius: radius.field, padding: space.lg },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
    gap: space.md,
  },
})
