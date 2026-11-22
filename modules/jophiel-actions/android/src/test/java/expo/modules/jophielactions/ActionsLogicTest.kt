package expo.modules.jophielactions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ActionsLogicTest {
  private val apps = listOf(
    App("Gojek", "com.gojek.app"),
    App("GoPay", "com.gojek.gopay"),
    App("Google Maps", "com.google.android.apps.maps"),
    App("Google", "com.google.android.googlequicksearchbox"),
    App("WhatsApp", "com.whatsapp"),
    App("WhatsApp Business", "com.whatsapp.w4b"),
    App("Spotify", "com.spotify.music"),
  )

  @Test
  fun exactLabelWins() {
    assertEquals(AppMatch.Found(apps[0]), AppMatcher.match("gojek", apps))
    assertEquals(AppMatch.Found(apps[0]), AppMatcher.match("GO-JEK ", apps))
    assertEquals(AppMatch.Found(apps[3]), AppMatcher.match("Google", apps))
    assertEquals(AppMatch.Found(apps[4]), AppMatcher.match("whatsapp", apps))
  }

  @Test
  fun uniquePrefixThenContains() {
    assertEquals(AppMatch.Found(apps[6]), AppMatcher.match("spot", apps))
    assertEquals(AppMatch.Found(apps[2]), AppMatcher.match("maps", apps))
  }

  @Test
  fun severalOrNone() {
    assertEquals(AppMatch.Ambiguous, AppMatcher.match("go", apps))
    assertEquals(AppMatch.NotFound, AppMatcher.match("Discord", apps))
    assertEquals(AppMatch.NotFound, AppMatcher.match("  ", apps))
  }

  @Test
  fun sameLabelTwiceIsOneApp() {
    val twice = apps + App("Spotify", "com.spotify.clone")
    assertEquals(AppMatch.Found(apps[6]), AppMatcher.match("spotify", twice))
  }

  @Test
  fun accentsIgnored() {
    assertEquals(AppMatch.Found(App("Café Rio", "x")), AppMatcher.match("cafe rio", listOf(App("Café Rio", "x"))))
  }

  // ---- WhatsApp ----

  @Test
  fun numbers() {
    assertEquals("6281234567890", WhatsAppLogic.numberFromJid("6281234567890@s.whatsapp.net"))
    assertNull(WhatsAppLogic.numberFromJid(null))
    assertEquals("6281234567890", WhatsAppLogic.internationalDigits("+62 812-3456-7890"))
    assertEquals("6281234567890", WhatsAppLogic.internationalDigits("0062 812 3456 7890"))
    assertNull(WhatsAppLogic.internationalDigits("0812-3456-7890"))
  }

  @Test
  fun oneContactWithANumberOpensTheChat() {
    val rows = listOf(DraftContact(1, "Rina", "6281"), DraftContact(2, "Rina Kusuma", "6282"))
    assertEquals(DraftTarget.Chat("6281"), WhatsAppLogic.choose("rina", rows))
    assertEquals(DraftTarget.Chat("6282"), WhatsAppLogic.choose("kusuma", rows))
  }

  @Test
  fun otherwiseThePicker() {
    val rows = listOf(DraftContact(1, "Budi A", "6281"), DraftContact(2, "Budi B", "6282"), DraftContact(3, "Sari", null))
    assertEquals(DraftTarget.Picker, WhatsAppLogic.choose("budi", rows))
    assertEquals(DraftTarget.Picker, WhatsAppLogic.choose("sari", rows))
    assertEquals(DraftTarget.Picker, WhatsAppLogic.choose("nobody", rows))
    assertEquals(DraftTarget.Picker, WhatsAppLogic.choose(null, rows))
  }

  @Test
  fun oneContactTwoRowsSameNumber() {
    val rows = listOf(DraftContact(1, "Rina", "6281"), DraftContact(1, "Rina", "6281"))
    assertEquals(DraftTarget.Chat("6281"), WhatsAppLogic.choose("Rina", rows))
  }

  // ---- Volume ----

  @Test
  fun volumeSteps() {
    assertEquals(0, VolumeLogic.index(0, 15))
    assertEquals(15, VolumeLogic.index(100, 15))
    assertEquals(8, VolumeLogic.index(50, 15))
    assertEquals(1, VolumeLogic.index(1, 15))
    assertEquals(15, VolumeLogic.index(250, 15))
  }
}
