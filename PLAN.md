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
- **Phone senses (phase 6):** seven groups (phone use, battery, headphones, network, sound mode,
  motion, places), each on/off, with the last value she was told; places (home, work…) she knows by name.
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
detail in `PLAN_PHASE_0-3.md`, phase 4 in `PLAN_PHASE_4.md`, phase 5 in `PLAN_PHASE_5.md`,
phase 6 in `PLAN_PHASE_6.md`. No time estimates (owner, 2026-11-21): the size of a phase is
described by its hard parts in its own plan.

Phase order changed 2026-11-21: the old phase 6 (Location + Maps) was split into **6 Phone
senses** and **7 Maps + phone-action channel**; everything after moved up by one.

| # | Phase | Phone side | Backend side (`../app`) |
|---|---|---|---|
| 0 | **Setup** | Expo dev build in the Android emulator on the Mac | none |
| 1 | **Login + chat** | Login, Chat (history, streaming replies, stickers, nudges), reconnect when the app comes back | Bearer token on REST + WS; WS origin check allows the phone; login returns the token |
| 2 | **Notifications** | Firebase push; tap a notification → opens the chat | Register phone devices (FCM token); push what she says when you aren't present anywhere and she didn't say it aloud |
| 3 | **Settings + Setup** | Both screens, settings stored on the phone, permission steps | none |
| — | **Real-phone pass (S21)** | Tailscale + HTTPS, release APK, Samsung battery, notifications on the real phone | none |
| 4 | **Voice, app open** | Native (Kotlin) mic capture with Android's echo cancellation, PCM playback, VAD, push-to-talk; voice mode on Chat | none (reuses the WS voice protocol) |
| 5 | **Voice in the background** | Foreground service ("Jophiel is listening" notification), AirPods/speaker routing, Samsung battery setup, survives screen lock | none |
| 6 | **Phone senses** | Reports screen, lock, battery, charging, headphones, network, Wi-Fi name, Do Not Disturb, ringer, motion and named place: in `sense` frames while open or in a call; place / motion / Bluetooth headphones also from a closed app (geofences, activity transitions). Places in Settings, 7 switch groups, 3 Setup steps | **Already built**: `PUT /api/phone/state`, `phone` in `sense`, her phone source in the mind |
| 7 | **Maps + phone actions channel** | Carry out actions sent by her and report results; first action `navigate_to` (open Google Maps navigating); add a place by address | One general **phone-action tool** (actions down over WS, or push when the app sleeps); `search_places` + `get_route` via Google Maps Platform so she answers travel questions hands-free; Maps API key. Open: route start point vs "no coordinates" (see `PLAN_PHASE_6.md`) |
| 8 | **Phone actions** | Open apps/links: WhatsApp (message pre-typed), Discord, Spotify, Maps; play/pause/next/volume; read notifications and reply via their reply button (works while locked); alarms, reminders. New permission: notification access | More actions on the same phone-action tool |
| 9 | **Phone control** | Accessibility service: read screen, tap, type, scroll, back. For whatever phase 8 can't do directly. Setup step for Samsung's "Allow restricted settings" | Tools `read_screen`/`tap`/`type_text`/…; allowed-apps list and confirmations enforced on both sides |
| 10 | **Chibi in the app** | Rive animation driven by her state (idle, listening, thinking, talking + lip sync, moods) | Her state/mood in the WS frames if not already there |
| 11 | **Floating chibi** | Overlay window over other apps (Kotlin), roaming, tap to talk, drag, hide per app | none |
| 12 | **Wake word** | Porcupine "hey Jophiel" inside the background service | none |
| 13 | **Default assistant** | Jophiel as the assistant on power-button long-press | none |

## How big is it

- **Code size, roughly:** phone app 10–15k lines TypeScript + 2–4k lines Kotlin; backend
  additions 3–5k lines Python (mostly tools, the phone body, push, tests).
- Phone control and the floating chibi are the biggest unknowns.
- **Not code, made separately:** the chibi art and its Rive file. The app only needs
  the Rive file's state-machine inputs agreed on (see phase 10).

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

## Locked phone: what she can and can't do

The phase 6–9 tools are grouped together (decided 2026-11-21); the chibi and the wake word come after.

- **Works locked, phone in the pocket:** music controls, replying to notifications, reading
  notifications, location (if set to "always"), alarms and reminders, talking to her (phase 5).
- **Needs the phone unlocked:** opening an app (it opens behind the lock screen otherwise),
  a new WhatsApp message to someone with no notification to reply to, and all of phase 9
  (it uses the real screen, visibly). She can never enter the PIN; she says "unlock your
  phone and I'll open Maps".
- **Samsung Smart Lock** (Settings → Lock screen → Smart Lock), owner's choice, optional:
  trusted device = the owner's AirPods only. While they're connected the lock screen is a
  swipe, which she can get past herself (wake screen + dismiss). Android still asks for the
  PIN after a restart and after ~4 h without a real unlock.

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
