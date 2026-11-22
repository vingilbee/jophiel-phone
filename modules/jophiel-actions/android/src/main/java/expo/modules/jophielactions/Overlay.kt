package expo.modules.jophielactions

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Android 15 lets an app with "Display over other apps" start activities from the background only
 * while one of its overlay windows is visible. So: a 1-pixel, transparent, untouchable overlay
 * for a moment, the activity started while it shows, then the overlay removed. Nothing is visible
 * and nothing can be touched.
 */
internal object Overlay {
  /** Long enough for the window to be shown before the start. */
  private const val SETTLE_MS = 150L
  private const val KEEP_MS = 1_500L

  private val main = Handler(Looper.getMainLooper())

  /** Start `intent` behind a brief overlay; `done(null)` on success, else the reason. Any thread. */
  fun start(context: Context, intent: Intent, done: (String?) -> Unit) {
    main.post {
      val windows = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
      val view = View(context)
      val params = WindowManager.LayoutParams(
        1,
        1,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
          WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
          WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
        PixelFormat.TRANSLUCENT,
      ).apply { gravity = Gravity.TOP or Gravity.START }
      try {
        windows.addView(view, params)
      } catch (e: Exception) {
        Log.w(TAG, "overlay refused", e)
        done("background")
        return@post
      }
      main.postDelayed({
        val reason = try {
          context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          null
        } catch (e: android.content.ActivityNotFoundException) {
          "app_not_found"
        } catch (e: Exception) {
          Log.w(TAG, "start behind overlay failed", e)
          "open_failed"
        }
        main.postDelayed({ runCatching { windows.removeView(view) } }, KEEP_MS)
        done(reason)
      }, SETTLE_MS)
    }
  }

  /** The same, waiting for the answer (from a background thread, never the main one). */
  fun startBlocking(context: Context, intent: Intent): String? {
    val latch = CountDownLatch(1)
    var answer: String? = "open_failed"
    start(context, intent) {
      answer = it
      latch.countDown()
    }
    return if (latch.await(3, TimeUnit.SECONDS)) answer else "open_failed"
  }
}
