import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { batteryPermission, notificationPermission, showsBatteryStep, type PermissionState } from './permissions'

export interface Permissions {
  notifications: PermissionState
  battery: PermissionState | null
}

/** Read from Android on focus and whenever the app comes back (e.g. from the system settings). */
export function usePermissions(): [Permissions, () => void] {
  const [state, setState] = useState<Permissions>({ notifications: 'unknown', battery: null })

  const refresh = useCallback(() => {
    void (async () => {
      const notifications = await notificationPermission()
      const battery = showsBatteryStep() ? await batteryPermission() : null
      setState((prev) =>
        prev.notifications === 'blocked' && notifications === 'denied'
          ? { notifications: 'blocked', battery }
          : { notifications, battery },
      )
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
