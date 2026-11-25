import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { actionsAvailable, controlAvailable, openAccessibilitySettings, openDndSettings, openFullScreenIntentSettings, openOverlaySettings } from '@/actions'
import { notificationsAvailable, openNotificationAccessSettings } from '@/notifications'
import { checkHealth } from '@/api/auth'
import { AppText } from '@/components/AppText'
import { Button, Icon, type IconName } from '@/components/Controls'
import { pushEnabled } from '@/push/config'
import { registerNow } from '@/push/registration'
import {
  hasActivityPermission,
  hasBackgroundLocationPermission,
  hasFullScreenPermission,
  hasNearbyPermission,
  hasRestrictedSettings,
  openAppSettings,
  openBatterySettings,
  requestContactsPermission,
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
  'overlay',
  'full-screen',
  'restricted-settings',
  'notification-access',
  'accessibility',
  'dnd-access',
  'contacts',
  'battery',
] as const

type StepId = (typeof STEP_IDS)[number]

function isStep(value: unknown): value is StepId {
  return typeof value === 'string' && (STEP_IDS as readonly string[]).includes(value)
}

/** Android 13+ keeps both notification access and accessibility behind "Allow restricted settings". */
function restrictedStillNeeded(p: Permissions): boolean {
  return (notificationsAvailable && p.notificationAccess !== 'granted') || (controlAvailable && p.accessibility !== 'granted')
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
      case 'overlay':
        return actionsAvailable
      case 'full-screen':
        return actionsAvailable && hasFullScreenPermission
      case 'restricted-settings':
        // Only needed until notification access and accessibility are on (Android has no way to read the setting).
        return (notificationsAvailable || controlAvailable) && hasRestrictedSettings && (current === id || restrictedStillNeeded(p))
      case 'notification-access':
        return notificationsAvailable
      case 'accessibility':
        return controlAvailable
      case 'dnd-access':
        return actionsAvailable
      case 'contacts':
        return notificationsAvailable || actionsAvailable
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
      case 'overlay':
        return permissions.overlay === 'granted'
      case 'full-screen':
        return permissions.fullScreen === 'granted'
      case 'restricted-settings':
        return !restrictedStillNeeded(permissions)
      case 'notification-access':
        return permissions.notificationAccess === 'granted'
      case 'accessibility':
        return permissions.accessibility === 'granted'
      case 'dnd-access':
        return permissions.dndAccess === 'granted'
      case 'contacts':
        return permissions.contacts === 'granted'
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
    case 'overlay':
      icon = 'layers-outline'
      title = 'Opening Maps for you'
      body =
        'So she can open Google Maps navigating (and later other apps) while you’re in another app. Android calls this “Display over other apps”; the floating chibi will use it too. Tap below, turn it on for Jophiel, then come back. Without it, she sends a “Tap to start navigation” notification instead.'
      action = done ? null : { label: 'Open the setting', onPress: () => openOverlaySettings() }
      break
    case 'full-screen':
      icon = 'cellphone-screenshot'
      title = 'Navigation from your pocket'
      body =
        'So she can wake the screen and start navigation when the phone is in your pocket and no PIN is needed (for example with Smart Lock and your earphones). Android calls this “Full-screen notifications”. With a PIN, she sends a notification and asks you to unlock.'
      action = done ? null : { label: 'Open the setting', onPress: () => openFullScreenIntentSettings() }
      break
    case 'restricted-settings':
      icon = 'shield-lock-open-outline'
      title = 'Allow restricted settings'
      body =
        'Android keeps apps installed from a file (like this one) away from notification access and accessibility until you allow it. In App info, tap ⋮ (top right) → “Allow restricted settings”, confirm, then come back. If there’s no ⋮ menu yet, tap Next, try to turn on notification access once (Android refuses), then come back here: the menu shows up after that.'
      action = done ? null : { label: 'Open App info', onPress: () => void openBatterySettings() }
      break
    case 'notification-access':
      icon = 'bell-ring-outline'
      title = 'What lands on your phone'
      body =
        'So she knows the notifications you get from every app (messages, codes, reminders) and when they go away, what’s playing, and the next turn while Google Maps navigates. It’s also how she replies through a notification’s reply button, and pauses or skips music. Tap below, turn Jophiel on, then come back. You can switch it off any time in Settings → Phone senses.'
      action = done ? null : { label: 'Open notification access', onPress: () => openNotificationAccessSettings() }
      if (!done && hasRestrictedSettings) {
        problem = 'If Android says it’s a restricted setting, go back one step and allow restricted settings first.'
      }
      break
    case 'accessibility':
      icon = 'gesture-tap'
      title = 'Using your screen for you'
      body =
        'So she can do things in any app while you’re talking with her: pick a song in Spotify, open a chat and send a message, turn on the hotspot. She sees the screen (a picture and its text) and taps, types and scrolls on it, in front of you, never on her own. A banner shows while she works; touch the screen to stop her. Tap below, find Jophiel (under Installed apps on Samsung), turn it on, then come back. You can switch it off any time in Settings → Her actions → Phone control.'
      action = done ? null : { label: 'Open accessibility settings', onPress: () => openAccessibilitySettings() }
      if (!done && hasRestrictedSettings) {
        problem = 'If Android says it’s a restricted setting, go back to “Allow restricted settings” first.'
      }
      break
    case 'dnd-access':
      icon = 'minus-circle-outline'
      title = 'Silent mode and Do Not Disturb'
      body =
        'So she can put the phone on silent or turn Do Not Disturb on and off when you ask (or when it fits, like a meeting). Android calls this “Do Not Disturb access”. Tap below, allow it for Jophiel, then come back.'
      action = done ? null : { label: 'Open the setting', onPress: () => openDndSettings() }
      break
    case 'contacts':
      icon = 'account-multiple-outline'
      title = 'Who’s who'
      body =
        'So she can tell your contacts from strangers when a message comes in, and pre-type a WhatsApp message to someone by name. Numbers and the address book stay on this phone; she only learns whether a sender is one of your contacts.'
      action =
        permissions.contacts === 'blocked'
          ? { label: 'Open app settings', onPress: () => void openAppSettings() }
          : done
            ? null
            : {
                label: 'Allow contacts',
                onPress: () =>
                  void requestContactsPermission().then((result) => {
                    if (result !== 'unknown') learn('contacts', result)
                    refresh()
                  }),
              }
      if (permissions.contacts === 'blocked') {
        problem = "Android won't ask again. In the app settings, tap Permissions → Contacts and allow it."
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
