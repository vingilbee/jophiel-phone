package expo.modules.jophielsenses

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal const val TAG = "JophielSenses"

/** The seven switch groups (Settings → Phone senses) and the fields each one reports. */
internal object Groups {
  const val PHONE_USE = "phoneUse"
  const val BATTERY = "battery"
  const val HEADPHONES = "headphones"
  const val NETWORK = "network"
  const val SOUND_MODE = "soundMode"
  const val MOTION = "motion"
  const val PLACES = "places"

  val FIELDS: Map<String, List<String>> = linkedMapOf(
    PHONE_USE to listOf("screen", "locked"),
    BATTERY to listOf("battery", "charging"),
    HEADPHONES to listOf("headphones"),
    NETWORK to listOf("network", "wifi_name"),
    SOUND_MODE to listOf("dnd", "ringer"),
    MOTION to listOf("motion"),
    PLACES to listOf("place"),
  )
}

/** A value as last handed on (sent in a `sense` frame or queued for the PUT), and when. */
internal data class Reported(val value: Any?, val at: Long, val since: Long)

/**
 * Everything the module keeps between runs, in app-private storage: the switches and places
 * (mirrored from JS, so a reboot can re-register without JS), the circles you're inside, the last
 * motion / place, what was last reported, and the credentials for background reports (encrypted
 * with a key in the Android keystore).
 */
internal object Store {
  private const val PREFS = "jophiel.senses"
  private const val GROUPS = "groups"
  private const val PLACES = "places"
  private const val INSIDE = "inside"
  private const val VALUES = "values"
  private const val HANDED = "handed"
  private const val REPORTED = "reported"
  private const val CREDENTIALS = "credentials"

  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun obj(context: Context, key: String): JSONObject =
    prefs(context).getString(key, null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()

  // ---- Switches and places ----

  /** All groups on unless switched off (the default, also before JS first configures). */
  @Synchronized
  fun groups(context: Context): Map<String, Boolean> {
    val stored = obj(context, GROUPS)
    return Groups.FIELDS.keys.associateWith { stored.optBoolean(it, true) }
  }

  @Synchronized
  fun setGroups(context: Context, groups: Map<String, Boolean>) {
    val json = JSONObject()
    Groups.FIELDS.keys.forEach { json.put(it, groups[it] ?: true) }
    prefs(context).edit().putString(GROUPS, json.toString()).apply()
  }

  fun groupOn(context: Context, group: String): Boolean = groups(context)[group] ?: true

  /** The fields of the groups switched on. */
  fun enabledFields(context: Context): Set<String> =
    groups(context).filterValues { it }.keys.flatMap { Groups.FIELDS[it].orEmpty() }.toSet()

  @Synchronized
  fun places(context: Context): List<Place> {
    val raw = prefs(context).getString(PLACES, null) ?: return emptyList()
    return runCatching {
      val array = JSONArray(raw)
      (0 until array.length()).map { i ->
        val p = array.getJSONObject(i)
        Place(p.getString("id"), p.getString("name"), p.getDouble("latitude"), p.getDouble("longitude"), p.getDouble("radius"))
      }
    }.getOrDefault(emptyList())
  }

  @Synchronized
  fun setPlaces(context: Context, places: List<Place>) {
    val array = JSONArray()
    places.forEach {
      array.put(
        JSONObject()
          .put("id", it.id)
          .put("name", it.name)
          .put("latitude", it.latitude)
          .put("longitude", it.longitude)
          .put("radius", it.radius),
      )
    }
    prefs(context).edit().putString(PLACES, array.toString()).apply()
  }

  // ---- Place and motion state ----

  @Synchronized
  fun inside(context: Context): Set<String> {
    val raw = prefs(context).getString(INSIDE, null) ?: return emptySet()
    return runCatching {
      val array = JSONArray(raw)
      (0 until array.length()).map { array.getString(it) }.toSet()
    }.getOrDefault(emptySet())
  }

  @Synchronized
  fun setInside(context: Context, ids: Set<String>) {
    prefs(context).edit().putString(INSIDE, JSONArray(ids.toList()).toString()).apply()
  }

  /** `motion` / `place` as last seen. Absent: unknown; present and null: known to be none. */
  @Synchronized
  fun values(context: Context): Map<String, Any?> {
    val json = obj(context, VALUES)
    return json.keys().asSequence().associateWith { normalize(json.opt(it)) }
  }

  @Synchronized
  fun setValue(context: Context, field: String, value: Any?) {
    val json = obj(context, VALUES)
    json.put(field, value ?: JSONObject.NULL)
    prefs(context).edit().putString(VALUES, json.toString()).apply()
  }

  @Synchronized
  fun forgetValue(context: Context, field: String) {
    val json = obj(context, VALUES)
    json.remove(field)
    prefs(context).edit().putString(VALUES, json.toString()).apply()
  }

  // ---- What was reported ----

  /** The fields whose value differs from what was last handed on (sent, or queued to send). */
  @Synchronized
  fun unhanded(context: Context, fields: Map<String, Any?>): Map<String, Any?> {
    val handed = obj(context, HANDED)
    return fields.filter { (name, value) -> !handed.has(name) || normalize(handed.opt(name)) != normalize(value) }
  }

  @Synchronized
  fun markHanded(context: Context, fields: Map<String, Any?>) {
    val handed = obj(context, HANDED)
    fields.forEach { (name, value) -> handed.put(name, value ?: JSONObject.NULL) }
    prefs(context).edit().putString(HANDED, handed.toString()).apply()
  }

  /**
   * What reached the server (a `sense` frame went out, or the PUT succeeded) and when. An older
   * observation arriving late doesn't replace a newer one (the server ignores it too).
   */
  @Synchronized
  fun markReported(context: Context, fields: Map<String, Any?>, at: Long) {
    val reported = obj(context, REPORTED)
    fields.forEach { (name, raw) ->
      val value = normalize(raw)
      val old = reported.optJSONObject(name)
      val oldAt = old?.optLong("at", 0L) ?: 0L
      if (old != null && at < oldAt) return@forEach
      val same = old != null && normalize(old.opt("value")) == value
      val since = if (same) old!!.optLong("since", at) else at
      reported.put(name, JSONObject().put("value", value ?: JSONObject.NULL).put("at", at).put("since", since))
    }
    prefs(context).edit().putString(REPORTED, reported.toString()).apply()
  }

  @Synchronized
  fun reported(context: Context): Map<String, Reported> {
    val json = obj(context, REPORTED)
    return json.keys().asSequence().mapNotNull { name ->
      val entry = json.optJSONObject(name) ?: return@mapNotNull null
      name to Reported(normalize(entry.opt("value")), entry.optLong("at"), entry.optLong("since"))
    }.toMap()
  }

  /** Logout (or a dead token): nothing about this account's phone is kept. Switches and places stay. */
  @Synchronized
  fun clearState(context: Context) {
    prefs(context).edit().remove(INSIDE).remove(VALUES).remove(HANDED).remove(REPORTED).apply()
  }

  // ---- Credentials for background reports ----

  data class Credentials(val serverUrl: String, val token: String)

  @Synchronized
  fun setCredentials(context: Context, credentials: Credentials) {
    val plain = JSONObject().put("serverUrl", credentials.serverUrl).put("token", credentials.token).toString()
    val sealed = Secret.seal(plain)
    if (sealed == null) {
      Log.w(TAG, "credentials not stored: keystore unavailable")
      prefs(context).edit().remove(CREDENTIALS).apply()
      return
    }
    prefs(context).edit().putString(CREDENTIALS, sealed).apply()
  }

  @Synchronized
  fun credentials(context: Context): Credentials? {
    val sealed = prefs(context).getString(CREDENTIALS, null) ?: return null
    val plain = Secret.open(sealed)
    if (plain == null) {
      // Unreadable (keystore reset, restored backup): drop it; the next app start stores it again.
      prefs(context).edit().remove(CREDENTIALS).apply()
      return null
    }
    return runCatching {
      val json = JSONObject(plain)
      Credentials(json.getString("serverUrl"), json.getString("token"))
    }.getOrNull()
  }

  fun hasCredentials(context: Context): Boolean = prefs(context).contains(CREDENTIALS)

  @Synchronized
  fun clearCredentials(context: Context) {
    prefs(context).edit().remove(CREDENTIALS).apply()
  }

  /** JSON and the JS bridge give numbers as Double / Long; compare them as the Int they are. */
  fun normalize(value: Any?): Any? = when (value) {
    null, JSONObject.NULL -> null
    is Number -> value.toDouble().let { if (it == Math.floor(it) && !it.isInfinite()) it.toInt() else it }
    else -> value
  }
}

/** AES-GCM with a key that never leaves the Android keystore. */
internal object Secret {
  private const val KEYSTORE = "AndroidKeyStore"
  private const val ALIAS = "jophiel.senses.credentials"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"

  private fun key(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  fun seal(plain: String): String? = try {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
    val data = Base64.encodeToString(cipher.doFinal(plain.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    "$iv:$data"
  } catch (e: Exception) {
    Log.w(TAG, "seal failed", e)
    null
  }

  fun open(sealed: String): String? = try {
    val (iv, data) = sealed.split(":", limit = 2).let { it[0] to it[1] }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
    String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), Charsets.UTF_8)
  } catch (e: Exception) {
    Log.w(TAG, "open failed", e)
    null
  }
}
