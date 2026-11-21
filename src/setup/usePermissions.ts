import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { batteryPermission, microphonePermission, notificationPermission, showsBatteryStep, type PermissionState } from './permissions'

export interface Permissions {
  notifications: PermissionState
  microphone: PermissionState
  battery: PermissionState | null
}

/** Read from Android on focus and whenever the app comes back (e.g. from the system settings). */
export function usePermissions(): [Permissions, () => void] {
  const [state, setState] = useState<Permissions>({ notifications: 'unknown', microphone: 'unknown', battery: null })

  const refresh = useCallback(() => {
    void (async () => {
      const notifications = await notificationPermission()
      const microphone = await microphonePermission()
      const battery = showsBatteryStep() ? await batteryPermission() : null
      // Android only says "blocked" when asked; a later check reads "denied". Keep what we learned.
      setState((prev) => ({
        notifications: prev.notifications === 'blocked' && notifications === 'denied' ? 'blocked' : notifications,
        microphone: prev.microphone === 'blocked' && microphone === 'denied' ? 'blocked' : microphone,
        battery,
      }))
    })()
  }, [])

  useFocusEffect(refresh)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh()
    })
    return () => sub.remove()
  }, [refresh])

  return [state, refresh]
}
