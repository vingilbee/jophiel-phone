# Jophiel on the phone — plan

Android only. Works on any Android phone from roughly Android 7–8 up (the Expo SDK's
minimum); built and tested on the owner's Samsung Galaxy S21 (Android 14 / One UI 6).
Private app, installed as an APK (no Google Play). Other brands differ only in battery
settings (see the Samsung notes) and need the same Tailscale access.
Backend stays in `../app` on the Mac and is reached over Tailscale.

## What the app is

Jophiel living on the phone: you talk to her by text or voice (also in the background,
through AirPods or the speaker), she knows where you are, uses Google Maps for you, can
act on the phone for you, and a chibi version of her lives in the app and can float over
other apps.

## Screens

| Screen | What's on it |
|---|---|
| **Login** | Email + password (the backend's existing account). Server address field (prefilled with the Tailscale address). |
| **Setup** (first run only, reopenable from Settings) | One step per permission, each explaining why in plain words, with a button that opens the right Android screen: mic, notifications, location, display over apps, battery unrestricted, accessibility, default assistant. Every step can be skipped. |
| **Chat** (home) | The conversation (text, stickers, her nudges), a mic button for voice mode, the chibi sitting at the top of the chat. Voice mode = same screen with the chibi large and the voice state clear (listening / thinking / speaking). |
| **Settings** | See below. |

The floating chibi and the background voice aren't screens: they're a bubble over other
apps and a notification.

### Settings

- **Chibi:** off / in the app only / floating over other apps; roam (stays put, or walks
  along the screen edges); size; hide while specific apps are open (e.g. games, video).
- **Voice:** push-to-talk or wake word ("hey Jophiel"); keep listening in the background
  on/off; output (automatic / speaker / headphones); use the phone's mic even with
  AirPods (better sound quality).
- **Location:** off / while using / always; places (home, work…) she knows by name.
- **Phone control:** master switch; apps she may touch; actions that always ask first
  (sending a message, calling, paying, deleting).
- **Her reaching out:** none in the app: Android's notification settings for Jophiel (quiet times = Samsung's Do Not Disturb).
- **Connection:** server address, connection status, log out.
- **Permissions:** what's granted, reopen Setup.

## Important fact found in the backend

The chat WebSocket (`/api/chat/ws`) **already carries voice**: 16-bit mono PCM up
(`voice_start` / binary frames / `voice_end`), her TTS PCM down (`audio_start` / binary /
`audio_end`), barge-in, nudges spoken aloud. So the phone does **not** need LiveKit: it
needs native audio capture + playback and speaks the same protocol as the web app.
(Earlier I suggested LiveKit; this replaces that.)

## Build order

Each phase ends with something usable on the phone. Phases 0–3 are specified in
detail in `PLAN_PHASE_0-3.md`.

| # | Phase | Phone side | Backend side (`../app`) | Size |
|---|---|---|---|---|
| 0 | **Setup** | Expo dev build in the Android emulator on the Mac (the S21 + Tailscale pass comes before phase 4) | none | 1–2 days |
| 1 | **Login + chat** | Login, Chat (history, streaming replies, stickers, nudges), reconnect when the app comes back | Accept `Authorization: Bearer` (same opaque session token) on REST + WS; WS origin check allows the phone; login returns the token for the phone | 4–6 days |
| 2 | **Notifications** | Firebase push; tap a notification → opens the chat | Register phone devices (FCM token); push what she says when you aren't present anywhere and she didn't say it aloud | 2–3 days |
| 3 | **Settings + Setup** | Both screens, settings stored on the phone, permission steps | none | 2–3 days |
| — | **Real-phone pass (S21)** | Tailscale + HTTPS, release APK, Samsung battery, notifications on the real phone | none | 1–2 days |
| 4 | **Voice, app open** | Native (Kotlin) mic capture with Android's echo cancellation, PCM playback, VAD, push-to-talk; voice mode on Chat | none (reuses the WS voice protocol) | 4–7 days |
| 5 | **Voice in the background** | Foreground service ("Jophiel is listening" notification), AirPods/speaker routing, Samsung battery setup, survives screen lock | none | 4–6 days |
| 6 | **Location + Maps** | Report location as a sense; geofences for named places; open Google Maps with navigation | Tools: `get_user_location`, `search_places`, `get_route`, `open_navigation`; places table; Google Maps API key | 4–6 days |
| 7 | **Chibi in the app** | Rive animation driven by her state (idle, listening, thinking, talking + lip sync, moods) | Her state/mood in the WS frames if not already there | 3–5 days (art made separately) |
| 8 | **Floating chibi** | Overlay window over other apps (Kotlin), roaming, tap to talk, drag, hide per app | none | 5–8 days |
| 9 | **Wake word** | Porcupine "hey Jophiel" inside the background service | none | 2–4 days |
| 10 | **Phone actions** | Alarms, reminders, open app/link, notifications | Tools + a phone "body" (actions sent down over WS, or push when the app sleeps; results reported back) | 3–5 days |
| 11 | **Phone control** | Accessibility service: read screen, tap, type, scroll, back | Tools `read_screen`/`tap`/`type_text`/…; allowed-apps list and confirmations enforced on both sides | 7–12 days |
| 12 | **Default assistant** | Jophiel as the assistant on power-button long-press | none | 2–3 days |

## How big is it

- **Usable MVP (phases 0–3, chat + notifications):** about **2 weeks**.
- **Voice everywhere (through phase 5):** about **4–5 weeks** total.
- **Everything (through phase 12):** about **2–3 months** of steady work. Phone control
  and the floating chibi are the biggest unknowns.
- **Code size, roughly:** phone app 10–15k lines TypeScript + 2–4k lines Kotlin; backend
  additions 3–5k lines Python (mostly tools, the phone body, push, tests).
- **Not code, made separately:** the chibi art and its Rive file. The app only needs
  the Rive file's state-machine inputs agreed on (see phase 7).

## Stack

| Part | Choice |
|---|---|
| App | Expo (dev build) + TypeScript, Bun, Expo Router |
| Styling | NativeWind (Tailwind), tokens from `../app/DESIGN.md` |
| Server data | TanStack Query; types generated from FastAPI's OpenAPI (`openapi-typescript`) |
| Login token | `expo-secure-store` |
| Native parts | Expo modules in Kotlin: audio, foreground service, overlay, accessibility, assistant role |
| Push | Firebase Cloud Messaging |
| Chibi | Rive (React Native + Android runtimes) |
| Wake word | Picovoice Porcupine (free for personal use) |
| Maps | Google Maps Platform (Places + Routes) on the backend; the Maps app for navigation |
| Network | Tailscale + `tailscale serve` (HTTPS, WebSockets) |
| Install | USB (`adb`) while developing; signed APK for daily use (keep the signing key safe) |

## Mac prerequisites (checked 2026-11-20)

- Already there: Bun 1.3, Node 26, Java (OpenJDK 21; check it matches the Expo SDK's
  required JDK, use 17 if the build complains).
- Missing: Android SDK + `adb` (install Android Studio, or the command-line tools),
  Tailscale (Mac app and the phone app).

## Samsung S21 notes

- Android 14: every foreground service must declare its type (`microphone`, `location`,
  `specialUse` for the overlay) and the matching permission, and a mic service can only
  start while the app is visible (or from the wake-word service already running).
- Battery → set Jophiel to **Unrestricted**, and keep her out of "Sleeping apps" /
  "Deep sleeping apps", or One UI will kill the background voice.
- AirPods work as a normal Bluetooth headset; mic over Bluetooth is lower quality, which
  is why "use the phone's mic" is a setting.

## Still to decide

- The Rive inputs contract with the chibi artist (e.g. `state`: idle/listening/thinking/
  talking, `mood`, `mouth` 0–1 for lip sync, `walk` for roaming, `tap` trigger).
- Whether her thoughts (owner-only) show on the phone.
