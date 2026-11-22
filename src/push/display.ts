import AsyncStorage from '@react-native-async-storage/async-storage'
import notifee, { AndroidGroupAlertBehavior, AndroidImportance, AndroidVisibility, EventType, type Event } from '@notifee/react-native'
import { CHANNEL_ID, GROUP_ID, SUMMARY_ID, messageNotification, summaryFor, type PushData } from './plan'

let channelReady: Promise<string> | null = null

function ensureChannel() {
  channelReady ??= notifee.createChannel({
    id: CHANNEL_ID,
    name: 'Messages from Jophiel',
    description: 'What she says when you are not in the app',
    importance: AndroidImportance.HIGH,
    visibility: AndroidVisibility.PRIVATE,
  })
  return channelReady
}

const ANDROID_BASE = {
  channelId: CHANNEL_ID,
  groupId: GROUP_ID,
  smallIcon: 'ic_stat_jophiel',
  color: '#B8572F',
  pressAction: { id: 'default', launchActivity: 'default' },
}

/** Show one of her messages, stacked into the Jophiel group. */
export async function showMessage(push: Extract<PushData, { type: 'message' }>) {
  await ensureChannel()
  const notification = messageNotification(push)
  const displayed = await notifee.getDisplayedNotifications()
  const ids = displayed
    .filter((d) => d.notification.android?.groupId === GROUP_ID || d.id === SUMMARY_ID)
    .map((d) => d.id ?? '')
    .filter(Boolean)
  if (ids.includes(notification.id)) return
  await notifee.displayNotification({
    id: notification.id,
    title: notification.title,
    body: notification.body,
    data: notification.data,
    android: { ...ANDROID_BASE, timestamp: Date.now(), showTimestamp: true, groupAlertBehavior: AndroidGroupAlertBehavior.ALL },
  })
  const summary = summaryFor(ids, notification.id)
  if (summary) {
    await notifee.displayNotification({
      id: SUMMARY_ID,
      title: summary.title,
      body: summary.title,
      data: { message_id: notification.id, conversation_id: notification.data.conversation_id },
      android: {
        ...ANDROID_BASE,
        groupSummary: true,
        // Only the new message makes a sound, not the summary as well.
        groupAlertBehavior: AndroidGroupAlertBehavior.CHILDREN,
      },
    })
  }
}

/** Remove every Jophiel notification (opened the app, or seen elsewhere). */
export async function clearPresentedNotifications() {
  try {
    await notifee.cancelDisplayedNotifications()
  } catch {
    // notifee unavailable (no native module) → nothing to clear
  }
}

export async function handlePush(push: PushData | null) {
  if (!push) return
  if (push.type === 'clear') await clearPresentedNotifications()
  else if (push.type === 'message') await showMessage(push)
  // phone_action pushes are src/actions' (background.ts, registration.ts), never a notification.
}

/** The message a notification tap should open, if this event is a tap. */
export function tappedMessageId(event: Event): string | null {
  if (event.type !== EventType.PRESS) return null
  const id = event.detail.notification?.data?.message_id
  return typeof id === 'string' && id ? id : null
}

export async function initialTappedMessageId(): Promise<string | null> {
  try {
    const initial = await notifee.getInitialNotification()
    const id = initial?.notification.data?.message_id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

// A tap while the app is in the background reaches notifee's background handler, not the screen.
// It's parked here until the app is in front to open it.
const PENDING_TAP_KEY = 'jophiel.pending-tap'
const pendingTapListeners = new Set<() => void>()

export async function savePendingTap(messageId: string) {
  await AsyncStorage.setItem(PENDING_TAP_KEY, messageId)
  // The app may already be coming to the front (same JS runtime): tell it now.
  pendingTapListeners.forEach((listener) => listener())
}

/** The parked tap, if any, removed so it opens only once. */
export async function takePendingTap(): Promise<string | null> {
  try {
    const id = await AsyncStorage.getItem(PENDING_TAP_KEY)
    if (id) await AsyncStorage.removeItem(PENDING_TAP_KEY)
    return id
  } catch {
    return null
  }
}

export function onPendingTap(listener: () => void) {
  pendingTapListeners.add(listener)
  return () => {
    pendingTapListeners.delete(listener)
  }
}

export { notifee }
