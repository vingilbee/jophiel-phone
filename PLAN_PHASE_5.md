# Phase 5 — Voice in the background

Goal: a call with Jophiel keeps going when you leave the app, lock the screen, or put the phone in
your pocket with AirPods in. Backend: no changes.

Builds on phase 4 (`PLAN_PHASE_4.md`): `modules/jophiel-audio` (Kotlin capture + playback in one
call-mode session), the ported web logic in `src/voice/`, voice frames in `src/chat/voice.ts`.
The audio path does not change: whatever works with the app open (including spoken barge-in on a
given headset) works the same in the background. This phase only keeps it *running*.

Decisions settled with the owner on 2026-11-21 (see "Decided" at the end).

## What changes, in one paragraph

Today the call ends on leaving the app (`useVoiceSession.ts`, AppState → `leave()`), and nothing
would keep it alive anyway: Android stops a background app's mic, may kill the process, and React
Native pauses JS timers once the app isn't visible. Phase 5 adds an **Android foreground service**
that owns the call while it's on, with a notification as the control surface. The call's **timers
move onto a native clock**, and the **chat socket stays open** while a call is live. The voice logic
itself stays the phase 4 port of the web code.

## Facts found (checked in code, 2026-11-21)

- **JS timers stop in the background.** RN 0.88 `JavaTimerManager.kt`: on `onHostPause` timers stop
  firing unless a Headless JS task is running, and even then they're driven by Choreographer
  (display vsync), which stalls with the screen off. The voice loop depends on timers (hold
  decision 8 s, audio grace 4 s, no-answer 60 s, yield 6 s, ack/reconnect in `connection.ts`).
  Native events (mic frames, socket messages) still reach JS in the background; only timers stall.
- **Side finding (phase 2):** `ChatProvider`'s "close the socket 30 s after backgrounding"
  (`BACKGROUND_CLOSE_MS`) is a `setTimeout` too, so it likely doesn't fire until the app returns.
  The native clock below fixes it as well.
- **Android 14:** a `microphone` foreground service must be *started while the app is visible*
  and needs `FOREGROUND_SERVICE_MICROPHONE` + `RECORD_AUDIO`. So the service starts when the call
  starts (in the app), never on leaving the app (that would be refused).
- **Samsung:** the battery step (Unrestricted) already exists in Setup (`src/setup/permissions.ts`).
- **No backend change:** the server already handles a voice-live socket that isn't visible
  (`visible: false` + `hearing_enabled` / `voice_state`): said aloud → not pushed; spoken nudges
  allowed.

## Behavior (owner decisions)

| Situation | What happens |
|---|---|
| Leave the app / lock the screen, setting **on** (default) | Call continues; notification shows |
| Same, setting **off** | Phase 4 behavior: the call ends, her reply finishes as text |
| Phone call or another app takes audio focus | Voice pauses (mic muted, her audio stopped as in phase 4); when focus comes back, it **listens again by itself**. Exception: a *permanent* loss (another app starts media) never gets focus back from Android, so it stays "Paused for a call" until you tap Unmute (see Implementation notes) |
| App swiped away from recents | **Call ends**, notification goes away |
| **30 min** without *your* speech, in the background | Call ends; notification "Call ended after 30 min of quiet". Her nudges don't reset the clock. Not applied while the app is on screen. |
| **2 min** without a connection, in the background | Call ends; notification "Call ended: couldn't reach Jophiel". With the app open it keeps retrying (phase 4). |
| She has something to say while the phone is locked | She **speaks it** (spoken nudges), same as with the app open |
| First call that goes to the background while battery isn't Unrestricted | One-time prompt opening the Samsung battery step (same screen as Setup). Afterwards only Settings → Permissions shows it. |
| Coming back to the app during a call | Voice panel shows the live call; nothing restarts |

Output routing is unchanged from phase 4 and **not configurable**: headphones/AirPods when
connected, otherwise the loudspeaker; always call mode (talk through the earbuds).

## Architecture

### 1. Foreground service (in `modules/jophiel-audio`)

- `VoiceCallService` (Kotlin), `foregroundServiceType="microphone"`, declared in the module's
  own `android/src/main/AndroidManifest.xml` (merged at build; no hand edits to `android/`), with
  `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `WAKE_LOCK`. `stopWithTask="false"` plus
  `onTaskRemoved` → emit `onCallEnded(reason: "swiped")` and stop, so swipe-away ends the call
  cleanly (her reply finishes as text if the socket is still up, as in phase 4's leave).
- Started from JS when a call starts (`startCallService()`, app visible), stopped when it ends.
  Lifetime = the call, not the app. Started for every call, even with the background setting
  off (it's cheap and avoids starting it at the moment of leaving, which Android 14 refuses).
  With the setting off, leaving the app ends the call and stops it.
- Holds a **partial wake lock** and a **Wi-Fi low-latency lock** for the call, so the CPU and the
  network don't sleep with the screen off. Released on stop.
- **Notification** (new channel "Voice calls", low importance: silent, no heads-up; ongoing, shown on
  the lock screen):
  - Title "Jophiel", text = state in words (Listening / Thinking / Speaking / Muted /
    Reconnecting… / Paused for a call).
  - Actions: **Interrupt** while she's thinking/speaking, **Talk now** when idle (one action that
    changes with the state; hidden while listening), **Mute / Unmute**, **End**.
  - Tap → opens the chat.
  - JS calls `updateCallNotification(state, muted)` on each state change; actions come back as
    module event `onCallAction(action)` and map to the existing `interrupt` / `pushToTalk` /
    `setMuted` / `disable`.
  - Shown for the whole call (Android requires it from the start), also while the app is open.
- Built natively, not with Notifee: the service owns the wake locks and the audio session next to
  the existing audio code, and stays independent of JS reloads.

### 2. Native clock for the call

- Module functions `setTimer(id, ms)` / `clearTimer(id)` + event `onTimer(id)`, on a native
  `Handler` thread, so they fire with the screen off.
- `src/voice/timers.ts` exposes `setTimeout`/`clearTimeout`-shaped wrappers. `useVoiceSession`,
  `src/chat/voice.ts`, `connection.ts` (ack + reconnect backoff) and `ChatProvider`
  (`BACKGROUND_CLOSE_MS`) use them. It's a mechanical swap; the ported logic doesn't otherwise change.
- The 30-min quiet and 2-min no-connection limits run on the same clock.

### 3. Socket and presence

- While a call is live, backgrounding **doesn't close the socket**. When the call ends in the
  background, the normal 30 s close starts (now on the native clock).
- Senses: `visible: false` in the background, `hearing_enabled` / `voice_state` stay live.
- Reconnect in the background: phase 4 behavior (call open, listens again when back), bounded by
  the 2-min limit above.

### 4. Session changes (`src/voice/useVoiceSession.ts`, `VoiceProvider.tsx`)

- `leave()` on background runs only when the background setting is off.
- Audio focus: `onInterrupted("focus_lost")` → pause (muted, her audio stopped, state "Paused for a
  call"); new native event on focus regained → unmute and listen again. A `mic_lost` (dead mic that
  couldn't be restarted) keeps today's behavior.
- Quiet timer: reset on every VAD `speech-start` from the user; started/stopped on AppState
  background/active.
- These are phone-only additions; mark them as such in the code so the web-ported parts stay
  recognisable.

### 5. Headset button (best effort)

- A `MediaSession` held by the service, receiving headset button / AirPods stem press:
  single press → **Interrupt** while she thinks/speaks, **Talk now** when idle.
- In call mode Android may route the button to "hang up" instead. If the S21 doesn't deliver it to
  the app, **drop the feature** without blocking the phase (note it in the S21 results).
- With AirPods, this (or the notification's Interrupt) is how you cut her off: phase 4 found AirPods
  mute their mic while she plays. (Owner thinks spoken barge-in on AirPods worked; to re-check: ask
  for a long answer and talk over her mid-sentence. If it works, correct PLAN_PHASE_4.md.)

### 6. Settings and Setup

- **Settings → Voice:** one switch, **Keep listening in the background** (default **on**). Stored in
  `PhoneSettings` (add the field via `migrate`, no version bump needed: new fields get defaults).
- Battery prompt as in the behavior table; reuse the Setup battery step screen. Remember "shown once"
  in `PhoneSettings`.
- Setup's notification step already covers posting the call notification (Android 13+
  `POST_NOTIFICATIONS`). If notifications are denied, the call still works (Android shows the
  service in the task manager instead); no extra prompt.

## Build order

| Step | What | Done when |
|---|---|---|
| 5.1 | Native clock + swap in voice / socket / ChatProvider | Unit tests; a dev-screen timer keeps firing with the screen off |
| 5.2 | Foreground service + notification (no actions yet) + wake/Wi-Fi locks; socket kept open during a call | A full turn with the screen locked, on the emulator |
| 5.3 | Notification actions; focus loss/regain; swipe-away; 30-min and 2-min limits (shortened via the Developer screen for testing) | Each row of the behavior table tried |
| 5.4 | Headset button via MediaSession (best effort) | Works on the S21, or dropped and noted |
| 5.5 | Settings → Voice switch; battery prompt | Switch changes behavior live |
| 5.6 | **S21 pass (owner):** pocket + AirPods; 30 min locked (incl. a long quiet stretch for the AirPods dead-mic restart); a real phone call mid-call; spoken nudge while locked; battery drain per hour | Results written to this file |
| 5.7 | Lint, typecheck, tests, PR | Merged to `main` |

## Risks

1. **Samsung killing the service** despite Unrestricted ("Deep sleeping apps"). Mitigation: the
   battery prompt, and the 30-min locked test in 5.6.
2. **AirPods mic after long background quiet.** The phase 4 dead-mic restart has only been seen
   with the screen on; 5.6 covers a locked phone with long silences.
3. **Battery drain**: mic + Wi-Fi + CPU awake. Expected a few %/hour; measured in 5.6.
4. **Headset button** may not reach the app in call mode (best effort, see §5).

## Size

4–6 days (PLAN.md).

## Decided (with the owner, 2026-11-21)

1. "Keep listening in the background" setting, **on by default**; off = phase 4 behavior.
2. Notification: state in words + **Interrupt / Talk now**, **Mute/Unmute**, **End**; tap opens the chat.
3. After a phone call / focus loss: listen again by itself.
4. Swipe away from recents: end the call.
5. 30 min without your speech in the background: end the call (nudges don't count).
6. She may speak first while the phone is locked.
7. Headset / AirPods button: Interrupt / Talk now, best effort.
8. Call mode only (no "better sound" media mode); output always automatic (no "loudspeaker always").
9. Battery prompt once, on the first background call.
10. 2 min without a connection in the background: end the call.
11. Not in phase 5: a "Call" button on her push notifications (idea for later), wake word (phase 9).

## Implementation notes (2026-11-21, branch `phase-5-background-voice`)

Steps 5.1–5.5 are built; 5.6 (S21 pass) and 5.7 (PR) are open. Lint, typecheck and `bun test`
(incl. `src/voice/background.test.ts`) pass; the module's Kotlin compiles. Not yet run on a device.

- **Native clock:** `setTimer` / `clearTimer` / `onTimer` on a `HandlerThread` in the module;
  `src/voice/clock.ts` (pure) + `src/voice/timers.ts`. Swapped into `useVoiceSession`,
  `connection.ts`, `ChatProvider` (`BACKGROUND_CLOSE_MS`) and the player's "done" backstop
  (`player.ts` polled with `setInterval`, which would also have stalled in the background).
  Developer screen → Background calls → **Clock test** checks it with the screen off.
- **Service:** `VoiceCallService.kt` (framework `Notification` and `MediaSession`, no new
  dependencies), declared in the module's own `AndroidManifest.xml`. Started in `VoiceProvider`
  when a call goes live, stopped when it ends; also stopped if JS goes away (module `OnDestroy`).
  If Android refuses to start it, leaving the app ends the call as in phase 4.
- **Focus:** the module emits `onFocusRegained` on `AUDIOFOCUS_GAIN` after a loss, after taking call
  mode back, re-routing and reopening the mic. A *permanent* loss (another app starts playing
  media) gets no gain callback from Android, so that case stays "Paused for a call" until you tap
  Unmute.
- **Battery prompt:** a background app can't show a screen, so the one-time battery step opens when
  you come back to the app after that first background call.
- **Limits:** in `VoiceTuning` (`backgroundQuietMs`, `backgroundOfflineMs`), adjustable on the
  Developer screen for testing.
- **Headset button:** wired via `MediaSession` (headset hook / play-pause); untested, see 5.4.

## S21 results (2026-11-21, wireless debugging)

Owner's pass on the S21:
- Background: the call keeps going with the app left and the screen locked; works as expected.
- Spoken barge-in: works.
- Not yet tried: a real phone call mid-call (pause / listen again), the 30-min locked run with
  long quiet stretches (incl. the AirPods dead-mic restart), battery drain per hour, and the
  headset button (5.4). To do in a later pass.
