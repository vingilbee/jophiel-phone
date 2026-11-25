package expo.modules.jophielcontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ControlLogicTest {
  private fun node(
    parent: Int,
    box: Box,
    cls: String? = "android.widget.TextView",
    text: String? = null,
    desc: String? = null,
    clickable: Boolean = false,
    editable: Boolean = false,
    scrollable: Boolean = false,
    checkable: Boolean = false,
    checked: Boolean = false,
    hint: String? = null,
    showingHint: Boolean = false,
    visible: Boolean = true,
    enabled: Boolean = true,
  ) = RawNode(
    parent = parent,
    className = cls,
    text = text,
    description = desc,
    hint = hint,
    showingHint = showingHint,
    clickable = clickable,
    editable = editable,
    scrollable = scrollable,
    checkable = checkable,
    checked = checked,
    enabled = enabled,
    visible = visible,
    box = box,
  )

  // ---- Args ----

  @Test
  fun argsAreCheckedPerAction() {
    assertEquals(Request("read_screen"), ControlLogic.parse("read_screen", emptyMap()))
    assertEquals(5_000L, ControlLogic.parse("read_screen", mapOf("wait_ms" to 9_000.0))!!.waitMs)
    assertNull(ControlLogic.parse("read_screen", mapOf("wait_ms" to "soon")))

    val tap = ControlLogic.parse("tap", mapOf("screen" to "s3", "n" to 2.0, "turn" to "t1"))!!
    assertEquals("s3", tap.screen)
    assertEquals(2, tap.n)
    assertEquals("t1", tap.turn)
    assertNull(ControlLogic.parse("tap", mapOf("n" to 2.0)))
    assertNull(ControlLogic.parse("tap", mapOf("screen" to "s3", "n" to 2.5)))
    assertNull(ControlLogic.parse("tap", mapOf("screen" to "s3", "n" to 0.0)))
    assertEquals("42", ControlLogic.parse("tap", mapOf("screen" to "s3", "n" to 1.0, "turn" to 42.0))!!.turn)

    val typed = ControlLogic.parse("type_text", mapOf("screen" to "s1", "n" to 1.0, "text" to "", "enter" to true))!!
    assertEquals("", typed.text)
    assertTrue(typed.enter)
    assertNull(ControlLogic.parse("type_text", mapOf("screen" to "s1", "n" to 1.0)))
    assertNull(ControlLogic.parse("type_text", mapOf("screen" to "s1", "n" to 1.0, "text" to "x", "enter" to "yes")))

    assertEquals("down", ControlLogic.parse("scroll", mapOf("screen" to "s1", "direction" to "Down"))!!.direction)
    assertNull(ControlLogic.parse("scroll", mapOf("screen" to "s1", "direction" to "sideways")))

    val swipe = ControlLogic.parse("swipe", mapOf("screen" to "s1", "x1" to 1.0, "y1" to 2.0, "x2" to 3.4, "y2" to 4.6, "ms" to 50.0))!!
    assertEquals(listOf(1, 2, 3, 5), listOf(swipe.x, swipe.y, swipe.x2, swipe.y2))
    assertEquals(100L, swipe.ms)

    val pinch = ControlLogic.parse("gesture", mapOf("screen" to "s1", "ms" to 500.0,
      "fingers" to listOf(listOf(300.0, 700.0, 100.0, 500.0), listOf(400.0, 800.0, 600.4, 999.6))))!!
    assertEquals(listOf(listOf(300, 700, 100, 500), listOf(400, 800, 600, 1000)), pinch.fingers!!.map { it.toList() })
    assertEquals(500L, pinch.ms)
    assertNull(ControlLogic.parse("gesture", mapOf("screen" to "s1", "fingers" to emptyList<Any>())))
    assertNull(ControlLogic.parse("gesture", mapOf("screen" to "s1", "fingers" to listOf(listOf(1.0, 2.0, 3.0)))))
    assertNull(ControlLogic.parse("gesture", mapOf("screen" to "s1", "fingers" to List(6) { listOf(1.0, 1.0, 1.0, 1.0) })))
    assertNull(ControlLogic.parse("gesture", mapOf("fingers" to listOf(listOf(1.0, 1.0, 1.0, 1.0)))))

    assertEquals("home", ControlLogic.parse("press", mapOf("key" to "home"))!!.key)
    assertNull(ControlLogic.parse("press", mapOf("key" to "power")))
    assertNotNull(ControlLogic.parse("end_control", emptyMap()))
    assertNull(ControlLogic.parse("launch_rockets", emptyMap()))
  }

  // ---- Rules ----

  @Test
  fun insideHerOwnAppSheCanOnlyReadAndLeave() {
    val own = "com.jophiel.app"
    assertTrue(ControlLogic.allowedInFront(Request("tap", screen = "s1", n = 1), "com.spotify.music", own))
    assertFalse(ControlLogic.allowedInFront(Request("tap", screen = "s1", n = 1), own, own))
    assertFalse(ControlLogic.allowedInFront(Request("type_text", screen = "s1", n = 1, text = "x"), own, own))
    assertTrue(ControlLogic.allowedInFront(Request("read_screen"), own, own))
    assertTrue(ControlLogic.allowedInFront(Request("press", key = "back"), own, own))
    assertTrue(ControlLogic.allowedInFront(Request("press", key = "home"), own, own))
    assertFalse(ControlLogic.allowedInFront(Request("press", key = "quick_settings"), own, own))
  }

  @Test
  fun yourTouchEndsHerTurnAndANewerTurnEndsTheOldOne() {
    val gate = TurnGate()
    assertTrue(gate.admit("t1", 0))
    assertTrue(gate.admit("t1", 1))
    gate.takeOver(2)
    assertFalse(gate.admit("t1", 3))
    assertTrue(gate.over("t1", 3))
    // Asking again is a new turn: she may start again.
    assertTrue(gate.admit("t2", 4))
    // Your new words started t3: what's left of t2 is over.
    assertTrue(gate.admit("t3", 5))
    assertFalse(gate.admit("t2", 6))
    assertTrue(gate.admit("t3", 7))
    assertFalse(gate.over("t3", 7))
  }

  @Test
  fun aTakeoverWithoutATurnBlocksFor30Seconds() {
    val gate = TurnGate()
    assertTrue(gate.admit(null, 0))
    gate.takeOver(1_000)
    assertFalse(gate.admit(null, 30_999))
    assertTrue(gate.over(null, 30_999))
    assertTrue(gate.admit(null, 31_000))
    // A real turn isn't affected.
    gate.takeOver(40_000)
    assertTrue(gate.admit("t9", 40_001))
  }

  @Test
  fun theScreenSettlesWhenQuietOrAfterTwoSeconds() {
    assertFalse(ControlLogic.settled(now = 1_100, actionAt = 1_000, lastEventAt = 0))
    assertTrue(ControlLogic.settled(now = 1_300, actionAt = 1_000, lastEventAt = 0))
    assertFalse(ControlLogic.settled(now = 1_500, actionAt = 1_000, lastEventAt = 1_400))
    assertTrue(ControlLogic.settled(now = 3_000, actionAt = 1_000, lastEventAt = 2_990))
  }

  @Test
  fun pointsMapToTheRealScreenAndOutsideIsOffScreen() {
    val scale = ControlLogic.scaleFor(1080)
    assertEquals(720.0 / 1080, scale, 1e-9)
    assertEquals(1.0, ControlLogic.scaleFor(600), 1e-9)
    assertEquals(Pair(540, 1200), ControlLogic.toScreen(360, 800, scale, 720, 1600))
    assertNull(ControlLogic.toScreen(720, 10, scale, 720, 1600))
    assertNull(ControlLogic.toScreen(-1, 10, scale, 720, 1600))
  }

  @Test
  fun scrollingDownDragsTheFingerUp() {
    val s = ControlLogic.scrollStroke(Box(0, 0, 100, 1000), "down")
    assertTrue(s[1] > s[3])
    assertEquals(s[0], s[2])
    val r = ControlLogic.scrollStroke(Box(0, 0, 1000, 100), "right")
    assertTrue(r[0] > r[2])
  }

  @Test
  fun anAllBlackCaptureIsASecureScreen() {
    assertTrue(ControlLogic.mostlyBlack(IntArray(100) { 0xFF000000.toInt() }))
    assertTrue(ControlLogic.mostlyBlack(IntArray(100) { if (it == 0) 0xFFFFFFFF.toInt() else 0xFF050505.toInt() }))
    assertFalse(ControlLogic.mostlyBlack(IntArray(100) { 0xFF121212.toInt() }))
    assertFalse(ControlLogic.mostlyBlack(IntArray(0)))
  }

  @Test
  fun aWindowAboveCoversWhatsUnderIt() {
    val dialog = Box(100, 500, 980, 1400)
    assertTrue(ControlLogic.covered(Box(200, 600, 300, 700), listOf(dialog)))
    assertFalse(ControlLogic.covered(Box(200, 100, 300, 200), listOf(dialog)))
  }

  // ---- Items ----

  @Test
  fun rolesComeFromTheWidget() {
    val b = Box(0, 0, 10, 10)
    assertEquals("text_field", ControlLogic.role(node(-1, b, "android.widget.EditText", editable = true)))
    assertEquals("switch", ControlLogic.role(node(-1, b, "androidx.appcompat.widget.SwitchCompat", checkable = true, clickable = true)))
    assertEquals("checkbox", ControlLogic.role(node(-1, b, "android.widget.CheckBox", checkable = true, clickable = true)))
    assertEquals("radio", ControlLogic.role(node(-1, b, "android.widget.RadioButton", checkable = true, clickable = true)))
    assertEquals("button", ControlLogic.role(node(-1, b, "android.widget.ImageButton", clickable = true)))
    assertEquals("button", ControlLogic.role(node(-1, b, "android.widget.ImageView", clickable = true)))
    assertEquals("list", ControlLogic.role(node(-1, b, "androidx.recyclerview.widget.RecyclerView", scrollable = true)))
    assertEquals("item", ControlLogic.role(node(-1, b, "android.widget.LinearLayout", clickable = true)))
    assertEquals("image", ControlLogic.role(node(-1, b, "android.widget.ImageView", desc = "Album art")))
    assertEquals("text", ControlLogic.role(node(-1, b, "android.widget.TextView", text = "Hello")))
  }

  /** Settings-like: a search field, a list, two rows with title + summary, a switch. */
  private val settings = listOf(
    node(-1, Box(0, 0, 1080, 2400), "android.widget.FrameLayout"), // 0
    node(0, Box(0, 300, 1080, 2400), "androidx.recyclerview.widget.RecyclerView", scrollable = true), // 1
    node(1, Box(0, 600, 1080, 800), "android.widget.LinearLayout", clickable = true), // 2 row
    node(2, Box(40, 620, 800, 680), text = "Connections"), // 3
    node(2, Box(40, 690, 800, 760), text = "Wi-Fi · Bluetooth"), // 4
    node(1, Box(0, 800, 1080, 1000), "android.widget.LinearLayout", clickable = true), // 5 row
    node(5, Box(40, 820, 800, 880), text = "Dark mode"), // 6
    node(5, Box(900, 850, 1000, 950), "android.widget.Switch", clickable = true, checkable = true, checked = true), // 7
    node(0, Box(40, 150, 1040, 250), "android.widget.EditText", text = "Search settings", hint = "Search settings", editable = true, showingHint = true), // 8
    node(0, Box(40, 50, 400, 100), text = "Settings"), // 9
    node(0, Box(40, 2300, 400, 2350), text = "Hidden", visible = false), // 10
  )

  @Test
  fun itemsAreInReadingOrderWithNumbersOnTheActionableOnes() {
    val built = ControlLogic.build(settings)
    assertFalse(built.truncated)
    val summary = built.items.map { listOf(it.n, it.role, it.text ?: it.label) }
    assertEquals(
      listOf(
        listOf(null, "text", "Settings"),
        listOf(1, "text_field", ""),
        listOf(2, "list", null),
        listOf(3, "item", "Connections · Wi-Fi · Bluetooth"),
        listOf(4, "item", "Dark mode"),
        listOf(5, "switch", null),
      ),
      summary,
    )
    // The row's texts named it, so they aren't repeated; the hidden one isn't there at all.
    assertEquals(0, built.items.count { it.n == null && it.text == "Connections" })
    assertEquals("Search settings", built.items[1].hint)
    assertEquals(true, built.items[5].checked)
    assertEquals(2, ControlLogic.biggestList(built.items, settings)!!.n)
  }

  @Test
  fun aFieldShowingItsHintIsEmptyAndTypedTextIsKept() {
    val typed = listOf(node(-1, Box(0, 0, 500, 100), "android.widget.EditText", text = "taylor swift", hint = "What do you want to listen to?", editable = true))
    assertEquals("taylor swift", ControlLogic.build(typed).items.single().text)
  }

  @Test
  fun tooManyItemsAreTruncated() {
    val many = List(300) { node(-1, Box(0, it * 10, 100, it * 10 + 10), "android.widget.Button", text = "B$it", clickable = true) }
    val built = ControlLogic.build(many)
    assertTrue(built.truncated)
    assertEquals(ControlLogic.MAX_ITEMS, built.items.size)
    assertEquals(ControlLogic.MAX_ITEMS, built.items.last().n)

    val long = List(10) { node(-1, Box(0, it * 10, 100, it * 10 + 10), text = "x".repeat(1_900)) }
    val clipped = ControlLogic.build(long)
    assertTrue(clipped.truncated)
    assertEquals(6, clipped.items.size)
  }

  // ---- JSON ----

  @Test
  fun theScreenJsonHasTheContractsShape() {
    val built = ControlLogic.build(settings)
    val scale = ControlLogic.scaleFor(1080)
    val json = ControlLogic.screenJson("s7", "Settings", "com.android.settings", false, null, 720, 1600, "secure", built, scale)
    assertTrue(json.startsWith("{\"id\":\"s7\",\"app\":\"Settings\",\"package\":\"com.android.settings\",\"keyboard\":false,\"image\":null,\"image_missing\":\"secure\",\"items\":["))
    assertTrue(json.contains("{\"role\":\"text\",\"text\":\"Settings\"}"))
    assertTrue(json.contains("{\"n\":1,\"role\":\"text_field\",\"text\":\"\",\"hint\":\"Search settings\",\"box\":[27,100,666,67]}"))
    assertTrue(json.contains("\"n\":5,\"role\":\"switch\",\"checked\":true"))
    assertFalse(json.contains("truncated"))
    assertEquals("\"a\\\"b\\\\c\\nd\\u0001\"", ControlLogic.quote("a\"b\\c\nd\u0001"))
  }
}
