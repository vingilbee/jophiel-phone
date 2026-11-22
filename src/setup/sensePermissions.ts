import { openNotificationAccessSettings } from '@/notifications'
import {
  openAppSettings,
  requestActivityPermission,
  requestBackgroundLocationPermission,
  requestLocationPermission,
  requestNearbyPermission,
  type PermissionState,
} from './permissions'

/** Phase 6: the permissions the phone senses need, asked the same way from Setup and Settings. */
export type SensePermission = 'location' | 'backgroundLocation' | 'activity' | 'nearby' | 'notificationAccess'

/**
 * Ask for it: Android's prompt (for "Allow all the time", Android's location page). Already
 * "blocked", Android won't ask again, so the app's settings open instead.
 */
export async function askSensePermission(kind: SensePermission, current: PermissionState): Promise<PermissionState> {
  if (kind === 'notificationAccess') {
    // Android's own page; the screen reads it again when the app comes back.
    openNotificationAccessSettings()
    return current
  }
  if (current === 'blocked') {
    await openAppSettings()
    return current
  }
  switch (kind) {
    case 'location':
      return requestLocationPermission()
    case 'backgroundLocation':
      return requestBackgroundLocationPermission()
    case 'activity':
      return requestActivityPermission()
    case 'nearby':
      return requestNearbyPermission()
  }
}
