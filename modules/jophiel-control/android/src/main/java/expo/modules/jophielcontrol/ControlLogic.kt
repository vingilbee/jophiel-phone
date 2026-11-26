package expo.modules.jophielcontrol

/**
 * Phase 9's pure parts (PLAN_PHASE_9.md): the args, item roles and labels, reading order and
 * numbering, point mapping, the takeover / newer-turn rule, the own-app rule, the all-black check
 * and the screen JSON. No Android types, so it's JUnit-tested
 * (`:jophiel-control:testDebugUnitTest`).
 */

/** A rectangle in real screen pixels (or screenshot pixels after `scaled`). */
internal data class Box(val left: Int, val top: Int, val right: Int, val bottom: Int) {
  val width: Int get() = right - left
  val height: Int get() = bottom - top
  val centerX: Int get() = (left + right) / 2
  val centerY: Int get() = (top + bottom) / 2
  val area: Long get() = if (isEmpty()) 0 else width.toLong() * height

  fun isEmpty(): Boolean = width <= 0 || height <= 0

  fun contains(x: Int, y: Int): Boolean = x >= left && x < right && y >= top && y < bottom

  fun scaled(scale: Double): Box =
    Box(Math.round(left * scale).toInt(), Math.round(top * scale).toInt(), Math.round(right * scale).toInt(), Math.round(bottom * scale).toInt())
}

/** One accessibility node, copied out of Android in walk order (parents before children). */
internal data class RawNode(
  /** Parent's index in the same list; -1 for a window's root. */
  val parent: Int,
  val className: String?,
  val text: String?,
  val description: String?,
  val hint: String?,
  /** The field shows its hint (its `text` is then the hint, not what was typed). */
  val showingHint: Boolean = false,
  val roleDescription: String? = null,
  val clickable: Boolean = false,
  val longClickable: Boolean = false,
  val editable: Boolean = false,
  val checkable: Boolean = false,
  val checked: Boolean = false,
  val scrollable: Boolean = false,
  val selected: Boolean = false,
  val enabled: Boolean = true,
  val focused: Boolean = false,
  val password: Boolean = false,
  /** Android says the user can see it, and no window above covers its centre. */
  val visible: Boolean = true,
  val box: Box,
)

/** An item of the screen she's shown. `node` is its index in the raw list (for acting on it). */
internal data class Item(
  val n: Int?,
  val role: String,
  /** Fields and plain text: what it says. */
  val text: String?,
  /** Everything else that's numbered: what it's called. */
  val label: String?,
  val hint: String?,
  val focused: Boolean,
  val checked: Boolean?,
  val selected: Boolean,
  val disabled: Boolean,
  val password: Boolean,
  val box: Box,
  val node: Int,
)

internal data class Built(val items: List<Item>, val truncated: Boolean)

/** A request from her, its args checked. */
internal data class Request(
  val action: String,
  val turn: String? = null,
  val screen: String? = null,
  val n: Int? = null,
  val text: String? = null,
  val enter: Boolean = false,
  val direction: String? = null,
  val x: Int? = null,
  val y: Int? = null,
  val x2: Int? = null,
  val y2: Int? = null,
  val ms: Long = ControlLogic.SWIPE_DEFAULT_MS,
  val key: String? = null,
  val waitMs: Long = 0,
  /** `gesture`: one [x1, y1, x2, y2] per finger, in screenshot pixels, all moving together for `ms`. */
  val fingers: List<IntArray>? = null,
  /** `tap_points`: one [x, y] per tap, in screenshot pixels, tapped one after another `gapMs` apart. */
  val points: List<IntArray>? = null,
  val gapMs: Long = ControlLogic.TAP_GAP_DEFAULT_MS,
)

internal object ControlLogic {
  const val MAX_ITEMS = 250
  const val MAX_CHARS = 12_000
  const val MAX_LABEL = 300
  const val MAX_TYPED = 4_000
  /** The screenshot's short edge: 720 px wide in portrait, 720 px tall in landscape. */
  const val IMAGE_SHORT_EDGE = 720
  /** The coordinate grid (`wantsGrid`): a line every this many picture pixels, labelled at the edges. */
  const val GRID_STEP = 100
  private const val GRID_MAX_ITEMS = 3
  private const val GRID_COVER_SHARE = 0.5
  const val JPEG_QUALITY = 70
  const val MAX_WAIT_MS = 5_000L
  const val SWIPE_DEFAULT_MS = 300L
  /** `tap_points`: at most this many taps in one action, this far apart by default (0 to `TAP_GAP_MAX_MS`). */
  const val MAX_POINTS = 20
  const val TAP_GAP_DEFAULT_MS = 150L
  const val TAP_GAP_MAX_MS = 1_000L
  const val SWIPE_MIN_MS = 100L
  const val SWIPE_MAX_MS = 2_000L
  /** The screen counts as settled after this long without a window event… */
  const val QUIET_MS = 300L
  /** …or this long after the action, whichever comes first. */
  const val SETTLE_MAX_MS = 2_000L
  /** The banner (and her control) goes this long after her last action. */
  const val IDLE_MS = 20_000L
  /** A takeover without a `turn` blocks turn-less actions this long. */
  const val NO_TURN_BLOCK_MS = 30_000L
  /** Touches during her own gesture and this long after aren't yours. */
  const val OWN_TOUCH_GRACE_MS = 300L
  /** Fingers in one `gesture` (Android allows at least 10 strokes; she gets 5). */
  const val MAX_FINGERS = 5

  val ACTIONS = setOf("read_screen", "tap", "long_press", "type_text", "scroll", "tap_point", "tap_points", "swipe", "gesture", "press", "end_control")
  val DIRECTIONS = setOf("up", "down", "left", "right")
  val KEYS = setOf("back", "home", "recents", "notifications", "quick_settings")
  /** The actions that act on a given screen (its numbers or its pixels). */
  private val ON_SCREEN = setOf("tap", "long_press", "type_text", "scroll", "tap_point", "tap_points", "swipe", "gesture")

  fun needsScreen(action: String): Boolean = action in ON_SCREEN

  // ---- Args ----

  private fun string(value: Any?): String? = (value as? String)?.trim()?.takeIf { it.isNotEmpty() }

  /** A whole number (JS sends every number as a double). */
  private fun whole(value: Any?): Long? {
    val number = (value as? Number)?.toDouble() ?: return null
    if (number.isNaN() || number.isInfinite() || number != Math.floor(number)) return null
    if (number < Int.MIN_VALUE || number > Int.MAX_VALUE) return null
    return number.toLong()
  }

  /** A pixel of the screenshot: any finite number, rounded (bounds are checked against the screen). */
  private fun pixel(value: Any?): Int? {
    val number = (value as? Number)?.toDouble() ?: return null
    if (number.isNaN() || number.isInfinite() || number < -100_000 || number > 100_000) return null
    return Math.round(number).toInt()
  }

  /** The backend's id of the reply turn: a string, or a number sent as one. */
  private fun turn(value: Any?): String? = when (value) {
    is String -> value.trim().takeIf { it.isNotEmpty() }?.take(200)
    is Number -> whole(value)?.toString()
    else -> null
  }

  /** `args` checked for `action`; null → `failed`, `bad_args` (or `unknown_action`, see `ACTIONS`). */
  fun parse(action: String, args: Map<String, Any?>): Request? {
    if (action !in ACTIONS) return null
    val base = Request(action = action, turn = turn(args["turn"]))
    val screen = string(args["screen"])
    if (needsScreen(action) && screen == null) return null
    return when (action) {
      "read_screen" -> {
        val wait = args["wait_ms"]
        if (wait == null) base else base.copy(waitMs = (whole(wait) ?: return null).coerceIn(0, MAX_WAIT_MS))
      }
      "tap", "long_press" -> base.copy(screen = screen, n = number(args["n"]) ?: return null)
      "type_text" -> {
        val text = args["text"] as? String ?: return null
        if (text.codePointCount(0, text.length) > MAX_TYPED) return null
        val enter = args["enter"]
        if (enter != null && enter !is Boolean) return null
        base.copy(screen = screen, n = number(args["n"]) ?: return null, text = text, enter = enter == true)
      }
      "scroll" -> {
        val direction = string(args["direction"])?.lowercase()
        if (direction !in DIRECTIONS) return null
        val n = args["n"]
        base.copy(screen = screen, direction = direction, n = if (n == null) null else number(n) ?: return null)
      }
      "tap_point" -> base.copy(screen = screen, x = pixel(args["x"]) ?: return null, y = pixel(args["y"]) ?: return null)
      "tap_points" -> {
        val list = args["points"] as? List<*> ?: return null
        if (list.isEmpty() || list.size > MAX_POINTS) return null
        val points = list.map { point ->
          val xy = point as? List<*> ?: return null
          if (xy.size != 2) return null
          IntArray(2) { i -> pixel(xy[i]) ?: return null }
        }
        val gap = args["gap_ms"]
        base.copy(
          screen = screen,
          points = points,
          gapMs = if (gap == null) TAP_GAP_DEFAULT_MS else (whole(gap) ?: return null).coerceIn(0, TAP_GAP_MAX_MS),
        )
      }
      "swipe" -> {
        val ms = args["ms"]
        base.copy(
          screen = screen,
          x = pixel(args["x1"]) ?: return null,
          y = pixel(args["y1"]) ?: return null,
          x2 = pixel(args["x2"]) ?: return null,
          y2 = pixel(args["y2"]) ?: return null,
          ms = if (ms == null) SWIPE_DEFAULT_MS else (whole(ms) ?: return null).coerceIn(SWIPE_MIN_MS, SWIPE_MAX_MS),
        )
      }
      "gesture" -> {
        val list = args["fingers"] as? List<*> ?: return null
        if (list.isEmpty() || list.size > MAX_FINGERS) return null
        val fingers = list.map { finger ->
          val points = finger as? List<*> ?: return null
          if (points.size != 4) return null
          IntArray(4) { i -> pixel(points[i]) ?: return null }
        }
        val ms = args["ms"]
        base.copy(
          screen = screen,
          fingers = fingers,
          ms = if (ms == null) SWIPE_DEFAULT_MS else (whole(ms) ?: return null).coerceIn(SWIPE_MIN_MS, SWIPE_MAX_MS),
        )
      }
      "press" -> {
        val key = string(args["key"])?.lowercase()
        if (key !in KEYS) return null
        base.copy(key = key)
      }
      else -> base
    }
  }

  private fun number(value: Any?): Int? = whole(value)?.takeIf { it >= 1 }?.toInt()

  // ---- The rules ----

  /**
   * Inside the Jophiel app she can read but not act: everything except `read_screen`,
   * `end_control` and `press` back / home answers `own_app`. True: allowed.
   */
  fun allowedInFront(request: Request, frontPackage: String?, ownPackage: String): Boolean {
    if (frontPackage != ownPackage) return true
    return when (request.action) {
      "read_screen", "end_control" -> true
      "press" -> request.key == "back" || request.key == "home"
      else -> false
    }
  }

  /** The screen has settled: no window event for `QUIET_MS` since the action (or since the last event), or `SETTLE_MAX_MS` passed. */
  fun settled(now: Long, actionAt: Long, lastEventAt: Long): Boolean =
    now - maxOf(actionAt, lastEventAt) >= QUIET_MS || now - actionAt >= SETTLE_MAX_MS

  /**
   * Screenshot size over the real size: the short edge comes out 720 (or the screen's own when it's
   * smaller), whichever way the phone is held. Scaling by the width made a landscape game ~720x330,
   * too small to point at its buttons.
   */
  fun scaleFor(screenWidth: Int, screenHeight: Int): Double {
    val short = minOf(screenWidth, screenHeight)
    return if (short > IMAGE_SHORT_EDGE) IMAGE_SHORT_EDGE.toDouble() / short else 1.0
  }

  /**
   * Whether her picture gets a coordinate grid: when there's (almost) nothing numbered to act on, she taps by
   * pixel, and a point is read far better off labelled lines than guessed on a bare picture. That's no numbered
   * item, or only a few with one covering most of the picture (a game drawn as one big view).
   */
  fun wantsGrid(items: List<Item>, scale: Double, imageWidth: Int, imageHeight: Int): Boolean {
    val numbered = items.filter { it.n != null }
    if (numbered.isEmpty()) return true
    if (numbered.size > GRID_MAX_ITEMS) return false
    val picture = imageWidth.toLong() * imageHeight
    if (picture <= 0) return false
    return numbered.any { item ->
      val b = item.box.scaled(scale)
      val w = (minOf(b.right, imageWidth) - maxOf(b.left, 0)).coerceAtLeast(0)
      val h = (minOf(b.bottom, imageHeight) - maxOf(b.top, 0)).coerceAtLeast(0)
      w.toLong() * h >= picture * GRID_COVER_SHARE
    }
  }

  /** Where the grid's lines sit along one edge of the picture: every `GRID_STEP` pixels, inside it. */
  fun gridLines(size: Int, step: Int = GRID_STEP): List<Int> =
    if (size <= 0 || step <= 0) emptyList() else (step until size step step).toList()

  /** A screenshot pixel to a real screen pixel; null when it's outside the screenshot (`off_screen`). */
  fun toScreen(x: Int, y: Int, scale: Double, imageWidth: Int, imageHeight: Int): Pair<Int, Int>? {
    if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) return null
    return Pair((x / scale).toInt(), (y / scale).toInt())
  }

  /**
   * A finger stroke that scrolls `box` in `direction` (content moves so you see what's that way:
   * "down" drags the finger up), over the middle 60% of the box.
   */
  fun scrollStroke(box: Box, direction: String): IntArray {
    val x = box.centerX
    val y = box.centerY
    val dy = (box.height * 0.3).toInt()
    val dx = (box.width * 0.3).toInt()
    return when (direction) {
      "down" -> intArrayOf(x, y + dy, x, y - dy)
      "up" -> intArrayOf(x, y - dy, x, y + dy)
      "right" -> intArrayOf(x + dx, y, x - dx, y)
      else -> intArrayOf(x - dx, y, x + dx, y)
    }
  }

  /** A capture that's (almost) entirely black: a secure window Android blanked out. */
  fun mostlyBlack(pixels: IntArray, share: Double = 0.98): Boolean {
    if (pixels.isEmpty()) return false
    val dark = pixels.count { p ->
      val r = (p shr 16) and 0xFF
      val g = (p shr 8) and 0xFF
      val b = p and 0xFF
      maxOf(r, maxOf(g, b)) <= 10
    }
    return dark >= pixels.size * share
  }

  /** A node's centre is covered by a window above it (a dialog, the shade, the keyboard). */
  fun covered(box: Box, above: List<Box>): Boolean = above.any { it.contains(box.centerX, box.centerY) }

  // ---- Items ----

  fun actionable(node: RawNode): Boolean =
    node.clickable || node.longClickable || node.editable || node.checkable || node.scrollable

  private fun simple(className: String?): String = className?.substringAfterLast('.')?.substringAfterLast('$') ?: ""

  fun role(node: RawNode): String {
    val cls = simple(node.className)
    val described = node.roleDescription?.trim()?.lowercase()
    return when {
      node.editable || cls.endsWith("EditText") || cls.endsWith("AutoCompleteTextView") -> "text_field"
      cls.contains("Switch") || cls.endsWith("ToggleButton") || described == "switch" -> "switch"
      cls.endsWith("RadioButton") || described == "radio button" -> "radio"
      cls.endsWith("CheckBox") || described == "checkbox" -> "checkbox"
      described == "tab" || cls == "TabView" || cls.endsWith("TabView") -> "tab"
      described == "link" -> "link"
      node.scrollable && !node.clickable -> "list"
      cls.endsWith("Button") || described == "button" -> "button"
      actionable(node) && cls.endsWith("ImageView") -> "button"
      node.checkable -> "checkbox"
      actionable(node) -> "item"
      cls.endsWith("ImageView") || described == "image" -> "image"
      else -> "text"
    }
  }

  private fun clean(value: String?): String? = value?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotEmpty() }

  private fun clip(value: String?, max: Int = MAX_LABEL): String? {
    val text = clean(value) ?: return null
    return if (text.length <= max) text else text.take(max - 1) + "…"
  }

  /** What a field holds (empty while it shows its hint; Android hides a password's text itself). */
  private fun fieldText(node: RawNode): String {
    if (node.showingHint) return ""
    val text = clean(node.text) ?: return ""
    return if (node.hint != null && text == clean(node.hint)) "" else text
  }

  /**
   * The screen as she's shown it, in reading order (top to bottom, then left to right). Actionable
   * nodes get numbers; a numbered row with no text of its own is named by the text inside it
   * (which then isn't repeated as plain text). At most `maxItems` items and `maxChars` characters.
   */
  fun build(nodes: List<RawNode>, maxItems: Int = MAX_ITEMS, maxChars: Int = MAX_CHARS): Built {
    val children = HashMap<Int, MutableList<Int>>()
    nodes.forEachIndexed { i, node -> if (node.parent >= 0) children.getOrPut(node.parent) { mutableListOf() }.add(i) }
    val shown = BooleanArray(nodes.size) { nodes[it].visible && !nodes[it].box.isEmpty() }
    val isAction = BooleanArray(nodes.size) { shown[it] && actionable(nodes[it]) }
    val consumed = BooleanArray(nodes.size)
    val labels = arrayOfNulls<String>(nodes.size)

    /** Text of the plain nodes under `index`, stopping at numbered ones (they speak for themselves). */
    fun inner(index: Int, into: MutableList<Int>) {
      for (child in children[index].orEmpty()) {
        if (isAction[child]) continue
        if (shown[child] && (clean(nodes[child].text) != null || clean(nodes[child].description) != null)) into.add(child)
        inner(child, into)
      }
    }

    for (i in nodes.indices) {
      if (!isAction[i]) continue
      val node = nodes[i]
      val own = clean(node.description) ?: if (node.editable) null else clean(node.text)
      if (own != null || node.editable || (node.scrollable && !node.clickable)) {
        labels[i] = own
        continue
      }
      val parts = mutableListOf<Int>()
      inner(i, parts)
      val words = parts.mapNotNull { clean(nodes[it].description) ?: clean(nodes[it].text) }.distinct()
      if (words.isNotEmpty()) {
        labels[i] = words.joinToString(" · ")
        parts.forEach { consumed[it] = true }
      }
    }

    /** The label of the closest numbered ancestor (a child repeating it is dropped). */
    fun ancestorLabel(index: Int): String? {
      var p = nodes[index].parent
      while (p >= 0) {
        if (isAction[p]) return labels[p]
        p = nodes[p].parent
      }
      return null
    }

    val order = nodes.indices.filter { shown[it] }.sortedWith(compareBy({ nodes[it].box.top }, { nodes[it].box.left }))
    val items = mutableListOf<Item>()
    var chars = 0
    var next = 1
    var truncated = false
    for (i in order) {
      val node = nodes[i]
      val item = if (isAction[i]) {
        val role = role(node)
        val field = role == "text_field"
        Item(
          n = 0,
          role = role,
          text = if (field) fieldText(node) else null,
          label = if (field) clip(node.description) else clip(labels[i]),
          hint = clip(node.hint),
          focused = node.focused,
          checked = if (node.checkable) node.checked else null,
          selected = node.selected,
          disabled = !node.enabled,
          password = node.password,
          box = node.box,
          node = i,
        )
      } else {
        if (consumed[i]) continue
        val words = clean(node.text) ?: clean(node.description) ?: continue
        if (words == ancestorLabel(i)) continue
        Item(null, role(node).let { if (it == "image") it else "text" }, clip(words, 2_000), null, null, false, null, node.selected, false, false, node.box, i)
      }
      val cost = (item.text?.length ?: 0) + (item.label?.length ?: 0) + (item.hint?.length ?: 0)
      if (items.size >= maxItems || chars + cost > maxChars) {
        truncated = true
        break
      }
      chars += cost
      items.add(if (item.n == null) item else item.copy(n = next++))
    }
    return Built(items, truncated)
  }

  /** The biggest scrollable item on a screen (the default list for `scroll`), or null. */
  fun biggestList(items: List<Item>, nodes: List<RawNode>): Item? =
    items.filter { it.n != null && nodes[it.node].scrollable }.maxByOrNull { it.box.area }

  // ---- JSON ----

  fun quote(value: String): String {
    val out = StringBuilder(value.length + 2).append('"')
    for (c in value) {
      when (c) {
        '"' -> out.append("\\\"")
        '\\' -> out.append("\\\\")
        '\n' -> out.append("\\n")
        '\r' -> out.append("\\r")
        '\t' -> out.append("\\t")
        ' ' -> out.append("\\u2028")
        ' ' -> out.append("\\u2029")
        else -> if (c < ' ') out.append(String.format("\\u%04x", c.code)) else out.append(c)
      }
    }
    return out.append('"').toString()
  }

  fun itemJson(item: Item, scale: Double): String {
    val fields = mutableListOf<String>()
    if (item.n != null) fields.add("\"n\":${item.n}")
    fields.add("\"role\":${quote(item.role)}")
    if (item.text != null) fields.add("\"text\":${quote(item.text)}")
    if (item.label != null) fields.add("\"label\":${quote(item.label)}")
    if (item.hint != null) fields.add("\"hint\":${quote(item.hint)}")
    if (item.focused) fields.add("\"focused\":true")
    if (item.checked != null) fields.add("\"checked\":${item.checked}")
    if (item.selected) fields.add("\"selected\":true")
    if (item.disabled) fields.add("\"disabled\":true")
    if (item.password) fields.add("\"password\":true")
    if (item.n != null) {
      val b = item.box.scaled(scale)
      fields.add("\"box\":[${b.left},${b.top},${b.width},${b.height}]")
    }
    return fields.joinToString(",", "{", "}")
  }

  /** `data.screen`. `imageMissing`: secure, not_supported or failed (then `jpegBase64` is null). */
  fun screenJson(
    id: String,
    app: String?,
    packageName: String?,
    keyboard: Boolean,
    jpegBase64: String?,
    imageWidth: Int,
    imageHeight: Int,
    imageMissing: String?,
    built: Built,
    scale: Double,
    grid: Int? = null,
  ): String {
    val out = StringBuilder(256 + (jpegBase64?.length ?: 0))
    out.append("{\"id\":").append(quote(id))
    out.append(",\"app\":").append(app?.let(::quote) ?: "null")
    out.append(",\"package\":").append(packageName?.let(::quote) ?: "null")
    out.append(",\"keyboard\":").append(keyboard)
    out.append(",\"image\":")
    if (jpegBase64 != null) out.append("{\"jpeg_base64\":").append(quote(jpegBase64)).append(",\"width\":$imageWidth,\"height\":$imageHeight")
      .append(if (grid != null) ",\"grid\":$grid}" else "}")
    else out.append("null")
    out.append(",\"image_missing\":").append(imageMissing?.let(::quote) ?: "null")
    out.append(",\"items\":[")
    built.items.forEachIndexed { i, item ->
      if (i > 0) out.append(',')
      out.append(itemJson(item, scale))
    }
    out.append(']')
    if (built.truncated) out.append(",\"truncated\":true")
    return out.append('}').toString()
  }
}

/**
 * Who's in charge, per reply turn. Stop on the banner takes over the turn she was acting in: every further
 * action of that turn answers `taken_over`. A turn older than the newest one seen is over too (your
 * new words started another). Without a `turn`, a takeover blocks turn-less actions for 30 s.
 */
internal class TurnGate(private val noTurnBlockMs: Long = ControlLogic.NO_TURN_BLOCK_MS) {
  private val seen = ArrayDeque<String>()
  private val takenOver = LinkedHashSet<String>()
  private var noTurnBlockedUntil = Long.MIN_VALUE
  /** The turn of the last action let through (null: it had none). */
  private var current: String? = null

  /** True: the action may go ahead (a turn not seen before becomes the newest). */
  fun admit(turn: String?, now: Long): Boolean {
    if (turn == null) {
      if (now < noTurnBlockedUntil) return false
      current = null
      return true
    }
    if (turn in takenOver) return false
    if (turn !in seen) {
      seen.addLast(turn)
      while (seen.size > 64) seen.removeFirst()
    } else if (seen.last() != turn) {
      return false
    }
    current = turn
    return true
  }

  /** The turn is over (taken over, or a newer one seen) without letting anything through or recording it. */
  fun over(turn: String?, now: Long): Boolean {
    if (turn == null) return now < noTurnBlockedUntil
    return turn in takenOver || (turn in seen && seen.last() != turn)
  }

  /** You tapped Stop: the current turn is over. */
  fun takeOver(now: Long) {
    val turn = current
    if (turn == null) {
      noTurnBlockedUntil = now + noTurnBlockMs
    } else {
      takenOver.add(turn)
      while (takenOver.size > 64) takenOver.remove(takenOver.first())
    }
  }
}
