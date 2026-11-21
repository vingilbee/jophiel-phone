package expo.modules.jophielaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import android.view.KeyEvent

private const val TAG = "JophielCall"

/** Silent, no heads-up; shown on the lock screen. Shared with the "call ended" note. */
const val CALL_CHANNEL_ID = "jophiel-voice-calls"
private const val CALL_NOTIFICATION_ID = 7301
private const val ENDED_NOTIFICATION_ID = 7302

private const val ACTION_START = "expo.modules.jophielaudio.CALL_START"
private const val ACTION_BUTTON = "expo.modules.jophielaudio.CALL_ACTION"
private const val EXTRA_ACTION = "action"

/**
 * Phase 5: owns a voice call while it's on, so it keeps going with the app in the background or the
 * screen locked. A `microphone` foreground service (Android stops a background app's mic otherwise),
 * a partial wake lock and a low-latency Wi-Fi lock (CPU and network stay up with the screen off),
 * the call notification as the control surface, and a MediaSession for the headset button.
 *
 * It holds no audio itself: capture and playback stay in JophielAudioModule. It only keeps the
 * process allowed to use them, and reports what you press back to JS through [listener].
 */
class VoiceCallService : Service() {
  interface Listener {
    /** "interrupt" | "talk" | "mute" | "unmute" | "end" | "button" */
    fun onCallAction(action: String)

    /** The call has to end: "swiped" (app swiped away from recents). */
    fun onCallEnded(reason: String)

    /**
     * Android promoted the service to the foreground (true), refused to (false), or it stopped
     * (false). Starting it is only a request; this is the answer.
     */
    fun onServiceStateChanged(running: Boolean)
  }

  /** What the notification shows, set from JS on every state change. */
  data class Display(val text: String, val primary: String?, val muted: Boolean)

  companion object {
    @Volatile var listener: Listener? = null

    @Volatile private var running: VoiceCallService? = null

    @Volatile private var shown = Display("Starting…", null, false)

    val isRunning: Boolean
      get() = running != null

    /** Must be called while the app is visible (Android 14 refuses a mic service started from the background). */
    fun start(context: Context) {
      val intent = Intent(context, VoiceCallService::class.java).setAction(ACTION_START)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      running?.let {
        it.shutDown()
        return
      }
      context.stopService(Intent(context, VoiceCallService::class.java))
    }

    fun update(context: Context, next: Display) {
      shown = next
      val service = running ?: return
      service.notificationManager().notify(CALL_NOTIFICATION_ID, service.buildNotification())
    }

    /** A one-off note after a call ended by itself in the background ("Call ended after 30 min of quiet"). */
    fun showEnded(context: Context, text: String) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      ensureChannel(manager)
      val notification = Notification.Builder(context, CALL_CHANNEL_ID)
        .setSmallIcon(smallIcon(context))
        .setContentTitle("Jophiel")
        .setContentText(text)
        .setContentIntent(openAppIntent(context))
        .setAutoCancel(true)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setCategory(Notification.CATEGORY_STATUS)
        .build()
      try {
        manager.notify(ENDED_NOTIFICATION_ID, notification)
      } catch (e: SecurityException) {
        // Notifications denied: nothing to show.
      }
    }

    fun clearEnded(context: Context) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      manager.cancel(ENDED_NOTIFICATION_ID)
    }

    private fun ensureChannel(manager: NotificationManager) {
      if (manager.getNotificationChannel(CALL_CHANNEL_ID) != null) return
      val channel = NotificationChannel(CALL_CHANNEL_ID, "Voice calls", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while a voice call with Jophiel is on."
        setShowBadge(false)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        setSound(null, null)
        enableVibration(false)
      }
      manager.createNotificationChannel(channel)
    }

    /** Jophiel's ✦ (plugins/withNotificationIcon.js), else the launcher icon. */
    private fun smallIcon(context: Context): Int {
      val id = context.resources.getIdentifier("ic_stat_jophiel", "drawable", context.packageName)
      return if (id != 0) id else context.applicationInfo.icon
    }

    private fun openAppIntent(context: Context): PendingIntent? {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
      return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var mediaSession: MediaSession? = null
  private var foreground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_BUTTON -> {
        intent.getStringExtra(EXTRA_ACTION)?.let { listener?.onCallAction(it) }
        return START_NOT_STICKY
      }
      else -> {
        if (!foreground && !goForeground()) {
          listener?.onServiceStateChanged(false)
          stopSelf()
          return START_NOT_STICKY
        }
        val announce = running !== this
        running = this
        if (announce) listener?.onServiceStateChanged(true)
        acquireLocks()
        startMediaSession()
        clearEnded(this)
      }
    }
    // Not restarted after a kill: the call (in JS) is gone with the process.
    return START_NOT_STICKY
  }

  private fun goForeground(): Boolean {
    ensureChannel(notificationManager())
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startForeground(CALL_NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(CALL_NOTIFICATION_ID, buildNotification())
      }
      foreground = true
      true
    } catch (e: Exception) {
      // Android 14 refuses a mic service started from the background, or without RECORD_AUDIO.
      Log.w(TAG, "startForeground refused", e)
      false
    }
  }

  /** The app was swiped away from recents: the call ends (decided 2026-11-21). */
  override fun onTaskRemoved(rootIntent: Intent?) {
    listener?.onCallEnded("swiped")
    shutDown()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    releaseAll()
    super.onDestroy()
  }

  fun shutDown() {
    releaseAll()
    if (foreground) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      foreground = false
    }
    stopSelf()
  }

  private fun releaseAll() {
    if (running === this) {
      running = null
      listener?.onServiceStateChanged(false)
    }
    try {
      wakeLock?.takeIf { it.isHeld }?.release()
    } catch (e: Exception) {
      Log.w(TAG, "wake lock release failed", e)
    }
    wakeLock = null
    try {
      wifiLock?.takeIf { it.isHeld }?.release()
    } catch (e: Exception) {
      Log.w(TAG, "wifi lock release failed", e)
    }
    wifiLock = null
    mediaSession?.let {
      it.isActive = false
      it.release()
    }
    mediaSession = null
  }

  private fun acquireLocks() {
    if (wakeLock == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jophiel:voice-call").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    if (wifiLock == null) {
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        WifiManager.WIFI_MODE_FULL_LOW_LATENCY
      } else {
        @Suppress("DEPRECATION")
        WifiManager.WIFI_MODE_FULL_HIGH_PERF
      }
      wifiLock = wifi.createWifiLock(mode, "jophiel:voice-call").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
  }

  /**
   * Best effort (plan §5): the headset / AirPods button. In call mode Android may route it to
   * "hang up" instead and never deliver it here.
   */
  private fun startMediaSession() {
    if (mediaSession != null) return
    try {
      val session = MediaSession(this, "JophielCall")
      session.setCallback(object : MediaSession.Callback() {
        override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
          val event = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
          } else {
            @Suppress("DEPRECATION")
            mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
          } ?: return false
          if (event.action != KeyEvent.ACTION_UP || event.repeatCount > 0) return true
          when (event.keyCode) {
            KeyEvent.KEYCODE_HEADSETHOOK,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            KeyEvent.KEYCODE_MEDIA_PLAY,
            KeyEvent.KEYCODE_MEDIA_PAUSE -> {
              Log.i(TAG, "headset button ${event.keyCode}")
              listener?.onCallAction("button")
              return true
            }
          }
          return false
        }
      })
      session.setPlaybackState(
        PlaybackState.Builder()
          .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE)
          .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
          .build(),
      )
      session.isActive = true
      mediaSession = session
    } catch (e: Exception) {
      Log.w(TAG, "media session unavailable", e)
    }
  }

  fun notificationManager(): NotificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun actionIntent(action: String, requestCode: Int): PendingIntent {
    val intent = Intent(this, VoiceCallService::class.java).setAction(ACTION_BUTTON).putExtra(EXTRA_ACTION, action)
    return PendingIntent.getService(this, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun action(title: String, action: String, requestCode: Int): Notification.Action =
    Notification.Action.Builder(null, title, actionIntent(action, requestCode)).build()

  fun buildNotification(): Notification {
    val current = shown
    val builder = Notification.Builder(this, CALL_CHANNEL_ID)
      .setSmallIcon(smallIcon(this))
      .setContentTitle("Jophiel")
      .setContentText(current.text)
      .setContentIntent(openAppIntent(this))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setCategory(Notification.CATEGORY_CALL)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    when (current.primary) {
      "interrupt" -> builder.addAction(action("Interrupt", "interrupt", 1))
      "talk" -> builder.addAction(action("Talk now", "talk", 2))
    }
    builder.addAction(if (current.muted) action("Unmute", "unmute", 3) else action("Mute", "mute", 4))
    builder.addAction(action("End", "end", 5))
    return builder.build()
  }
}
