package expo.modules.jophielsenses

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaceLogicTest {
  // Home is a 150 m circle; the gym (60 m) sits inside the neighbourhood (1000 m), which contains home.
  private val home = Place("h", "home", -6.2000, 106.8000, 150.0)
  private val area = Place("a", "the neighbourhood", -6.2000, 106.8000, 1000.0)
  private val gym = Place("g", "the gym", -6.2030, 106.8000, 60.0)
  private val places = listOf(area, home, gym)

  @Test
  fun distanceIsRoughlyRight() {
    // 0.001° of latitude ≈ 111 m.
    val d = PlaceLogic.distanceMeters(-6.2000, 106.8000, -6.2010, 106.8000)
    assertTrue("got $d", d in 110.0..112.5)
  }

  @Test
  fun enterReportsThatPlace() {
    val inside = PlaceLogic.afterTransition(emptySet(), listOf("g"), entered = true)
    assertEquals("the gym", PlaceLogic.resolve(inside, places))
  }

  @Test
  fun overlappingPlacesTheSmallestWins() {
    val inside = PlaceLogic.afterTransition(emptySet(), listOf("a", "h"), entered = true)
    assertEquals("home", PlaceLogic.resolve(inside, places))
  }

  @Test
  fun exitFallsBackToTheOtherPlaceStillAround() {
    val inside = PlaceLogic.afterTransition(setOf("a", "h"), listOf("h"), entered = false)
    assertEquals("the neighbourhood", PlaceLogic.resolve(inside, places))
  }

  @Test
  fun exitFromTheLastPlaceIsNull() {
    val inside = PlaceLogic.afterTransition(setOf("h"), listOf("h"), entered = false)
    assertNull(PlaceLogic.resolve(inside, places))
  }

  @Test
  fun enteringABiggerCircleKeepsTheSmallerOne() {
    val inside = PlaceLogic.afterTransition(setOf("h"), listOf("a"), entered = true)
    assertEquals("home", PlaceLogic.resolve(inside, places))
  }

  @Test
  fun aTieGoesToTheFirstSaved() {
    val twin = Place("t", "the twin", -6.2000, 106.8000, 150.0)
    assertEquals("home", PlaceLogic.resolve(setOf("h", "t"), listOf(home, twin)))
    assertEquals("the twin", PlaceLogic.resolve(setOf("h", "t"), listOf(twin, home)))
  }

  @Test
  fun containingFindsEveryCircleAroundThePoint() {
    // At home's centre: home and the neighbourhood, not the gym (≈ 333 m away).
    assertEquals(setOf("h", "a"), PlaceLogic.containing(-6.2000, 106.8000, places))
    // Just outside home (≈ 200 m), still in the neighbourhood.
    assertEquals(setOf("a"), PlaceLogic.containing(-6.2018, 106.8000, places))
    // Far away: nowhere.
    assertEquals(emptySet<String>(), PlaceLogic.containing(-6.3000, 106.8000, places))
  }

  @Test
  fun deletedPlacesArePrunedFromTheInsideSet() {
    val pruned = PlaceLogic.prune(setOf("h", "gone"), places)
    assertEquals(setOf("h"), pruned)
    assertNull(PlaceLogic.resolve(setOf("gone"), places))
  }
}
