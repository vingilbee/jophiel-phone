# Phase 4 — Voice with the app open

Goal: the web app's voice mode, on Android, with **every behavior it has today**. Same feel,
same timings, same barge-in. Backend: no changes needed (the chat WebSocket already carries voice);
one follow-up for the backend agent is listed at the end.

It behaves like a **call**, not voice notes: tap the call button once, talk, it sends by itself when
you stop, she answers aloud, and it keeps listening until you end it. The mic is open the whole
time; while she talks it only listens for an interruption (stricter thresholds), once she's done
anything you say is a new turn.

Decisions in this file were settled with the owner on 2026-11-21 (see "Decided" at the end).

Reference implementation (the source of truth for behavior):
`../app/frontend/src/hooks/useVoiceSession.ts`, `../app/frontend/src/audio/*`, the voice half of
`../app/frontend/src/hooks/useChatSocket.ts`, wiring in `../app/frontend/src/pages/ChatPage.tsx`.

## The approach in one paragraph

The web code splits into **logic** (state machine, VAD, barge-in, fencing, timers) and **audio I/O**
(browser `getUserMedia`, AudioWorklet, Web Audio). The logic is ported to the phone nearly line for
line, so a fix on one side can be copied to the other. The audio I/O is replaced by one small Kotlin
module, `modules/jophiel-audio`, that does capture and playback **together**. Only then does Android's
echo cancellation know what she is saying and remove it from the mic. Without that, barge-in fires on
her own voice.

Why not `expo-audio`: SDK 58's `AudioStream` can stream mic PCM, but it records and plays separately
(playback is file/URL only). It has no streamed PCM playback and gives no control over the
voice-communication mode that echo cancellation needs. It's fine for recording, not for a
conversation.

## Feature parity checklist (all of it ships in phase 4)

From the web app, with the exact numbers:

| # | Behavior | Web value |
|---|---|---|
| 1 | Continuous loop: listen → think → speak → listen again automatically | — |
| 2 | End of turn by silence (VAD), adaptive noise floor, reset each turn | hangover 800 ms, onset 150 ms, onset gap 120 ms, ratio 2.5, min threshold 0.012 |
| 3 | Room tone / echo never sent to Whisper (no speech → utterance cancelled, not sent) | — |
| 4 | **Spoken barge-in as a hold:** her reply *pauses*, your speech streams with pre-roll | ring 800 ms, padding 150 ms |
| 5 | Stricter speech detection while she talks (skip "mm-hm" and echo) | 250 ms, ratio 2.0 |
| 6 | Hold ends quickly; server decides **resume / stop / turn** (`barge_resolved`) | hold hangover 400 ms |
| 7 | Clearly a real turn → commit early (`voice_interrupt_commit`) | 1000 ms of speech |
| 8 | No decision from server → resume her reply | 8 s |
| 9 | Interrupt button (hard barge-in, one-frame handoff `voice_interrupt`) | — |
| 10 | "Done talking" button (end turn now), "Talk now" (push-to-talk) | — |
| 11 | Mute mic: her replies still play; an open hold resumes her | — |
| 12 | Typing a message while voice is on: mute + drop her spoken reply (`pauseForText`) | — |
| 13 | **Heard tracking:** which part of an interrupted reply you heard (`audio_segment` → `voice_heard`); the unheard tail shows faded in chat, also in history (`heard_chars`) | — |
| 14 | She speaks first (spoken nudges, `audio_start.unprompted`): closes an empty open mic, plays, listens again; never talks over you | — |
| 15 | `reply_interrupted` (urgent event): stop her where she is, wait for her message, listen again | 6 s |
| 16 | Fencing: late audio/events from a cancelled turn are dropped (epochs, fenced turn ids, `dropAudio`) | — |
| 17 | Gapless playback, jitter cushion that doubles on underrun, instant total stop, pause/resume in place | lead 120 ms → max 600 ms |
| 18 | Safety nets: no answer at all → give up and listen again; reply with no audio → listen again | 60 s / 4 s |
| 19 | Latency marks per turn (`voice_latency`) | — |
| 20 | Levels for the visualiser: mic (smoothed), her voice (measured on output), sqrt display curve, damped when idle | — |
| 21 | Visualiser with a different *motion* per state (still / breathing / mic bars / sweep / ripples) | — |
| 22 | Transcript bubble appears for your turn; empty "typing" placeholders cleaned up after a cut-off | — |
| 23 | Senses: `activity: speaking`, `hearing_enabled`, `voice_state`, `wake_armed: false` (the server uses these to decide whether to speak a nudge to *this* socket) | — |
| 24 | Voice only offered when `/api/capabilities` says `voice_enabled`; "Not connected." handling | — |
| 25 | Recover the mic when coming back to the app | web: visibilitychange |

Server-side behaviors that come for free: filler audio, transcription, the barge decision, no
push for what she said aloud.

Not in phase 4: wake word (phase 9; the web build doesn't have a trained model either),
background listening + screen lock (phase 5), speaker/headphones/phone-mic settings (phase 5).

## Architecture

```
 Chat screen ── VoiceBar / VoiceOrb (UI)
       │
 VoiceProvider (src/voice/) ── useVoiceSession  ← ported from web, logic unchanged
       │            │   vad.ts, pcmRingBuffer.ts, heardText.ts  ← copied as-is, with tests
       │            │   player.ts (segments, lead, heard)       ← web playback.ts logic over native
       │            ▼
       │     modules/jophiel-audio (Kotlin)   AudioRecord + AudioTrack, one voice session
       ▼
 ChatConnection (src/chat/connection.ts) + voice frames  ← voice half of web useChatSocket
```

### 1. Native module `modules/jophiel-audio` (Kotlin, local Expo module)

Created with `bunx create-expo-module@latest --local`; autolinked; rebuilt with
`bunx expo run:android`.

**Capture**
- `AudioRecord`, source `VOICE_COMMUNICATION`, 16 kHz mono 16-bit. Android's own echo
  canceller / noise suppressor / AGC (`AcousticEchoCanceler`, `NoiseSuppressor`,
  `AutomaticGainControl`) attached to its session when available. This is the counterpart of
  the browser's `echoCancellation/noiseSuppression/autoGainControl: true`.
- Reader thread, 20 ms frames (320 samples). Per frame, Kotlin computes RMS (same formula as the
  web worklet) and sends one event `{ pcm: base64, rms }`. That's 50 events/s of 640 bytes, well
  within what the bridge handles. (The docs only document binary as a *function argument*,
  `ByteArray` → `Uint8Array`, not as an event payload, so events use base64.)
- `setMuted` stops delivering frames without tearing the mic down.

**Playback**
- `AudioTrack` in streaming mode, `USAGE_VOICE_COMMUNICATION`, at the `audio_start` sample rate
  (24/32 kHz from the server). It's in the same communication session as the recorder, so the
  echo canceller has her voice as reference.
- `enqueue(Uint8Array)`: write PCM, returns the frame position where it was placed.
- `pause()` / `resume()`: `AudioTrack.pause/play`, keeps everything queued (the hold).
- `stop()`: `pause + flush`, immediate and total (the barge-in).
- `playedFrames` (from `getPlaybackHeadPosition`) is the clock that the JS player uses for
  segments, heard text and "done", the same way the web uses `AudioContext.currentTime`.
- `level`: RMS of what's being written out, for the orb (the web analyser's job).
- Event `onPlaybackDrained` when the queue empties (web `waitUntilDone`).

**Android audio session**
- `AudioManager.MODE_IN_COMMUNICATION` while voice is on, normal mode when off.
- **Gotcha:** in communication mode Android routes to the *earpiece* by default and the volume
  keys control *call* volume. On Android 12+ we call `setCommunicationDevice(speaker)`, or the
  wired/Bluetooth device when one is connected. **Decided:** loudspeaker by default, headphones /
  AirPods take over when connected, no proximity (ear) switch. Output choices are phase 5 settings.
- Audio focus `AUDIOFOCUS_GAIN` (voice communication). Losing it (incoming call, another app)
  → event `onInterrupted` → JS mutes and stands down, same as an error.
- `AudioDeviceCallback` → event on headphones in/out, so routing follows.

### 2. Ported logic (`src/voice/`)

- `vad.ts`, `pcmRingBuffer.ts`, `heardText.ts` and their tests: **copied verbatim**, run with
  `bun test`.
- `useVoiceSession.ts`: copied, with only mechanical swaps: `window.setTimeout` → `setTimeout`,
  `import.meta.env.DEV` → `__DEV__`, `performance.timeOrigin + performance.now()` → `Date.now()`,
  `startCapture` / `createPlayer` → the native-backed versions with the same interface.
  The web's `visibilitychange` recovery becomes `AppState`. A header comment in every copied file
  records the web commit it was ported from (copy, not a shared package: the repos stay separate).
- **Deliberate differences from the web** (everything else stays identical):
  - **Leaving the app ends voice** (home, app switch; phase 5 changes that). Her reply in flight is
    *not* cancelled: audio stops, `voice_heard` is reported, the text keeps streaming and finishes in
    the chat with the unheard part faded (pushed as usual by the server). Back in the app, voice is
    off until you tap the call button again.
  - **Connection drop during a call:** the call stays open and shows "Reconnecting…"; when the
    socket is back, it starts listening again on its own (the web stands down to idle and waits for
    "Talk now"). A reply being spoken when it dropped is lost (the server already treats it as cut off).
  - VAD values are read from the dev tuning store (see UI) instead of constants, defaulting to the
    web values.
- `capture.ts`: same `MicCapture` interface as the web (`stop`, `setMuted`, `resume`, `active`,
  `sampleRate`), backed by the module.
- `player.ts`: same `PcmPlayer` interface as web `playback.ts`. The segment / lead / underrun /
  `heardTextEnd` math is kept from the web and runs on the native frame clock.

### 3. Socket (`src/chat/connection.ts`, `src/chat/frames.ts`)

- `binaryType = 'arraybuffer'`; incoming binary → audio handler; outgoing `Int16Array` sent as
  binary frames.
- New frames: `transcript`, `audio_start` (+`unprompted`), `audio_segment`, `audio_end`,
  `barge_resolved` in; `voice_start`, `voice_end`, `voice_cancel`, `voice_interrupt`
  (+`tentative`), `voice_interrupt_commit`, `voice_heard`, `voice_latency` out.
- The voice methods of web `useChatSocket` are ported: `startVoice`, `sendAudio`, `endVoice`,
  `cancelVoice`, `interruptVoiceStart`, `holdVoice`, `commitHold`, `endHold`, `resumeHold`,
  `stopHold`, `adoptHold`, `reportHeard`, `reportVoiceLatency`, plus the fencing
  (`fencedTurns`, `dropAudio`, `ignoredNudge`).
- `SenseFrame` gains `activity: 'speaking'`, `hearing_enabled`, `wake_armed`, `voice_state`.
- `StoredMessage` gains `heard_chars`; the chat model and bubbles render the unheard tail faded.
- Voice turns go **outside** the text waiting queue (they're live, not retried). A text message
  sent while voice is on still goes through the queue, after `pauseForText`.

### 4. UI (Chat screen)

- **Call button in the Chat header**, next to Settings (call/headset icon, shown only if
  `voice_enabled`). The composer stays text-only with its normal Send button. Tap → mic
  permission if missing (reuse Setup's mic step; denied → snackbar with "Open settings") → call on.
  Voice **never starts by itself** (not on app open, not from a notification).
- **Voice panel:** slides in above the messages while a call is on, slides away when it ends; the
  chat scrolls under it. It holds the orb (~120dp, the chibi's future place), the state in words
  (Listening / Thinking / Speaking / Mic muted / Reconnecting…), and the same buttons as the web:
  **Talk now / Done talking / Interrupt** (one context button), **Mute**, **End**.
- Typing while a call is on: mutes the mic and drops her spoken reply (`pauseForText`, as web).
- **Full `VoiceOrb`**, rebuilt with `react-native-svg` + Reanimated (both installed). Level read
  from a getter on the UI thread, so the screen doesn't re-render at 60 Hz. Same per-state motions
  as the web orb. It stays after phase 7 as the fallback when the chibi is off.
- Errors in the same snackbar as chat errors.
- Keep the screen awake while a call is on (`expo-keep-awake`, via `bunx expo install`).
- No vibration cues (decided).

### 5. Developer screen (Settings → Developer, dev builds only)

Hidden in release builds. One screen with:
- **Echo test (for the S21 check after 4.2):** plays a stored reply clip loudly through the
  loudspeaker while capturing, and shows mic RMS next to output level and the VAD threshold, plus
  a verdict ("her voice reaches the mic at X% of the barge-in threshold"). Also a plain mic meter.
- **Live VAD tuning:** `speechRatio`, `minThreshold`, `hangoverMs`, `minSpeechMs`, and the
  while-she-talks values (`BARGE_IN_MIN_SPEECH_MS`, `BARGE_IN_SPEECH_RATIO`), live readout of
  noise floor / threshold / speaking. Saved on the phone (AsyncStorage), **Reset** to web
  defaults, **Copy** (JSON to the clipboard, to send back).
- **Echo fallbacks** (see Risks): toggle for output-level gating, toggle for
  "button-only interrupt on loudspeaker".

## Build order (each step testable on the emulator)

| Step | What | Done when |
|---|---|---|
| 4.1 | Module skeleton, capture only; dev screen showing the RMS meter | Mic level moves in the emulator |
| 4.2 | Playback: enqueue / pause / resume / stop / clock / level / drained; Developer screen with the echo test | A test tone plays gapless, stops instantly |
| **4.2b** | **Owner runs the echo test on the S21 over USB** (`adb reverse`, no Tailscale), ~10 min | Echo verdict recorded; fallback chosen *before* building on |
| 4.3 | Copy `vad`, `pcmRingBuffer`, `heardText` + tests; `capture.ts`, `player.ts` | `bun test` green |
| 4.4 | Socket voice frames + methods + fencing; sense fields | Unit tests on frame handling |
| 4.5 | Port `useVoiceSession`; `VoiceProvider` wiring (transcript, tokens, heard, nudges) | One full voice turn in the emulator |
| 4.6 | Voice UI: buttons, orb, states, mute, pause-for-text, heard fade | All 25 checklist rows tried on the emulator |
| 4.7 | Audio focus, calls, headphones, app background/return, permission denied | Edge cases behave |
| 4.8 | Lint, typecheck, tests, PR | Merged to `main` |

## Testing

- **Emulator:** Extended controls → Microphone → "Virtual microphone uses host audio input".
  Wear headphones on the Mac to test barge-in (the emulator has no real echo cancellation:
  through the Mac speakers she'll interrupt herself, which says nothing about the phone).
- **Unit tests:** the copied web tests, plus frame/fencing tests for the socket and the
  hold state machine.
- **S21 (when you do the real-phone pass):** echo cancellation through the loudspeaker,
  VAD thresholds (tuned against Chrome's noise suppressor; Samsung's differs, so expect to
  adjust `speechRatio` / `minThreshold`, nothing else), AirPods, a phone call during voice.

## Risks

1. **Echo cancellation quality varies per phone.** Checked early, in step 4.2b. If her voice
   still triggers barge-in, the fallbacks (all built in, so no new work is needed) in order:
   1. raise the while-she-talks thresholds (Developer screen);
   2. **output-level gating:** while she plays, mic RMS that tracks her own output level (native
      measures both) doesn't count as speech;
   3. last resort, behind a switch: on the **loudspeaker only**, spoken barge-in off and the
      Interrupt button only. With headphones, spoken barge-in stays on.
2. **Bridge timing:** 50 mic events/s + audio in. Small, but the JS thread also renders streaming
   text. If frames lag, VAD and pre-roll move to Kotlin (they're pure functions, easy to port).
3. **Earpiece/volume surprise** in communication mode (handled above, must be checked).

## Size

About **6–9 days**: more than the 4–7 in PLAN.md, because full parity includes the hold/resume
barge-in, heard tracking, spoken nudges and the orb.

## Decided (with the owner, 2026-11-21)

1. Full parity with the web voice mode; logic **copied** (web commit noted in each file), not shared.
2. Call-style: call button in the header; composer stays text-only; voice never auto-starts.
3. Voice panel above the messages with the full orb; same buttons as the web.
4. Loudspeaker by default, headphones/AirPods when connected, no ear switch.
5. Leaving the app ends the call; her reply finishes as text, unheard part faded; screen kept awake
   during a call.
6. Connection drop: call stays open, listens again automatically after reconnect.
7. Barge-in built in full; echo checked on the S21 right after 4.2 (step 4.2b); fallbacks in the
   order under Risks.
8. Developer screen (dev builds only): echo test + live VAD tuning + fallback toggles.
9. No vibration cues.
10. Two apps with voice on at once both speak a nudge until the backend follow-up below lands.
11. Always call mode, headphones included (decided on the S21, 2026-11-21). Media mode on
    headphones sounded fuller, but Bluetooth then can't use the earbuds' mic (SCO is call-only);
    talking through the earbuds matters more. A choice between the two belongs with phase 5's
    speaker/headphones/phone-mic settings.

## S21 results (2026-11-21, wireless debugging)

Owner tested on the S21 with AirPods Pro:
- Voice turns, Interrupt, Mute, Done talking, leaving the app mid-call: all fine.
- AirPods mic (Bluetooth SCO): after her first spoken reply it can stay at exact digital zeros.
  The native module restarts the mic once when that lasts 1 s right after she stops playing
  (`DEAD_MIC_FRAMES`); seen working on the S21. AirPods also send exact zeros whenever you're
  quiet, so zeros alone don't mean a dead mic.
- AirPods mute their mic while she plays: no spoken barge-in on AirPods; the Interrupt button
  works. Not a bug.
  Re-checked in the phase 5 pass: the owner reports spoken barge-in works (see PLAN_PHASE_5.md,
  S21 results).
- Loudspeaker echo test (4.2b): 0% of the barge-in threshold, so no fallback needed (both stay off).
  On a real call she never cut in on herself; spoken barge-in over her on the loudspeaker paused
  her (hold), and the server resolved it (`stop`).
- Wi-Fi drop can't be tested over wireless debugging (Android turns it off with the Wi-Fi, which
  takes the `adb reverse` tunnels down). Test reconnect by restarting the server, or over Tailscale.
- Two "she doesn't speak" reports were the TTS sidecar being unreachable (server side), not the app.

## Backend follow-up (for the backend agent; this folder never touches `../app`)

**Speak a nudge only on the connection where the user last started talking.** Today every socket
whose senses say `hearing_enabled` and `voice_state` idle/listening speaks it (`routes/chat.py`, the
nudge loop and `_deliver_unprompted`), so web + phone with voice on both say it aloud. Wanted: track
per user the socket of the most recent `voice_start` / `voice_interrupt`; only that socket gets
`audio_*` for an unprompted message, the others get `nudge_*` text only. If that socket is no longer
voice-live, fall back to today's behavior. The phone needs no change for this (it already reports
`hearing_enabled` / `voice_state` and sends `voice_start`).
