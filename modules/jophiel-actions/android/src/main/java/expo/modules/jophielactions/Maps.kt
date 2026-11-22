package expo.modules.jophielactions

import android.app.Activity
import android.app.ActivityManager
import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.UUID

internal const val TAG = "JophielActions"

/** What happened, as the phone_action_result's `status` / `reason`. */
internal data class Outcome(val status: String, val reason: String? = null)

/**
 * Opens Google Maps navigating, by the row of the plan's table that applies (MapsLogic), with the
 * "Tap to start navigation" notification as the fallback for everything that doesn't work.
 */
internal object Maps {
  const val PACKAGE = "com.google.android.apps.maps"
  private const val CHANNEL = "actions"
  /** One trip at a time: a new navigate_to replaces the previous notification. */
  private const val NOTIFICATION_ID = 7001
  private const val NOTIFICATION_TIMEOUT_MS = 10 * 60_000L
  /** How long the full-screen path may take to wake the screen and open Maps before it counts as notified. */
  private const val WAKE_TIMEOUT_MS = 6_000L
  private const val ACCENT = 0xFFB8572F.toInt()

  private val main = Handler(Looper.getMainLooper())
  /** Wake attempts in flight: token → what to do with WakeActivity's answer. */
  private val waiting = HashMap<String, (Outcome) -> Unit>()

  fun installed(context: Context): Boolean = try {
    context.packageManager.getPackageInfo(PACKAGE, 0)
    true
  } catch (e: PackageManager.NameNotFoundException) {
    false
  }

  fun intent(url: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(PACKAGE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  fun canDrawOverlays(context: Context): Boolean = Settings.canDrawOverlays(context)

  fun canUseFullScreenIntent(context: Context): Boolean =
    if (Build.VERSION.SDK_INT >= 34) {
      (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).canUseFullScreenIntent()
    } else {
      true
    }

  /** An activity of ours is in front (a call's foreground service alone doesn't count). */
  private fun appOnScreen(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  fun situation(context: Context): Situation {
    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    return Situation(
      appOnScreen = appOnScreen(),
      screenOn = power.isInteractive,
      keyguardLocked = keyguard.isKeyguardLocked,
      deviceLocked = keyguard.isDeviceLocked,
      canDrawOverlays = canDrawOverlays(context),
      overlayVisible = false,
      sdk = Build.VERSION.SDK_INT,
      fullScreenAllowed = canUseFullScreenIntent(context),
    )
  }

  /** Open Maps at `url` (built and tested in JS: src/actions/maps.ts). `done` runs once. */
  fun open(context: Context, activity: Activity?, url: String, title: String, done: (Outcome) -> Unit) {
    if (!installed(context)) {
      done(Outcome("failed", "maps_missing"))
      return
    }
    val choice = MapsLogic.choose(situation(context))
    when (choice.path) {
      Path.OPEN -> openNow(context, activity, url, title, done)
      Path.NOTIFY -> done(notifyOnly(context, url, title, choice.reason))
      Path.WAKE -> wake(context, url, title, done)
    }
  }

  private fun openNow(context: Context, activity: Activity?, url: String, title: String, done: (Outcome) -> Unit) {
    try {
      // From the activity when ours is in front; otherwise a new task (allowed by the overlay permission).
      (activity ?: context).startActivity(intent(url))
      cancelNotification(context)
      done(Outcome("done"))
    } catch (e: ActivityNotFoundException) {
      done(Outcome("failed", "maps_missing"))
    } catch (e: Exception) {
      Log.w(TAG, "opening Maps failed", e)
      done(notifyOnly(context, url, title, "open_failed"))
    }
  }

  private fun notifyOnly(context: Context, url: String, title: String, reason: String?): Outcome =
    if (post(context, url, title, fullScreen = null)) Outcome("notified", reason) else Outcome("failed", "notifications_off")

  /**
   * The pocket path: a full-screen-intent notification starts WakeActivity (over the lock screen,
   * screen on), which dismisses the keyguard and opens Maps. The same notification stays as the
   * fallback when the keyguard won't go, or nothing answers in time.
   */
  private fun wake(context: Context, url: String, title: String, done: (Outcome) -> Unit) {
    val token = UUID.randomUUID().toString()
    val activityIntent = Intent(context, WakeActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
      .putExtra(WakeActivity.EXTRA_URL, url)
      .putExtra(WakeActivity.EXTRA_TOKEN, token)
    val fullScreen = PendingIntent.getActivity(
      context,
      token.hashCode(),
      activityIntent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    main.post {
      waiting[token] = done
      if (!post(context, url, title, fullScreen)) {
        waiting.remove(token)
        done(Outcome("failed", "notifications_off"))
        return@post
      }
      main.postDelayed({
        // WakeActivity never answered (the full-screen intent didn't launch): the notification stays.
        waiting.remove(token)?.invoke(Outcome("notified", "no_wake"))
      }, WAKE_TIMEOUT_MS)
    }
  }

  /**
   * WakeActivity's answer. Null when the wait already ended (it then leaves Maps closed, so Maps
   * never opens after she was told it didn't). Main thread only.
   */
  fun claimWake(token: String?): ((Outcome) -> Unit)? = token?.let { waiting.remove(it) }

  private fun ensureChannel(context: Context) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(CHANNEL, "Actions", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "When Jophiel can't open an app by herself, e.g. “Tap to start navigation”"
    }
    manager.createNotificationChannel(channel)
  }

  private fun smallIcon(context: Context): Int {
    val star = context.resources.getIdentifier("ic_stat_jophiel", "drawable", context.packageName)
    return if (star != 0) star else context.applicationInfo.icon
  }

  /** The owner switched off the "Actions" channel: Android would drop the notification silently. */
  private fun channelBlocked(context: Context): Boolean {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return manager.getNotificationChannel(CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE
  }

  /**
   * The "Tap to start navigation" notification; its tap opens Maps navigating. False when it
   * wouldn't show: the app's notifications or its "Actions" channel are off.
   */
  private fun post(context: Context, url: String, title: String, fullScreen: PendingIntent?): Boolean {
    val notifications = NotificationManagerCompat.from(context)
    if (!notifications.areNotificationsEnabled()) return false
    ensureChannel(context)
    if (channelBlocked(context)) return false
    val tap = PendingIntent.getActivity(
      context,
      NOTIFICATION_ID,
      intent(url),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val destination = if (title.isBlank()) null else "To $title"
    // On the lock screen only "Tap to start navigation", not where to.
    val public = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(smallIcon(context))
      .setColor(ACCENT)
      .setContentTitle("Tap to start navigation")
      .build()
    val builder = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(smallIcon(context))
      .setColor(ACCENT)
      .setContentTitle("Tap to start navigation")
      .setContentText(destination)
      .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(public)
      .setAutoCancel(true)
      .setTimeoutAfter(NOTIFICATION_TIMEOUT_MS)
      .setContentIntent(tap)
    if (fullScreen != null) builder.setFullScreenIntent(fullScreen, true)
    return try {
      notifications.notify(NOTIFICATION_ID, builder.build())
      true
    } catch (e: SecurityException) {
      Log.w(TAG, "notification refused", e)
      false
    }
  }

  fun cancelNotification(context: Context) {
    NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
  }
}
