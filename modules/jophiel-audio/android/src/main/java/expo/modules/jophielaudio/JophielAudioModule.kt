package expo.modules.jophielaudio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

private const val TAG = "JophielAudio"

/** Whisper's rate; the web app captures at the same rate. */
private const val CAPTURE_RATE = 16_000

/** 20 ms frames: 50 events a second over the bridge. */
private const val FRAME_SAMPLES = 320

/** Output level is measured over blocks of this long, keyed by their frame position. */
private const val LEVEL_BLOCK_MS = 20

/**
 * Seen on the S21 with AirPods: after her reply ends, the Bluetooth mic can stay at exact digital
 * zeros for good. AirPods also send exact zeros whenever you're quiet, so zeros alone prove
 * nothing; only right after she stops playing does this many all-zero frames in a row (1 s) get
 * the mic restarted, once per reply.
 */
private const val DEAD_MIC_FRAMES = 50

/** At most one dead-mic restart this often, so a mic that's really gone can't loop. */
private const val DEAD_MIC_RETRY_MS = 3_000L

/** Queue empty, audio still unplayed and the head not moving for this long: pad with silence. */
private const val STALL_PAD_AFTER_MS = 150L

/**
 * Voice audio for Jophiel: microphone capture and reply playback in one Android voice-communication
 * session. Capture and playback have to live together: only then does Android's echo canceller have
 * her voice as its reference and remove it from the mic, which is what keeps barge-in from firing
 * on her own voice.
 *
 * Always a voice call, headphones included (owner's choice, 2026-11-21): only call mode lets a
 * Bluetooth earbud's mic work (SCO), at the price of Android's narrower call audio.
 *
 * JS owns all the logic (VAD, barge-in, segments, jitter cushion); this module only moves audio and
 * reports clocks and levels. Positions are in frames of the current playback track, counted from
 * when it was created; `stopPlayback` releases the track, so the next reply starts again from 0.
 */
class JophielAudioModule : Module() {
  private val lock = ReentrantLock()
  private val wake = lock.newCondition()
  private val mainHandler = Handler(Looper.getMainLooper())

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  // ---- Session: communication mode, audio focus, routing ----

  private var sessionActive = false
  private var focusRequest: AudioFocusRequest? = null
  private var previousMode = AudioManager.MODE_NORMAL
  private var route = "none"
  private var scoStarted = false

  /** Phase 5: set when a call or another app took the audio, so its return can be reported. */
  private var focusLost = false

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    // A call or another app took the audio. Ducking (a notification sound) is not a reason to stop.
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      focusLost = true
      emit("onInterrupted", Bundle().apply { putString("reason", "focus_lost") })
    } else if (change == AudioManager.AUDIOFOCUS_GAIN && focusLost) {
      focusLost = false
      regainSession()
    }
  }

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = applyRoute()
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = applyRoute()
  }

  // ---- Capture ----

  private var recorder: AudioRecord? = null
  private val effects = mutableListOf<AudioEffect>()
  private var readerThread: Thread? = null

  @Volatile private var captureGeneration = 0

  @Volatile private var muted = false

  private var lastMicRestart = 0L

  // ---- Playback ----

  private var track: AudioTrack? = null
  private var trackRate = 0
  private var paused = false
  private var writerThread: Thread? = null

  @Volatile private var playbackGeneration = 0

  /** Blocks waiting to be written, in order. Lead-in silence is a block of zeros. */
  private val queue = ArrayDeque<ShortArray>()

  /** Frame position right after the last queued block. */
  private var acceptedEnd = 0L

  /** Frames handed to the track so far. */
  private var writtenEnd = 0L
  private var drainedSent = true

  private class LevelBlock(val start: Long, val end: Long, val rms: Double)

  private val levels = ArrayDeque<LevelBlock>()

  // ---- Phase 5: the call's clock, and the call service ----

  /**
   * JS timers stop with the app in the background (RN drives them from the display's vsync). The
   * voice loop's timers run here instead, on their own thread; the call's wake lock keeps the CPU up.
   */
  private var clockThread: HandlerThread? = null
  private var clockHandler: Handler? = null
  private val timers = HashMap<Int, Runnable>()

  private val callListener = object : VoiceCallService.Listener {
    override fun onCallAction(action: String) {
      emit("onCallAction", Bundle().apply { putString("action", action) })
    }

    override fun onCallEnded(reason: String) {
      emit("onCallEnded", Bundle().apply { putString("reason", reason) })
    }
  }

  override fun definition() = ModuleDefinition {
    Name("JophielAudio")

    Events(
      "onFrame",
      "onPlaybackDrained",
      "onInterrupted",
      "onRouteChanged",
      "onFocusRegained",
      "onTimer",
      "onCallAction",
      "onCallEnded",
    )

    OnCreate {
      VoiceCallService.listener = callListener
    }

    /** Fires `onTimer(id)` once after `ms`, on a native thread that keeps going in the background. */
    Function("setTimer") { id: Int, ms: Double ->
      setTimerInternal(id, ms.toLong())
    }

    Function("clearTimer") { id: Int ->
      synchronized(timers) {
        timers.remove(id)?.let { clockHandler?.removeCallbacks(it) }
      }
    }

    /** Start the call service. Only while the app is visible: Android 14 refuses it later. */
    Function("startCallService") {
      try {
        VoiceCallService.start(context)
        return@Function true
      } catch (e: Exception) {
        Log.w(TAG, "call service not started", e)
        return@Function false
      }
    }

    Function("stopCallService") {
      VoiceCallService.stop(context)
    }

    Function("isCallServiceRunning") {
      return@Function VoiceCallService.isRunning
    }

    /** The call notification: state in words, the one context action (interrupt / talk / none), mute. */
    Function("updateCallNotification") { text: String, primary: String?, isMuted: Boolean ->
      VoiceCallService.update(context, VoiceCallService.Display(text, primary, isMuted))
    }

    /** A note after the call ended by itself in the background. */
    Function("showCallEndedNotification") { text: String ->
      VoiceCallService.showEnded(context, text)
    }

    /** Opens the mic (and the voice session). Resolves with the capture sample rate. */
    AsyncFunction("startCapture") {
      return@AsyncFunction startCaptureInternal()
    }

    Function("stopCapture") {
      stopCaptureInternal()
      lock.withLock { endSessionIfIdle() }
    }

    /** Stop delivering frames without tearing the mic down. */
    Function("setMuted") { value: Boolean ->
      muted = value
    }

    Function("isCapturing") {
      return@Function lock.withLock {
        recorder?.recordingState == AudioRecord.RECORDSTATE_RECORDING
      }
    }

    /**
     * Queue 16-bit mono PCM (little endian) at `sampleRate`, after `leadFrames` of silence.
     * Returns the frame position where the audio itself starts, or -1 if nothing was queued.
     */
    Function("enqueue") { pcm: ByteArray, sampleRate: Int, leadFrames: Int ->
      return@Function enqueueInternal(pcm, sampleRate, leadFrames)
    }

    /** Freeze playback where it is, keeping everything queued (the hold). */
    Function("pause") {
      lock.withLock {
        paused = true
        try {
          track?.pause()
        } catch (e: IllegalStateException) {
          Log.w(TAG, "pause failed", e)
        }
      }
    }

    Function("resume") {
      lock.withLock {
        if (!paused) return@withLock
        paused = false
        try {
          track?.play()
        } catch (e: IllegalStateException) {
          Log.w(TAG, "resume failed", e)
        }
        wake.signalAll()
      }
    }

    /** Immediate and total: everything queued and playing is dropped (barge-in). */
    Function("stopPlayback") {
      lock.withLock {
        releaseTrackLocked()
        endSessionIfIdle()
      }
    }

    /** The playback clock: frames of the current track that have actually played. */
    Function("playedFrames") {
      return@Function lock.withLock { headLocked().toDouble() }
    }

    /** RMS (0–1) of the audio playing right now; 0 when paused or silent. */
    Function("level") {
      return@Function lock.withLock { levelLocked() }
    }

    Function("route") {
      return@Function lock.withLock { route }
    }

    /** Stop capture and playback and give the audio mode and focus back. */
    Function("endSession") {
      stopCaptureInternal()
      lock.withLock {
        releaseTrackLocked()
        endSessionIfIdle()
      }
    }

    OnDestroy {
      // The call lives in JS; with JS gone (reload, process ending) nothing is left to own it.
      if (VoiceCallService.listener === callListener) VoiceCallService.listener = null
      try {
        appContext.reactContext?.let { VoiceCallService.stop(it) }
      } catch (e: Exception) {
        Log.w(TAG, "call service stop failed", e)
      }
      synchronized(timers) {
        timers.clear()
        clockThread?.quitSafely()
        clockThread = null
        clockHandler = null
      }
      stopCaptureInternal()
      lock.withLock {
        releaseTrackLocked()
        endSessionIfIdle()
      }
    }
  }

  private fun emit(name: String, body: Bundle) {
    try {
      sendEvent(name, body)
    } catch (e: Throwable) {
      // The JS side may be gone (reload); nothing to tell.
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Clock (phase 5)

  private fun setTimerInternal(id: Int, ms: Long) {
    synchronized(timers) {
      val handler = clockHandler ?: run {
        val thread = HandlerThread("jophiel-clock").also { it.start() }
        clockThread = thread
        Handler(thread.looper).also { clockHandler = it }
      }
      timers.remove(id)?.let { handler.removeCallbacks(it) }
      val runnable = object : Runnable {
        override fun run() {
          synchronized(timers) {
            if (timers[id] !== this) return
            timers.remove(id)
          }
          emit("onTimer", Bundle().apply { putInt("id", id) })
        }
      }
      timers[id] = runnable
      handler.postDelayed(runnable, max(0L, ms))
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Session

  /** Called with the lock held. Throws when another app (a call) holds the audio. */
  private fun beginSessionLocked() {
    if (sessionActive) return
    val manager = audioManager
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(attributes)
      .setAcceptsDelayedFocusGain(false)
      .setOnAudioFocusChangeListener(focusListener, mainHandler)
      .build()
    if (manager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      throw CodedException("ERR_AUDIO_BUSY", "Another app is using the audio (a call?).", null)
    }
    focusRequest = request
    previousMode = manager.mode
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    sessionActive = true
    manager.registerAudioDeviceCallback(deviceCallback, mainHandler)
    applyRouteLocked()
  }

  /** Called with the lock held: once neither capture nor playback is running, give everything back. */
  private fun endSessionIfIdle() {
    if (!sessionActive || recorder != null || track != null) return
    val manager = audioManager
    sessionActive = false
    try {
      manager.unregisterAudioDeviceCallback(deviceCallback)
    } catch (e: Exception) {
      Log.w(TAG, "unregister device callback failed", e)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.clearCommunicationDevice()
    } else {
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = false
      if (scoStarted) {
        @Suppress("DEPRECATION")
        manager.stopBluetoothSco()
        @Suppress("DEPRECATION")
        manager.isBluetoothScoOn = false
      }
    }
    scoStarted = false
    manager.mode = if (previousMode == AudioManager.MODE_IN_COMMUNICATION) AudioManager.MODE_NORMAL else previousMode
    focusRequest?.let { manager.abandonAudioFocusRequest(it) }
    focusRequest = null
    focusLost = false
    setRouteLocked("none")
  }

  /**
   * Phase 5: the audio came back after a phone call (or another app). The call may have left the
   * audio mode and routing changed, and the mic silenced: take call mode back, route again, reopen
   * the mic, then tell JS so it listens again.
   */
  private fun regainSession() {
    val hadMic: Boolean
    lock.withLock {
      if (!sessionActive) return
      audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
      applyRouteLocked()
      hadMic = recorder != null
    }
    if (hadMic) {
      val wasMuted = muted
      stopCaptureInternal()
      try {
        startCaptureInternal()
        muted = wasMuted
      } catch (e: Exception) {
        Log.w(TAG, "mic restart after focus failed", e)
        lock.withLock { endSessionIfIdle() }
        emit("onInterrupted", Bundle().apply { putString("reason", "mic_lost") })
        return
      }
    }
    emit("onFocusRegained", Bundle())
  }

  private fun applyRoute() {
    lock.withLock { applyRouteLocked() }
  }

  /**
   * Loudspeaker by default; wired or Bluetooth headphones take over while connected. In
   * communication mode Android would otherwise use the earpiece.
   */
  private fun applyRouteLocked() {
    if (!sessionActive) return
    val manager = audioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val devices = manager.availableCommunicationDevices
      val preference = listOf(
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
      )
      val chosen = preference.firstNotNullOfOrNull { type -> devices.firstOrNull { it.type == type } }
      if (chosen != null) {
        if (manager.communicationDevice?.id != chosen.id && !manager.setCommunicationDevice(chosen)) {
          Log.w(TAG, "setCommunicationDevice(${chosen.type}) refused")
        }
        setRouteLocked(routeName(chosen.type))
      } else {
        setRouteLocked(routeName(manager.communicationDevice?.type ?: AudioDeviceInfo.TYPE_BUILTIN_EARPIECE))
      }
    } else {
      val outputs = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      val wired = outputs.any {
        it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
          it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
          it.type == AudioDeviceInfo.TYPE_USB_HEADSET
      }
      val bluetooth = outputs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
      @Suppress("DEPRECATION")
      when {
        wired -> {
          manager.isSpeakerphoneOn = false
          setRouteLocked("headphones")
        }
        bluetooth -> {
          manager.isSpeakerphoneOn = false
          if (!scoStarted) {
            manager.startBluetoothSco()
            manager.isBluetoothScoOn = true
            scoStarted = true
          }
          setRouteLocked("bluetooth")
        }
        else -> {
          if (scoStarted) {
            manager.stopBluetoothSco()
            manager.isBluetoothScoOn = false
            scoStarted = false
          }
          manager.isSpeakerphoneOn = true
          setRouteLocked("speaker")
        }
      }
    }
  }

  private fun routeName(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
    else -> "headphones"
  }

  private fun setRouteLocked(next: String) {
    if (route == next) return
    route = next
    emit("onRouteChanged", Bundle().apply { putString("route", next) })
  }

  // ---------------------------------------------------------------------------------------------
  // Capture

  @SuppressLint("MissingPermission")
  private fun startCaptureInternal(): Int {
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      throw CodedException("ERR_MIC_PERMISSION", "Microphone permission denied.", null)
    }
    lock.withLock {
      if (recorder != null) return CAPTURE_RATE
      beginSessionLocked()
      val minBuffer = AudioRecord.getMinBufferSize(CAPTURE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      val bufferBytes = max(minBuffer, FRAME_SAMPLES * 2 * 8)
      val record = try {
        AudioRecord(
          MediaRecorder.AudioSource.VOICE_COMMUNICATION,
          CAPTURE_RATE,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          bufferBytes,
        )
      } catch (e: Exception) {
        endSessionIfIdle()
        throw CodedException("ERR_MIC_START", "Could not start the microphone.", e)
      }
      if (record.state != AudioRecord.STATE_INITIALIZED) {
        record.release()
        endSessionIfIdle()
        throw CodedException("ERR_MIC_START", "Could not start the microphone.", null)
      }
      attachEffects(record.audioSessionId)
      try {
        record.startRecording()
      } catch (e: IllegalStateException) {
        releaseEffects()
        record.release()
        endSessionIfIdle()
        throw CodedException("ERR_MIC_START", "Could not start the microphone.", e)
      }
      if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        // Another app holds the mic.
        releaseEffects()
        record.release()
        endSessionIfIdle()
        throw CodedException("ERR_MIC_START", "Could not start the microphone.", null)
      }
      recorder = record
      muted = false
      val generation = ++captureGeneration
      readerThread = Thread({ readLoop(record, generation) }, "jophiel-audio-capture").also { it.start() }
    }
    return CAPTURE_RATE
  }

  /** The counterpart of the browser's echoCancellation / noiseSuppression / autoGainControl. */
  private fun attachEffects(sessionId: Int) {
    try {
      if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(sessionId)?.let { it.enabled = true; effects.add(it) }
      if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(sessionId)?.let { it.enabled = true; effects.add(it) }
      if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(sessionId)?.let { it.enabled = true; effects.add(it) }
    } catch (e: Exception) {
      Log.w(TAG, "audio effects unavailable", e)
    }
  }

  private fun releaseEffects() {
    effects.forEach {
      try {
        it.release()
      } catch (e: Exception) {
        Log.w(TAG, "effect release failed", e)
      }
    }
    effects.clear()
  }

  private fun readLoop(record: AudioRecord, generation: Int) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    val frame = ShortArray(FRAME_SAMPLES)
    val bytes = ByteArray(FRAME_SAMPLES * 2)
    var zeroFrames = 0
    var zeroWhilePlaying = 0
    var playing = false
    // Armed when her playback ends; disarmed by real sound or by the one restart.
    var armed = false
    while (captureGeneration == generation) {
      var filled = 0
      while (filled < FRAME_SAMPLES) {
        val read = try {
          record.read(frame, filled, FRAME_SAMPLES - filled)
        } catch (e: Exception) {
          AudioRecord.ERROR_INVALID_OPERATION
        }
        if (captureGeneration != generation) return
        if (read < 0) {
          emit("onInterrupted", Bundle().apply { putString("reason", "mic_lost") })
          return
        }
        if (read == 0) SystemClock.sleep(2)
        filled += read
      }
      // Dead-mic watchdog (see DEAD_MIC_FRAMES). Counted even when muted: the mic is still open.
      var allZero = true
      for (i in 0 until FRAME_SAMPLES) {
        if (frame[i].toInt() != 0) {
          allZero = false
          break
        }
      }
      val nowPlaying = herVoicePlaying()
      if (playing && !nowPlaying) {
        armed = true
        zeroFrames = 0
      }
      playing = nowPlaying
      if (!allZero) {
        if (zeroWhilePlaying > 0) Log.i(TAG, "mic: ${zeroWhilePlaying * 20} ms of exact silence while she played (route=$route)")
        zeroFrames = 0
        zeroWhilePlaying = 0
        armed = false
      } else if (nowPlaying) {
        // Her voice is playing: some Bluetooth headsets mute their mic meanwhile.
        zeroWhilePlaying++
      } else if (armed && ++zeroFrames >= DEAD_MIC_FRAMES) {
        armed = false
        zeroFrames = 0
        mainHandler.post { restartDeadMic(generation) }
      }
      if (muted) continue
      // Same RMS as the web worklet: samples scaled to -1…1.
      var sumSquares = 0.0
      for (i in 0 until FRAME_SAMPLES) {
        val sample = frame[i].toInt()
        val scaled = sample / 32768.0
        sumSquares += scaled * scaled
        bytes[2 * i] = (sample and 0xff).toByte()
        bytes[2 * i + 1] = ((sample shr 8) and 0xff).toByte()
      }
      val rms = sqrt(sumSquares / FRAME_SAMPLES)
      emit(
        "onFrame",
        Bundle().apply {
          putString("pcm", Base64.encodeToString(bytes, Base64.NO_WRAP))
          putDouble("rms", rms)
        },
      )
    }
  }

  /**
   * From the capture thread, which must never wait on the lock (stopCapture holds it while joining
   * that thread): if the lock is busy, count it as playing, which only delays the watchdog.
   */
  private fun herVoicePlaying(): Boolean {
    if (!lock.tryLock()) return true
    try {
      return track != null && !playbackIdleLocked()
    } finally {
      lock.unlock()
    }
  }

  /** Called with the lock held. Nothing queued and everything written has played. */
  private fun playbackIdleLocked(): Boolean = !paused && queue.isEmpty() && headLocked() >= writtenEnd

  /** The mic went dead (exact zeros): close it and open it again, same session. */
  private fun restartDeadMic(generation: Int) {
    if (captureGeneration != generation) return
    val now = SystemClock.uptimeMillis()
    if (now - lastMicRestart < DEAD_MIC_RETRY_MS) return
    lastMicRestart = now
    Log.w(TAG, "mic: exact silence for ${DEAD_MIC_FRAMES * 20} ms (route=$route), restarting it")
    val wasMuted = muted
    stopCaptureInternal()
    try {
      startCaptureInternal()
      muted = wasMuted
    } catch (e: Exception) {
      Log.w(TAG, "mic restart failed", e)
      lock.withLock { endSessionIfIdle() }
      emit("onInterrupted", Bundle().apply { putString("reason", "mic_lost") })
    }
  }

  private fun stopCaptureInternal() {
    lock.withLock {
      val record = recorder ?: return
      captureGeneration++
      recorder = null
      try {
        record.stop()
      } catch (e: IllegalStateException) {
        Log.w(TAG, "recorder stop failed", e)
      }
      val reader = readerThread
      readerThread = null
      releaseEffects()
      // The reader may still be inside read(); stop() makes it return. Release once it's out.
      // (It never takes the lock, so waiting here can't deadlock.)
      reader?.join(200)
      record.release()
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Playback

  private fun enqueueInternal(pcm: ByteArray, sampleRate: Int, leadFrames: Int): Double {
    if (pcm.size < 2 || sampleRate <= 0) return -1.0
    lock.withLock {
      if (track == null || trackRate != sampleRate) {
        if (track != null) releaseTrackLocked()
        if (!createTrackLocked(sampleRate)) return -1.0
      }
      val samples = ShortArray(pcm.size / 2)
      for (i in samples.indices) {
        samples[i] = ((pcm[2 * i].toInt() and 0xff) or (pcm[2 * i + 1].toInt() shl 8)).toShort()
      }
      val lead = max(0, leadFrames)
      if (lead > 0) queue.addLast(ShortArray(lead))
      val start = acceptedEnd + lead
      queue.addLast(samples)
      acceptedEnd = start + samples.size
      recordLevels(samples, start, sampleRate)
      drainedSent = false
      wake.signalAll()
      return start.toDouble()
    }
  }

  private fun recordLevels(samples: ShortArray, start: Long, sampleRate: Int) {
    val block = max(1, sampleRate * LEVEL_BLOCK_MS / 1000)
    var offset = 0
    while (offset < samples.size) {
      val end = min(samples.size, offset + block)
      var sumSquares = 0.0
      for (i in offset until end) {
        val scaled = samples[i] / 32768.0
        sumSquares += scaled * scaled
      }
      levels.addLast(LevelBlock(start + offset, start + end, sqrt(sumSquares / (end - offset))))
      offset = end
    }
  }

  /** Called with the lock held. */
  private fun createTrackLocked(sampleRate: Int): Boolean {
    try {
      beginSessionLocked()
    } catch (e: CodedException) {
      Log.w(TAG, "no audio focus for playback", e)
      return false
    }
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val format = AudioFormat.Builder()
      .setSampleRate(sampleRate)
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
      .build()
    val minBuffer = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    // At least 100 ms of room, so the writer thread can be late now and then without a gap.
    val bufferBytes = max(minBuffer * 2, sampleRate / 10 * 2)
    val builder = AudioTrack.Builder()
      .setAudioAttributes(attributes)
      .setAudioFormat(format)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(bufferBytes)
    // Same session as the recorder: the echo canceller gets her voice as its reference.
    recorder?.audioSessionId?.let { builder.setSessionId(it) }
    val created = try {
      builder.build()
    } catch (e: Exception) {
      Log.w(TAG, "AudioTrack build failed", e)
      null
    }
    if (created == null || created.state != AudioTrack.STATE_INITIALIZED) {
      created?.release()
      endSessionIfIdle()
      return false
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // Start as soon as 20 ms is buffered, not when the whole buffer is full.
      try {
        created.setStartThresholdInFrames(min(sampleRate / 50, created.bufferSizeInFrames))
      } catch (e: Exception) {
        Log.w(TAG, "start threshold not set", e)
      }
    }
    track = created
    trackRate = sampleRate
    acceptedEnd = 0
    writtenEnd = 0
    levels.clear()
    queue.clear()
    drainedSent = true
    if (!paused) {
      try {
        created.play()
      } catch (e: IllegalStateException) {
        Log.w(TAG, "play failed", e)
      }
    }
    val generation = ++playbackGeneration
    writerThread = Thread({ writeLoop(created, generation) }, "jophiel-audio-playback").also { it.start() }
    return true
  }

  /** Called with the lock held. */
  private fun releaseTrackLocked() {
    playbackGeneration++
    queue.clear()
    levels.clear()
    acceptedEnd = 0
    writtenEnd = 0
    drainedSent = true
    paused = false
    val current = track ?: return
    track = null
    trackRate = 0
    try {
      current.pause()
      current.flush()
    } catch (e: IllegalStateException) {
      Log.w(TAG, "track stop failed", e)
    }
    current.release()
    writerThread = null
    wake.signalAll()
  }

  /** Called with the lock held. */
  private fun headLocked(): Long {
    val current = track ?: return 0
    return try {
      current.playbackHeadPosition.toLong() and 0xffffffffL
    } catch (e: IllegalStateException) {
      0
    }
  }

  /** Called with the lock held. */
  private fun levelLocked(): Double {
    if (track == null || paused) return 0.0
    val head = headLocked()
    while (levels.isNotEmpty() && levels.first().end <= head) levels.removeFirst()
    val block = levels.firstOrNull() ?: return 0.0
    return if (block.start <= head) block.rms else 0.0
  }

  private fun writeLoop(target: AudioTrack, generation: Int) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
    var current: ShortArray? = null
    var offset = 0
    var lastHead = -1L
    var stalledSince = 0L
    lock.withLock {
      while (playbackGeneration == generation) {
        if (current == null) {
          current = queue.pollFirst()
          offset = 0
        }
        val block = current
        if (block == null) {
          val head = headLocked()
          if (!paused) {
            if (head >= writtenEnd) {
              if (!drainedSent) {
                drainedSent = true
                emit("onPlaybackDrained", Bundle())
              }
            } else if (head != lastHead) {
              lastHead = head
              stalledSince = SystemClock.uptimeMillis()
            } else if (SystemClock.uptimeMillis() - stalledSince > STALL_PAD_AFTER_MS) {
              // The tail is shorter than what the track waits for before it plays: push it out.
              val pad = max(1, trackRate / 50)
              queue.addLast(ShortArray(pad))
              acceptedEnd += pad
              stalledSince = SystemClock.uptimeMillis()
              continue
            }
          }
          wake.await(10, TimeUnit.MILLISECONDS)
          continue
        }
        val written = try {
          target.write(block, offset, block.size - offset, AudioTrack.WRITE_NON_BLOCKING)
        } catch (e: Exception) {
          Log.w(TAG, "track write failed", e)
          return
        }
        if (written < 0) {
          Log.w(TAG, "track write error $written")
          return
        }
        offset += written
        writtenEnd += written
        if (offset >= block.size) {
          current = null
        } else {
          // The track's buffer is full (or paused): wait for room.
          wake.await(5, TimeUnit.MILLISECONDS)
        }
      }
    }
  }
}
