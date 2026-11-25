package expo.modules.jophielcontrol

import android.accessibilityservice.AccessibilityService
import android.content.pm.PackageManager
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo

/** One read of the screen: the raw nodes (with Android's handles, for acting) and what's around them. */
internal class Reading(
  val nodes: List<RawNode>,
  val handles: List<AccessibilityNodeInfo>,
  val keyboard: Boolean,
  val packageName: String?,
  val app: String?,
  /** The front app window's bounds (where the all-black check looks). */
  val appBounds: Box?,
)

/**
 * Walks the interactive windows, topmost first (system dialogs, the notification shade, the app;
 * never the keyboard or our banner), into raw nodes. A node whose centre a window above covers
 * isn't shown (the app behind a dialog, the list behind the keyboard).
 */
internal object ScreenReader {
  private const val MAX_NODES = 3_000
  private const val MAX_DEPTH = 80
  private const val ROLE_DESCRIPTION = "AccessibilityNodeInfo.roleDescription"

  fun read(service: AccessibilityService): Reading {
    val windows = runCatching { service.windows }.getOrNull().orEmpty().sortedByDescending { it.layer }
    val nodes = ArrayList<RawNode>()
    val handles = ArrayList<AccessibilityNodeInfo>()
    val above = ArrayList<Box>()
    var keyboard = false
    var appBounds: Box? = null
    val rect = Rect()

    for (window in windows) {
      when (window.type) {
        AccessibilityWindowInfo.TYPE_INPUT_METHOD -> {
          keyboard = true
          window.getBoundsInScreen(rect)
          above.add(rect.toBox())
          continue
        }
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY, AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> continue
      }
      val root = window.root ?: continue
      window.getBoundsInScreen(rect)
      val windowBox = rect.toBox()
      if (window.type == AccessibilityWindowInfo.TYPE_APPLICATION && appBounds == null) appBounds = windowBox
      val coveredBy = ArrayList(above)
      val before = nodes.size
      walk(root, -1, 0, coveredBy, nodes, handles)
      // A window that showed nothing (a transparent overlay) doesn't hide what's under it.
      if (nodes.subList(before, nodes.size).any { it.visible }) above.add(windowBox)
      if (nodes.size >= MAX_NODES) break
    }

    val active = runCatching { service.rootInActiveWindow }.getOrNull()
    val packageName = active?.packageName?.toString()
      ?: windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }?.root?.packageName?.toString()
    return Reading(nodes, handles, keyboard, packageName, packageName?.let { label(service.packageManager, it) }, appBounds)
  }

  /** The package of the app in front right now (for the own-app rule). */
  fun frontPackage(service: AccessibilityService): String? =
    runCatching { service.rootInActiveWindow?.packageName?.toString() }.getOrNull()

  private fun walk(
    node: AccessibilityNodeInfo,
    parent: Int,
    depth: Int,
    above: List<Box>,
    nodes: MutableList<RawNode>,
    handles: MutableList<AccessibilityNodeInfo>,
  ) {
    if (nodes.size >= MAX_NODES || depth > MAX_DEPTH) return
    val rect = Rect()
    node.getBoundsInScreen(rect)
    val box = rect.toBox()
    val index = nodes.size
    nodes.add(
      RawNode(
        parent = parent,
        className = node.className?.toString(),
        text = node.text?.toString(),
        description = node.contentDescription?.toString(),
        hint = node.hintText?.toString(),
        showingHint = node.isShowingHintText,
        roleDescription = runCatching { node.extras?.getCharSequence(ROLE_DESCRIPTION)?.toString() }.getOrNull(),
        clickable = node.isClickable,
        longClickable = node.isLongClickable,
        editable = node.isEditable,
        checkable = node.isCheckable,
        checked = node.isChecked,
        scrollable = node.isScrollable,
        selected = node.isSelected,
        enabled = node.isEnabled,
        focused = node.isFocused,
        password = node.isPassword,
        visible = node.isVisibleToUser && !ControlLogic.covered(box, above),
        box = box,
      ),
    )
    handles.add(node)
    for (i in 0 until node.childCount) {
      val child = runCatching { node.getChild(i) }.getOrNull() ?: continue
      walk(child, index, depth + 1, above, nodes, handles)
    }
  }

  private fun label(pm: PackageManager, packageName: String): String = try {
    pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
  } catch (e: Exception) {
    packageName
  }
}

internal fun Rect.toBox() = Box(left, top, right, bottom)
