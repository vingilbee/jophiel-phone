package expo.modules.jophielsenses

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.concurrent.TimeUnit

/** The server takes an `observed_at` older than 24 h as "now"; a report that late would lie, so it's dropped. */
private const val MAX_AGE_MS = 23L * 3600_000L

private const val WORK_TAG = "jophiel-senses-report"

/**
 * Where a new value goes. With JS live (app visible or a call on) it's handed to JS, which sends
 * it in the next `sense` frame. Otherwise it's queued for `PUT /api/phone/state` with the time it
 * was seen; WorkManager waits for a network and retries with backoff.
 */
internal object Reporter {
  /** Set while JS is live (`startLive`); gets the fields and when they were seen. */
  @Volatile
  var liveSink: ((Map<String, Any?>, Long) -> Unit)? = null

  fun deliver(context: Context, fields: Map<String, Any?>, at: Long) {
    val app = context.applicationContext
    val enabled = Store.enabledFields(app)
    val wanted = fields.filterKeys { it in enabled }
    if (wanted.isEmpty()) return
    val sink = liveSink
    if (sink != null) {
      // JS keeps its own "what was sent" and diffs against it.
      sink(wanted, at)
      return
    }
    sendInBackground(app, wanted, at, dedupe = true)
  }

  /**
   * Queue a PUT. `dedupe`: drop the fields whose value was already handed on (only what changed
   * goes out). Not signed in → nothing is sent.
   */
  fun sendInBackground(context: Context, fields: Map<String, Any?>, at: Long, dedupe: Boolean) {
    val app = context.applicationContext
    if (!Store.hasCredentials(app)) return
    val changed = if (dedupe) Store.unhanded(app, fields) else fields
    if (changed.isEmpty()) return
    Store.markHanded(app, changed)
    val body = JSONObject()
    changed.forEach { (name, value) -> body.put(name, Store.normalize(value) ?: JSONObject.NULL) }
    val data = Data.Builder().putString(ReportWorker.FIELDS, body.toString()).putLong(ReportWorker.AT, at).build()
    val request = OneTimeWorkRequest.Builder(ReportWorker::class.java)
      .setInputData(data)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .addTag(WORK_TAG)
      .apply {
        // Android 12+: run now as an expedited job when there's quota. Before 12, expedited work
        // needs a foreground notification, which we don't show.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      }
      .build()
    try {
      WorkManager.getInstance(app).enqueue(request)
    } catch (e: Exception) {
      Log.w(TAG, "report not queued", e)
    }
  }

  fun cancelAll(context: Context) {
    try {
      WorkManager.getInstance(context.applicationContext).cancelAllWorkByTag(WORK_TAG)
    } catch (e: Exception) {
      Log.w(TAG, "reports not cancelled", e)
    }
  }
}

/** One background report: `PUT /api/phone/state` with the bearer token. */
class ReportWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  companion object {
    const val FIELDS = "fields"
    const val AT = "at"
    private const val MAX_ATTEMPTS = 12
  }

  override fun doWork(): Result {
    val raw = inputData.getString(FIELDS) ?: return Result.success()
    val at = inputData.getLong(AT, System.currentTimeMillis())
    if (System.currentTimeMillis() - at > MAX_AGE_MS) return Result.success()
    val credentials = Store.credentials(applicationContext) ?: return Result.success()
    val fields = try {
      JSONObject(raw)
    } catch (e: Exception) {
      return Result.success()
    }
    val body = JSONObject(fields.toString()).put("observed_at", Instant.ofEpochMilli(at).toString())

    val code = try {
      put(credentials, body.toString())
    } catch (e: IOException) {
      Log.i(TAG, "report not sent yet: ${e.message}")
      return if (runAttemptCount + 1 >= MAX_ATTEMPTS) Result.success() else Result.retry()
    } catch (e: Exception) {
      Log.w(TAG, "report failed", e)
      return Result.success()
    }

    return when {
      code in 200..299 -> {
        val sent = fields.keys().asSequence().associateWith { Store.normalize(fields.opt(it)) }
        Store.markReported(applicationContext, sent, at)
        Result.success()
      }
      code == 401 -> {
        // The session is gone: stop reporting until the next sign-in stores a new token.
        Log.i(TAG, "report refused (401): background reports stop until the next sign-in")
        Senses.stopReporting(applicationContext, cancelWork = false)
        Result.success()
      }
      code == 408 || code == 429 || code >= 500 ->
        if (runAttemptCount + 1 >= MAX_ATTEMPTS) Result.success() else Result.retry()
      // Anything else (403, 422) won't get better by sending it again.
      else -> {
        Log.w(TAG, "report refused ($code)")
        Result.success()
      }
    }
  }

  private fun put(credentials: Store.Credentials, body: String): Int {
    val connection = URL(credentials.serverUrl.trimEnd('/') + "/api/phone/state").openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "PUT"
      connection.connectTimeout = 15_000
      connection.readTimeout = 15_000
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Authorization", "Bearer ${credentials.token}")
      connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      val code = connection.responseCode
      // Drain the reply so the connection can be reused.
      runCatching { (if (code < 400) connection.inputStream else connection.errorStream)?.use { it.readBytes() } }
      return code
    } finally {
      connection.disconnect()
    }
  }
}
