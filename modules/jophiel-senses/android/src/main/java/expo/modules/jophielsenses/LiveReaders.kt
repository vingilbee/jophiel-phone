package expo.modules.jophielsenses

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/** While the screen is off and the keyguard hasn't locked yet (Samsung locks after a delay), look again this often. */
private const val LOCK_POLL_MS = 5_000L

/** …for at most this long (the longest "lock after" a phone offers is 30 min). */
private const val LOCK_POLL_FOR_MS = 31 * 60_000L

/** Network callbacks arrive in bursts; read once they've been quiet this long. */
private const val NETWORK_SETTLE_MS = 500L

/**
 * Listeners for every live field, on while the app is visible or a call keeps it alive (JS starts
 * and stops them). Android 14 holds these broadcasts back from a cached app, so they're only meant
 * for those two states. `emit` gets the fields whose value changed, on the main thread.
 */
internal class LiveReaders(private val context: Context, private val emit: (Map<String, Any?>) -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private val last = HashMap<String, Any?>()
  private val networks = HashMap<Network, NetworkCapabilities>()
  private var running = false
  private var lockPollUntil = 0L

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      when (intent.action) {
        Intent.ACTION_SCREEN_ON, Intent.ACTION_SCREEN_OFF, Intent.ACTION_USER_PRESENT -> {
          readPhoneUse()
          if (intent.action == Intent.ACTION_SCREEN_OFF) startLockPoll()
        }
        Intent.ACTION_BATTERY_CHANGED -> {
          val (battery, charging) = Readers.battery(intent)
          publish(buildMap {
            battery?.let { put("battery", it) }
            charging?.let { put("charging", it) }
          })
        }
        NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED -> Readers.dnd(context)?.let { publish(mapOf("dnd" to it)) }
        AudioManager.RINGER_MODE_CHANGED_ACTION -> Readers.ringer(context)?.let { publish(mapOf("ringer" to it)) }
      }
    }
  }

  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = readHeadphones()
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = readHeadphones()
  }

  // Android 12+: only a callback that asks for location info sees the Wi-Fi name.
  private val networkCallback: ConnectivityManager.NetworkCallback =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      object : ConnectivityManager.NetworkCallback(FLAG_INCLUDE_LOCATION_INFO) {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = onNetwork(network, capabilities)
        override fun onLost(network: Network) = onNetwork(network, null)
      }
    } else {
      object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = onNetwork(network, capabilities)
        override fun onLost(network: Network) = onNetwork(network, null)
      }
    }

  private val lockPoll = object : Runnable {
    override fun run() {
      if (!running) return
      readPhoneUse()
      val screenOff = last["screen"] == "off"
      val locked = last["locked"] == true
      if (screenOff && !locked && System.currentTimeMillis() < lockPollUntil) main.postDelayed(this, LOCK_POLL_MS)
    }
  }

  /** Main thread. */
  fun start() {
    if (running) return
    running = true
    last.clear()
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_SCREEN_OFF)
      addAction(Intent.ACTION_USER_PRESENT)
      addAction(Intent.ACTION_BATTERY_CHANGED)
      addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED)
      addAction(AudioManager.RINGER_MODE_CHANGED_ACTION)
    }
    try {
      // System broadcasts only: not exported (Android 13+ wants it said).
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        context.registerReceiver(receiver, filter)
      }
    } catch (e: Exception) {
      Log.w(TAG, "live receiver not registered", e)
    }
    try {
      audio().registerAudioDeviceCallback(devices, main)
    } catch (e: Exception) {
      Log.w(TAG, "audio device callback not registered", e)
    }
    try {
      val request = NetworkRequest.Builder()
        .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
        .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
        .build()
      connectivity().registerNetworkCallback(request, networkCallback, main)
    } catch (e: Exception) {
      Log.w(TAG, "network callback not registered", e)
    }
    // A first reading of everything; the callbacks above follow with their own.
    publish(Readers.live(context))
    if (last["screen"] == "off") startLockPoll()
  }

  /** Main thread. */
  fun stop() {
    if (!running) return
    running = false
    main.removeCallbacks(lockPoll)
    main.removeCallbacks(networkRead)
    runCatching { context.unregisterReceiver(receiver) }
    runCatching { audio().unregisterAudioDeviceCallback(devices) }
    runCatching { connectivity().unregisterNetworkCallback(networkCallback) }
    networks.clear()
    last.clear()
  }

  private fun readPhoneUse() {
    publish(mapOf("screen" to Readers.screen(context), "locked" to Readers.locked(context)))
  }

  private fun readHeadphones() {
    publish(mapOf("headphones" to Readers.headphones(context)))
  }

  private fun startLockPoll() {
    lockPollUntil = System.currentTimeMillis() + LOCK_POLL_FOR_MS
    main.removeCallbacks(lockPoll)
    main.postDelayed(lockPoll, LOCK_POLL_MS)
  }

  /**
   * Callbacks come one network at a time (on start, mobile data may be reported before Wi-Fi), so
   * the type is read from all networks once they've settled; the callbacks' own capabilities carry
   * the Wi-Fi name on Android 12+.
   */
  private fun onNetwork(network: Network, capabilities: NetworkCapabilities?) {
    if (!running) return
    if (capabilities == null) networks.remove(network) else networks[network] = capabilities
    main.removeCallbacks(networkRead)
    main.postDelayed(networkRead, NETWORK_SETTLE_MS)
  }

  private val networkRead = Runnable {
    if (!running) return@Runnable
    val (type, name) = Readers.network(context, networks.values)
    publish(mapOf("network" to type, "wifi_name" to name))
  }

  /** Only what changed since the last reading goes on (the battery broadcast repeats a lot). */
  private fun publish(values: Map<String, Any?>) {
    if (!running) return
    val changed = values.filter { (name, value) -> !last.containsKey(name) || last[name] != value }
    if (changed.isEmpty()) return
    last.putAll(changed)
    emit(changed)
  }

  private fun audio() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private fun connectivity() = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
}
