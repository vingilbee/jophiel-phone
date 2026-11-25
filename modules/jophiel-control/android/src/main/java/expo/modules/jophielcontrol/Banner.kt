package expo.modules.jophielcontrol

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * "Jophiel is using your phone · Stop", at the top of the screen while she's in control. Drawn by
 * the accessibility service itself (no extra permission). It also watches for touches outside it:
 * your touch anywhere (or Stop) calls `onTakeover`. Touches during her own gesture and shortly
 * after aren't yours (`ownGesture`). Hidden for the moment a screenshot is taken.
 */
internal class Banner(private val service: AccessibilityService, private val onTakeover: (by: String) -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private val windows = service.getSystemService(WindowManager::class.java)
  private var view: View? = null
  private var params: WindowManager.LayoutParams? = null

  /** Uptime ms until which touches are hers, not yours. */
  @Volatile
  private var ownUntil = 0L

  @Volatile
  var showing = false
    private set

  fun show() = onMain {
    if (view != null) return@onMain
    val banner = build()
    val layout = WindowManager.LayoutParams(
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
        WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
      y = dp(36f).toInt()
    }
    try {
      windows.addView(banner, layout)
      view = banner
      params = layout
      showing = true
    } catch (e: Exception) {
      view = null
    }
  }

  /** Gone (control ended): `end_control`, the idle timeout, your touch, a switch going off. */
  fun remove() = onMain {
    val banner = view ?: return@onMain
    view = null
    params = null
    showing = false
    runCatching { windows.removeView(banner) }
  }

  /**
   * Her gesture is about to run for `durationMs` (called off the main thread; returns once the
   * banner lets touches through, so a tap where it sits reaches the app, not Stop). Touches until
   * shortly after aren't taken for yours.
   */
  fun ownGesture(durationMs: Long) {
    ownUntil = SystemClock.uptimeMillis() + durationMs + ControlLogic.OWN_TOUCH_GRACE_MS
    onMainAndWait { setTouchable(false) }
    main.postDelayed({ if (SystemClock.uptimeMillis() >= ownUntil) setTouchable(true) }, durationMs + ControlLogic.OWN_TOUCH_GRACE_MS + 10)
  }

  /** Blocks until the banner is invisible (called off the main thread). */
  fun hideForCapture() = onMainAndWait { view?.visibility = View.INVISIBLE }

  fun showAfterCapture() = onMain { view?.visibility = View.VISIBLE }

  private fun setTouchable(touchable: Boolean) = onMain {
    val banner = view ?: return@onMain
    val layout = params ?: return@onMain
    layout.flags = if (touchable) {
      layout.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
    } else {
      layout.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    }
    runCatching { windows.updateViewLayout(banner, layout) }
  }

  @SuppressLint("ClickableViewAccessibility", "SetTextI18n")
  private fun build(): View {
    val row = LinearLayout(service).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      val padH = dp(16f).toInt()
      val padV = dp(8f).toInt()
      setPadding(padH, padV, dp(6f).toInt(), padV)
      background = GradientDrawable().apply {
        cornerRadius = dp(24f)
        setColor(Color.argb(235, 32, 26, 23))
      }
      elevation = dp(6f)
    }
    val message = TextView(service).apply {
      text = "Jophiel is using your phone"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    }
    val stop = TextView(service).apply {
      text = "Stop"
      setTextColor(Color.rgb(255, 181, 154))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      typeface = Typeface.DEFAULT_BOLD
      val pad = dp(10f).toInt()
      setPadding(pad, pad / 2, pad, pad / 2)
      contentDescription = "Stop Jophiel using your phone"
      setOnClickListener { touched("stop") }
    }
    val dot = TextView(service).apply {
      text = "  ·  "
      setTextColor(Color.argb(160, 255, 255, 255))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    }
    row.addView(message)
    row.addView(dot)
    row.addView(stop)
    row.setOnTouchListener { _, event ->
      if (event.actionMasked == MotionEvent.ACTION_OUTSIDE) touched("touch")
      false
    }
    return row
  }

  private fun touched(by: String) {
    if (SystemClock.uptimeMillis() < ownUntil) return
    onTakeover(by)
  }

  private fun dp(value: Float): Float = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, service.resources.displayMetrics)

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }

  private fun onMainAndWait(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    val done = CountDownLatch(1)
    main.post {
      try {
        block()
      } finally {
        done.countDown()
      }
    }
    done.await(1, TimeUnit.SECONDS)
  }
}
