package expo.modules.jophielactions

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.provider.MediaStore
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** A result for JS: status, reason, and `data` for the result (`opened`, `target`). */
internal data class Result(val status: String, val reason: String? = null, val data: Map<String, Any?>? = null) {
  fun toMap(): Map<String, Any?> = mapOf("status" to status, "reason" to reason, "data" to data)
}

/**
 * Opens something for her the way phase 7 opens Maps: straight away when an activity may start
 * (her app in front, or "Display over other apps" where it still counts), otherwise a "Tap to …"
 * notification whose tap does it (status `notified`).
 */
internal object Opener {
  /** One at a time: a new one replaces the previous "Tap to …" (Maps' trip notification stays). */
  private const val NOTIFICATION_ID = 7002
  private const val NOTIFICATION_TIMEOUT_MS = 10 * 60_000L

  fun start(context: Context, activity: Activity?, intent: Intent, tapTitle: String, data: Map<String, Any?>? = null): Result {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val choice = MapsLogic.choose(Maps.situation(context))
    if (choice.path != Path.OPEN) return notify(context, intent, tapTitle, if (choice.path == Path.WAKE) "screen_off" else choice.reason, data)
    return try {
      (activity ?: context).startActivity(intent)
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
      Result("done", data = data)
    } catch (e: ActivityNotFoundException) {
      Result("failed", "app_not_found")
    } catch (e: Exception) {
      Log.w(TAG, "opening failed", e)
      notify(context, intent, tapTitle, "open_failed", data)
    }
  }

  private fun notify(context: Context, intent: Intent, title: String, reason: String?, data: Map<String, Any?>?): Result {
    val notifications = NotificationManagerCompat.from(context)
    if (!notifications.areNotificationsEnabled()) return Result("failed", "notifications_off")
    Maps.ensureChannel(context)
    if (Maps.channelBlocked(context)) return Result("failed", "notifications_off")
    val tap = PendingIntent.getActivity(context, NOTIFICATION_ID, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    // Lock screen: only that Jophiel wants to open something, not what.
    val public = NotificationCompat.Builder(context, Maps.CHANNEL)
      .setSmallIcon(Maps.smallIcon(context))
      .setColor(Maps.ACCENT)
      .setContentTitle("Jophiel wants to open something")
      .build()
    val notification = NotificationCompat.Builder(context, Maps.CHANNEL)
      .setSmallIcon(Maps.smallIcon(context))
      .setColor(Maps.ACCENT)
      .setContentTitle(title)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(public)
      .setAutoCancel(true)
      .setTimeoutAfter(NOTIFICATION_TIMEOUT_MS)
      .setContentIntent(tap)
      .build()
    return try {
      notifications.notify(NOTIFICATION_ID, notification)
      Result("notified", reason, data)
    } catch (e: SecurityException) {
      Result("failed", "notifications_off")
    }
  }
}

/** Phase 8's device actions (PLAN_PHASE_8.md "Actions"). JS checked the switches and the args. */
internal object PhoneActions {
  const val SPOTIFY = "com.spotify.music"
  const val WHATSAPP = "com.whatsapp"
  private const val WHATSAPP_MIME = "vnd.android.cursor.item/vnd.com.whatsapp.profile"

  private fun installed(context: Context, packageName: String): Boolean = try {
    context.packageManager.getPackageInfo(packageName, 0)
    true
  } catch (e: PackageManager.NameNotFoundException) {
    false
  }

  // ---- Sound ----

  /** Media volume only (owner): 0–100. */
  fun setVolume(context: Context, level: Int): Result {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    return try {
      val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
      audio.setStreamVolume(AudioManager.STREAM_MUSIC, VolumeLogic.index(level, max), 0)
      Result("done")
    } catch (e: SecurityException) {
      // Changing volume while Do Not Disturb holds it needs DND access.
      Result("refused", "no_dnd_access")
    }
  }

  fun hasDndAccess(context: Context): Boolean =
    (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).isNotificationPolicyAccessGranted

  fun setRinger(context: Context, mode: String): Result {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val value = when (mode) {
      "normal" -> AudioManager.RINGER_MODE_NORMAL
      "vibrate" -> AudioManager.RINGER_MODE_VIBRATE
      "silent" -> AudioManager.RINGER_MODE_SILENT
      else -> return Result("failed", "bad_args")
    }
    if (value == AudioManager.RINGER_MODE_SILENT && !hasDndAccess(context)) return Result("refused", "no_dnd_access")
    return try {
      audio.ringerMode = value
      Result("done")
    } catch (e: SecurityException) {
      Result("refused", "no_dnd_access")
    }
  }

  fun setDnd(context: Context, on: Boolean): Result {
    if (!hasDndAccess(context)) return Result("refused", "no_dnd_access")
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return try {
      manager.setInterruptionFilter(if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL)
      Result("done")
    } catch (e: SecurityException) {
      Result("refused", "no_dnd_access")
    }
  }

  // ---- Clock ----

  /** In the clock app without its UI. Android can't list or delete alarms afterwards. */
  fun setAlarm(context: Context, activity: Activity?, hour: Int, minute: Int, label: String?, days: List<Int>): Result {
    val intent = Intent(AlarmClock.ACTION_SET_ALARM)
      .putExtra(AlarmClock.EXTRA_HOUR, hour)
      .putExtra(AlarmClock.EXTRA_MINUTES, minute)
      .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
    if (!label.isNullOrBlank()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label)
    if (days.isNotEmpty()) intent.putExtra(AlarmClock.EXTRA_DAYS, ArrayList(days))
    if (intent.resolveActivity(context.packageManager) == null) return Result("failed", "app_not_found")
    return Opener.start(context, activity, intent, "Tap to set the alarm for %02d:%02d".format(hour, minute))
  }

  fun setTimer(context: Context, activity: Activity?, seconds: Int, label: String?): Result {
    val intent = Intent(AlarmClock.ACTION_SET_TIMER)
      .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
      .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
    if (!label.isNullOrBlank()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label)
    if (intent.resolveActivity(context.packageManager) == null) return Result("failed", "app_not_found")
    return Opener.start(context, activity, intent, "Tap to start the timer")
  }

  // ---- Opening things ----

  fun launchableApps(context: Context): List<App> {
    val pm = context.packageManager
    val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return pm.queryIntentActivities(launcher, 0).map { App(it.loadLabel(pm).toString(), it.activityInfo.packageName) }
  }

  fun openApp(context: Context, activity: Activity?, name: String): Result =
    when (val match = AppMatcher.match(name, launchableApps(context))) {
      AppMatch.NotFound -> Result("failed", "app_not_found")
      AppMatch.Ambiguous -> Result("failed", "ambiguous")
      is AppMatch.Found -> {
        val intent = context.packageManager.getLaunchIntentForPackage(match.app.packageName)
        if (intent == null) {
          Result("failed", "app_not_found")
        } else {
          Opener.start(context, activity, intent, "Tap to open ${match.app.label}", mapOf("opened" to match.app.label))
        }
      }
    }

  /** http(s) only (checked in JS); Android picks the app (Discord, YouTube, a browser). */
  fun openLink(context: Context, activity: Activity?, url: String): Result {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
    if (intent.resolveActivity(context.packageManager) == null) return Result("failed", "app_not_found")
    return Opener.start(context, activity, intent, "Tap to open ${Uri.parse(url).host ?: "the link"}")
  }

  /** Spotify plays the top hit for `query` (play-from-search; no Spotify API). */
  fun playMusic(context: Context, activity: Activity?, query: String): Result {
    if (!installed(context, SPOTIFY)) return Result("failed", "app_not_found")
    val intent = Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
      .setPackage(SPOTIFY)
      .putExtra(SearchManager.QUERY, query)
      .putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
    return Opener.start(context, activity, intent, "Tap to play “$query” on Spotify")
  }

  // ---- WhatsApp ----

  private fun contactsGranted(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

  /** Contacts whose name contains `to`, with the number WhatsApp has for them (or an international phone number). */
  private fun draftContacts(context: Context, to: String): List<DraftContact> {
    val pattern = "%" + to.trim().replace("%", "").replace("_", "") + "%"
    val rows = ArrayList<DraftContact>()
    val resolver = context.contentResolver
    resolver.query(
      ContactsContract.Data.CONTENT_URI,
      arrayOf(ContactsContract.Data.CONTACT_ID, ContactsContract.Data.DISPLAY_NAME, ContactsContract.Data.DATA1),
      "${ContactsContract.Data.MIMETYPE} = ? AND ${ContactsContract.Data.DISPLAY_NAME} LIKE ?",
      arrayOf(WHATSAPP_MIME, pattern),
      null,
    )?.use { c ->
      while (c.moveToNext()) rows.add(DraftContact(c.getLong(0), c.getString(1) ?: "", WhatsAppLogic.numberFromJid(c.getString(2))))
    }
    val withWhatsApp = rows.map { it.contactId }.toSet()
    resolver.query(
      ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
      arrayOf(
        ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
        ContactsContract.CommonDataKinds.Phone.NUMBER,
      ),
      "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?",
      arrayOf(pattern),
      null,
    )?.use { c ->
      while (c.moveToNext()) {
        val id = c.getLong(0)
        // A WhatsApp row is the better number; a phone row only counts for contacts without one.
        if (id !in withWhatsApp) rows.add(DraftContact(id, c.getString(1) ?: "", WhatsAppLogic.internationalDigits(c.getString(2))))
      }
    }
    return rows
  }

  /**
   * The text typed into WhatsApp, for you to press send (WhatsApp doesn't let apps send). With `to`
   * matching one contact: that chat; otherwise WhatsApp's chat picker. The number stays here.
   */
  fun whatsappDraft(context: Context, activity: Activity?, to: String?, text: String): Result {
    if (!installed(context, WHATSAPP)) return Result("failed", "app_not_found")
    val wanted = to?.trim()?.takeIf { it.isNotEmpty() }
    val noAccess = wanted != null && !contactsGranted(context)
    val target = if (wanted == null || noAccess) {
      DraftTarget.Picker
    } else {
      try {
        WhatsAppLogic.choose(wanted, draftContacts(context, wanted))
      } catch (e: Exception) {
        Log.w(TAG, "contacts lookup failed", e)
        DraftTarget.Picker
      }
    }
    val (intent, label) = when (target) {
      is DraftTarget.Chat -> Intent(
        Intent.ACTION_VIEW,
        Uri.parse("https://api.whatsapp.com/send?phone=${target.number}&text=${Uri.encode(text)}"),
      ).setPackage(WHATSAPP) to "contact"
      DraftTarget.Picker -> Intent(Intent.ACTION_SEND)
        .setType("text/plain")
        .putExtra(Intent.EXTRA_TEXT, text)
        .setPackage(WHATSAPP) to "picker"
    }
    val title = if (target is DraftTarget.Chat && wanted != null) "Tap to see her WhatsApp draft to $wanted" else "Tap to see her WhatsApp draft"
    val result = Opener.start(context, activity, intent, title, mapOf("target" to label))
    return if (noAccess && result.reason == null) result.copy(reason = "no_contacts_access") else result
  }
}
