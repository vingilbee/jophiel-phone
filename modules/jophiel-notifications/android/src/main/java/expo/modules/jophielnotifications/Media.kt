package expo.modules.jophielnotifications

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.util.Log
import org.json.JSONObject

/**
 * Hands a phone-state field (`media`, `navigation`) to the senses module, which sends it in the
 * next `sense` frame or a background `PUT /api/phone/state` (and drops it when the Notifications
 * group is off). An explicit broadcast to its own receiver, so the two modules stay apart.
 */
internal object Fields {
  private const val ACTION = "expo.modules.jophielsenses.FIELD"
  private const val RECEIVER = "expo.modules.jophielsenses.FieldReceiver"

  fun report(context: Context, field: String, value: JSONObject?) {
    val intent = Intent(ACTION)
      .setClassName(context.packageName, RECEIVER)
      .putExtra("field", field)
      .putExtra("value", value?.toString())
      .putExtra("at", System.currentTimeMillis())
    try {
      context.sendBroadcast(intent)
    } catch (e: Exception) {
      Log.w(TAG, "field not handed on", e)
    }
  }
}

/**
 * Now playing, and play / pause / next / previous for her. Needs notification access (the active
 * sessions are only given to an enabled listener). Main thread.
 */
internal class Media(private val context: Context, private val component: ComponentName, private val handler: Handler) {
  private val manager = context.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
  private var controllers: List<MediaController> = emptyList()
  private var last: String? = null
  private var started = false
  private val labels = HashMap<String, String>()

  private val callback = object : MediaController.Callback() {
    override fun onPlaybackStateChanged(state: PlaybackState?) = changed()
    override fun onMetadataChanged(metadata: MediaMetadata?) = changed()
    override fun onSessionDestroyed() = changed()
  }

  private val sessions = MediaSessionManager.OnActiveSessionsChangedListener { list -> track(list.orEmpty()) }

  fun start() {
    if (started) return
    started = true
    try {
      manager.addOnActiveSessionsChangedListener(sessions, component, handler)
      track(manager.getActiveSessions(component))
    } catch (e: SecurityException) {
      Log.w(TAG, "no media sessions (notification access?)", e)
    }
  }

  fun stop() {
    if (!started) return
    started = false
    runCatching { manager.removeOnActiveSessionsChangedListener(sessions) }
    controllers.forEach { runCatching { it.unregisterCallback(callback) } }
    controllers = emptyList()
  }

  /** Switched off: what was sent is forgotten, so switching on again sends it anew. */
  fun forget() {
    last = null
  }

  /** Forget what was sent (switched off and on again): the next change, or `resend`, sends it. */
  fun resend() {
    last = null
    changed()
  }

  private fun track(list: List<MediaController>) {
    controllers.forEach { runCatching { it.unregisterCallback(callback) } }
    // Jophiel's own session (the voice call's, always "playing") is never what she means: with it
    // counted, play / pause went to it once Spotify was paused.
    controllers = list.filter { it.packageName != context.packageName }
    controllers.forEach { runCatching { it.registerCallback(callback, handler) } }
    changed()
  }

  private fun isPlaying(c: MediaController): Boolean {
    val state = c.playbackState?.state ?: return false
    return state == PlaybackState.STATE_PLAYING || state == PlaybackState.STATE_BUFFERING
  }

  /** The session she means: one playing, else the first with something loaded. */
  private fun current(): MediaController? =
    controllers.firstOrNull(::isPlaying) ?: controllers.firstOrNull { it.metadata != null }

  private fun label(packageName: String): String = labels.getOrPut(packageName) {
    try {
      val pm = context.packageManager
      pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    } catch (e: PackageManager.NameNotFoundException) {
      packageName
    }
  }

  fun nowPlaying(): JSONObject? {
    val c = current() ?: return null
    val metadata = c.metadata
    val title = clip(metadata?.getString(MediaMetadata.METADATA_KEY_TITLE), MAX_TITLE)
      ?: clip(metadata?.description?.title?.toString(), MAX_TITLE)
      ?: return null
    val artist = clip(metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST), MAX_TITLE)
      ?: clip(metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST), MAX_TITLE)
      ?: clip(metadata?.description?.subtitle?.toString(), MAX_TITLE)
    return JSONObject()
      .put("app", clip(label(c.packageName), MAX_APP) ?: c.packageName.take(MAX_APP))
      .put("title", title)
      .put("artist", artist ?: JSONObject.NULL)
      .put("state", if (isPlaying(c)) "playing" else "paused")
  }

  private fun changed() {
    if (!started) return
    if (!Store.enabled(context)) return
    val now = nowPlaying()
    val text = now?.toString()
    if (text == last) return
    last = text
    Fields.report(context, "media", now)
  }

  /**
   * Play the top hit for `query` in that app through its media session (Spotify supports it): no
   * activity is started, so it works with another app in front and the phone locked. null: done.
   * Only when the app has a session (it ran recently); otherwise the caller opens the app.
   */
  fun playFromSearch(packageName: String, query: String): String? {
    val c = controllers.firstOrNull { it.packageName == packageName } ?: return "no_media_session"
    return try {
      c.transportControls.playFromSearch(query, android.os.Bundle())
      null
    } catch (e: Exception) {
      Log.w(TAG, "play from search failed", e)
      "error"
    }
  }

  /** null: done; otherwise the reason it couldn't. */
  fun control(command: String): String? {
    val c = current() ?: return "no_media_session"
    val controls = c.transportControls
    when (command) {
      "play" -> controls.play()
      "pause" -> controls.pause()
      "next" -> controls.skipToNext()
      "previous" -> controls.skipToPrevious()
      else -> return "bad_args"
    }
    return null
  }
}
