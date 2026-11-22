package expo.modules.jophielactions

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Phone actions (phase 7): what she asks the phone to do. JS owns the channel (checks, expiry,
 * results); this module does the parts only Android can: open Maps from wherever the phone is
 * (in front, behind another app, in your pocket), the fallback notification, and the permission
 * checks for Setup and Settings.
 */
class JophielActionsModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("JophielActions")

    /** Open Google Maps at `url`; resolves `{ status, reason }` (done / notified / failed). */
    AsyncFunction("openMaps") { url: String, title: String, promise: Promise ->
      Maps.open(context, appContext.currentActivity, url, title) { outcome ->
        promise.resolve(mapOf("status" to outcome.status, "reason" to outcome.reason))
      }
    }

    Function("mapsInstalled") { Maps.installed(context) }

    /** "Display over other apps". */
    Function("canDrawOverlays") { Maps.canDrawOverlays(context) }

    /** Full-screen notifications (Android 14+; always true below). */
    Function("canUseFullScreenIntent") { Maps.canUseFullScreenIntent(context) }

    Function("openOverlaySettings") {
      openSettings(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}")))
    }

    Function("openFullScreenIntentSettings") {
      if (Build.VERSION.SDK_INT >= 34) {
        openSettings(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")))
      }
    }
  }

  private fun openSettings(intent: Intent) {
    val activity = appContext.currentActivity
    try {
      if (activity != null) activity.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (e: Exception) {
      // Some builds lack the page: the app's own settings instead.
      val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
      (activity ?: context).startActivity(details.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
