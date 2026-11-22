package expo.modules.jophielsenses

import android.content.Context
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Phone senses (phase 6): what the phone tells Jophiel about itself. JS owns the switches, places
 * and the `sense` frames; this module reads Android, and runs the parts that have to work with
 * no JS at all (geofences, activity transitions, Bluetooth headphones, the background PUT).
 */
class JophielSensesModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var live: LiveReaders? = null

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("JophielSenses")

    Events("onChange")

    /** Every field's current value. Motion and place: the last ones seen (absent when unknown). */
    Function("snapshot") {
      val ctx = context
      val values = LinkedHashMap<String, Any?>(Readers.live(ctx))
      values.putAll(Store.values(ctx))
      return@Function values
    }

    /** App visible or a call on: listen to every field and pass wake-up values to JS. */
    Function("startLive") {
      val ctx = context
      Reporter.liveSink = { fields, at -> emitChange(fields, at) }
      main.post {
        if (live == null) live = LiveReaders(ctx) { fields -> emitChange(fields, System.currentTimeMillis()) }
        live?.start()
      }
    }

    Function("stopLive") {
      stopLiveInternal()
    }

    /** The switches (group → on) and the places; registers or removes the background parts. */
    Function("configure") { groups: Map<String, Any?>, places: List<Map<String, Any?>> ->
      val switches = Groups.FIELDS.keys.associateWith { (groups[it] as? Boolean) ?: true }
      Senses.configure(context, switches, places.mapNotNull(::toPlace))
    }

    /** Signed in: the server and token for background reports (stored encrypted). */
    Function("setReporting") { serverUrl: String, token: String ->
      Senses.startReporting(context, Store.Credentials(serverUrl, token))
    }

    /** Logout: no more background reports, geofences and transitions removed. Places and switches stay. */
    Function("clearReporting") {
      Senses.stopReporting(context)
    }

    /** JS sent these in a `sense` frame (seen at `at`, epoch ms). */
    Function("noteSent") { fields: Map<String, Any?>, at: Double ->
      val ctx = context
      Store.markHanded(ctx, fields)
      Store.markReported(ctx, fields, at.toLong())
    }

    /** No socket: send these with a background PUT now (a group switched off sends its nulls). */
    Function("sendInBackground") { fields: Map<String, Any?>, at: Double ->
      Reporter.sendInBackground(context, fields, at.toLong(), dedupe = false)
    }

    /** Per field: the last value that reached the server, when it was sent, and since when it's had it. */
    Function("lastReported") {
      return@Function Store.reported(context).mapValues { (_, r) ->
        mapOf("value" to r.value, "at" to r.at.toDouble(), "since" to r.since.toDouble())
      }
    }

    /** One precise fix for "I'm here now". Coordinates go to JS only to be saved as a place on the phone. */
    AsyncFunction("currentLocation") { promise: Promise ->
      Senses.currentLocation(context) { location ->
        promise.resolve(
          location?.let {
            mapOf("latitude" to it.latitude, "longitude" to it.longitude, "accuracy" to it.accuracy.toDouble())
          },
        )
      }
    }

    /** Which place you're at now, from one fix. Resolves true when it could tell. */
    AsyncFunction("checkPlaceNow") { promise: Promise ->
      Senses.checkPlaceNow(context) { promise.resolve(it) }
    }

    OnDestroy {
      // JS is gone (reload, process ending): wake-ups go to the background path again.
      stopLiveInternal()
    }
  }

  private fun stopLiveInternal() {
    Reporter.liveSink = null
    main.post { live?.stop() }
  }

  private fun emitChange(fields: Map<String, Any?>, at: Long) {
    try {
      sendEvent("onChange", mapOf("fields" to fields, "at" to at.toDouble()))
    } catch (e: Throwable) {
      // JS may be gone (reload); nothing to tell.
    }
  }

  private fun toPlace(raw: Map<String, Any?>): Place? {
    val id = raw["id"] as? String ?: return null
    val name = raw["name"] as? String ?: return null
    val latitude = (raw["latitude"] as? Number)?.toDouble() ?: return null
    val longitude = (raw["longitude"] as? Number)?.toDouble() ?: return null
    val radius = (raw["radius"] as? Number)?.toDouble() ?: return null
    if (id.isEmpty() || radius <= 0 || latitude !in -90.0..90.0 || longitude !in -180.0..180.0) return null
    return Place(id, name, latitude, longitude, radius)
  }
}
