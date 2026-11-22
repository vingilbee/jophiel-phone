package expo.modules.jophielsenses

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** A named circle the owner saved on the phone. Coordinates never leave the phone; only `name` does. */
data class Place(val id: String, val name: String, val latitude: Double, val longitude: Double, val radius: Double)

/**
 * Which named place the phone is at, from the circles it's inside (pure: no Android, unit-tested).
 *
 * The phone tracks the set of circles it's inside: geofence ENTER adds to it, EXIT removes, a
 * current-location check replaces it. The reported place is the smallest of those circles
 * (overlapping places: the smaller, more specific one wins); none → [AWAY] ("Left home"). Null
 * on the wire means "not known" (location off), never a departure.
 */
object PlaceLogic {
  /** At none of the named places (the server's confirmed departure; src/senses/places.ts AWAY). */
  const val AWAY = "away"
  private const val EARTH_RADIUS_M = 6_371_008.8

  /** Great-circle distance in meters (haversine). */
  fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
    val dLat = Math.toRadians(lat2 - lat1)
    val dLon = Math.toRadians(lon2 - lon1)
    val a = sin(dLat / 2) * sin(dLat / 2) +
      cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2) * sin(dLon / 2)
    return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(a)))
  }

  /** Ids of the places whose circle contains the point. */
  fun containing(latitude: Double, longitude: Double, places: List<Place>): Set<String> =
    places.filter { distanceMeters(latitude, longitude, it.latitude, it.longitude) <= it.radius }.map { it.id }.toSet()

  /** The inside set after a geofence transition for `ids`. */
  fun afterTransition(inside: Set<String>, ids: Collection<String>, entered: Boolean): Set<String> =
    if (entered) inside + ids else inside - ids.toSet()

  /** Only ids of places that still exist (a deleted place can't keep you "inside"). */
  fun prune(inside: Set<String>, places: List<Place>): Set<String> {
    val known = places.map { it.id }.toSet()
    return inside.filter { it in known }.toSet()
  }

  /** The place to report: the smallest circle you're inside (first saved wins a tie), or [AWAY]. */
  fun resolve(inside: Set<String>, places: List<Place>): String =
    places.filter { it.id in inside }.minByOrNull { it.radius }?.name ?: AWAY
}
