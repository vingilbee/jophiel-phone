# Phases 0–3: the usable app — plan and spec

Part of `PLAN.md`. Covers: setup, login, chat, push notifications, settings.
Estimated **~2 weeks** of focused work.

Decisions in this file were settled with the owner in a grilling session on 2026-11-20.
Don't reopen them without asking.

## Goal

Jophiel is on the phone as a real app, not a web page: log in once, talk to her by text in
the same conversation as the web app and WhatsApp, and when she says something you
haven't seen anywhere else, the phone gets a notification that opens straight into the chat.

### Done when (the whole milestone, on the Android emulator)

1. Logging in once keeps you logged in for months; logging out really ends the session.
2. A message typed on the phone gets her streamed reply; the same conversation shows on
   the web app.
3. Your messages show 🕓 → ✓ → ✓✓ like WhatsApp; a message written while the backend is
   down waits, survives closing the app, and goes out by itself in order once it's back.
4. Something she says that you haven't seen anywhere (not on a visible web app, not on the
   open phone app, not spoken aloud) arrives as a notification within a few seconds;
   tapping it opens the chat at that message; several stack into one.
5. If the backend can't be reached, the app says so plainly and recovers by itself.
6. Settings has only switches that actually work.

### Who it's for

Only the owner for now, with their existing backend account. **Login only, no signup.**

### Not in this milestone

Voice, location, Maps, chibi, floating overlay, wake word, phone control, default
assistant, photo upload, her thoughts / the System page, several conversations, replying
from a notification, quiet hours (Samsung's Do Not Disturb covers it), a devices /
"log out everywhere" screen, avatar design, the real-phone pass (moved to before phase 4).

---

## Phase 0 — Setup (1–2 days)

### Goal
A blank Expo app runs in the Android emulator on the Mac and reaches the local backend.

### Tasks
1. **Mac tools:** Android Studio (SDK, platform tools / `adb`, emulator); set
   `ANDROID_HOME`. Java is OpenJDK 21; if the Expo SDK's Gradle wants 17, install 17 and
   point `JAVA_HOME` at it.
2. **Emulator:** a recent Pixel-size device with a **Google Play** system image (needed
   for push notifications to work in the emulator).
3. **App skeleton** in `frontend-phone/`: Expo (latest SDK), TypeScript, Bun, Expo Router,
   NativeWind, TanStack Query, `expo-dev-client`, `expo-secure-store`. Package
   `com.jophiel.app` (permanent).
4. **Builds are local only:** `bunx expo run:android`. No Expo account, no EAS, no
   over-the-air updates.
5. **Backend from the emulator:** the emulator reaches the Mac at `http://10.0.2.2:8000`.
   Plain HTTP is allowed **in debug builds only** (Android network security config);
   release builds require HTTPS.
6. **Lint/test:** oxlint (same as web), `bun test` for pure logic.

### Done when
- The dev build opens in the emulator and hot-reloads on save.
- A test screen does `GET http://10.0.2.2:8000/health` and shows `ok`.

---

## Phase 1 — Login + chat

### Goal
Log in, see the conversation, send messages with ticks, watch her reply stream in, see her
unprompted messages live, keep messages written while offline, survive the app going to
the background and back.

### Backend changes (`../app/backend`)

What's there today (checked 2026-11-20):
- Sessions are opaque tokens in Redis (`session:<sha256>` → `{user_id}`), 7-day TTL, no
  sliding renewal (`services/auth.py`).
- Every route reads the token **only from the `session` cookie** (`api/deps.py`).
- `signin`, `signout`, and other writes require `Origin` ∈ `cors_origins`
  (`validate_origin`). A React Native `fetch` sends **no** Origin → 403 today.
- The chat WebSocket also requires an allowed Origin and the cookie (`api/routes/chat.py:409`).
- The WS sends `ack` when it saves your message; nothing tells the client when her chat
  worker picks it up.
- `SenseReport` (`services/awareness.py`) has no field for which client or whether it's
  on screen.

Changes:

1. **Token from the header.** `get_current_user`, `get_current_user_optional` and the chat
   WebSocket accept `Authorization: Bearer <token>`, falling back to the cookie. Same Redis
   lookup, same hashing.
2. **Origin rule.** `validate_origin` is a CSRF guard for cookies. A request authenticated by
   a bearer header can't be forged cross-site, so it **passes** `validate_origin`. Cookie
   requests keep the check unchanged. Same rule on the WebSocket.
3. **Phone sign-in.** `POST /api/auth/token`
   - Body: `{ email, password, device_name }`
   - Returns: `{ token, user: UserOut, expires_at }`; sets **no** cookie, so no Origin check.
   - Same rate limit as signin (5/minute).
   - The session record gains `{"client": "phone", "device_name": ...}`.
4. **90-day sliding phone sessions.** `phone_session_lifetime_seconds` (default 90 days);
   each authenticated request extends the TTL when less than half is left. Web cookie
   sessions unchanged.
5. **Sign out with a token.** `POST /api/auth/signout` deletes the bearer token's session
   (and, from phase 2, the phone's device row).
6. **Where messages came from.** Add `"phone"` to `source_channel` and record it for
   messages sent from the phone (derived from the session's `client`, not trusted from
   the frame).
7. **Sending is idempotent.** Each `run` from the phone carries a client-generated
   message id (reuse the existing `turn_id` if it already identifies a send; otherwise add
   `client_message_id`, unique per user). A resend of the same id returns the same `ack`
   instead of a second message, so retrying after a flaky connection never doubles a message.
8. **Written-at time.** `run` carries `written_at` (the phone's clock when you hit send).
   Stored as `chat_messages.written_at` (nullable). Message order is still the database's
   `conversation_sequence`, never this time. It's client-reported: never in the future
   (clamped to now), used only as information. When it's more than a couple of minutes
   before the message arrived, her view of the history says so (e.g. "written 9 h before
   it arrived") so she can see the delay. She decides what it means.
9. **Two ticks ("she picked it up").** When her chat worker claims the job for a user
   message, set `chat_messages.seen_at` and publish a `seen` frame
   `{type: "seen", message_id}` to that user's sockets. `ChatMessageOut` gains `seen_at`
   so ticks are right after a reload. (Means "she started on it", not "she replied": she
   may choose to stay silent.)
10. **Senses from the phone.** `SenseReport` gains `client` (`"web"` | `"phone"`). The phone
    reports `client: "phone"`; her awareness shows it as a fact only. **No code rule changes
    her behaviour on the phone.**
11. **Tests:** bearer on REST and WS; bearer passes the origin check; cookie without origin
    still fails; expired/revoked token → 401 / WS close 1008; sliding renewal;
    `/auth/token` rate limit; resend of the same id → one message; `written_at` clamped
    and shown; `seen_at` set on claim and the `seen` frame sent; `source_channel = phone`.

### Phone app

**Screens**
- **Login:** server address (prefilled: `http://10.0.2.2:8000` in the emulator; the
  Tailscale HTTPS address on the real phone later), email, password. Plain-words errors:
  wrong password / can't reach the server.
- **Chat:** the primary conversation (see "Chat design" below), composer, a stop button
  while she's replying, connection banner.

**Auth**
- The token lives in `expo-secure-store`, never in plain storage or logs.
- Every REST call and the WebSocket send `Authorization: Bearer` (RN's `WebSocket`
  accepts headers on Android).
- Any 401 or WS close 1008 → clear the token, go to Login.

**Chat over the WebSocket** (same protocol as the web app; reference client
`../app/frontend/src/hooks/useChatSocket.ts`; protocol documented at the top of
`../app/backend/app/api/routes/chat.py`)
- Text only: send `run`, `stop`, `sense`; handle `meta`, `history`, `ack`, `seen`,
  `token`, `sticker`, `done`, `stopped`, `error`, `nudge_start` / `nudge_token` /
  `nudge_sticker` / `nudge_end`, `state`. Ignore voice/audio frames, `thought` and the
  subagent frames.
- One conversation: the user's primary (omnichannel) conversation, shared with web and
  WhatsApp.

**Ticks and the waiting queue**

| Tick | Meaning | Set when |
|---|---|---|
| 🕓 | Waiting on the phone | Written, not yet saved by the backend |
| ✓ | Saved | `ack` for its id |
| ✓✓ | She picked it up | `seen` for it (or `seen_at` in history) |

- Every message you write goes into a **persistent queue on the phone** first (survives
  the app closing and the phone restarting), with its id and `written_at`.
- When connected, the queue sends **one at a time, in order**: the next goes after the
  previous one's `ack`. No `ack` within ~10 s → resend the same id (the backend dedupes).
- A queued message shows in the chat right away with 🕓.

**Connection life cycle**
- App to the foreground → connect (or reconnect); the `history` frame is the truth,
  merged with the local queue.
- App to the background → close the socket after ~30 s; push takes over (phase 2).
- Dropped connection → reconnect with backoff (1, 2, 5, 10, 30 s). Banner "Reconnecting…",
  then after ~15 s "Can't reach Jophiel. Is the Mac on and Tailscale connected?"
- An in-flight reply when the socket drops: history shows the saved (possibly partial)
  reply; resume with `resume_turn_id` if it's still running.

### Done when
- Login works; a wrong password and an unreachable server each show the right message.
- Send → ✓ → ✓✓ → reply streams in; the same messages appear on the web app with
  `source_channel = phone`.
- Stop the backend, write three messages (🕓), kill the app, start the backend, reopen:
  they go out in order, once each, and she sees they were written earlier.
- An unprompted message from her shows up live while the app is open.
- Background the app for 5 minutes, come back: the chat is current, no duplicates.
- Kill the app and reopen it: still logged in.

---

## Phase 2 — Push notifications

### Goal
What she says that you haven't seen anywhere reaches you as a notification.

### Decisions
- **FCM, sent directly from the backend** (FCM HTTP v1 with a Firebase service account).
  No Expo push service. Firebase is used only for messaging.
- **Always data-only messages.** The phone builds the notification itself, so it controls
  the wording, stacking and clearing. Phone side: `@react-native-firebase/messaging`
  (token + background handler) and `notifee` (display, grouping, cancel).
- **No notification settings in the app** (owner's decision, 2026-11-20): on/off, sound and
  lock-screen privacy are Android's own notification settings for Jophiel. So there is no
  "Show message text" switch: the push never carries message text; the notification says
  "Jophiel sent you a message" and the text is loaded from the backend when you open the
  app (nothing she says passes through Google). The phone still shows `text` if a push
  carries it, so this can change on the backend alone.
- **What gets a push:** every completed assistant message in the primary conversation,
  both her own messages and replies that finish after you left, **unless** at send time:
  - a web app of yours is **visible and used (mouse/keyboard) in the last 2 minutes**, or
  - the phone app is open on screen, or
  - she **actually spoke it aloud** on a live voice session (if voice was on but it
    went out as text, it's still pushed).
- **Stacking:** several unseen messages → one notification "Jophiel · 3 messages",
  expandable (Android notification group with a summary).
- **Clearing:** notifications you've seen elsewhere disappear by themselves.

### Backend changes
1. **Table `phone_devices`:** id, user_id, session hash (the device dies with its session),
   fcm_token (unique), device_name,
   created_at, last_seen_at. Alembic migration.
2. **Endpoints** (bearer-auth'd):
   - `PUT /api/phone/device`: register or refresh this session's device (token, name).
   - `DELETE /api/phone/device`: on logout (signout also removes it).
3. **Presence:**
   - `SenseReport` gains `visible` (bool) and `last_active_at`.
   - The **web app** reports `visible` on `visibilitychange` and `last_active_at` from
     mouse/keyboard input (throttled, e.g. at most every 30 s).
   - The **phone** reports `visible` on every app-state change.
   - The backend keeps per-socket presence in Redis with a short TTL. "Present" = any
     socket of the user that is `visible` and, for web, active within 2 minutes; for the
     phone, `visible` is enough.
4. **Spoken aloud:** where her message is delivered to a socket (`chat.py`, the
   `speak_aloud` decision), record that it was spoken (e.g. `chat_messages.spoken_at`)
   so the push worker can skip it.
5. **Push outbox:** same pattern as WhatsApp's `MessageDelivery` (transactional outbox,
   retries with backoff, a worker that sends). One helper `push.schedule_for_message(...)`,
   called where an assistant message is finally saved: the chat worker's completed turns
   and her unprompted delivery path (`autonomous_speech` / the `agent:say` publish).
   The worker waits ~3 s, then re-checks presence and spoken, then sends (or drops the
   row as not needed). A backend that was down sends late, not never.
6. **Clear push:** when the user becomes present (a visible web/phone socket appears),
   send a data-only `{type: "clear", conversation_id}` to their phones if any
   notifications went out since the last clear. The phone cancels its Jophiel
   notifications.
7. **Payload (data-only):** `{type: "message", conversation_id, message_id, text?}`,
   high priority. No `text` (see "No notification settings in the app").
8. **Dead tokens:** FCM `UNREGISTERED` → delete the device row.
9. **Tests:** pushed only when nobody is present; web visible but idle > 2 min → pushed;
   phone open → not pushed; spoken aloud → not pushed; presence appearing in the 3 s
   window → dropped; no text in the payload; clear sent on presence;
   dead token cleanup; one push per message.

### Phone app
- Ask for notification permission (Android 13+), explaining why first.
- After login, and whenever the FCM token changes, call `PUT /api/phone/device`.
- Background handler: `message` → add to the Jophiel group (summary "Jophiel · N
  messages"); `clear` → cancel all Jophiel notifications.
- Opening the app also clears its notifications.
- Tap a notification → open Chat scrolled to `message_id`.
- Report `visible` in `sense` on every app-state change.

### Done when (emulator)
- Send a message, put the app in the background before she finishes: her reply arrives
  as a notification within ~5 s. Same for one of her unprompted messages.
- The notification says "Jophiel sent you a message" with text off, her words with it on.
- Web app open, visible and in use on the Mac → no phone notification. Leave it idle for
  2+ minutes → the phone gets it.
- Three messages → one stacked notification. Open the web app → it clears from the phone.
- Tap → opens on that message. Log out → no more notifications.

---

## Phase 3 — Settings + Setup

### Goal
One place to see and change how the app behaves, and a first-run walkthrough of the
permissions, each explained in plain words.

### Settings (only what works in this milestone)
| Group | Setting | Stored |
|---|---|---|
| Connection | Server address, status (connected / reconnecting / unreachable), last connected | phone |
| Account | Signed in as …, Log out | — |
| Permissions | What's granted (notifications row opens Android's notification settings for Jophiel), "Open Setup again" | — |
| About | App version, backend version (from `/api/capabilities`) | — |

Later phases add their own groups (voice, location, chibi, phone control) when they ship.
**No switch is shown before the feature behind it works.** Quiet times are Samsung's Do Not
Disturb, not an app setting.

Phone-side settings live in a small typed store (MMKV or AsyncStorage) with a version number,
so later phases can add fields safely.

### Setup (first run, reopenable)
One screen per step: what it's for, a button, and "Skip".
1. **Connection check:** reaches the server? If not, explain (Mac on? Tailscale on?) and retry.
2. **Notifications:** system prompt.
3. **Battery (Samsung only):** opens the app's battery settings; explains "Unrestricted"
   and keeping Jophiel out of "Sleeping apps" / "Deep sleeping apps". Hidden on other
   phones and in the emulator; checked for real in the S21 pass.

Later phases add their steps (microphone, location, display over apps, accessibility,
default assistant). Each step shows "Done ✓" once granted, read from Android, not remembered.

### Done when
- Every setting does what it says (checked in the app and in the DB).
- Setup can be finished, skipped, and reopened; a denied permission shows how to fix it.

---

## Chat design

The implementing agent designs the screens with the **`impeccable` skill**. Fixed decisions:

- **Its own simple look**, not the web app's `DESIGN.md`: a warm, Claude-like palette
  (warm off-white / near-black backgrounds, a terracotta-orange accent).
- **Light and dark follow the phone's system setting.**
- **WhatsApp-style bubbles:** Jophiel's on the **left**, yours on the **right**.
- **Pictures:** hers is the ✦ glyph (same idea as the web app's `JophielMark`), yours is a
  plain **black circle**. Shown on the **first bubble of each run** (consecutive messages
  from the same sender), not on every bubble. Avatar design is out of scope.
- **Time on every bubble** (small, in the corner; next to the ticks on yours), and **date
  dividers** between days ("Today", "Yesterday", "12 Nov").
- **Basic formatting in her messages:** bold, italics, lists, links (open in the browser),
  inline code and code blocks.
- Stickers and images already in the conversation are shown; no upload.

---

## Phone app structure (suggested)

```
frontend-phone/
  app/                    # Expo Router screens
    (auth)/login.tsx
    (main)/chat.tsx
    (main)/settings.tsx
    setup/[step].tsx
    _layout.tsx           # auth gate, providers
  src/
    api/                  # client.ts (bearer fetch), auth.ts, chat.ts, phone.ts
    api/types.gen.ts      # generated from the backend's OpenAPI
    chat/                 # socket client, frame types, message store, send queue, ticks, reconnect
    push/                 # registration, background handler, grouping, clear, tap
    settings/             # typed store + defaults
    connection/           # reachability, banner state
    components/
    theme/                # palette, light/dark tokens
```

Types: `openapi-typescript` against the backend's `/openapi.json`, re-run when the backend
changes. WebSocket frame types are hand-written (OpenAPI doesn't cover them), based on the
web app's `useChatSocket.ts`, kept in one file.

## Testing

- **Backend:** real tests for every change above (listed per phase).
- **Phone:** unit tests (`bun test`) for the logic: chat message store and history merge,
  send queue (order, persistence, resend, dedupe), tick states, reconnect/backoff,
  notification grouping/clearing decisions.
- **Screens:** checked by hand in the emulator against each phase's "Done when".
- **No automated UI tests on a device.**

## Real-phone pass (S21) — later, before phase 4

Not part of this milestone. Done once before voice starts, since audio must be tested on
the real phone:

1. Tailscale on the Mac and the S21 (same tailnet, MagicDNS + HTTPS certificates on);
   `tailscale serve --bg 8000` → `https://<mac>.<tailnet>.ts.net` (WebSockets included;
   uvicorn stays on loopback).
2. Developer options → USB debugging; install the dev build over USB.
3. Release signing: generate the keystore, keep it and its passwords outside the repo,
   back it up. Losing it = can't update the installed app.
4. Build and install the release APK (HTTPS only).
5. Checklist:
   - [ ] Fresh install → Setup (incl. Samsung battery step) → Login → Chat
   - [ ] Tailscale off/on and Mac asleep → clear message; recovers by itself
   - [ ] Phone locked 30+ min → notifications still arrive
   - [ ] Reboot the phone → still logged in, notifications still arrive
   - [ ] Everything in phases 1–3 "Done when" again on the real phone

## Risks

| Risk | Mitigation |
|---|---|
| Samsung delays FCM for apps in "Sleeping apps" | High-priority data messages; Setup battery step; checked in the S21 pass |
| Emulator hides real-phone problems | The S21 pass before phase 4 |
| Backend on the Mac is down when a push should go out | The outbox sends once it's back (late but not lost) |
| Bearer change weakens web security | Cookie path untouched; origin check skipped only when a bearer header authenticates; tests for both |
| A queued message sent twice | Client message id + backend dedupe |
| Phone clock wrong → odd written-at times | Clamped to "not in the future"; used as information only, never for ordering |
| Web and phone drift on the WS protocol | One frame-type file on the phone; the backend's `chat.py` header lists both clients |
| Lost signing key | Back it up the day it's created (S21 pass) |
