import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import {
  accessibilityPermission,
  activityPermission,
  approximateLocationOnly,
  backgroundLocationPermission,
  batteryPermission,
  contactsPermission,
  dndAccessPermission,
  fullScreenPermission,
  locationPermission,
  microphonePermission,
  nearbyPermission,
  notificationAccessPermission,
  notificationPermission,
  overlayPermission,
  showsBatteryStep,
  type PermissionState,
} from './permissions'

export interface Permissions {
  notifications: PermissionState
  microphone: PermissionState
  battery: PermissionState | null
  /** Phase 6: precise location (places, the Wi-Fi name). */
  location: PermissionState
  /** Only approximate location was allowed. */
  approximateOnly: boolean
  /** Phase 6: "Allow all the time" (arrivals with the app closed). */
  backgroundLocation: PermissionState
  /** Phase 6: physical activity (motion). */
  activity: PermissionState
  /** Phase 6: nearby devices (Bluetooth headphones with the app closed). */
  nearby: PermissionState
  /** Phase 7: "Display over other apps" (open Maps while another app is on screen). */
  overlay: PermissionState
  /** Phase 7: full-screen notifications (wake the screen to start navigation; Android 14+). */
  fullScreen: PermissionState
  /** Phase 8: "Notification access" (notifications, replies, now playing, the Maps trip). */
  notificationAccess: PermissionState
  /** Phase 8: Do Not Disturb access (silent mode, DND on / off). */
  dndAccess: PermissionState
  /** Phase 8: contacts (who's a contact, WhatsApp drafts to a named person). */
  contacts: PermissionState
  /** Phase 9: the accessibility service (phone control). */
  accessibility: PermissionState
}

type Blockable = 'notifications' | 'microphone' | 'location' | 'backgroundLocation' | 'activity' | 'nearby' | 'contacts'

const INITIAL: Permissions = {
  notifications: 'unknown',
  microphone: 'unknown',
  battery: null,
  location: 'unknown',
  approximateOnly: false,
  backgroundLocation: 'unknown',
  activity: 'unknown',
  nearby: 'unknown',
  overlay: 'unknown',
  fullScreen: 'unknown',
  notificationAccess: 'unknown',
  dndAccess: 'unknown',
  contacts: 'unknown',
  accessibility: 'unknown',
}

/**
 * Read from Android on focus and whenever the app comes back (e.g. from the system settings).
 * `learn` records an answer from a request (only a request can say "blocked").
 */
export function usePermissions(): [Permissions, () => void, (name: Blockable, state: PermissionState) => void] {
  const [state, setState] = useState<Permissions>(INITIAL)

  const refresh = useCallback(() => {
    void (async () => {
      const next: Permissions = {
        notifications: await notificationPermission(),
        microphone: await microphonePermission(),
        battery: showsBatteryStep() ? await batteryPermission() : null,
        location: await locationPermission(),
        approximateOnly: await approximateLocationOnly(),
        backgroundLocation: await backgroundLocationPermission(),
        activity: await activityPermission(),
        nearby: await nearbyPermission(),
        overlay: overlayPermission(),
        fullScreen: fullScreenPermission(),
        notificationAccess: notificationAccessPermission(),
        dndAccess: dndAccessPermission(),
        contacts: await contactsPermission(),
        accessibility: accessibilityPermission(),
      }
      // Android only says "blocked" when asked; a later check reads "denied". Keep what we learned.
      setState((prev) => {
        const keep = (name: Blockable) => (prev[name] === 'blocked' && next[name] === 'denied' ? 'blocked' : next[name])
        return {
          ...next,
          notifications: keep('notifications'),
          microphone: keep('microphone'),
          location: keep('location'),
          backgroundLocation: keep('backgroundLocation'),
          activity: keep('activity'),
          nearby: keep('nearby'),
          contacts: keep('contacts'),
        }
      })
    })()
  }, [])

  const learn = useCallback((name: Blockable, answer: PermissionState) => {
    setState((prev) => ({ ...prev, [name]: answer }))
  }, [])

  useFocusEffect(refresh)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh()
    })
    return () => sub.remove()
  }, [refresh])

  return [state, refresh, learn]
}
