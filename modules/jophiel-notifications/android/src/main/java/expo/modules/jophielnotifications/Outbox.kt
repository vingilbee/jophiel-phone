package expo.modules.jophielnotifications

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Older than this, a queued batch is dropped: the backend keeps notifications for 24 h at most. */
private const val MAX_AGE_MS = 23L * 3600_000L
/** One chain, so a removal never overtakes the post it removes. */
private const val WORK_NAME = "jophiel-notifications"

/**
 * Where a batch goes. With JS live (app visible or a call on) it's handed to JS, which sends it as
 * a `phone_notifications` frame (or hands it back to `queue` when the socket is down). Otherwise
 * it's written to a file and queued for `POST /api/phone/notifications`; WorkManager waits for a
 * network and retries with backoff, one batch after another.
 */
internal object Outbox {
  /** Set while JS is live; gets the frame as JSON text. */
  @Volatile
  var liveSink: ((String) -> Unit)? = null

  /** The backend takes at most this many per batch; bigger ones go as several. */
  private const val MAX_POSTED = 50
  private const val MAX_REMOVED = 200

  /** `allRemoved`: the sense was switched off, nothing reported before is still known. */
  fun send(context: Context, posted: List<Posted>, removed: List<Removed>, allRemoved: Boolean = false) {
    if (posted.size > MAX_POSTED || removed.size > MAX_REMOVED) {
      removed.chunked(MAX_REMOVED).forEach { send(context, emptyList(), it) }
      posted.chunked(MAX_POSTED).forEach { send(context, it, emptyList()) }
      if (allRemoved) send(context, emptyList(), emptyList(), allRemoved = true)
      return
    }
    if (posted.isEmpty() && removed.isEmpty() && !allRemoved) return
    val app = context.applicationContext
    val body = frame(posted, removed, allRemoved).toString()
    Store.markSentAt(app, System.currentTimeMillis())
    // While a batch still waits in the background chain, later ones join it rather than overtaking
    // it on the socket (a removal or clear arriving before the post it undoes).
    val sink = liveSink
    if (sink != null && !hasQueued(app)) {
      sink(body)
      return
    }
    queue(app, body)
  }

  /**
   * The sense was switched off: one "all removed", so the backend forgets everything this phone
   * told it. Queued posts still go first (the chain keeps order), then the clear undoes them.
   */
  fun clearAll(context: Context) {
    Store.setSentKeys(context.applicationContext, emptySet())
    send(context, emptyList(), emptyList(), allRemoved = true)
  }

  private fun dir(app: Context) = File(app.noBackupFilesDir, "notifications")

  /** A batch file exists from `queue` until its worker is done with it. */
  private fun hasQueued(app: Context): Boolean = dir(app).listFiles()?.isNotEmpty() == true

  /** Queue a POST (no JS, or JS had no socket). Not signed in → nothing is sent. */
  fun queue(context: Context, body: String) {
    val app = context.applicationContext
    if (!Store.hasCredentials(app)) return
    // Input data is capped at 10 KB; a batch can be bigger, so it waits in a file.
    val dir = dir(app).apply { mkdirs() }
    val file = File(dir, "${UUID.randomUUID()}.json")
    try {
      file.writeText(body)
    } catch (e: IOException) {
      Log.w(TAG, "batch not queued", e)
      return
    }
    val data = Data.Builder()
      .putString(PostWorker.FILE, file.absolutePath)
      .putLong(PostWorker.AT, System.currentTimeMillis())
      .build()
    val request = OneTimeWorkRequest.Builder(PostWorker::class.java)
      .setInputData(data)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      }
      .build()
    try {
      WorkManager.getInstance(app).beginUniqueWork(WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request).enqueue()
    } catch (e: Exception) {
      file.delete()
      Log.w(TAG, "batch not queued", e)
    }
  }

  fun cancelAll(context: Context) {
    val app = context.applicationContext
    try {
      WorkManager.getInstance(app).cancelUniqueWork(WORK_NAME)
    } catch (e: Exception) {
      Log.w(TAG, "batches not cancelled", e)
    }
    dir(app).listFiles()?.forEach { it.delete() }
  }

  /** The socket frame; the POST sends the same without `type`. */
  fun frame(posted: List<Posted>, removed: List<Removed>, allRemoved: Boolean): JSONObject =
    JSONObject()
      .put("type", "phone_notifications")
      .put("posted", JSONArray().apply { posted.forEach { put(json(it)) } })
      .put("removed", JSONArray().apply { removed.forEach { put(JSONObject().put("key", it.key).put("reason", it.reason)) } })
      .put("all_removed", allRemoved)

  private fun json(p: Posted): JSONObject =
    JSONObject()
      .put("key", p.key)
      .put("revision", p.revision)
      .put("app", p.app)
      .put("package", p.packageName)
      .put("title", p.title ?: JSONObject.NULL)
      .put("text", p.text ?: JSONObject.NULL)
      .put("conversation", p.conversation ?: JSONObject.NULL)
      .put("conversation_id", p.conversationId)
      .put("conversation_identity", p.conversationIdentity)
      .put("is_group", p.isGroup)
      .put(
        "messages",
        JSONArray().apply {
          p.messages.forEach { m ->
            put(
              JSONObject()
                .put("event_id", m.eventId)
                .put("sender", m.sender)
                .put("sender_id", m.senderId)
                .put("identity", m.identity ?: JSONObject.NULL)
                .put("in_contacts", m.inContacts)
                .put("text", m.text)
                .put("at", m.at),
            )
          }
        },
      )
      .put("can_reply", p.canReply)
      .put("posted_at", p.postedAt)
}

/** One queued batch: `POST /api/phone/notifications` with the bearer token. */
class PostWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  companion object {
    const val FILE = "file"
    const val AT = "at"
    private const val MAX_ATTEMPTS = 12
  }

  override fun doWork(): Result {
    val path = inputData.getString(FILE) ?: return Result.success()
    val file = File(path)
    fun finish(): Result {
      file.delete()
      return Result.success()
    }
    val at = inputData.getLong(AT, System.currentTimeMillis())
    if (System.currentTimeMillis() - at > MAX_AGE_MS) return finish()
    val credentials = Store.credentials(applicationContext) ?: return finish()
    val body = try {
      JSONObject(file.readText())
    } catch (e: Exception) {
      return finish()
    }
    // The endpoint's body is the frame without its `type`.
    body.remove("type")
    // Switched off while this waited: what was posted stays on the phone; removals still go.
    if (!Store.enabled(applicationContext)) body.put("posted", JSONArray())
    val empty = (body.optJSONArray("posted")?.length() ?: 0) == 0 && (body.optJSONArray("removed")?.length() ?: 0) == 0
    if (empty && !body.optBoolean("all_removed", false)) return finish()

    val code = try {
      post(credentials, body.toString())
    } catch (e: IOException) {
      Log.i(TAG, "batch not sent yet: ${e.message}")
      return if (runAttemptCount + 1 >= MAX_ATTEMPTS) finish() else Result.retry()
    } catch (e: Exception) {
      Log.w(TAG, "batch failed", e)
      return finish()
    }
    return when {
      code in 200..299 -> finish()
      code == 401 -> {
        Log.i(TAG, "batch refused (401): background sends stop until the next sign-in")
        Store.clearAccount(applicationContext)
        finish()
      }
      code == 408 || code == 429 || code >= 500 -> if (runAttemptCount + 1 >= MAX_ATTEMPTS) finish() else Result.retry()
      else -> {
        Log.w(TAG, "batch refused ($code)")
        finish()
      }
    }
  }

  private fun post(credentials: Store.Credentials, body: String): Int {
    val connection = URL(credentials.serverUrl.trimEnd('/') + "/api/phone/notifications").openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "POST"
      connection.connectTimeout = 15_000
      connection.readTimeout = 15_000
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Authorization", "Bearer ${credentials.token}")
      connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      val code = connection.responseCode
      runCatching { (if (code < 400) connection.inputStream else connection.errorStream)?.use { it.readBytes() } }
      return code
    } finally {
      connection.disconnect()
    }
  }
}
