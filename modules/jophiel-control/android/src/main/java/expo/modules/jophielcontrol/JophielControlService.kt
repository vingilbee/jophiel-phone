package expo.modules.jophielcontrol

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent

/**
 * Phase 9: Android's accessibility service, the only way an app can read another app's screen and
 * act on it. Bound by Android once you turn Jophiel on in Settings → Accessibility; it does nothing
 * by itself. The work is in `Controller` (one action at a time), `ScreenReader`, `Screenshot`,
 * `Actor` and `Banner`. Window events only mark the time, so `Controller` knows when the screen
 * has settled.
 */
class JophielControlService : AccessibilityService() {
  /** Uptime ms of the last window event (state, content or windows changed). */
  @Volatile
  internal var lastEventAt = 0L

  internal lateinit var banner: Banner
    private set

  override fun onServiceConnected() {
    super.onServiceConnected()
    banner = Banner(this) { Controller.takenOver() }
    instance = this
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    lastEventAt = SystemClock.uptimeMillis()
  }

  override fun onInterrupt() {}

  override fun onUnbind(intent: Intent?): Boolean {
    gone()
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    gone()
    super.onDestroy()
  }

  private fun gone() {
    if (instance === this) instance = null
    if (::banner.isInitialized) banner.remove()
    Controller.serviceGone()
  }

  companion object {
    @Volatile
    internal var instance: JophielControlService? = null

    fun component(context: Context) = ComponentName(context, JophielControlService::class.java)

    /** Turned on in Settings → Accessibility (it may not be bound yet, e.g. right after a crash). */
    fun enabled(context: Context): Boolean {
      val list = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
      val ours = component(context)
      return list.split(':').any { ComponentName.unflattenFromString(it.trim()) == ours }
    }
  }
}
