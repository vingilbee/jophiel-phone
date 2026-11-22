package expo.modules.jophielnotifications

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.time.ZoneId

/** What a reply / dismiss / media command came to, as the phone_action_result's status / reason. */
internal data class Answer(val status: String, val reason: String? = null)

/**
 * The notifications sense (PLAN_PHASE_8.md). Android binds it once "Notification access" is on,
 * also with the app closed, and rebinds it after Samsung kills it. Everything runs on its own
 * thread: reading a notification (with a contacts lookup), coalescing, the live keys for her
 * replies and dismissals, now playing, and the Maps trip.
 */
class JophielNotificationListener : NotificationListenerService() {
  companion object {
    @Volatile
    internal var instance: JophielNotificationListener? = null

    fun component(context: Context) = ComponentName(context, JophielNotificationListener::class.java)
  }

  private data class Live(val sbn: StatusBarNotification, val entry: LiveEntry)

  private lateinit var thread: HandlerThread
  private lateinit var worker: Handler
  private lateinit var ids: Ids
  private val coalescer = Coalescer<Posted>()
  /** Her opaque key → the notification, while it's on the phone. Worker thread only. */
  private val live = HashMap<String, Live>()
  private val labels = HashMap<String, Pair<String, Boolean>>()
  private var media: Media? = null
  private var navigation: Navigation? = null
  private var navigationKey: String? = null
  private val flush = Runnable { flushDue() }

  override fun onCreate() {
    super.onCreate()
    thread = HandlerThread("jophiel-notifications").apply { start() }
    worker = Handler(thread.looper)
    ids = Ids(Store.secret(this))
  }

  override fun onDestroy() {
    instance = null
    worker.post { media?.stop() }
    thread.quitSafely()
    super.onDestroy()
  }

  override fun onListenerConnected() {
    instance = this
    worker.post {
      // Tracked whatever the sense switch says: her media controls need the sessions. Only
      // reporting now playing follows the switch (Media.changed).
      media = Media(this, component(this), worker).also { it.start() }
      if (Store.enabled(this)) resync()
    }
  }

  override fun onListenerDisconnected() {
    instance = null
    worker.post {
      media?.stop()
      media = null
      live.clear()
      coalescer.clear()
      reportNavigation(null)
    }
    // Ask Android to bind it again (Samsung battery kills it now and then).
    runCatching { requestRebind(component(this)) }
  }

  override fun onNotificationPosted(sbn: StatusBarNotification, rankingMap: RankingMap?) {
    val silent = silent(sbn.key, rankingMap)
    worker.post { posted(sbn, silent, update = true) }
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification, rankingMap: RankingMap?, reason: Int) {
    worker.post { removed(sbn, reason) }
  }

  // ---- From the module (any thread) ----

  internal fun setEnabled(on: Boolean) {
    worker.post {
      if (on) {
        media?.resend()
        resync()
      } else {
        coalescer.clear()
        worker.removeCallbacks(flush)
        live.clear()
        navigation = null
        navigationKey = null
        media?.forget()
        Outbox.clearAll(this)
      }
    }
  }

  internal fun reply(key: String, conversationId: String?, revision: Int?, text: String, done: (Answer) -> Unit) {
    worker.post {
      val entry = live[key]
      val problem = ReplyCheck.check(entry?.entry, conversationId, revision, Store.messagesOn(this))
      if (problem != null) {
        done(Answer(if (problem == "replies_paused") "refused" else "failed", problem))
        return@post
      }
      val action = replyAction(entry!!.sbn.notification)
      if (action == null) {
        done(Answer("failed", "no_reply_button"))
        return@post
      }
      done(send(action, text))
    }
  }

  internal fun dismiss(key: String, done: (Answer) -> Unit) {
    worker.post {
      val entry = live[key]
      if (entry == null) {
        done(Answer("failed", "notification_gone"))
        return@post
      }
      // Ongoing ones (a listening party, a download) can't be swiped away, so they can't be dismissed either.
      if (!entry.sbn.isClearable) {
        done(Answer("failed", "not_clearable"))
        return@post
      }
      try {
        cancelNotification(entry.sbn.key)
        done(Answer("done"))
      } catch (e: Exception) {
        Log.w(TAG, "dismiss failed", e)
        done(Answer("failed", "error"))
      }
    }
  }

  internal fun playFromSearch(packageName: String, query: String, done: (Answer) -> Unit) {
    worker.post {
      val reason = media?.playFromSearch(packageName, query) ?: if (media == null) "no_media_session" else null
      done(if (reason == null) Answer("done") else Answer("failed", reason))
    }
  }

  internal fun mediaControl(command: String, done: (Answer) -> Unit) {
    worker.post {
      val reason = media?.control(command) ?: if (media == null) "no_media_session" else null
      done(if (reason == null) Answer("done") else Answer("failed", reason))
    }
  }

  // ---- Posted / removed ----

  private fun posted(sbn: StatusBarNotification, silent: Boolean, update: Boolean) {
    if (!Store.enabled(this)) return
    if (sbn.packageName == MapsTrip.PACKAGE && isNavigation(sbn.notification)) {
      trip(sbn)
      return
    }
    val (raw, ownerName) = try {
      read(sbn, silent)
    } catch (e: Exception) {
      Log.w(TAG, "notification not read", e)
      return
    }
    if (!NotificationFilter.include(raw, packageName)) return
    val revision = if (update) Store.bumpRevision(this, sbn.key) else Store.revision(this, sbn.key)
    val item = Extract.posted(raw, ids, revision, ZoneId.systemDefault(), ownerName) { Contacts.match(this, it) }
    live[item.key] = Live(sbn, LiveEntry(sbn.packageName, item.conversationId, revision, raw.canReply))
    coalescer.post(item.key, item, System.currentTimeMillis())
    schedule()
  }

  private fun removed(sbn: StatusBarNotification, reason: Int) {
    if (sbn.key == navigationKey) {
      navigationKey = null
      reportNavigation(null)
      return
    }
    Store.forgetRevision(this, sbn.key)
    val key = ids.key(sbn.key)
    live.remove(key)
    coalescer.remove(key)
    schedule()
    val sent = Store.sentKeys(this)
    if (key !in sent) return
    Store.setSentKeys(this, sent - key)
    // Removals go at once.
    Outbox.send(this, emptyList(), listOf(Removed(key, Extract.removalReason(reason))))
  }

  /** On connect and on switching back on: everything on the phone now, and removals missed meanwhile. */
  private fun resync() {
    val active = try {
      activeNotifications.orEmpty()
    } catch (e: Exception) {
      Log.w(TAG, "active notifications not read", e)
      return
    }
    Store.pruneRevisions(this, active.map { it.key }.toSet())
    val ranking = runCatching { currentRanking }.getOrNull()
    active.forEach { posted(it, silent(it.key, ranking), update = false) }
    val onPhone = active.map { ids.key(it.key) }.toSet()
    val sent = Store.sentKeys(this)
    val gone = sent - onPhone
    if (gone.isEmpty()) return
    Store.setSentKeys(this, sent - gone)
    Outbox.send(this, emptyList(), gone.map { Removed(it, "removed") })
  }

  private fun schedule() {
    worker.removeCallbacks(flush)
    val due = coalescer.nextDue() ?: return
    worker.postDelayed(flush, (due - System.currentTimeMillis()).coerceAtLeast(0))
  }

  private fun flushDue() {
    val ready = coalescer.due(System.currentTimeMillis())
    if (ready.isNotEmpty() && Store.enabled(this)) {
      Store.setSentKeys(this, Store.sentKeys(this) + ready.map { it.key })
      Outbox.send(this, ready, emptyList())
    }
    schedule()
  }

  // ---- The Maps trip ----

  private fun isNavigation(n: Notification): Boolean =
    (n.flags and Notification.FLAG_ONGOING_EVENT) != 0 && (n.category == null || n.category == Notification.CATEGORY_NAVIGATION)

  private fun trip(sbn: StatusBarNotification) {
    navigationKey = sbn.key
    val extras = sbn.notification.extras
    val next = MapsTrip.parse(
      extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
      extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
      extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString(),
      extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
    )
    reportNavigation(next)
  }

  private fun reportNavigation(next: Navigation?) {
    if (!MapsTrip.worthSending(navigation, next)) {
      navigation = next
      return
    }
    navigation = next
    if (!Store.enabled(this)) return
    val value = next?.let {
      JSONObject()
        .put("next_step", it.nextStep)
        .put("distance_text", it.distanceText ?: JSONObject.NULL)
        .put("eta_text", it.etaText ?: JSONObject.NULL)
    }
    Fields.report(this, "navigation", value)
  }

  // ---- Reading a notification ----

  private fun silent(key: String, rankingMap: RankingMap?): Boolean {
    val ranking = Ranking()
    if (rankingMap == null || !rankingMap.getRanking(key, ranking)) return false
    return ranking.importance <= NotificationManager.IMPORTANCE_LOW
  }

  /** The app's name and whether it's part of the system image. */
  private fun app(packageName: String): Pair<String, Boolean> = labels.getOrPut(packageName) {
    try {
      val info = packageManager.getApplicationInfo(packageName, 0)
      packageManager.getApplicationLabel(info).toString() to ((info.flags and ApplicationInfo.FLAG_SYSTEM) != 0)
    } catch (e: PackageManager.NameNotFoundException) {
      packageName to false
    }
  }

  private fun read(sbn: StatusBarNotification, silent: Boolean): Pair<RawNotification, String?> {
    val n = sbn.notification
    val extras = n.extras
    val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
    val ownerKey = style?.user?.key
    val messages = style?.messages.orEmpty().mapNotNull { m ->
      val text = m.text?.toString() ?: return@mapNotNull null
      val person = m.person
      val fromOwner = person == null || (ownerKey != null && person.key == ownerKey)
      RawMessage(person?.name?.toString(), person?.uri, text, m.timestamp, fromOwner)
    }
    val text = messages.lastOrNull()?.text
      ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
      ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
    val (appName, systemApp) = app(sbn.packageName)
    val raw = RawNotification(
      sbnKey = sbn.key,
      packageName = sbn.packageName,
      appName = appName,
      tag = sbn.tag,
      ongoing = (n.flags and Notification.FLAG_ONGOING_EVENT) != 0,
      foregroundService = (n.flags and Notification.FLAG_FOREGROUND_SERVICE) != 0,
      groupSummary = (n.flags and Notification.FLAG_GROUP_SUMMARY) != 0,
      category = n.category,
      silent = silent,
      systemApp = systemApp,
      title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
      text = text,
      conversationTitle = style?.conversationTitle?.toString(),
      shortcutId = n.shortcutId,
      isGroup = style?.isGroupConversation ?: false,
      messages = messages,
      canReply = replyAction(n) != null,
      postedAt = sbn.postTime,
    )
    return raw to style?.user?.name?.toString()
  }

  // ---- Replying through the reply button ----

  /** The action with a free-text `RemoteInput`; the one marked "reply" first. */
  private fun replyAction(n: Notification): Notification.Action? {
    val candidates = n.actions.orEmpty().filter { action -> action.remoteInputs.orEmpty().any { it.allowFreeFormInput } }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      candidates.firstOrNull { it.semanticAction == Notification.Action.SEMANTIC_ACTION_REPLY }?.let { return it }
    }
    return candidates.firstOrNull()
  }

  /** Fill the reply button's text field and press it (works while locked; never opens the app). */
  private fun send(action: Notification.Action, text: String): Answer {
    val inputs = action.remoteInputs.orEmpty()
    val results = Bundle()
    inputs.filter { it.allowFreeFormInput }.forEach { results.putCharSequence(it.resultKey, text) }
    val intent = Intent().addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
    RemoteInput.addResultsToIntent(inputs, intent, results)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) RemoteInput.setResultsSource(intent, RemoteInput.SOURCE_FREE_FORM_INPUT)
    return try {
      action.actionIntent.send(this, 0, intent)
      Answer("done")
    } catch (e: PendingIntent.CanceledException) {
      Answer("failed", "notification_gone")
    } catch (e: Exception) {
      Log.w(TAG, "reply failed", e)
      Answer("failed", "error")
    }
  }
}
