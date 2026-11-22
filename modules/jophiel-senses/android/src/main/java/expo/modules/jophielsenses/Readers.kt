package expo.modules.jophielsenses

import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import kotlin.math.roundToInt

/** Reads each field's current value from Android. Every reader is safe to call from any thread. */
internal object Readers {
  private val HEADPHONE_TYPES: Set<Int> = buildSet {
    add(AudioDeviceInfo.TYPE_WIRED_HEADSET)
    add(AudioDeviceInfo.TYPE_WIRED_HEADPHONES)
    add(AudioDeviceInfo.TYPE_USB_HEADSET)
    add(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)
    add(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    add(AudioDeviceInfo.TYPE_HEARING_AID)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(AudioDeviceInfo.TYPE_BLE_HEADSET)
  }

  fun screen(context: Context): String {
    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    return if (power.isInteractive) "on" else "off"
  }

  fun locked(context: Context): Boolean {
    val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    return keyguard.isKeyguardLocked
  }

  /** From the sticky battery broadcast: percent (rounded) and whether it's plugged in. */
  fun battery(context: Context): Pair<Int?, Boolean?> {
    val intent = sticky(context) ?: return null to null
    return battery(intent)
  }

  fun battery(intent: Intent): Pair<Int?, Boolean?> {
    val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    val percent = if (level >= 0 && scale > 0) (level * 100.0 / scale).roundToInt().coerceIn(0, 100) else null
    val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)
    return percent to (if (plugged >= 0) plugged != 0 else null)
  }

  private fun sticky(context: Context): Intent? = try {
    context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
  } catch (e: Exception) {
    Log.w(TAG, "battery read failed", e)
    null
  }

  /** Wired, USB or Bluetooth headphones (or earbuds) are an output right now. */
  fun headphones(context: Context): Boolean {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    return audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in HEADPHONE_TYPES }
  }

  fun dnd(context: Context): Boolean? {
    val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return when (notifications.currentInterruptionFilter) {
      NotificationManager.INTERRUPTION_FILTER_ALL -> false
      NotificationManager.INTERRUPTION_FILTER_PRIORITY,
      NotificationManager.INTERRUPTION_FILTER_NONE,
      NotificationManager.INTERRUPTION_FILTER_ALARMS,
      -> true
      else -> null
    }
  }

  fun ringer(context: Context): String? {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    return when (audio.ringerMode) {
      AudioManager.RINGER_MODE_NORMAL -> "normal"
      AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
      AudioManager.RINGER_MODE_SILENT -> "silent"
      else -> null
    }
  }

  /**
   * The phone's own networks, VPNs left out (Tailscale is always on: its network is the default one,
   * and it says nothing about Wi-Fi or mobile data). Wi-Fi wins when both are up.
   */
  @Suppress("DEPRECATION")
  fun network(context: Context): Pair<String, String?> {
    val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val all = try {
      connectivity.allNetworks.mapNotNull { connectivity.getNetworkCapabilities(it) }
    } catch (e: Exception) {
      Log.w(TAG, "network read failed", e)
      emptyList()
    }
    return classify(context, all)
  }

  /**
   * The type from every network up right now; the Wi-Fi name preferably from `fromCallback` (a
   * callback's capabilities, which carry it on Android 12+).
   */
  fun network(context: Context, fromCallback: Collection<NetworkCapabilities>): Pair<String, String?> {
    val (type, name) = network(context)
    if (type != "wifi") return type to null
    val wifi = fromCallback.firstOrNull { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }
    return type to (wifi?.let { ssid(context, it) } ?: name)
  }

  private fun classify(context: Context, networks: List<NetworkCapabilities>): Pair<String, String?> {
    val own = networks.filter { !it.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }
    val wifi = own.firstOrNull { it.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) }
    if (wifi != null) return "wifi" to ssid(context, wifi)
    if (own.any { it.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) }) return "cellular" to null
    return "none" to null
  }

  /**
   * The Wi-Fi name, or null without location permission / with location off (Android hides it then).
   * Android 12+: from the network's own info when the callback asked for location info; otherwise
   * from WifiManager (deprecated, still answers with the permission).
   */
  @Suppress("DEPRECATION")
  private fun ssid(context: Context, capabilities: NetworkCapabilities): String? {
    val fromNetwork = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      (capabilities.transportInfo as? WifiInfo)?.ssid
    } else {
      null
    }
    val raw = clean(fromNetwork) ?: run {
      val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      clean(try {
        wifi?.connectionInfo?.ssid
      } catch (e: Exception) {
        null
      })
    }
    return raw
  }

  /** WifiInfo quotes UTF-8 names ("\"Home\"") and says "<unknown ssid>" when it may not tell. */
  private fun clean(ssid: String?): String? {
    if (ssid.isNullOrEmpty() || ssid == "<unknown ssid>" || ssid == "0x") return null
    val name = if (ssid.length >= 2 && ssid.startsWith("\"") && ssid.endsWith("\"")) ssid.substring(1, ssid.length - 1) else ssid
    return name.ifEmpty { null }
  }

  /**
   * The live fields (all but motion and place, which come from wake-ups). A reading Android didn't
   * give is left out rather than sent as null (null tells her "no longer known"); `wifi_name` null
   * is a real answer (not on Wi-Fi, or the name is hidden).
   */
  fun live(context: Context): Map<String, Any?> {
    val (battery, charging) = battery(context)
    val (network, wifiName) = network(context)
    val values = linkedMapOf<String, Any?>(
      "screen" to screen(context),
      "locked" to locked(context),
      "headphones" to headphones(context),
      "network" to network,
      "wifi_name" to wifiName,
    )
    battery?.let { values["battery"] = it }
    charging?.let { values["charging"] = it }
    dnd(context)?.let { values["dnd"] = it }
    ringer(context)?.let { values["ringer"] = it }
    return values
  }
}
