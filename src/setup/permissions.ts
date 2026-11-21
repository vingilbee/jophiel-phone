import * as Application from 'expo-application'
import * as Battery from 'expo-battery'
import * as Device from 'expo-device'
import * as IntentLauncher from 'expo-intent-launcher'
import { Linking, PermissionsAndroid, Platform } from 'react-native'

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
