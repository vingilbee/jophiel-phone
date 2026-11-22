package expo.modules.jophielsenses

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.util.Log
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource

/** How long a one-off location may take (GPS indoors can be slow), and how old a cached fix may be. */
private const val LOCATION_TIMEOUT_MS = 20_000L
private const val LOCATION_MAX_AGE_MS = 30_000L
/** Phase 7, her one-off position: a fix this fresh is reused, else a new one within this long. */
private const val POSITION_MAX_AGE_MS = 2 * 60_000L
private const val POSITION_TIMEOUT_MS = 10_000L

/**
 * What the wake-ups and the JS calls do with the stored state: the same code runs with JS live
 * (values go to JS) and with the app closed (values go out as a background PUT).
 */
internal object Senses {
  /** A geofence ENTER / EXIT for `ids`. */
  fun onGeofence(context: Context, ids: List<String>, entered: Boolean) {
    if (!Store.groupOn(context, Groups.PLACES)) return
    val places = Store.places(context)
    val inside = PlaceLogic.prune(PlaceLogic.afterTransition(Store.inside(context), ids, entered), places)
    Store.setInside(context, inside)
    setPlace(context, PlaceLogic.resolve(inside, places), System.currentTimeMillis())
  }

  /** A current-location fix: the circles it's in replace the inside set. */
  fun onLocation(context: Context, location: Location) {
    if (!Store.groupOn(context, Groups.PLACES)) return
    val places = Store.places(context)
    val inside = PlaceLogic.containing(location.latitude, location.longitude, places)
    Store.setInside(context, inside)
    setPlace(context, PlaceLogic.resolve(inside, places), System.currentTimeMillis())
  }

  private fun setPlace(context: Context, place: String?, at: Long) {
    Store.setValue(context, "place", place)
    Reporter.deliver(context, mapOf("place" to place), at)
  }

  fun onMotion(context: Context, motion: String, at: Long) {
    if (!Store.groupOn(context, Groups.MOTION)) return
    Store.setValue(context, "motion", motion)
    Reporter.deliver(context, mapOf("motion" to motion), at)
  }

  /**
   * Phase 8: `media` or `navigation` from the notification listener (jophiel-notifications), kept
   * as last seen (like motion and place) and handed on like any other change.
   */
  fun onField(context: Context, field: String, value: Map<String, Any?>?, at: Long) {
    if (field !in FIELD_FROM_LISTENER || !Store.groupOn(context, Groups.NOTIFICATIONS)) return
    Store.setValue(context, field, value)
    Reporter.deliver(context, mapOf(field to value), at)
  }

  private val FIELD_FROM_LISTENER = setOf("media", "navigation")

  /** After a Bluetooth connect / disconnect: read headphones again (wired or Bluetooth). */
  fun onHeadphonesMaybeChanged(context: Context) {
    if (!Store.groupOn(context, Groups.HEADPHONES)) return
    Reporter.deliver(context, mapOf("headphones" to Readers.headphones(context)), System.currentTimeMillis())
  }

  /**
   * JS's switches and places (on app start and every change). A group switched off forgets its
   * state here (JS sends the null); places renamed or deleted re-resolve the current place.
   */
  fun configure(context: Context, groups: Map<String, Boolean>, places: List<Place>) {
    Store.setGroups(context, groups)
    Store.setPlaces(context, places.take(MAX_PLACES))
    if (groups[Groups.PLACES] == false) {
      Store.setInside(context, emptySet())
      Store.forgetValue(context, "place")
    } else {
      val stored = Store.places(context)
      val inside = PlaceLogic.prune(Store.inside(context), stored)
      Store.setInside(context, inside)
      val values = Store.values(context)
      // Only a place already known can change by renaming / deleting; unknown stays unknown.
      if (values.containsKey("place")) {
        val place = PlaceLogic.resolve(inside, stored)
        if (place != values["place"]) setPlace(context, place, System.currentTimeMillis())
      }
    }
    if (groups[Groups.MOTION] == false) Store.forgetValue(context, "motion")
    if (groups[Groups.NOTIFICATIONS] == false) {
      Store.forgetValue(context, "media")
      Store.forgetValue(context, "navigation")
    }
    Background.apply(context)
  }

  /** Signed in: background reports may go out with this token. */
  fun startReporting(context: Context, credentials: Store.Credentials) {
    val previous = Store.credentials(context)
    if (previous != null && previous.serverUrl != credentials.serverUrl) {
      // Another server: what the last one was told means nothing here.
      Store.clearState(context)
    }
    Store.setCredentials(context, credentials)
    Background.apply(context)
  }

  /** Logout, or the server refused the token: nothing more is sent, the circles and transitions go. */
  fun stopReporting(context: Context, cancelWork: Boolean = true) {
    Store.clearCredentials(context)
    if (cancelWork) Reporter.cancelAll(context)
    Background.removeAll(context)
    Store.clearState(context)
  }

  /** One precise fix (coordinates stay on the phone). `done(null)`: no permission, location off, or timed out. */
  @SuppressLint("MissingPermission") // checked first
  fun currentLocation(context: Context, done: (Location?) -> Unit) {
    if (!Permissions.fineLocation(context)) {
      done(null)
      return
    }
    try {
      val request = CurrentLocationRequest.Builder()
        .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
        .setDurationMillis(LOCATION_TIMEOUT_MS)
        .setMaxUpdateAgeMillis(LOCATION_MAX_AGE_MS)
        .build()
      LocationServices.getFusedLocationProviderClient(context)
        .getCurrentLocation(request, CancellationTokenSource().token)
        .addOnSuccessListener { done(it) }
        .addOnFailureListener {
          Log.w(TAG, "current location failed", it)
          done(null)
        }
    } catch (e: Exception) {
      Log.w(TAG, "current location failed", e)
      done(null)
    }
  }

  /** On app open (no geofences without "all the time"), and after the places change. */
  fun checkPlaceNow(context: Context, done: (Boolean) -> Unit) {
    if (!Store.groupOn(context, Groups.PLACES) || Store.places(context).isEmpty()) {
      done(false)
      return
    }
    currentLocation(context) { location ->
      if (location == null) {
        done(false)
      } else {
        onLocation(context, location)
        done(true)
      }
    }
  }

  /**
   * Phase 7: one position for one of her lookups ("how long to the office?"). Never stored or
   * logged; JS hands it straight to the backend in a `get_position` result. `done` gets the fix or
   * why not: `no_permission` (none, or the app isn't in front without "Allow all the time"),
   * `location_off` (switched off on the phone), `no_fix` (nothing within the time).
   */
  @SuppressLint("MissingPermission") // checked first
  fun positionOnce(context: Context, done: (Location?, String?) -> Unit) {
    if (!Permissions.fineLocation(context) || (!appInFront() && !Permissions.backgroundLocation(context))) {
      done(null, "no_permission")
      return
    }
    if (!locationOn(context)) {
      done(null, "location_off")
      return
    }
    try {
      val request = CurrentLocationRequest.Builder()
        .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
        .setDurationMillis(POSITION_TIMEOUT_MS)
        .setMaxUpdateAgeMillis(POSITION_MAX_AGE_MS)
        .build()
      LocationServices.getFusedLocationProviderClient(context)
        .getCurrentLocation(request, CancellationTokenSource().token)
        .addOnSuccessListener { done(it, if (it == null) "no_fix" else null) }
        .addOnFailureListener { done(null, "no_fix") }
    } catch (e: Exception) {
      done(null, "no_fix")
    }
  }

  private fun locationOn(context: Context): Boolean {
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      manager.isLocationEnabled
    } else {
      manager.isProviderEnabled(LocationManager.GPS_PROVIDER) || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }
  }

  /** An activity of ours is in front: "while using the app" location applies. */
  private fun appInFront(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }
}
