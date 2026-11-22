package expo.modules.jophielnotifications

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal const val TAG = "JophielNotifications"

/**
 * What the module keeps between runs (app-private): the Notifications sense switch and the Messages
 * switch (mirrored from JS, read with no JS running), the per-install id secret, each live
 * notification's revision, the keys she was told about (so their removal reaches her even after
 * the process died), and the credentials for background sends (encrypted, Android keystore).
 */
internal object Store {
  private const val PREFS = "jophiel.notifications"
  private const val ENABLED = "enabled"
  private const val MESSAGES_ON = "messagesOn"
  private const val SECRET = "secret"
  private const val REVISIONS = "revisions"
  private const val SENT = "sent"
  private const val LAST_SENT_AT = "lastSentAt"
  private const val CREDENTIALS = "credentials"

  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ---- Switches ----

  /** Settings → Phone senses → Notifications. On by default, also before JS first configures. */
  fun enabled(context: Context): Boolean = prefs(context).getBoolean(ENABLED, true)

  /** Settings → Phone actions → Messages: off pauses every reply and draft, checked at dispatch. */
  fun messagesOn(context: Context): Boolean = prefs(context).getBoolean(MESSAGES_ON, true)

  fun setSwitches(context: Context, enabled: Boolean, messagesOn: Boolean) {
    prefs(context).edit().putBoolean(ENABLED, enabled).putBoolean(MESSAGES_ON, messagesOn).apply()
  }

  // ---- Ids ----

  @Synchronized
  fun secret(context: Context): ByteArray {
    prefs(context).getString(SECRET, null)?.let { stored ->
      runCatching { Base64.decode(stored, Base64.NO_WRAP) }.getOrNull()?.takeIf { it.size == 32 }?.let { return it }
    }
    val fresh = ByteArray(32).also { SecureRandom().nextBytes(it) }
    prefs(context).edit().putString(SECRET, Base64.encodeToString(fresh, Base64.NO_WRAP)).apply()
    return fresh
  }

  // ---- Revisions (per Android notification key) ----

  private fun obj(context: Context, key: String): JSONObject =
    prefs(context).getString(key, null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()

  /** The next revision of a key (1 for a new one). */
  @Synchronized
  fun bumpRevision(context: Context, sbnKey: String): Int {
    val revisions = obj(context, REVISIONS)
    val next = revisions.optInt(sbnKey, 0) + 1
    revisions.put(sbnKey, next)
    prefs(context).edit().putString(REVISIONS, revisions.toString()).apply()
    return next
  }

  /** The current revision, or a first one for a key not seen yet (a resync doesn't count as an update). */
  @Synchronized
  fun revision(context: Context, sbnKey: String): Int {
    val revisions = obj(context, REVISIONS)
    if (revisions.has(sbnKey)) return revisions.optInt(sbnKey, 1)
    revisions.put(sbnKey, 1)
    prefs(context).edit().putString(REVISIONS, revisions.toString()).apply()
    return 1
  }

  @Synchronized
  fun forgetRevision(context: Context, sbnKey: String) {
    val revisions = obj(context, REVISIONS)
    revisions.remove(sbnKey)
    prefs(context).edit().putString(REVISIONS, revisions.toString()).apply()
  }

  /** Only the keys still on the phone keep a revision. */
  @Synchronized
  fun pruneRevisions(context: Context, live: Set<String>) {
    val revisions = obj(context, REVISIONS)
    val stale = revisions.keys().asSequence().filter { it !in live }.toList()
    if (stale.isEmpty()) return
    stale.forEach { revisions.remove(it) }
    prefs(context).edit().putString(REVISIONS, revisions.toString()).apply()
  }

  // ---- What she was told ----

  @Synchronized
  fun sentKeys(context: Context): Set<String> {
    val raw = prefs(context).getString(SENT, null) ?: return emptySet()
    return runCatching {
      val array = JSONArray(raw)
      (0 until array.length()).map { array.getString(it) }.toSet()
    }.getOrDefault(emptySet())
  }

  @Synchronized
  fun setSentKeys(context: Context, keys: Set<String>) {
    prefs(context).edit().putString(SENT, JSONArray(keys.toList()).toString()).apply()
  }

  fun lastSentAt(context: Context): Long = prefs(context).getLong(LAST_SENT_AT, 0L)

  fun markSentAt(context: Context, at: Long) {
    prefs(context).edit().putLong(LAST_SENT_AT, at).apply()
  }

  // ---- Credentials for background sends ----

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
      prefs(context).edit().remove(CREDENTIALS).apply()
      return null
    }
    return runCatching {
      val json = JSONObject(plain)
      Credentials(json.getString("serverUrl"), json.getString("token"))
    }.getOrNull()
  }

  fun hasCredentials(context: Context): Boolean = prefs(context).contains(CREDENTIALS)

  /** Logout (or a dead token): no more sends, and nothing about what this account was told is kept. */
  @Synchronized
  fun clearAccount(context: Context) {
    prefs(context).edit().remove(CREDENTIALS).remove(SENT).remove(LAST_SENT_AT).apply()
  }
}

/** AES-GCM with a key that never leaves the Android keystore. */
internal object Secret {
  private const val KEYSTORE = "AndroidKeyStore"
  private const val ALIAS = "jophiel.notifications.credentials"
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
