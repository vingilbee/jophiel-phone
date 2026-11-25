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
import android.os.SystemClock
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

  /** `force`: send it even when it's what was last sent (a report she waits for after a command). */
  fun report(context: Context, field: String, value: JSONObject?, force: Boolean = false) {
    val intent = Intent(ACTION)
      .setClassName(context.packageName, RECEIVER)
      .putExtra("field", field)
      .putExtra("value", value?.toString())
      .putExtra("at", System.currentTimeMillis())
      .putExtra("force", force)
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
  /**
   * What was last sent, without where in the track (a position moving on is no change); `sent`
   * false: nothing yet since connecting (or switching on), so even "nothing playing" goes.
   */
  private var last: String? = null
  private var sent = false
  /** The position last sent, when (elapsed realtime), and whether it was moving then: a seek is told. */
  private var lastPosition: Long? = null
  private var lastPositionAt = 0L
  private var lastMoving = false
  /** The report she reads a moment after one of her commands (her check needs a fresh one). */
  private val afterCommand = Runnable { changed(force = true) }
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
    handler.removeCallbacks(afterCommand)
    runCatching { manager.removeOnActiveSessionsChangedListener(sessions) }
    controllers.forEach { runCatching { it.unregisterCallback(callback) } }
    controllers = emptyList()
  }

  /** Switched off: what was sent is forgotten, so switching on again sends it anew. */
  fun forget() {
    last = null
    sent = false
    lastPosition = null
  }

  /** Forget what was sent (switched off and on again): the next change, or `resend`, sends it. */
  fun resend() {
    forget()
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

  /** What's playing, and where in the track (`position_ms` / `duration_ms`, left out when unknown). */
  private class NowPlaying(val what: JSONObject, val positionMs: Long?, val durationMs: Long?, val moving: Boolean) {
    fun json(): JSONObject = JSONObject(what.toString()).apply {
      positionMs?.let { put("position_ms", it) }
      durationMs?.let { put("duration_ms", it) }
    }
  }

  private fun nowPlaying(): NowPlaying? {
    val c = current() ?: return null
    val metadata = c.metadata
    val title = clip(metadata?.getString(MediaMetadata.METADATA_KEY_TITLE), MAX_TITLE)
      ?: clip(metadata?.description?.title?.toString(), MAX_TITLE)
      ?: return null
    val artist = clip(metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST), MAX_TITLE)
      ?: clip(metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST), MAX_TITLE)
      ?: clip(metadata?.description?.subtitle?.toString(), MAX_TITLE)
    val what = JSONObject()
      .put("app", clip(label(c.packageName), MAX_APP) ?: c.packageName.take(MAX_APP))
      .put("title", title)
      .put("artist", artist ?: JSONObject.NULL)
      .put("state", if (isPlaying(c)) "playing" else "paused")
    // MediaMetadata's duration: 0 or less when the app doesn't say (a live stream).
    val duration = metadata?.getLong(MediaMetadata.METADATA_KEY_DURATION)?.takeIf { it in 1..MAX_MS }
    val state = c.playbackState
    val moving = state?.state == PlaybackState.STATE_PLAYING
    return NowPlaying(what, position(state, moving, duration), duration, moving)
  }

  /**
   * Where in the track now, in ms. PlaybackState's position is as of its last update; while
   * playing it has moved on since, at the playback speed. null: the app doesn't say.
   */
  private fun position(state: PlaybackState?, moving: Boolean, duration: Long?): Long? {
    if (state == null || state.position < 0) return null
    var at = state.position
    if (moving && state.lastPositionUpdateTime > 0) {
      val since = SystemClock.elapsedRealtime() - state.lastPositionUpdateTime
      if (since > 0) at += (since * state.playbackSpeed).toLong()
    }
    if (duration != null) at = at.coerceAtMost(duration)
    return at.coerceIn(0L, MAX_MS)
  }

  /** `force`: send it even unchanged (the report a moment after one of her commands). */
  private fun changed(force: Boolean = false) {
    if (!started) return
    if (!Store.enabled(context)) return
    val now = nowPlaying()
    val text = now?.what?.toString()
    val clock = SystemClock.elapsedRealtime()
    if (!force && sent && text == last && !seeked(now, clock)) return
    last = text
    sent = true
    lastPosition = now?.positionMs
    lastPositionAt = clock
    lastMoving = now?.moving == true
    Fields.report(context, "media", now?.json(), force)
  }

  /** The same track, but not where it would be by now (a seek, or previous restarting it). */
  private fun seeked(now: NowPlaying?, clock: Long): Boolean {
    val before = lastPosition ?: return false
    val position = now?.positionMs ?: return false
    val expected = before + if (lastMoving) clock - lastPositionAt else 0L
    return Math.abs(position - expected) > SEEK_MS
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
    // Her check reads the phone's next report: send one once the player has acted, even when the
    // press changed nothing it shows (pause while paused). Several presses: one, after the last.
    handler.removeCallbacks(afterCommand)
    handler.postDelayed(afterCommand, AFTER_COMMAND_MS)
    return null
  }

  private companion object {
    /** The server takes positions and durations up to a day. */
    const val MAX_MS = 86_400_000L
    /** Further than this from where it would be: a seek, so it's sent. */
    const val SEEK_MS = 3_000L
    const val AFTER_COMMAND_MS = 1_000L
  }
}
