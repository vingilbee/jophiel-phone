# Jophiel phone app (Android)

Phases 0–3 of `PLAN.md` / `PLAN_PHASE_0-3.md`: login, chat with ticks and an offline queue, push
notifications, settings, first-run setup. Design: `DESIGN.md`. Backend: `../app` (not touched here).

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

## Scripts

| | |
|---|---|
| `bun run android` | build + install the dev build |
| `bun start` | Metro for the dev build |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | oxlint |
| `bun test src` | unit tests (store/merge, queue, ticks, backoff, markdown, notification grouping) |
| `bun run gen:api` | regenerate `src/api/types.gen.ts` from the backend's `/openapi.json` |

## Layout

```
src/app/            screens (Expo Router): (auth)/login, (main)/index = chat, settings, setup/[step]
src/chat/           frames.ts (WS protocol), model.ts (store + merge + ticks), queue.ts, connection.ts, ChatProvider
src/push/           plan.ts (pure), display.ts (notifee), background.ts, registration.ts (FCM)
src/settings/       versioned phone-side settings
src/connection/     backoff + banner state
src/setup/          permission reads (always from Android)
src/components/     UI building blocks
src/theme/          palette + type tokens
plugins/            config plugin: notification status-bar icon
```
