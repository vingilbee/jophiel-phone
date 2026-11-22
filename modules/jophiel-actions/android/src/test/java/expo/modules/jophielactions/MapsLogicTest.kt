package expo.modules.jophielactions

import org.junit.Assert.assertEquals
import org.junit.Test

class MapsLogicTest {
  /** Unlocked, screen on, her app in front, Android 14, nothing granted. */
  private val base = Situation(
    appOnScreen = true,
    screenOn = true,
    keyguardLocked = false,
    deviceLocked = false,
    canDrawOverlays = false,
    overlayVisible = false,
    sdk = 34,
    fullScreenAllowed = false,
  )

  @Test
  fun herAppOnScreenOpensMaps() {
    assertEquals(Choice(Path.OPEN), MapsLogic.choose(base))
  }

  @Test
  fun anotherAppOnScreenWithOverlayOpensMapsOnAndroid14() {
    assertEquals(Choice(Path.OPEN), MapsLogic.choose(base.copy(appOnScreen = false, canDrawOverlays = true)))
  }

  @Test
  fun anotherAppOnScreenWithoutOverlayNotifies() {
    assertEquals(Choice(Path.NOTIFY, "background"), MapsLogic.choose(base.copy(appOnScreen = false)))
  }

  @Test
  fun android15NeedsAVisibleOverlayWindow() {
    val behind = base.copy(appOnScreen = false, canDrawOverlays = true, sdk = 35)
    assertEquals(Choice(Path.NOTIFY, "background"), MapsLogic.choose(behind))
    assertEquals(Choice(Path.OPEN), MapsLogic.choose(behind.copy(overlayVisible = true)))
  }

  @Test
  fun screenOffNoPinWakes() {
    val pocket = base.copy(appOnScreen = false, screenOn = false, keyguardLocked = true, fullScreenAllowed = true)
    assertEquals(Choice(Path.WAKE), MapsLogic.choose(pocket))
  }

  @Test
  fun screenOffBeforeTheKeyguardEngagesWakes() {
    val dimmed = base.copy(appOnScreen = false, screenOn = false, fullScreenAllowed = true)
    assertEquals(Choice(Path.WAKE), MapsLogic.choose(dimmed))
  }

  @Test
  fun pinNeededNotifiesWithoutWaking() {
    val locked = base.copy(appOnScreen = false, screenOn = false, keyguardLocked = true, deviceLocked = true, fullScreenAllowed = true)
    assertEquals(Choice(Path.NOTIFY, "locked"), MapsLogic.choose(locked))
  }

  @Test
  fun lockScreenShowingWithPinNotifies() {
    val shown = base.copy(appOnScreen = false, keyguardLocked = true, deviceLocked = true, fullScreenAllowed = true)
    assertEquals(Choice(Path.NOTIFY, "locked"), MapsLogic.choose(shown))
  }

  @Test
  fun noFullScreenPermissionNotifies() {
    val pocket = base.copy(appOnScreen = false, screenOn = false, keyguardLocked = true)
    assertEquals(Choice(Path.NOTIFY, "no_full_screen"), MapsLogic.choose(pocket))
  }

  @Test
  fun herAppBehindTheLockScreenDoesNotCountAsOnScreen() {
    val locked = base.copy(keyguardLocked = true, fullScreenAllowed = true)
    assertEquals(Choice(Path.WAKE), MapsLogic.choose(locked))
  }
}
