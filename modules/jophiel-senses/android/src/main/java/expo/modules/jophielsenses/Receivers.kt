package expo.modules.jophielsenses

import android.bluetooth.BluetoothA2dp
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHeadset
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofenceStatusCodes
import com.google.android.gms.location.GeofencingEvent
import java.util.concurrent.atomic.AtomicBoolean

/** Bluetooth audio shows up in AudioManager a moment after the connection broadcast. */
private const val BLUETOOTH_SETTLE_MS = 2_500L

/** A receiver that went async has about 10 s; finish before Android gives up on it. */
private const val ASYNC_LIMIT_MS = 9_000L

/** `goAsync` with a guard: finishing twice throws. */
private fun BroadcastReceiver.async(): () -> Unit {
  val pending = goAsync()
  val finished = AtomicBoolean(false)
  val finish = {
    if (finished.compareAndSet(false, true)) {
      try {
        pending.finish()
      } catch (e: IllegalStateException) {
        // already finished by Android
      }
    }
  }
  Handler(Looper.getMainLooper()).postDelayed(finish, ASYNC_LIMIT_MS)
  return finish
}

/** Play Services: you entered or left a place's circle. Wakes the app even when it's closed. */
class GeofenceReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val event = GeofencingEvent.fromIntent(intent) ?: return
    if (event.hasError()) {
      Log.w(TAG, "geofence error ${GeofenceStatusCodes.getStatusCodeString(event.errorCode)}")
      // Location was switched off: Android dropped the geofences; register them again later.
      if (event.errorCode == GeofenceStatusCodes.GEOFENCE_NOT_AVAILABLE) Background.forgetPlaces()
      return
    }
    val entered = when (event.geofenceTransition) {
      Geofence.GEOFENCE_TRANSITION_ENTER -> true
      Geofence.GEOFENCE_TRANSITION_EXIT -> false
      else -> return
    }
    val ids = event.triggeringGeofences?.map { it.requestId }.orEmpty()
    if (ids.isEmpty()) return
    Senses.onGeofence(context.applicationContext, ids, entered)
  }
}

/** Play Services: you started walking, running, cycling, riding in a vehicle, or stopped. */
class MotionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!ActivityTransitionResult.hasResult(intent)) return
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val latest = result.transitionEvents
      .filter { it.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER }
      .maxByOrNull { it.elapsedRealTimeNanos } ?: return
    val motion = when (latest.activityType) {
      DetectedActivity.STILL -> "still"
      DetectedActivity.WALKING -> "walking"
      DetectedActivity.RUNNING -> "running"
      DetectedActivity.ON_BICYCLE -> "cycling"
      DetectedActivity.IN_VEHICLE -> "vehicle"
      else -> return
    }
    // The event's clock is time since boot; turn it into wall time.
    val agoMs = (SystemClock.elapsedRealtimeNanos() - latest.elapsedRealTimeNanos) / 1_000_000
    val at = System.currentTimeMillis() - agoMs.coerceAtLeast(0)
    Senses.onMotion(context.applicationContext, motion, at)
  }
}

/**
 * Bluetooth headphones connected or disconnected. One of the few implicit broadcasts a closed app
 * still gets (needs Nearby devices on Android 12+). The broadcast is only a hint: headphones are
 * read from AudioManager once the audio route has settled.
 */
class BluetoothReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      BluetoothDevice.ACTION_ACL_CONNECTED,
      BluetoothDevice.ACTION_ACL_DISCONNECTED,
      BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED,
      BluetoothA2dp.ACTION_CONNECTION_STATE_CHANGED,
      -> Unit
      else -> return
    }
    val app = context.applicationContext
    if (!Store.groupOn(app, Groups.HEADPHONES)) return
    // Nothing would receive it: not live, and no account to report to.
    if (Reporter.liveSink == null && !Store.hasCredentials(app)) return
    val finish = async()
    Handler(Looper.getMainLooper()).postDelayed({
      try {
        Senses.onHeadphonesMaybeChanged(app)
      } catch (e: Exception) {
        Log.w(TAG, "headphones not read", e)
      } finally {
        finish()
      }
    }, BLUETOOTH_SETTLE_MS)
  }
}

/** Reboot or app update: put the geofences and transitions back. */
class RestoreReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> Background.forget()
      else -> return
    }
    val app = context.applicationContext
    if (!Store.hasCredentials(app)) return
    val finish = async()
    try {
      Background.apply(app) { finish() }
    } catch (e: Exception) {
      Log.w(TAG, "restore failed", e)
      finish()
    }
  }
}

/**
 * Phase 8: a phone-state field from the notification listener (`media`, `navigation`), sent by
 * jophiel-notifications as an explicit broadcast to this class (not exported: only this app can).
 */
class FieldReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val field = intent.getStringExtra("field") ?: return
    val raw = intent.getStringExtra("value")
    val value = if (raw == null) {
      null
    } else {
      val parsed = runCatching { org.json.JSONObject(raw) }.getOrNull() ?: return
      @Suppress("UNCHECKED_CAST")
      (Store.normalize(parsed) as? Map<String, Any?>) ?: return
    }
    Senses.onField(
      context.applicationContext,
      field,
      value,
      intent.getLongExtra("at", System.currentTimeMillis()),
      intent.getBooleanExtra("force", false),
    )
  }
}
