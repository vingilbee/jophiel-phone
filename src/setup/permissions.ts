import * as Application from 'expo-application'
import * as Battery from 'expo-battery'
import * as Device from 'expo-device'
import * as IntentLauncher from 'expo-intent-launcher'
import { Linking, PermissionsAndroid, Platform } from 'react-native'
import { canDrawOverlays, canUseFullScreenIntent, hasDndAccess } from '@/actions'
import { notificationAccess } from '@/notifications'

/** Every state here is read from Android each time, never remembered. */
export type PermissionState = 'granted' | 'denied' | 'blocked' | 'unknown'

const needsRuntimeNotificationPermission = Platform.OS === 'android' && Number(Platform.Version) >= 33

export async function notificationPermission(): Promise<PermissionState> {
  if (!needsRuntimeNotificationPermission) return 'granted'
  try {
    const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
    return granted ? 'granted' : 'denied'
  } catch {
    return 'unknown'
  }
}

/** Shows Android's prompt. "blocked" means Android won't ask again: fix it in the app's settings. */
export async function requestNotificationPermission(): Promise<PermissionState> {
  if (!needsRuntimeNotificationPermission) return 'granted'
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)
  if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted'
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked'
  return 'denied'
}

/** The microphone, for voice calls with her. */
export async function microphonePermission(): Promise<PermissionState> {
  try {
    return (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) ? 'granted' : 'denied'
  } catch {
    return 'unknown'
  }
}

/** Shows Android's prompt. "blocked" means Android won't ask again: fix it in the app's settings. */
export async function requestMicrophonePermission(): Promise<PermissionState> {
  try {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)
    if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted'
    if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked'
    return 'denied'
  } catch {
    return 'unknown'
  }
}

export function openAppSettings() {
  return Linking.openSettings()
}

/** Android's notification settings for Jophiel: on/off, sound, lock-screen privacy. */
export async function openNotificationSettings() {
  try {
    await IntentLauncher.startActivityAsync('android.settings.APP_NOTIFICATION_SETTINGS', {
      extra: { 'android.provider.extra.APP_PACKAGE': Application.applicationId ?? 'com.jophiel.app' },
    })
  } catch {
    await Linking.openSettings()
  }
}

/** The battery step only matters on Samsung phones (One UI puts apps to sleep); hidden elsewhere. */
export function showsBatteryStep(): boolean {
  return Platform.OS === 'android' && Device.isDevice && (Device.manufacturer ?? '').toLowerCase() === 'samsung'
}

/** "granted" = Android isn't optimizing Jophiel's battery use ("Unrestricted"). */
export async function batteryPermission(): Promise<PermissionState> {
  try {
    return (await Battery.isBatteryOptimizationEnabledAsync()) ? 'denied' : 'granted'
  } catch {
    return 'unknown'
  }
}

/** Opens Jophiel's App info page, where Battery → Unrestricted lives on Samsung. */
export async function openBatterySettings() {
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS, {
      data: `package:${Application.applicationId ?? 'com.jophiel.app'}`,
    })
  } catch {
    await Linking.openSettings()
  }
}

// ---- Phase 6: phone senses ----

const sdk = Platform.OS === 'android' ? Number(Platform.Version) : 0
/** "Allow all the time" is its own permission from Android 10. */
export const hasBackgroundLocationPermission = sdk >= 29
/** Physical activity is a runtime permission from Android 10. */
export const hasActivityPermission = sdk >= 29
/** Nearby devices (Bluetooth connect) is a runtime permission from Android 12. */
export const hasNearbyPermission = sdk >= 31

const P = PermissionsAndroid.PERMISSIONS

async function check(permission: (typeof P)[keyof typeof P]): Promise<PermissionState> {
  try {
    return (await PermissionsAndroid.check(permission)) ? 'granted' : 'denied'
  } catch {
    return 'unknown'
  }
}

function answer(result: string | undefined): PermissionState {
  if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted'
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked'
  return 'denied'
}

/** Precise location ("granted"); approximate alone reads "denied" (see `approximateLocationOnly`). */
export function locationPermission(): Promise<PermissionState> {
  return check(P.ACCESS_FINE_LOCATION)
}

/** The user chose "Approximate" in Android's prompt: places and the Wi-Fi name need precise. */
export async function approximateLocationOnly(): Promise<boolean> {
  return (await check(P.ACCESS_COARSE_LOCATION)) === 'granted' && (await check(P.ACCESS_FINE_LOCATION)) !== 'granted'
}

/**
 * Shows Android's prompt for precise location (Android 12+ asks for both at once; asking again
 * after "Approximate" offers the upgrade to precise).
 */
export async function requestLocationPermission(): Promise<PermissionState> {
  try {
    const result = await PermissionsAndroid.requestMultiple([P.ACCESS_FINE_LOCATION, P.ACCESS_COARSE_LOCATION])
    return answer(result[P.ACCESS_FINE_LOCATION])
  } catch {
    return 'unknown'
  }
}

/** "Allow all the time": closed-app arrivals and departures. Needs precise location first. */
export async function backgroundLocationPermission(): Promise<PermissionState> {
  if (!hasBackgroundLocationPermission) return locationPermission()
  if ((await locationPermission()) !== 'granted') return 'denied'
  return check(P.ACCESS_BACKGROUND_LOCATION)
}

/**
 * Android 11+ can't grant "Allow all the time" from a prompt: asking opens Jophiel's location page
 * in Android's settings, where the owner picks it (Android 10 shows a prompt). "blocked": Android
 * won't open it again; the app's settings still can.
 */
export async function requestBackgroundLocationPermission(): Promise<PermissionState> {
  if (!hasBackgroundLocationPermission) return locationPermission()
  try {
    return answer(await PermissionsAndroid.request(P.ACCESS_BACKGROUND_LOCATION))
  } catch {
    return 'unknown'
  }
}

/** Physical activity, for motion (walking, in a vehicle…). */
export async function activityPermission(): Promise<PermissionState> {
  return hasActivityPermission ? check(P.ACTIVITY_RECOGNITION) : 'granted'
}

export async function requestActivityPermission(): Promise<PermissionState> {
  if (!hasActivityPermission) return 'granted'
  try {
    return answer(await PermissionsAndroid.request(P.ACTIVITY_RECOGNITION))
  } catch {
    return 'unknown'
  }
}

/** Nearby devices, to notice Bluetooth headphones connecting with the app closed. */
export async function nearbyPermission(): Promise<PermissionState> {
  return hasNearbyPermission ? check(P.BLUETOOTH_CONNECT) : 'granted'
}

export async function requestNearbyPermission(): Promise<PermissionState> {
  if (!hasNearbyPermission) return 'granted'
  try {
    return answer(await PermissionsAndroid.request(P.BLUETOOTH_CONNECT))
  } catch {
    return 'unknown'
  }
}

// ---- Phase 7: her actions ----

/** Full-screen notifications are their own permission from Android 14 (granted below). */
export const hasFullScreenPermission = sdk >= 34

/** "Display over other apps": she can open Maps while another app is on screen. */
export function overlayPermission(): PermissionState {
  const allowed = canDrawOverlays()
  return allowed === null ? 'unknown' : allowed ? 'granted' : 'denied'
}

/** Full-screen notifications: she can wake the screen to start navigation (Android 14+). */
export function fullScreenPermission(): PermissionState {
  if (!hasFullScreenPermission) return 'granted'
  const allowed = canUseFullScreenIntent()
  return allowed === null ? 'unknown' : allowed ? 'granted' : 'denied'
}

// ---- Phase 8: notifications as a sense, and more actions ----

/**
 * Android 13+ blocks notification access (and later accessibility) for an app installed from an
 * APK until "Allow restricted settings" is on in its App info. Android doesn't say whether it is,
 * so the step counts as done once notification access is on.
 */
export const hasRestrictedSettings = sdk >= 33

/** "Notification access": notifications, replies, now playing, media control, the Maps trip. */
export function notificationAccessPermission(): PermissionState {
  const allowed = notificationAccess()
  return allowed === null ? 'unknown' : allowed ? 'granted' : 'denied'
}

/** Do Not Disturb access: silent mode and DND on / off. */
export function dndAccessPermission(): PermissionState {
  const allowed = hasDndAccess()
  return allowed === null ? 'unknown' : allowed ? 'granted' : 'denied'
}

/** Contacts: who's a contact (never the number), WhatsApp drafts to a named person. */
export function contactsPermission(): Promise<PermissionState> {
  return check(P.READ_CONTACTS)
}

export async function requestContactsPermission(): Promise<PermissionState> {
  try {
    return answer(await PermissionsAndroid.request(P.READ_CONTACTS))
  } catch {
    return 'unknown'
  }
}
