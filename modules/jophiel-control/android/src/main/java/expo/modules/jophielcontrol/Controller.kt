package expo.modules.jophielcontrol

import android.app.KeyguardManager
import android.content.Context
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.Display
import java.util.concurrent.Executors

/** What an action came to: `screen` (JSON text, `data.screen`) only with `done`. */
internal class Answer(val status: String, val reason: String?, val screen: String?)

/**
 * One action at a time, in the order they arrive: check it (service on, phone control allowed,
 * her turn not taken over, screen on, unlocked, not inside our own app, her screen id still the
 * latest), show the banner, act, wait for the screen to settle, read the new one. The phone keeps
 * only the latest screen, and drops it when control ends.
 */
internal object Controller {
  private val executor = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private val lock = Any()
  private val gate = TurnGate()

  @Volatile
  private var screen: Screen? = null
  private var counter = 0

  /** The master switch and Phone control (mirrored from JS, which also checks them first). */
  @Volatile
  private var allowed = true

  private val idle = Runnable { endControl(keepScreen = true) }

  /** For the takeover log: the action running (null between actions) and when her last one started. */
  @Volatile
  private var running: String? = null

  @Volatile
  private var lastActionAt = 0L

  fun perform(context: Context, action: String, args: Map<String, Any?>, done: (Answer) -> Unit) {
    executor.execute {
      val answer = try {
        handle(context.applicationContext, action, args)
      } catch (e: Exception) {
        Answer("failed", "error", null)
      }
      running = null
      done(answer)
    }
  }

  private fun refused(reason: String) = Answer("refused", reason, null)

  private fun failed(reason: String) = Answer("failed", reason, null)

  private fun handle(context: Context, action: String, args: Map<String, Any?>): Answer {
    if (action !in ControlLogic.ACTIONS) return failed("unknown_action")
    val request = ControlLogic.parse(action, args) ?: return failed("bad_args")
    if (request.action == "end_control") {
      endControl(keepScreen = false)
      return Answer("done", null, null)
    }
    if (!allowed) return refused("switched_off")
    val service = JophielControlService.instance ?: return refused("no_accessibility")
    if (!synchronized(lock) { gate.admit(request.turn, SystemClock.elapsedRealtime()) }) return refused("taken_over")
    if (context.getSystemService(PowerManager::class.java)?.isInteractive == false) return refused("screen_off")
    // Unlocked only: with nobody looking at the screen, the banner's Stop can't stop her.
    if (context.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked == true) return refused("locked")
    if (!ControlLogic.allowedInFront(request, ScreenReader.frontPackage(service), context.packageName)) return refused("own_app")
    val current = screen
    if (ControlLogic.needsScreen(request.action) && (current == null || current.id != request.screen)) return failed("stale_screen")

    service.banner.show()
    restartIdle()
    running = request.action
    var actionAt = SystemClock.uptimeMillis()
    lastActionAt = actionAt
    if (request.action == "read_screen") {
      if (request.waitMs > 0) SystemClock.sleep(request.waitMs)
      // Nothing was done: only wait if the screen is still changing.
      actionAt = SystemClock.uptimeMillis() - ControlLogic.QUIET_MS
    } else {
      Actor.run(service, request, current)?.let { return failed(it) }
    }
    settle(service, actionAt)
    // Your touch came while she acted: what she did did happen (`taken_over_after`), but she stops here.
    val acted = request.action != "read_screen"
    if (over(request.turn)) return refused(if (acted) "taken_over_after" else "taken_over")
    val json = read(service)
    if (over(request.turn)) {
      screen = null
      return refused(if (acted) "taken_over_after" else "taken_over")
    }
    restartIdle()
    return Answer("done", null, json)
  }

  private fun over(turn: String?): Boolean = synchronized(lock) { gate.over(turn, SystemClock.elapsedRealtime()) }

  private fun settle(service: JophielControlService, actionAt: Long) {
    while (!ControlLogic.settled(SystemClock.uptimeMillis(), actionAt, service.lastEventAt)) SystemClock.sleep(50)
  }

  /** Read the screen as it is now: the new latest screen (older ids become stale). */
  private fun read(service: JophielControlService): String {
    val reading = ScreenReader.read(service)
    val built = ControlLogic.build(reading.nodes)
    val size = displaySize(service)
    val scale = ControlLogic.scaleFor(size.x, size.y)
    val shot = Screenshot.take(service, built.items, scale, reading.appBounds)
    val width = if (shot.jpegBase64 != null) shot.width else (size.x * scale).toInt()
    val height = if (shot.jpegBase64 != null) shot.height else (size.y * scale).toInt()
    val id = synchronized(lock) { "s${++counter}" }
    screen = Screen(id, built, reading.nodes, reading.handles, scale, width, height)
    return ControlLogic.screenJson(id, reading.app, reading.packageName, reading.keyboard, shot.jpegBase64, width, height, shot.missing, built, scale)
  }

  @Suppress("DEPRECATION")
  private fun displaySize(context: Context): Point {
    val point = Point()
    context.getSystemService(DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY)?.getRealSize(point)
    if (point.x <= 0) {
      val metrics = context.resources.displayMetrics
      point.set(metrics.widthPixels, metrics.heightPixels)
    }
    return point
  }

  private fun restartIdle() {
    main.removeCallbacks(idle)
    main.postDelayed(idle, ControlLogic.IDLE_MS)
  }

  /** The banner goes and her control ends; the next action shows it again. */
  private fun endControl(keepScreen: Boolean) {
    main.removeCallbacks(idle)
    JophielControlService.instance?.banner?.remove()
    if (!keepScreen) screen = null
  }

  /** Stop on the banner: the turn she was acting in is over. `by`: "stop". */
  fun takenOver(by: String) {
    // Diagnostic only (`adb logcat -s JophielControl`): what ended her turn, and when, against her own actions.
    Log.i("JophielControl", "takeover by $by, ${SystemClock.uptimeMillis() - lastActionAt} ms after her last action started" +
      (running?.let { " (during $it)" } ?: " (between actions)"))
    synchronized(lock) { gate.takeOver(SystemClock.elapsedRealtime()) }
    endControl(keepScreen = false)
  }

  /** The master switch or Phone control went off (or on again). */
  fun setAllowed(on: Boolean) {
    allowed = on
    if (!on) endControl(keepScreen = false)
  }

  fun serviceGone() {
    main.removeCallbacks(idle)
    screen = null
  }
}
