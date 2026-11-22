package expo.modules.jophielactions

import android.app.Activity
import android.app.KeyguardManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager

/**
 * Transparent and empty: started only by the full-screen-intent notification of the pocket path.
 * Shows over the lock screen with the screen turned on, asks Android to dismiss the keyguard (no
 * PIN: a swipe lock, or Smart Lock trusting the owner's earphones), then opens Maps and finishes.
 * When the keyguard won't go, the notification stays for a tap after unlocking.
 */
class WakeActivity : Activity() {
  companion object {
    const val EXTRA_URL = "url"
    const val EXTRA_TOKEN = "token"
  }

  /** Who waits for this attempt's outcome; null once answered. */
  private var answer: ((Outcome) -> Unit)? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }

    val url = intent.getStringExtra(EXTRA_URL)
    answer = Maps.claimWake(intent.getStringExtra(EXTRA_TOKEN))
    if (url == null || answer == null) {
      // Too late (she was already told "notified"), or not started by our notification.
      answer?.invoke(Outcome("notified", "open_failed"))
      answer = null
      finish()
      return
    }
    val keyguard = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
    if (!keyguard.isKeyguardLocked) {
      openMaps(url)
      return
    }
    keyguard.requestDismissKeyguard(
      this,
      object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() = openMaps(url)

        override fun onDismissError() {
          reply(Outcome("notified", "keyguard"))
          finish()
        }

        override fun onDismissCancelled() {
          reply(Outcome("notified", "keyguard"))
          finish()
        }
      },
    )
  }

  private fun openMaps(url: String) {
    try {
      startActivity(Maps.intent(url))
      Maps.cancelNotification(this)
      reply(Outcome("done"))
    } catch (e: Exception) {
      Log.w(TAG, "opening Maps from the lock screen failed", e)
      reply(Outcome("notified", "open_failed"))
    }
    finish()
  }

  private fun reply(outcome: Outcome) {
    val waiting = answer ?: return
    answer = null
    waiting(outcome)
  }

  override fun onDestroy() {
    // Closed before the keyguard answered: the notification is still there.
    reply(Outcome("notified", "keyguard"))
    super.onDestroy()
  }
}
