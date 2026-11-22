package expo.modules.jophielsenses

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import org.json.JSONArray

/** Geofences: Play Services allows 100 per app. */
internal const val MAX_PLACES = 100

internal object Permissions {
  private fun granted(context: Context, permission: String) =
    context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  fun fineLocation(context: Context) = granted(context, Manifest.permission.ACCESS_FINE_LOCATION)

  /** "Allow all the time". Before Android 10 there's no such permission: foreground location covers it. */
  fun backgroundLocation(context: Context) =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      fineLocation(context) && granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    } else {
      fineLocation(context)
    }

  /** Physical activity: a runtime permission from Android 10, granted at install before. */
  fun activity(context: Context) =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) granted(context, Manifest.permission.ACTIVITY_RECOGNITION) else true
}

/**
 * The parts that run inside Play Services with the app closed: one geofence per place, and
 * activity transitions for motion. Registered when the group is on, its permission is there and a
 * signed-in account can receive reports; removed otherwise. Both are cleared by a reboot or an app
 * update (RestoreReceiver applies them again) and geofences also when location is switched off.
 */
internal object Background {
  /** What's registered in this process: the places + permissions it was made for ("" = nothing). */
  private var placesKey: String? = null
  private var motionOn: Boolean? = null

  private fun intent(context: Context, receiver: Class<*>, code: Int): PendingIntent {
    // Play Services fills the intent in, so it has to be mutable (Android 12+ wants it said).
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
    return PendingIntent.getBroadcast(context, code, Intent(context, receiver), flags)
  }

  fun geofenceIntent(context: Context) = intent(context.applicationContext, GeofenceReceiver::class.java, 1)

  fun motionIntent(context: Context) = intent(context.applicationContext, MotionReceiver::class.java, 2)

  /** Registrations are gone (reboot, app update, location off): the next `apply` makes them again. */
  @Synchronized
  fun forget() {
    placesKey = null
    motionOn = null
  }

  @Synchronized
  fun forgetPlaces() {
    placesKey = null
  }

  /** Bring the registrations in line with the settings. `done` runs once Play Services answered. */
  @Synchronized
  fun apply(context: Context, done: (() -> Unit)? = null) {
    val app = context.applicationContext
    val tasks = mutableListOf<Task<*>>()
    val signedIn = Store.hasCredentials(app)
    val groups = Store.groups(app)

    val places = Store.places(app).take(MAX_PLACES)
    val wantPlaces = signedIn && groups[Groups.PLACES] == true && places.isNotEmpty() && Permissions.backgroundLocation(app)
    val key = if (wantPlaces) placesJson(places) else ""
    if (key != placesKey) {
      placesKey = key
      val task = if (wantPlaces) registerPlaces(app, places) else removePlaces(app)
      task?.addOnFailureListener {
        Log.w(TAG, "geofences not updated", it)
        // Try again on the next apply.
        synchronized(this) { if (placesKey == key) placesKey = null }
      }
      if (task == null) placesKey = null else tasks.add(task)
    }

    val wantMotion = signedIn && groups[Groups.MOTION] == true && Permissions.activity(app)
    if (wantMotion != motionOn) {
      motionOn = wantMotion
      val task = if (wantMotion) registerMotion(app) else removeMotion(app)
      task?.addOnFailureListener {
        Log.w(TAG, "activity transitions not updated", it)
        synchronized(this) { if (motionOn == wantMotion) motionOn = null }
      }
      if (task == null) motionOn = null else tasks.add(task)
    }

    if (done == null) return
    if (tasks.isEmpty()) done() else Tasks.whenAllComplete(tasks).addOnCompleteListener { done() }
  }

  /** Logout / a dead token: everything off. */
  @Synchronized
  fun removeAll(context: Context) {
    val app = context.applicationContext
    removePlaces(app)
    removeMotion(app)
    placesKey = ""
    motionOn = false
  }

  private fun placesJson(places: List<Place>): String {
    val array = JSONArray()
    places.forEach { array.put("${it.id}|${it.latitude}|${it.longitude}|${it.radius}") }
    return array.toString()
  }

  @SuppressLint("MissingPermission") // checked by the caller (backgroundLocation)
  private fun registerPlaces(context: Context, places: List<Place>): Task<Void>? = try {
    val client = LocationServices.getGeofencingClient(context)
    val fences = places.map {
      Geofence.Builder()
        .setRequestId(it.id)
        .setCircularRegion(it.latitude, it.longitude, it.radius.toFloat())
        .setExpirationDuration(Geofence.NEVER_EXPIRE)
        .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)
        .build()
    }
    // Already inside a circle when it's added: that counts as entering it.
    val request = GeofencingRequest.Builder()
      .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
      .addGeofences(fences)
      .build()
    val pending = geofenceIntent(context)
    // Replace the whole set: a deleted place's circle must go too.
    client.removeGeofences(pending).continueWithTask { client.addGeofences(request, pending) }
  } catch (e: Exception) {
    Log.w(TAG, "geofences not registered", e)
    null
  }

  private fun removePlaces(context: Context): Task<Void>? = try {
    LocationServices.getGeofencingClient(context).removeGeofences(geofenceIntent(context))
  } catch (e: Exception) {
    Log.w(TAG, "geofences not removed", e)
    null
  }

  @SuppressLint("MissingPermission") // checked by the caller (activity)
  private fun registerMotion(context: Context): Task<Void>? = try {
    val activities = listOf(
      DetectedActivity.STILL,
      DetectedActivity.WALKING,
      DetectedActivity.RUNNING,
      DetectedActivity.ON_BICYCLE,
      DetectedActivity.IN_VEHICLE,
    )
    val transitions = activities.map {
      ActivityTransition.Builder()
        .setActivityType(it)
        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
        .build()
    }
    ActivityRecognition.getClient(context).requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), motionIntent(context))
  } catch (e: Exception) {
    Log.w(TAG, "activity transitions not registered", e)
    null
  }

  @SuppressLint("MissingPermission")
  private fun removeMotion(context: Context): Task<Void>? = try {
    ActivityRecognition.getClient(context).removeActivityTransitionUpdates(motionIntent(context))
  } catch (e: Exception) {
    Log.w(TAG, "activity transitions not removed", e)
    null
  }
}
