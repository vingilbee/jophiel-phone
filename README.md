# Jophiel phone app (Android)

Phases 0–3 of `PLAN.md` / `PLAN_PHASE_0-3.md`: login, chat with ticks and an offline queue, push
notifications, settings, first-run setup. Phase 4 (`PLAN_PHASE_4.md`): voice calls with the app open.
Design: `DESIGN.md`. Backend: `../app` (not touched here).

## First time on the Mac

1. Install **Android Studio**. In its SDK Manager install the latest SDK Platform, Platform-Tools and
   Build-Tools. Add to `~/.zshrc`:
   ```sh
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
   ```
   Java: Android Studio bundles a JDK. If Gradle complains about Java 21, point `JAVA_HOME` at it:
   `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`.
2. Device Manager → create a Pixel-size phone with a **Google Play** system image (needed for push).
3. Start the backend (`../app`) on port 8000, start the emulator, then:
   ```sh
   bun install
   bun run android        # = bunx expo run:android: builds the dev client and installs it
   ```
   Afterwards `bun start` is enough for JS changes (hot reload).

In the emulator the server address is prefilled as `http://10.0.2.2:8000` (the Mac's localhost).
Plain HTTP works only in debug builds; release builds need HTTPS (Tailscale).

## Push notifications (phase 2)

Push is compiled in only when `google-services.json` is in this folder (it's git-ignored):

1. Create a Firebase project → add an Android app with package `com.jophiel.app` → download
   `google-services.json` here.
2. Give the backend a service account for FCM HTTP v1 (backend side).
3. Regenerate the native project and rebuild (a plain rebuild reuses the old `android/` folder,
   which has no Firebase in it):
   ```sh
   bunx expo prebuild --platform android --clean
   bun run android
   ```
   Skipping this gives "No Firebase App '[DEFAULT]'" in older builds; now the app just runs without
   push and logs a warning saying to rebuild.

Without the file the app works; it just doesn't show notification settings or the Setup step.

## Voice (phase 4)

Voice needs the native module in `modules/jophiel-audio` (Kotlin, autolinked). After pulling it, or
after any change under `modules/` or to `app.config.ts`, rebuild the dev client:

```sh
bunx expo prebuild --platform android
bun run android
```

An older build still runs; the call button just stays hidden (no audio module).

- The call button (☎) is in the Chat header, shown when the server reports `voice_enabled`.
- **Emulator:** Extended controls → Microphone → turn on "Virtual microphone uses host audio
  input". Wear headphones on the Mac to try barge-in: the emulator has no real echo cancellation, so
  through the Mac speakers she interrupts herself (that says nothing about the phone).
- **Settings → Developer** (dev builds only): mic meter, the echo test for the S21 (step 4.2b),
  live VAD tuning and the echo fallbacks. Tuning is saved on the phone; **Copy** puts it on the
  clipboard as JSON.

## Scripts

| | |
|---|---|
| `bun run android` | build + install the dev build |
| `bun start` | Metro for the dev build |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | oxlint |
| `bun test src` | unit tests (store/merge, queue, ticks, backoff, markdown, notification grouping, voice frames/fencing, VAD, player) |
| `bun run gen:api` | regenerate `src/api/types.gen.ts` from the backend's `/openapi.json` |

## Layout

```
src/app/            screens (Expo Router): (auth)/login, (main)/index = chat, settings, setup/[step]
src/chat/           frames.ts (WS protocol), model.ts (store + merge + ticks), queue.ts, connection.ts, voice.ts (voice half of the socket), ChatProvider
src/push/           plan.ts (pure), display.ts (notifee), background.ts, registration.ts (FCM)
src/settings/       versioned phone-side settings
src/connection/     backoff + banner state
src/setup/          permission reads (always from Android)
src/voice/          voice call: useVoiceSession (ported from the web), VAD, ring buffer, player, capture, tuning
modules/jophiel-audio/  native mic + playback in one Android voice-communication session (Kotlin)
modules/jophiel-senses/ phone senses: live readers, geofences, motion, background PUT (Kotlin)
modules/jophiel-actions/ her actions: Maps, volume, ringer/DND, alarms, opening apps/links, Spotify, WhatsApp drafts (Kotlin)
modules/jophiel-notifications/ notifications as a sense (listener), replies, dismiss, media control (Kotlin)
src/actions/        the phone-action channel: parse, checks, dispatch, answer once
src/notifications/  notification frames over the socket while live
src/senses/         phone senses controller (sense frames), groups, places
src/components/     UI building blocks
src/theme/          palette + type tokens
plugins/            config plugin: notification status-bar icon
```
