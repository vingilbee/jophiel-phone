package expo.modules.jophielcontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The screen her numbers belong to. */
internal class Screen(
  val id: String,
  val built: Built,
  val nodes: List<RawNode>,
  val handles: List<AccessibilityNodeInfo>,
  val scale: Double,
  /** The screenshot's size (or the screen's, scaled, when there's no picture). */
  val imageWidth: Int,
  val imageHeight: Int,
) {
  fun item(n: Int): Item? = built.items.firstOrNull { it.n == n }

  fun handle(item: Item): AccessibilityNodeInfo = handles[item.node]
}

/**
 * Carries out one request. By number through the item's own node (`ACTION_CLICK` and friends; a
 * node that won't click gets a real tap at its centre); by point and swipe with real gestures;
 * keys with global actions. Null: done; otherwise the failure reason.
 */
internal object Actor {
  private const val TAP_MS = 60L
  private const val LONG_PRESS_MS = 700L
  private val main = Handler(Looper.getMainLooper())

  fun run(service: JophielControlService, request: Request, screen: Screen?): String? {
    return when (request.action) {
      "tap" -> tap(service, numbered(screen, request) ?: return "element_gone", long = false)
      "long_press" -> tap(service, numbered(screen, request) ?: return "element_gone", long = true)
      "type_text" -> type(numbered(screen, request) ?: return "element_gone", request.text.orEmpty(), request.enter)
      "scroll" -> scroll(service, screen!!, request)
      "tap_point" -> point(service, screen!!, request)
      "swipe" -> swipe(service, screen!!, request)
      "press" -> press(service, request.key!!)
      else -> null
    }
  }

  private fun numbered(screen: Screen?, request: Request): AccessibilityNodeInfo? {
    val item = screen?.item(request.n ?: return null) ?: return null
    val node = screen.handle(item)
    // Gone from the screen since (closed, scrolled away, replaced).
    if (!node.refresh() || !node.isVisibleToUser) return null
    return node
  }

  private fun tap(service: JophielControlService, node: AccessibilityNodeInfo, long: Boolean): String? {
    val action = if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK
    if (node.performAction(action)) return null
    val rect = Rect()
    node.getBoundsInScreen(rect)
    if (rect.isEmpty) return "element_gone"
    return if (stroke(service, rect.centerX(), rect.centerY(), rect.centerX(), rect.centerY(), if (long) LONG_PRESS_MS else TAP_MS)) null else "gesture_failed"
  }

  private fun type(node: AccessibilityNodeInfo, text: String, enter: Boolean): String? {
    if (!node.isEditable) return "not_actionable"
    node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
    if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return "not_actionable"
    if (!enter) return null
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "not_supported"
    node.refresh()
    // The keyboard's go / send / search key needs the field to hold the input connection.
    if (!node.isFocused) node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    return if (node.performAction(AccessibilityAction.ACTION_IME_ENTER.id)) null else "not_actionable"
  }

  private fun scroll(service: JophielControlService, screen: Screen, request: Request): String? {
    val direction = request.direction!!
    val target: AccessibilityNodeInfo? = if (request.n != null) {
      val node = numbered(screen, request) ?: return "element_gone"
      scrollableSelfOrAncestor(node) ?: return "not_actionable"
    } else {
      ControlLogic.biggestList(screen.built.items, screen.nodes)?.let { screen.handle(it) }?.takeIf { it.refresh() }
    }
    if (target != null) {
      val directed = when (direction) {
        "down" -> AccessibilityAction.ACTION_SCROLL_DOWN
        "up" -> AccessibilityAction.ACTION_SCROLL_UP
        "left" -> AccessibilityAction.ACTION_SCROLL_LEFT
        else -> AccessibilityAction.ACTION_SCROLL_RIGHT
      }
      if (target.actionList.any { it.id == directed.id } && target.performAction(directed.id)) return null
      val plain = if (direction == "down" || direction == "right") AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
      if (target.performAction(plain)) return null
    }
    // Nothing that scrolls by itself (or it refused): a finger stroke over it, or over the screen.
    val rect = Rect()
    if (target != null) target.getBoundsInScreen(rect) else rect.set(0, 0, (screen.imageWidth / screen.scale).toInt(), (screen.imageHeight / screen.scale).toInt())
    if (rect.isEmpty) return "gesture_failed"
    val s = ControlLogic.scrollStroke(rect.toBox(), direction)
    return if (stroke(service, s[0], s[1], s[2], s[3], 350)) null else "gesture_failed"
  }

  private fun scrollableSelfOrAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
    var current: AccessibilityNodeInfo? = node
    var depth = 0
    while (current != null && depth < 30) {
      if (current.isScrollable) return current
      current = current.parent
      depth++
    }
    return null
  }

  private fun point(service: JophielControlService, screen: Screen, request: Request): String? {
    val (x, y) = ControlLogic.toScreen(request.x!!, request.y!!, screen.scale, screen.imageWidth, screen.imageHeight) ?: return "off_screen"
    return if (stroke(service, x, y, x, y, TAP_MS)) null else "gesture_failed"
  }

  private fun swipe(service: JophielControlService, screen: Screen, request: Request): String? {
    val from = ControlLogic.toScreen(request.x!!, request.y!!, screen.scale, screen.imageWidth, screen.imageHeight) ?: return "off_screen"
    val to = ControlLogic.toScreen(request.x2!!, request.y2!!, screen.scale, screen.imageWidth, screen.imageHeight) ?: return "off_screen"
    return if (stroke(service, from.first, from.second, to.first, to.second, request.ms)) null else "gesture_failed"
  }

  private fun press(service: AccessibilityService, key: String): String? {
    val action = when (key) {
      "back" -> AccessibilityService.GLOBAL_ACTION_BACK
      "home" -> AccessibilityService.GLOBAL_ACTION_HOME
      "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
      "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
      else -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
    }
    return if (service.performGlobalAction(action)) null else "gesture_failed"
  }

  /** A real finger: from one point to another (the same point: a tap or long press). Blocks until it's done. */
  private fun stroke(service: JophielControlService, x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long): Boolean {
    val path = Path().apply {
      moveTo(x1.coerceAtLeast(0).toFloat(), y1.coerceAtLeast(0).toFloat())
      if (x1 != x2 || y1 != y2) lineTo(x2.coerceAtLeast(0).toFloat(), y2.coerceAtLeast(0).toFloat())
    }
    val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build()
    service.banner.ownGesture(durationMs)
    val done = CountDownLatch(1)
    var ok = false
    val sent = service.dispatchGesture(
      gesture,
      object : AccessibilityService.GestureResultCallback() {
        override fun onCompleted(gestureDescription: GestureDescription?) {
          ok = true
          done.countDown()
        }

        override fun onCancelled(gestureDescription: GestureDescription?) {
          done.countDown()
        }
      },
      main,
    )
    if (!sent) return false
    done.await(durationMs + 3_000, TimeUnit.MILLISECONDS)
    return ok
  }
}
