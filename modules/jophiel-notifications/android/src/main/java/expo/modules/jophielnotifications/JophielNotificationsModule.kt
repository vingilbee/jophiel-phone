package expo.modules.jophielnotifications

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Phase 8: notifications as a sense, and the actions that need the listener (reply through a
 * notification's reply button, dismiss, media control). JS owns the switches, the socket and the
 * action channel; this module does the Android parts and the closed-app path.
 */
class JophielNotificationsModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("JophielNotifications")

    Events("onNotifications")

    /** "Notification access" is on for Jophiel. */
    Function("hasAccess") { hasAccess(context) }

    /** Android's notification access page (Jophiel's own entry where Android has one). */
    Function("openAccessSettings") {
      val ctx = context
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
          .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, JophielNotificationListener.component(ctx).flattenToString())
      } else {
        Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
      }
      try {
        start(ctx, intent)
      } catch (e: Exception) {
        start(ctx, Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
      }
    }

    /**
     * The Notifications sense switch and the Messages switch. Switching the sense off sends one
     * "all removed"; on again sends what's on the phone now. Also asks Android to bind the
     * listener if it isn't (Samsung battery).
     */
    Function("configure") { enabled: Boolean, messagesOn: Boolean ->
      val ctx = context
      val wasEnabled = Store.enabled(ctx)
      Store.setSwitches(ctx, enabled, messagesOn)
      val listener = JophielNotificationListener.instance
      if (listener != null) {
        if (wasEnabled != enabled) listener.setEnabled(enabled)
      } else if (hasAccess(ctx)) {
        runCatching { NotificationListenerService.requestRebind(JophielNotificationListener.component(ctx)) }
      }
    }

    /** Signed in: where background sends go (token stored encrypted). */
    Function("setReporting") { serverUrl: String, token: String ->
      val ctx = context
      val previous = Store.credentials(ctx)
      // Another server: what the last one was told means nothing here.
      if (previous != null && previous.serverUrl != serverUrl) Store.clearAccount(ctx)
      Store.setCredentials(ctx, Store.Credentials(serverUrl, token))
    }

    /** Logout: queued batches dropped, no more sends. */
    Function("clearReporting") {
      val ctx = context
      Outbox.cancelAll(ctx)
      Store.clearAccount(ctx)
      Contacts.forgetCache()
    }

    /** JS live: batches come to JS (`onNotifications`) for the socket. */
    Function("startLive") {
      val ctx = context
      Outbox.liveSink = { body ->
        try {
          sendEvent("onNotifications", mapOf("body" to body))
        } catch (e: Throwable) {
          // JS went away between the check and the send: the batch takes the background path.
          Outbox.queue(ctx, body)
        }
      }
    }

    Function("stopLive") { Outbox.liveSink = null }

    /** JS got a batch but has no socket: send it with a background POST. */
    Function("queue") { body: String -> Outbox.queue(context, body) }

    /** For Settings: access, whether the listener is bound, how many notifications she knows of, when last sent. */
    Function("status") {
      val ctx = context
      mapOf(
        "access" to hasAccess(ctx),
        "connected" to (JophielNotificationListener.instance != null),
        "known" to Store.sentKeys(ctx).size,
        "lastSentAt" to Store.lastSentAt(ctx).toDouble(),
      )
    }

    /** Reply through the notification's own reply button. Resolves `{ status, reason }`. */
    AsyncFunction("reply") { key: String, conversationId: String?, revision: Int?, text: String, promise: Promise ->
      val listener = listener(promise) ?: return@AsyncFunction
      listener.reply(key, conversationId, revision, text) { promise.resolve(answer(it)) }
    }

    AsyncFunction("dismiss") { key: String, promise: Promise ->
      val listener = listener(promise) ?: return@AsyncFunction
      listener.dismiss(key) { promise.resolve(answer(it)) }
    }

    /** play / pause / next / previous on what's playing. */
    AsyncFunction("mediaControl") { command: String, promise: Promise ->
      val listener = listener(promise) ?: return@AsyncFunction
      listener.mediaControl(command) { promise.resolve(answer(it)) }
    }

    OnDestroy { Outbox.liveSink = null }
  }

  /** The bound listener, or the promise answered with why there's none. */
  private fun listener(promise: Promise): JophielNotificationListener? {
    val listener = JophielNotificationListener.instance
    if (listener != null) return listener
    val ctx = context
    promise.resolve(
      when {
        !hasAccess(ctx) -> answer(Answer("refused", "no_notification_access"))
        !Store.enabled(ctx) -> answer(Answer("refused", "switched_off"))
        else -> answer(Answer("failed", "not_connected"))
      },
    )
    return null
  }

  private fun answer(a: Answer) = mapOf("status" to a.status, "reason" to a.reason)

  private fun hasAccess(context: Context): Boolean =
    NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)

  private fun start(context: Context, intent: Intent) {
    val activity = appContext.currentActivity
    if (activity != null) activity.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}
