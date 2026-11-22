package expo.modules.jophielnotifications

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/*
 * The pure half of the notifications sense (PLAN_PHASE_8.md "The contract"): which notifications
 * count, what's sent for one, the opaque ids, coalescing, the Maps trip and the reply checks. No
 * Android classes here, so it's unit-tested on the JVM (src/test).
 */

/** Text is cut to these (code points) so one huge notification can't bloat a frame. */
internal const val MAX_TITLE = 200
internal const val MAX_TEXT = 1_000
internal const val MAX_MESSAGES = 5
internal const val COALESCE_MS = 5_000L

/** One message of a chat notification (`MessagingStyle`), as Android gave it. */
internal data class RawMessage(
  /** As shown; null for the phone owner's own messages. */
  val sender: String?,
  /** The sender's `Person` URI (`tel:…`, a contacts lookup URI), when the app set one. */
  val senderUri: String?,
  val text: String,
  /** Epoch ms. */
  val at: Long,
  /** Written on this phone (by you, or by her through a reply button). */
  val fromOwner: Boolean,
)

/** A posted notification, read off its `StatusBarNotification` (Listener.kt). */
internal data class RawNotification(
  val sbnKey: String,
  val packageName: String,
  val appName: String,
  val tag: String?,
  val ongoing: Boolean,
  val foregroundService: Boolean,
  val groupSummary: Boolean,
  val category: String?,
  /** Its channel doesn't make a sound or show a heads-up (importance low or below). */
  val silent: Boolean,
  /** Comes from an app that's part of the system image. */
  val systemApp: Boolean,
  val title: String?,
  val text: String?,
  /** `MessagingStyle`'s conversation title (a group's name), when there is one. */
  val conversationTitle: String?,
  /** The conversation shortcut (`Notification.getShortcutId`): WhatsApp, Telegram, Messages. */
  val shortcutId: String?,
  val isGroup: Boolean,
  val messages: List<RawMessage>,
  /** An action with a `RemoteInput` (a reply button). */
  val canReply: Boolean,
  /** Epoch ms. */
  val postedAt: Long,
)

/** What a sender resolves to in the phone's contacts. */
internal data class ContactMatch(val lookupKey: String)

internal data class SentMessage(
  val eventId: String,
  val sender: String,
  val senderId: String,
  /** `contact` (made from the contact), `name` (conversation-local), `owner` (you). */
  val identity: String,
  val inContacts: Boolean,
  val text: String,
  val at: String,
)

/** One entry of the frame's `posted`. */
internal data class Posted(
  val key: String,
  val revision: Int,
  val app: String,
  val packageName: String,
  val title: String?,
  val text: String?,
  val conversation: String?,
  val conversationId: String,
  /** `shortcut` (Android's conversation id) or `title` (weaker: tag + title). */
  val conversationIdentity: String,
  val isGroup: Boolean,
  val messages: List<SentMessage>,
  val canReply: Boolean,
  val postedAt: String,
)

internal data class Removed(val key: String, val reason: String)

internal object NotificationFilter {
  private const val CATEGORY_TRANSPORT = "transport"
  private const val CATEGORY_PROGRESS = "progress"
  private val SYSTEM_CATEGORIES = setOf("sys", "service", "status")

  /**
   * Whether she's told about it. Left out: ongoing ones (music, downloads, navigation, "Jophiel is
   * listening"), group summaries (they repeat their children), media players, progress bars,
   * silent system ones, Jophiel's own, and empty ones. Codes and bank alerts stay in (owner).
   */
  fun include(n: RawNotification, ownPackage: String): Boolean {
    if (n.packageName == ownPackage) return false
    if (n.ongoing || n.foregroundService) return false
    if (n.groupSummary) return false
    if (n.category == CATEGORY_TRANSPORT || n.category == CATEGORY_PROGRESS) return false
    if (n.systemApp && n.silent) return false
    if (n.category in SYSTEM_CATEGORIES && (n.silent || n.systemApp)) return false
    return !(n.title.isNullOrBlank() && n.text.isNullOrBlank() && n.messages.isEmpty())
  }
}

/**
 * The opaque ids: HMAC-SHA256 with a per-install secret, so the same input gives the same id on
 * this install and nothing on the server can be turned back into a name, number or key. A reinstall
 * makes new ids (new records on the backend, by design).
 */
internal class Ids(secret: ByteArray) {
  private val key = SecretKeySpec(secret, "HmacSHA256")

  private fun hash(prefix: String, vararg parts: String?): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(key)
    val input = parts.joinToString("\u0000") { it ?: "" }
    val digest = mac.doFinal(input.toByteArray(Charsets.UTF_8))
    return prefix + "_" + Base64.getUrlEncoder().withoutPadding().encodeToString(digest).take(22)
  }

  fun key(sbnKey: String): String = hash("n", "key", sbnKey)

  /** Android's conversation shortcut when there is one, else package + tag + title (weaker). */
  fun conversation(packageName: String, shortcutId: String?, tag: String?, title: String?): Pair<String, String> =
    if (!shortcutId.isNullOrBlank()) {
      hash("c", "shortcut", packageName, shortcutId) to "shortcut"
    } else {
      hash("c", "title", packageName, tag, title) to "title"
    }

  /**
   * A contact's lookup key (stable across apps), else name + app + conversation: two strangers
   * called "Budi" in different chats never merge.
   */
  fun sender(contact: ContactMatch?, name: String, packageName: String, conversationId: String): Pair<String, String> =
    if (contact != null) {
      hash("p", "contact", contact.lookupKey) to "contact"
    } else {
      hash("p", "name", name, packageName, conversationId) to "name"
    }

  /** The same message in two overlapping snapshots has one id, so it counts once. */
  fun event(conversationId: String, sender: String, at: Long, text: String): String =
    hash("e", conversationId, sender, at.toString(), text)
}

internal fun clip(text: String?, max: Int): String? {
  if (text == null) return null
  val trimmed = text.trim()
  if (trimmed.isEmpty()) return null
  if (trimmed.codePointCount(0, trimmed.length) <= max) return trimmed
  return trimmed.substring(0, trimmed.offsetByCodePoints(0, max))
}

internal fun isoTime(at: Long, zone: ZoneId): String = OffsetDateTime.ofInstant(Instant.ofEpochMilli(at), zone).toString()

internal object Extract {
  /** Owner messages: no contact lookup, one fixed id. */
  const val OWNER_ID = "owner"

  /**
   * The `posted` entry for a notification. `contact` looks a sender up in the phone's contacts
   * (null without the permission, or no match).
   */
  fun posted(
    n: RawNotification,
    ids: Ids,
    revision: Int,
    zone: ZoneId,
    ownerName: String?,
    contact: (RawMessage) -> ContactMatch?,
  ): Posted {
    val conversationName = clip(n.conversationTitle, MAX_TITLE) ?: clip(n.title, MAX_TITLE)
    val (conversationId, conversationIdentity) = ids.conversation(n.packageName, n.shortcutId, n.tag, conversationName)
    val messages = n.messages.takeLast(MAX_MESSAGES).mapNotNull { m ->
      val text = clip(m.text, MAX_TEXT) ?: return@mapNotNull null
      if (m.fromOwner) {
        val name = clip(ownerName, MAX_TITLE) ?: "You"
        return@mapNotNull SentMessage(ids.event(conversationId, OWNER_ID, m.at, text), name, OWNER_ID, "owner", false, text, isoTime(m.at, zone))
      }
      val name = clip(m.sender, MAX_TITLE) ?: conversationName ?: "Unknown"
      val match = contact(m)
      val (senderId, identity) = ids.sender(match, name, n.packageName, conversationId)
      SentMessage(ids.event(conversationId, name, m.at, text), name, senderId, identity, match != null, text, isoTime(m.at, zone))
    }
    return Posted(
      key = ids.key(n.sbnKey),
      revision = revision,
      app = n.appName,
      packageName = n.packageName,
      title = clip(n.title, MAX_TITLE),
      text = clip(n.text, MAX_TEXT),
      conversation = conversationName,
      conversationId = conversationId,
      conversationIdentity = conversationIdentity,
      isGroup = n.isGroup,
      messages = messages,
      canReply = n.canReply,
      postedAt = isoTime(n.postedAt, zone),
    )
  }

  /** `onNotificationRemoved`'s reason code, in words. */
  fun removalReason(code: Int): String = when (code) {
    1 -> "opened" // REASON_CLICK
    2, 3 -> "cleared" // REASON_CANCEL, REASON_CANCEL_ALL
    8, 9 -> "app" // REASON_APP_CANCEL, REASON_APP_CANCEL_ALL
    10, 11 -> "dismissed" // REASON_LISTENER_CANCEL(_ALL): she dismissed it
    18 -> "snoozed" // REASON_SNOOZED
    19 -> "timeout" // REASON_TIMEOUT
    else -> "removed"
  }
}

/**
 * Per key, changes within a window go out as one (the latest): a busy group chat is one update
 * with its newest messages. The window starts with the first change and isn't pushed back by
 * later ones, so a chat that never stops still reaches her every 5 s.
 */
internal class Coalescer<T>(private val windowMs: Long = COALESCE_MS) {
  private val pending = LinkedHashMap<String, Pair<T, Long>>()

  /** Keep `item` as the key's latest; returns when it's due. */
  fun post(key: String, item: T, now: Long): Long {
    val due = pending[key]?.second ?: (now + windowMs)
    pending[key] = item to due
    return due
  }

  /** Drop a pending update (the notification went away first). True when one was waiting. */
  fun remove(key: String): Boolean = pending.remove(key) != null

  /** Everything due by `now`, in the order first changed. */
  fun due(now: Long): List<T> {
    val ready = pending.filterValues { it.second <= now }
    ready.keys.forEach { pending.remove(it) }
    return ready.values.map { it.first }
  }

  fun nextDue(): Long? = pending.values.minOfOrNull { it.second }

  fun clear() = pending.clear()

  fun isEmpty(): Boolean = pending.isEmpty()
}

/** The Maps trip: the next step and the time left, from Google Maps' navigation notification. */
internal data class Navigation(val nextStep: String, val distanceText: String?, val etaText: String?)

internal object MapsTrip {
  const val PACKAGE = "com.google.android.apps.maps"
  private const val MAX = 160

  /** "300 m", "1.2 km", "0,5 km", "500 ft", "2 mi", optionally followed by the instruction. */
  private val DISTANCE = Regex("""^(\d+(?:[.,]\d+)?\s?(?:m|km|ft|mi|yd))\b\s*[·•\-–]?\s*(.*)$""", RegexOption.IGNORE_CASE)
  /** A line that reads like time left / arrival: "15 min", "1 hr 5 min", "ETA 19:30", "19:30 arrival". */
  private val TIME = Regex("""(\d+\s?(?:min|mins|minutes|hr|hrs|h|hours?)\b)|(\d{1,2}[:.]\d{2})|\bETA\b|arrival|tiba""", RegexOption.IGNORE_CASE)

  /**
   * Maps' layout isn't an API and changes with Maps updates, so this fails soft: null when there's
   * no step to read. Usually the title is the distance ("300 m") and the text the instruction
   * ("Turn left onto Jl. Kemang Raya"); the sub text has time left and arrival.
   */
  fun parse(title: String?, text: String?, subText: String?, bigText: String?): Navigation? {
    val lines = listOfNotNull(clip(title, MAX), clip(text, MAX), clip(bigText, MAX)).distinct()
    if (lines.isEmpty()) return null
    var distance: String? = null
    val rest = mutableListOf<String>()
    for (line in lines) {
      val match = DISTANCE.matchEntire(line)
      if (distance == null && match != null) {
        distance = match.groupValues[1]
        match.groupValues[2].trim().takeIf { it.isNotEmpty() }?.let(rest::add)
      } else {
        rest.add(line)
      }
    }
    val eta = clip(subText, MAX) ?: rest.firstOrNull { TIME.containsMatchIn(it) && rest.size > 1 }
    val step = rest.firstOrNull { it != eta } ?: return null
    return Navigation(step, distance, eta)
  }

  /** Sent when the step or the arrival changes, not on every distance tick. */
  fun worthSending(previous: Navigation?, next: Navigation?): Boolean {
    if (previous == null || next == null) return previous != next
    return previous.nextStep != next.nextStep || previous.etaText != next.etaText
  }
}

/** What the phone knows about a live notification, for her reply / dismiss. */
internal data class LiveEntry(val packageName: String, val conversationId: String, val revision: Int, val canReply: Boolean)

internal object ReplyCheck {
  /**
   * The phone-side dispatch check (also done on the backend): the Messages switch on, the key still
   * live, the same conversation, not older than she saw, a reply button. Null: go ahead. Never falls
   * back to another way of sending.
   */
  fun check(entry: LiveEntry?, conversationId: String?, revision: Int?, messagesOn: Boolean): String? {
    if (!messagesOn) return "replies_paused"
    if (entry == null) return "notification_gone"
    if (conversationId != null && conversationId != entry.conversationId) return "stale"
    if (revision != null && entry.revision < revision) return "stale"
    if (!entry.canReply) return "no_reply_button"
    return null
  }
}
