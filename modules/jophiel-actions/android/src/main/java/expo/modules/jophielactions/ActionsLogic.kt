package expo.modules.jophielactions

import java.text.Normalizer

/** A launchable app: its label as the launcher shows it, and its package. */
internal data class App(val label: String, val packageName: String)

/** What `open_app`'s name matched. */
internal sealed class AppMatch {
  data class Found(val app: App) : AppMatch()
  object NotFound : AppMatch()
  object Ambiguous : AppMatch()
}

/** Phase 8, pure parts of the new actions (unit-tested in src/test). */
internal object AppMatcher {
  /** "Gojek", "GOJEK ", "go-jek" and "Gójek" all read "gojek". */
  fun key(text: String): String =
    Normalizer.normalize(text, Normalizer.Form.NFD)
      .replace(Regex("\\p{M}+"), "")
      .lowercase()
      .replace(Regex("[^\\p{L}\\p{N}]+"), "")

  /**
   * The app she means by `name`: an exact label first, then a unique label starting with it, then a
   * unique label containing it. Several labels at the best level → ambiguous (she asks you).
   */
  fun match(name: String, apps: List<App>): AppMatch {
    val wanted = key(name)
    if (wanted.isEmpty()) return AppMatch.NotFound
    val keyed = apps.distinctBy { it.packageName }.map { key(it.label) to it }
    for (level in listOf<(String) -> Boolean>({ it == wanted }, { it.startsWith(wanted) }, { it.contains(wanted) })) {
      val hits = keyed.filter { level(it.first) }.map { it.second }
      if (hits.size == 1) return AppMatch.Found(hits[0])
      if (hits.size > 1) {
        // The same label twice (a work profile, a clone): still one app for her.
        val labels = hits.map { key(it.label) }.toSet()
        return if (labels.size == 1) AppMatch.Found(hits[0]) else AppMatch.Ambiguous
      }
    }
    return AppMatch.NotFound
  }
}

/** A contact that matched `whatsapp_draft`'s `to`, with what WhatsApp knows it by. */
internal data class DraftContact(val contactId: Long, val name: String, val waNumber: String?)

internal sealed class DraftTarget {
  /** Straight into that chat, the text typed in. */
  data class Chat(val number: String) : DraftTarget()
  /** WhatsApp's share sheet with the text: you pick the chat. */
  object Picker : DraftTarget()
}

internal object WhatsAppLogic {
  /** WhatsApp's own contact rows carry the number as "6281234567890@s.whatsapp.net". */
  fun numberFromJid(jid: String?): String? {
    val digits = jid?.substringBefore('@')?.filter(Char::isDigit) ?: return null
    return digits.takeIf { it.length >= 6 }
  }

  /** A phone number in international form ("+62 812-3456", "0062…") as wa.me digits; local numbers can't be told apart, null. */
  fun internationalDigits(number: String?): String? {
    val trimmed = number?.trim() ?: return null
    val digits = trimmed.filter(Char::isDigit)
    return when {
      trimmed.startsWith("+") && digits.length >= 6 -> digits
      digits.startsWith("00") && digits.length >= 8 -> digits.removePrefix("00")
      else -> null
    }
  }

  /**
   * Exactly one contact by that name (exact first, else a unique "contains") with a WhatsApp number
   * → that chat. None, several, or no number → the picker. The number never leaves the phone.
   */
  fun choose(to: String?, contacts: List<DraftContact>): DraftTarget {
    val wanted = to?.let(AppMatcher::key)?.takeIf { it.isNotEmpty() } ?: return DraftTarget.Picker
    val byContact = contacts.groupBy { it.contactId }
    fun pick(filter: (String) -> Boolean): List<List<DraftContact>> =
      byContact.values.filter { rows -> rows.any { filter(AppMatcher.key(it.name)) } }
    val exact = pick { it == wanted }
    val hits = if (exact.isNotEmpty()) exact else pick { it.contains(wanted) }
    val only = hits.singleOrNull() ?: return DraftTarget.Picker
    val numbers = only.mapNotNull { it.waNumber }.distinct()
    return numbers.singleOrNull()?.let { DraftTarget.Chat(it) } ?: DraftTarget.Picker
  }
}

internal object VolumeLogic {
  /** 0–100 to the stream's steps (rounded; anything above 0 is at least one step). */
  fun index(level: Int, max: Int): Int {
    val clamped = level.coerceIn(0, 100)
    if (clamped == 0 || max <= 0) return 0
    return Math.round(clamped / 100.0 * max).toInt().coerceIn(1, max)
  }
}
