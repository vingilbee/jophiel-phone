package expo.modules.jophielactions

/** What the phone looks like when she asks it to open Maps (read from Android each time). */
internal data class Situation(
  /** One of Jophiel's activities is in front (not just her call's foreground service). */
  val appOnScreen: Boolean,
  val screenOn: Boolean,
  /** The keyguard is showing (swipe, Smart Lock or PIN). */
  val keyguardLocked: Boolean,
  /** Unlocking needs a PIN / pattern / biometric right now (`KeyguardManager.isDeviceLocked`). */
  val deviceLocked: Boolean,
  /** "Display over other apps" is allowed. */
  val canDrawOverlays: Boolean,
  /** One of her overlay windows is visible (the floating chibi, phase 11). Always false before that. */
  val overlayVisible: Boolean,
  val sdk: Int,
  /** Full-screen notifications are allowed (always below Android 14). */
  val fullScreenAllowed: Boolean,
)

internal enum class Path {
  /** Start Maps straight away. */
  OPEN,
  /** A full-screen-intent notification wakes the screen; WakeActivity dismisses the keyguard and opens Maps. */
  WAKE,
  /** Only the "Tap to start navigation" notification. */
  NOTIFY,
  /**
   * Android 15+, another app in front, "Display over other apps" allowed: show a 1-pixel overlay
   * window for a moment (Android lets an app with a visible overlay start activities), then open.
   */
  OVERLAY,
}

internal data class Choice(val path: Path, val reason: String? = null)

/** Android 15: "Display over other apps" only lets an app start activities while an overlay window shows. */
internal const val SDK_OVERLAY_NEEDS_WINDOW = 35

/**
 * Which row of PLAN_PHASE_7.md's "Opening Maps" table applies. Pure, so it's unit-tested; the
 * notification is the fallback for every other path too (an exception, a refused dismiss).
 */
internal object MapsLogic {
  fun choose(s: Situation): Choice {
    val unlockedAndOn = s.screenOn && !s.keyguardLocked
    if (unlockedAndOn) {
      if (s.appOnScreen) return Choice(Path.OPEN)
      if (!s.canDrawOverlays) return Choice(Path.NOTIFY, "background")
      return if (s.sdk < SDK_OVERLAY_NEEDS_WINDOW || s.overlayVisible) Choice(Path.OPEN) else Choice(Path.OVERLAY)
    }
    // Screen off, or the lock screen is showing.
    if (s.deviceLocked) return Choice(Path.NOTIFY, "locked")
    if (!s.fullScreenAllowed) return Choice(Path.NOTIFY, "no_full_screen")
    return Choice(Path.WAKE)
  }
}
