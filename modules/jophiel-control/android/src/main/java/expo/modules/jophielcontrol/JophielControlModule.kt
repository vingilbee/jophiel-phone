package expo.modules.jophielcontrol

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Phase 9, phone control: JS owns the channel (switches, expiry, results); this module answers
 * each control action through the accessibility service, and tells Setup / Settings whether the
 * service is on.
 */
class JophielControlModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("JophielControl")

    /** Turned on in Settings → Accessibility. */
    Function("isEnabled") { JophielControlService.enabled(context) }

    /** Android has the service bound right now (off after a crash until Android binds it again). */
    Function("isConnected") { JophielControlService.instance != null }

    /** Android's accessibility page (Jophiel's own entry where Android has one). */
    Function("openSettings") {
      val ctx = context
      val component = JophielControlService.component(ctx).flattenToString()
      val details = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
        .putExtra(Intent.EXTRA_COMPONENT_NAME, component)
      // Older Android: the list, with Jophiel highlighted where the settings app supports it.
      val list = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
        putExtra(":settings:fragment_args_key", component)
        putExtra(":settings:show_fragment_args", Bundle().apply { putString(":settings:fragment_args_key", component) })
      }
      try {
        start(ctx, details)
      } catch (e: Exception) {
        start(ctx, list)
      }
    }

    /** The master switch and Phone control: off ends her control at once (banner gone, screen dropped). */
    Function("setAllowed") { on: Boolean -> Controller.setAllowed(on) }

    /** One control action; resolves `{ status, reason, screen }` (`screen`: JSON text, only with done). */
    AsyncFunction("perform") { action: String, args: Map<String, Any?>, promise: Promise ->
      Controller.perform(context, action, args) { answer ->
        promise.resolve(mapOf("status" to answer.status, "reason" to answer.reason, "screen" to answer.screen))
      }
    }
  }

  private fun start(ctx: Context, intent: Intent) {
    val activity = appContext.currentActivity
    if (activity != null) activity.startActivity(intent) else ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}
