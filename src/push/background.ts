import { pushEnabled } from './config'
import { handlePush, notifee, savePendingTap, tappedMessageId } from './display'
import { parsePushData } from './plan'

// Runs at bundle load, before the app mounts, so Android can deliver a data message to a closed app.
if (pushEnabled) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getMessaging, setBackgroundMessageHandler } = require('@react-native-firebase/messaging') as typeof import('@react-native-firebase/messaging')
  setBackgroundMessageHandler(getMessaging(), async (message) => {
    await handlePush(parsePushData(message.data))
  })
}

// A tap while the app is in the background arrives here. Park the message; the chat opens it as
// soon as the app is in front (cold starts use getInitialNotification, on-screen taps onForegroundEvent).
notifee.onBackgroundEvent(async (event) => {
  const messageId = tappedMessageId(event)
  if (messageId) await savePendingTap(messageId)
})
