import { api } from './client'

/**
 * Backend phase 2: this session's phone device. Whether notifications show (and how) is Android's
 * own notification settings, not an app setting, so there is no PATCH.
 */
export function registerDevice(fcmToken: string, deviceName: string) {
  return api<unknown>('/api/phone/device', {
    method: 'PUT',
    body: { fcm_token: fcmToken, device_name: deviceName },
  })
}

export function deleteDevice() {
  return api<void>('/api/phone/device', { method: 'DELETE', timeoutMs: 5_000 })
}
