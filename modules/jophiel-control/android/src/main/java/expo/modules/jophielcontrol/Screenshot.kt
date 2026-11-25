package expo.modules.jophielcontrol

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.view.Display
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** A screenshot she can be shown, or why there isn't one. */
internal class Shot(val jpegBase64: String?, val width: Int, val height: Int, val missing: String?)

/**
 * The picture with numbers: Android's accessibility screenshot (Android 11+), with our banner
 * hidden for the moment it's taken, scaled to 720 px wide, a numbered box drawn on every item she
 * can act on, as JPEG. A secure window (banking, incognito) comes out black: text only.
 */
internal object Screenshot {
  /** Android refuses screenshots closer together than about a third of a second. */
  private const val INTERVAL_MS = 350L
  private const val TIMEOUT_MS = 3_000L
  /** Time for the banner to leave the screen before the capture. */
  private const val HIDE_MS = 80L

  private val executor = Executors.newSingleThreadExecutor()
  private var lastShotAt = 0L

  /** Distinct, high-contrast box colours (cycled by number). */
  private val COLORS = intArrayOf(
    Color.rgb(230, 25, 75),
    Color.rgb(0, 130, 200),
    Color.rgb(60, 180, 75),
    Color.rgb(245, 130, 48),
    Color.rgb(145, 30, 180),
    Color.rgb(0, 128, 128),
  )

  fun take(service: JophielControlService, items: List<Item>, scale: Double, appBounds: Box?): Shot {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return Shot(null, 0, 0, "not_supported")
    val bitmap = capture(service) ?: return Shot(null, 0, 0, "failed")
    try {
      val width = (bitmap.width * scale).toInt().coerceAtLeast(1)
      val height = (bitmap.height * scale).toInt().coerceAtLeast(1)
      val scaled = if (width == bitmap.width) bitmap else Bitmap.createScaledBitmap(bitmap, width, height, true)
      try {
        if (blank(scaled, appBounds?.scaled(scale))) return Shot(null, width, height, "secure")
        draw(scaled, items, scale)
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, ControlLogic.JPEG_QUALITY, out)
        return Shot(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), width, height, null)
      } finally {
        if (scaled !== bitmap) scaled.recycle()
      }
    } finally {
      bitmap.recycle()
    }
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun capture(service: JophielControlService): Bitmap? {
    service.banner.hideForCapture()
    try {
      SystemClock.sleep(HIDE_MS)
      return once(service) ?: run {
        // Too soon after the last one: wait out the interval and try once more.
        SystemClock.sleep(INTERVAL_MS)
        once(service)
      }
    } finally {
      service.banner.showAfterCapture()
    }
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun once(service: AccessibilityService): Bitmap? {
    val wait = lastShotAt + INTERVAL_MS - SystemClock.uptimeMillis()
    if (wait > 0) SystemClock.sleep(wait)
    lastShotAt = SystemClock.uptimeMillis()
    val done = CountDownLatch(1)
    var result: Bitmap? = null
    service.takeScreenshot(
      Display.DEFAULT_DISPLAY,
      executor,
      object : AccessibilityService.TakeScreenshotCallback {
        override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
          val buffer = screenshot.hardwareBuffer
          try {
            // Hardware bitmaps can't be drawn on or read pixel by pixel: copy to a software one.
            result = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)?.let { hw ->
              hw.copy(Bitmap.Config.ARGB_8888, true).also { hw.recycle() }
            }
          } catch (e: Exception) {
            result = null
          } finally {
            buffer.close()
            done.countDown()
          }
        }

        override fun onFailure(errorCode: Int) {
          done.countDown()
        }
      },
    )
    done.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)
    return result
  }

  /** Samples a grid over the front app (else the middle of the screen, past the status and nav bars). */
  private fun blank(bitmap: Bitmap, appBounds: Box?): Boolean {
    val full = Box(0, 0, bitmap.width, bitmap.height)
    val inset = Box(0, (bitmap.height * 0.08).toInt(), bitmap.width, (bitmap.height * 0.92).toInt())
    val area = appBounds?.let {
      Box(it.left.coerceAtLeast(0), it.top.coerceAtLeast(0), it.right.coerceAtMost(full.right), it.bottom.coerceAtMost(full.bottom))
    }?.takeUnless { it.isEmpty() } ?: inset
    val steps = 24
    val pixels = IntArray(steps * steps)
    var i = 0
    for (row in 0 until steps) {
      for (col in 0 until steps) {
        val x = (area.left + (area.width * (col + 0.5) / steps)).toInt().coerceIn(0, bitmap.width - 1)
        val y = (area.top + (area.height * (row + 0.5) / steps)).toInt().coerceIn(0, bitmap.height - 1)
        pixels[i++] = bitmap.getPixel(x, y)
      }
    }
    return ControlLogic.mostlyBlack(pixels)
  }

  private fun draw(bitmap: Bitmap, items: List<Item>, scale: Double) {
    val canvas = Canvas(bitmap)
    val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = 3f
    }
    val tag = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textSize = 20f
      isFakeBoldText = true
    }
    for (item in items) {
      val n = item.n ?: continue
      val b = item.box.scaled(scale)
      val color = COLORS[(n - 1) % COLORS.size]
      stroke.color = color
      tag.color = color
      canvas.drawRect(RectF(b.left.toFloat(), b.top.toFloat(), b.right.toFloat(), b.bottom.toFloat()), stroke)
      val label = n.toString()
      val w = text.measureText(label) + 8f
      val h = 24f
      // The number sits on the box's top-left corner, inside the picture.
      val x = b.left.toFloat().coerceIn(0f, (bitmap.width - w).coerceAtLeast(0f))
      val y = b.top.toFloat().coerceIn(0f, (bitmap.height - h).coerceAtLeast(0f))
      canvas.drawRect(RectF(x, y, x + w, y + h), tag)
      canvas.drawText(label, x + 4f, y + h - 5f, text)
    }
  }
}
