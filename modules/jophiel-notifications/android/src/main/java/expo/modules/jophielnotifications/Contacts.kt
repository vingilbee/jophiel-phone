package expo.modules.jophielnotifications

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.util.Log

/**
 * Who's a contact, for `in_contacts` and contact-based sender ids. Only a contact's lookup key is
 * used (hashed before it leaves); numbers and names from the address book never leave the phone.
 */
internal object Contacts {
  private const val CACHE_MS = 10 * 60_000L
  private val PHONE_LIKE = Regex("""^[+\d][\d\s\-().]{5,}$""")

  private data class Cached(val match: ContactMatch?, val at: Long)
  private val cache = HashMap<String, Cached>()

  fun granted(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

  /** The sender's contact: from its `Person` URI when the app gave one, else an exact, unique name. */
  @Synchronized
  fun match(context: Context, message: RawMessage): ContactMatch? {
    if (!granted(context)) return null
    val cacheKey = "${message.senderUri ?: ""}\u0000${message.sender ?: ""}"
    val now = System.currentTimeMillis()
    cache[cacheKey]?.let { if (now - it.at < CACHE_MS) return it.match }
    val match = try {
      lookup(context, message.senderUri, message.sender)
    } catch (e: Exception) {
      Log.w(TAG, "contact lookup failed", e)
      null
    }
    if (cache.size > 500) cache.clear()
    cache[cacheKey] = Cached(match, now)
    return match
  }

  @Synchronized
  fun forgetCache() = cache.clear()

  private fun lookup(context: Context, uri: String?, name: String?): ContactMatch? {
    if (uri != null) {
      when {
        uri.startsWith("tel:") -> return byNumber(context, Uri.decode(uri.removePrefix("tel:")))
        uri.startsWith(ContactsContract.Contacts.CONTENT_URI.toString()) -> return byContactUri(context, Uri.parse(uri))
      }
    }
    val shown = name?.trim().orEmpty()
    if (shown.isEmpty()) return null
    // Apps show an unknown sender by number ("+62 812-3456-7890").
    if (PHONE_LIKE.matches(shown)) return byNumber(context, shown)
    return byName(context, shown)
  }

  /**
   * A contact URI the app gave (a lookup URI, or a plain contact id): only a contact that exists
   * on this phone counts, under its current lookup key (an app's copy can be stale or made up).
   */
  private fun byContactUri(context: Context, uri: Uri): ContactMatch? {
    val resolver = context.contentResolver
    val contact = if (uri.toString().startsWith(ContactsContract.Contacts.CONTENT_LOOKUP_URI.toString())) {
      ContactsContract.Contacts.lookupContact(resolver, uri) ?: return null
    } else {
      uri
    }
    // Only `contacts/<id>`: the bare table, or a sub-path (photo, data…), isn't one person.
    if (!isOneContact(contact)) return null
    resolver.query(contact, arrayOf(ContactsContract.Contacts.LOOKUP_KEY), null, null, null)?.use { cursor ->
      if (cursor.count == 1 && cursor.moveToFirst()) return cursor.getString(0)?.let(::ContactMatch)
    }
    return null
  }

  private fun isOneContact(uri: Uri): Boolean {
    val base = ContactsContract.Contacts.CONTENT_URI
    if (uri.scheme != base.scheme || uri.authority != base.authority) return false
    val segments = uri.pathSegments
    return segments.size == 2 && segments[0] == base.lastPathSegment && segments[1].toLongOrNull() != null
  }

  private fun byNumber(context: Context, number: String): ContactMatch? {
    if (number.isBlank()) return null
    val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
    context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.LOOKUP_KEY), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) return cursor.getString(0)?.let(::ContactMatch)
    }
    return null
  }

  /** Exactly one contact shown by this name (several: can't tell, so not a contact match). */
  private fun byName(context: Context, name: String): ContactMatch? {
    val keys = HashSet<String>()
    context.contentResolver.query(
      ContactsContract.Contacts.CONTENT_URI,
      arrayOf(ContactsContract.Contacts.LOOKUP_KEY),
      "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} = ? COLLATE NOCASE",
      arrayOf(name),
      null,
    )?.use { cursor ->
      while (cursor.moveToNext()) cursor.getString(0)?.let(keys::add)
    }
    return keys.singleOrNull()?.let(::ContactMatch)
  }
}
