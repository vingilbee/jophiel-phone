package expo.modules.jophielnotifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class NotificationLogicTest {
  private val own = "com.jophiel.app"
  private val zone = ZoneId.of("Asia/Jakarta")
  private val ids = Ids(ByteArray(32) { it.toByte() })

  private val rina = RawMessage("Rina", null, "are you coming tonight?", 1_763_812_931_000, fromOwner = false)

  private val chat = RawNotification(
    sbnKey = "0|com.whatsapp|1|abc|10123",
    packageName = "com.whatsapp",
    appName = "WhatsApp",
    tag = "abc",
    ongoing = false,
    foregroundService = false,
    groupSummary = false,
    category = "msg",
    silent = false,
    systemApp = false,
    title = "Rina",
    text = "are you coming tonight?",
    conversationTitle = null,
    shortcutId = "6281234@s.whatsapp.net",
    isGroup = false,
    messages = listOf(rina),
    canReply = true,
    postedAt = 1_763_812_931_000,
  )

  // ---- Filter ----

  @Test
  fun aChatCounts() = assertTrue(NotificationFilter.include(chat, own))

  @Test
  fun leftOut() {
    assertFalse(NotificationFilter.include(chat.copy(packageName = own), own))
    assertFalse(NotificationFilter.include(chat.copy(ongoing = true), own))
    assertFalse(NotificationFilter.include(chat.copy(foregroundService = true), own))
    assertFalse(NotificationFilter.include(chat.copy(groupSummary = true), own))
    assertFalse(NotificationFilter.include(chat.copy(category = "transport"), own))
    assertFalse(NotificationFilter.include(chat.copy(category = "progress"), own))
    assertFalse(NotificationFilter.include(chat.copy(systemApp = true, silent = true), own))
    assertFalse(NotificationFilter.include(chat.copy(category = "sys", silent = true), own))
    assertFalse(NotificationFilter.include(chat.copy(title = " ", text = null, messages = emptyList()), own))
  }

  @Test
  fun codesAndLoudSystemOnesStayIn() {
    val code = chat.copy(packageName = "com.bca", appName = "BCA", category = null, messages = emptyList(), title = "OTP", text = "Your code is 123456")
    assertTrue(NotificationFilter.include(code, own))
    assertTrue(NotificationFilter.include(chat.copy(systemApp = true, silent = false, category = "msg"), own))
  }

  // ---- Ids ----

  @Test
  fun idsAreStableAndOpaque() {
    assertEquals(ids.key("k"), Ids(ByteArray(32) { it.toByte() }).key("k"))
    assertNotEquals(ids.key("k"), Ids(ByteArray(32)).key("k"))
    assertTrue(ids.key("k").startsWith("n_"))
    assertFalse(ids.key("0|com.whatsapp|1").contains("whatsapp"))
  }

  @Test
  fun conversationFromShortcutElseTitle() {
    val (shortcut, strong) = ids.conversation("com.whatsapp", "s1", "tag", "Rina")
    assertEquals("shortcut", strong)
    assertEquals(shortcut, ids.conversation("com.whatsapp", "s1", "other tag", "Renamed").first)
    val (title, weak) = ids.conversation("com.whatsapp", null, "tag", "Rina")
    assertEquals("title", weak)
    assertNotEquals(title, ids.conversation("com.whatsapp", null, "tag", "Budi").first)
  }

  @Test
  fun strangersWithOneNameNeverMerge() {
    val a = ids.sender(null, "Budi", "com.whatsapp", "c_1")
    val b = ids.sender(null, "Budi", "com.whatsapp", "c_2")
    assertEquals("name", a.second)
    assertNotEquals(a.first, b.first)
    val contactA = ids.sender(ContactMatch("lk1"), "Budi", "com.whatsapp", "c_1")
    val contactB = ids.sender(ContactMatch("lk1"), "Budi S.", "org.telegram.messenger", "c_9")
    assertEquals("contact", contactA.second)
    assertEquals(contactA.first, contactB.first)
  }

  // ---- Extract ----

  @Test
  fun postedCarriesTheContract() {
    val p = Extract.posted(chat, ids, 3, zone, "Vincent") { if (it.sender == "Rina") ContactMatch("lk-rina") else null }
    assertEquals(ids.key(chat.sbnKey), p.key)
    assertEquals(3, p.revision)
    assertEquals("shortcut", p.conversationIdentity)
    assertEquals("Rina", p.conversation)
    val m = p.messages.single()
    assertEquals("Rina", m.sender)
    assertEquals("contact", m.identity)
    assertTrue(m.inContacts)
    assertEquals("2025-11-22T19:02:11+07:00", m.at)
    assertEquals(ids.event(p.conversationId, "Rina", rina.at, rina.text), m.eventId)
  }

  @Test
  fun lastFiveMessagesOwnerMarked() {
    val many = (1..7).map { RawMessage("Rina", null, "m$it", it * 1000L, fromOwner = false) } + RawMessage(null, null, "on my way", 9000, fromOwner = true)
    val p = Extract.posted(chat.copy(messages = many), ids, 1, zone, "Vincent") { null }
    assertEquals(listOf("m4", "m5", "m6", "m7", "on my way"), p.messages.map { it.text })
    val owner = p.messages.last()
    assertNull(owner.identity)
    assertEquals("owner", owner.senderId)
    assertEquals("Vincent", owner.sender)
    assertEquals("name", p.messages.first().identity)
    assertFalse(p.messages.first().inContacts)
  }

  @Test
  fun aReplyRepostedUnderYourNameIsYours() {
    // WhatsApp after a reply-button send: the reply under a Person named like the user, no keys.
    assertTrue(fromOwner(true, null, "You", null, "You"))
    assertTrue(fromOwner(true, null, " You ", "me", "You"))
    assertTrue(fromOwner(false, null, null, "me", "You"))
    // Keys on both sides decide, whatever the names.
    assertTrue(fromOwner(true, "me", "Vincent", "me", "You"))
    assertFalse(fromOwner(true, "rina", "You", "me", "You"))
    // Someone else, or nothing to tell by.
    assertFalse(fromOwner(true, null, "Rina", null, "You"))
    assertFalse(fromOwner(true, null, null, null, null))
    assertFalse(fromOwner(true, null, "", null, ""))
  }

  @Test
  fun theSameMessageTwiceHasOneEventId() {
    val first = Extract.posted(chat, ids, 1, zone, null) { null }
    val second = Extract.posted(chat.copy(messages = listOf(rina, rina.copy(text = "?", at = rina.at + 5))), ids, 2, zone, null) { null }
    assertEquals(first.messages[0].eventId, second.messages[0].eventId)
  }

  @Test
  fun longTextIsClipped() {
    val p = Extract.posted(chat.copy(text = "x".repeat(5_000)), ids, 1, zone, null) { null }
    assertEquals(MAX_TEXT, p.text!!.length)
  }

  // ---- Coalescing ----

  @Test
  fun changesWithinTheWindowGoOutAsTheLatest() {
    val c = Coalescer<String>(5_000)
    assertEquals(5_000L, c.post("k", "v1", 0))
    assertEquals(5_000L, c.post("k", "v2", 4_000))
    c.post("j", "w1", 1_000)
    assertEquals(emptyList<String>(), c.due(4_999))
    assertEquals(listOf("v2"), c.due(5_000))
    assertEquals(6_000L, c.nextDue())
    assertEquals(listOf("w1"), c.due(6_000))
    assertTrue(c.isEmpty())
  }

  @Test
  fun aRemovalDropsWhatsPending() {
    val c = Coalescer<String>(5_000)
    c.post("k", "v1", 0)
    assertTrue(c.remove("k"))
    assertFalse(c.remove("k"))
    assertEquals(emptyList<String>(), c.due(10_000))
    assertNull(c.nextDue())
  }

  // ---- Maps trip ----

  @Test
  fun distanceTitleInstructionText() {
    val nav = MapsTrip.parse("300 m", "Turn left onto Jl. Kemang Raya", "12 min · 4.3 km · 19:30 ETA", null)
    assertEquals(Navigation("Turn left onto Jl. Kemang Raya", "300 m", "12 min · 4.3 km · 19:30 ETA"), nav)
  }

  @Test
  fun distanceAndInstructionInOneLine() {
    val nav = MapsTrip.parse("1,2 km · Keep right", null, null, null)
    assertEquals(Navigation("Keep right", "1,2 km", null), nav)
  }

  @Test
  fun nothingToReadFailsSoft() {
    assertNull(MapsTrip.parse(null, " ", null, null))
    assertNull(MapsTrip.parse("300 m", null, null, null))
  }

  @Test
  fun onlyStepOrArrivalChangesAreWorthSending() {
    val a = Navigation("Turn left", "300 m", "19:30")
    assertFalse(MapsTrip.worthSending(a, a.copy(distanceText = "200 m")))
    assertTrue(MapsTrip.worthSending(a, a.copy(etaText = "19:31")))
    assertTrue(MapsTrip.worthSending(a, a.copy(nextStep = "Turn right")))
    assertTrue(MapsTrip.worthSending(null, a))
    assertTrue(MapsTrip.worthSending(a, null))
    assertFalse(MapsTrip.worthSending(null, null))
  }

  // ---- Reply check ----

  @Test
  fun replyChecks() {
    val live = LiveEntry("com.whatsapp", "c_1", 3, canReply = true)
    assertNull(ReplyCheck.check(live, "c_1", 3, messagesOn = true))
    assertNull(ReplyCheck.check(live, "c_1", 2, messagesOn = true))
    assertEquals("replies_paused", ReplyCheck.check(live, "c_1", 3, messagesOn = false))
    assertEquals("notification_gone", ReplyCheck.check(null, "c_1", 3, messagesOn = true))
    assertEquals("stale", ReplyCheck.check(live, "c_2", 3, messagesOn = true))
    assertEquals("stale", ReplyCheck.check(live, "c_1", 4, messagesOn = true))
    assertEquals("no_reply_button", ReplyCheck.check(live.copy(canReply = false), "c_1", 3, messagesOn = true))
  }
}
