import * as Device from 'expo-device'
import { AppState } from 'react-native'
import { dispatchAction } from '@/actions'
import { deleteDevice, registerDevice } from '@/api/phone'
import { notificationPermission } from '@/setup/permissions'
import { pushEnabled } from './config'
import { clearPresentedNotifications, handlePush } from './display'
import { parsePushData } from './plan'
import { PushRegistrar } from './registrar'

type MessagingModule = typeof import('@react-native-firebase/messaging')

function messagingModule(): MessagingModule | null {
  if (!pushEnabled) return null
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@react-native-firebase/messaging') as MessagingModule
}

let registrar: PushRegistrar | null = null

function getRegistrar(): PushRegistrar | null {
  const m = messagingModule()
  if (!m) return null
  registrar ??= new PushRegistrar({
    permissionGranted: async () => (await notificationPermission()) === 'granted',
    token: () => m.getToken(m.getMessaging()).catch(() => null),
    register: async (token) => {
      await registerDevice(token, Device.deviceName || Device.modelName || 'Android phone')
    },
  })
  return registrar
}

/**
 * After sign-in: register this phone's FCM token with the backend and keep it current. Tries again
 * whenever the app comes to the foreground (notifications may just have been allowed in Android's
 * settings) and after every chat reconnect, until it works. Returns a cleanup.
 */
export function startPush(): () => void {
  const m = messagingModule()
  const r = getRegistrar()
  if (!m || !r) return () => {}
  const messaging = m.getMessaging()
  void r.ensure()
  const appState = AppState.addEventListener('change', (next) => {
    if (next === 'active') void r.ensure()
  })
  const unsubscribeRefresh = m.onTokenRefresh(messaging, (token) => void r.tokenChanged(token))
  const unsubscribeMessage = m.onMessage(messaging, async (message) => {
    const push = parsePushData(message.data)
    // On screen, the chat already shows her message; only act on "clear".
    if (push?.type === 'clear') await handlePush(push)
    // Phase 7: an action pushed while the app is open but its socket was down (a repeat is ignored).
    else if (push?.type === 'phone_action') await dispatchAction(push.action)
  })
  return () => {
    appState.remove()
    unsubscribeRefresh()
    unsubscribeMessage()
  }
}

/** The chat socket reconnected: the backend is back, so a failed registration can go through now. */
export function retryPushRegistration() {
  void getRegistrar()?.ensure()
}

/** Setup's "Allow notifications" was granted. */
export function registerNow() {
  return getRegistrar()?.ensure()
}

/** On sign-out: no more notifications for this phone. */
export async function stopPushForSignOut() {
  await clearPresentedNotifications()
  const m = messagingModule()
  if (!m) return
  getRegistrar()?.reset()
  await deleteDevice().catch(() => {})
  await m.deleteToken(m.getMessaging()).catch(() => {})
}
