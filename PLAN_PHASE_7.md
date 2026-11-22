# Phase 7 — Maps + the phone-action channel

Goal: she answers travel questions hands-free ("how long to the office?", "is the pharmacy still
open?", "where am I?") and starts Google Maps navigation for you, also with the phone in your
pocket. On the way it builds the **phone-action channel**: she sends an action down to the phone,
the phone does it and reports back. Phase 8 adds more actions to the same channel.

Decisions settled with the owner on 2026-11-21 (grilled; see "Decided" at the end). The backend
half is for the backend agent in `../app`; the phone half is this app. Nothing for phase 7 exists in
the backend yet (checked 2026-11-21: no Maps code, no config keys).

## What exists already (backend, read 2026-11-21)

- **Phone vs web is known per socket**: a bearer-token session is a phone session
  (`record["client"] == "phone"`, `api/routes/chat.py` ~459–479). Frames go to the user's sockets
  over a per-user Redis pub/sub (`services/agent_say.py`); the only per-socket filter today is
  `voice_socket_id`. A "phone sockets only" filter is a small addition.
- **Several phones per user**: `PhoneDevice` rows (`db/models.py` ~481), one per bearer session,
  with `fcm_token` and `last_seen_at`.
- **Push**: `fcm.send(token, data)` sends any data-only, high-priority message (`services/fcm.py`
  ~100). Payload types today: `message`, `clear`.
- **Request/reply precedent**: her desktop tools (`services/desktop_control.py` `act()`): publish the
  command, block on a Redis list for the answer with a timeout, return `"unconfirmed"` ("it may or
  may not have happened") when nothing comes back, never replay. Phase 7 copies this.
- **Tools per turn** are assembled in `_orchestrator_for` (`ai/chat.py` ~162–229); desktop tools only
  on reply turns (not nudges / background turns). Phase 7 does the same.
- **Text before a tool call is sent and spoken right away** (`ai/chat.py` ~289–313,
  `workers/chat.py` ~413–416), so "on it, give me a sec…" already works with **no prompt change**.
  Quirk left as is: speech starts at a 12-character clause, so a bare "On it." is spoken only after
  the tool returns (it shows in the chat immediately).
- **Tool results aren't replayed into her history, but the first 300 chars go into her learning
  records** (`ai/chat.py` ~292–296 → `services/mind_turn.py` ~711). So **no coordinates may ever
  appear in a tool result** (decision 6).

## Her abilities (backend agent)

| Tool | What she gets | Google API (cheapest tier that has the fields) |
|---|---|---|
| `phone_action` (general) | Sends an action to the phone, waits for its answer. Phase 7 actions: `navigate_to` | — |
| `get_route` | Time and distance **with live traffic** from where you are (or from a saved place / an address) to a destination | Routes (traffic-aware = Pro; two-wheeler = Enterprise) |
| `search_places` | Places matching a query, near you when relevant, with **open now + opening hours** | Places Text Search (hours = Enterprise) |
| "where am I" (tool name backend's choice) | A street / area name for where you are, only when you ask | Geocoding (reverse) |

- **`navigate_to`**: the backend resolves the destination first (a `search_places` result or a saved
  place) and sends the phone **coordinates + name**; plain text (`query`) only as a fallback. Calling it
  again replaces the current trip. She cannot stop a trip, add a stop or see its progress (Maps only lets
  other apps start one; phase 9 can read the screen).
- **Travel mode**: her mind picks it from what you say and your motion sense; **car** when she has
  nothing to go on. Two-wheeler only where Google supports it; otherwise she's told and drives.
- **No confirmation rule, no prompt changes.** Whether she checks before navigating is her mind's
  choice (owner: "let her mind decide").
- **Reply turns only**: the phone tools are offered while she answers you, never on her own
  background-mind / nudge turns (phase 8 may revisit for gentle actions like pausing music).
- **Which phone**: the most recently active one (`PhoneDevice.last_seen_at`, or a live phone socket).
  With one phone this never comes up.

### Your position (decisions 4–7)

- When `get_route`, `search_places` ("nearby") or "where am I" needs it, the backend sends the phone a
  **`get_position`** action over the same channel. The phone answers with one position.
- Used **for that one lookup only**: never stored, never logged, never in a tool result (her results
  say "25 min by car, 8 km", "Kimia Farma, 400 m", "Jl. Kemang Raya, South Jakarta").
- Phone side: last known position if under **2 min** old, else a fresh high-accuracy fix, up to **10 s**.
- Refused when the phase 6 **Places** group is switched off ("location is off"), when location
  permission is missing, or when location is off on the phone. With the app closed it needs
  "Allow all the time" (already a phase 6 Setup step). She can then ask you, or start from a saved place.
- The chat shows **"Used your location once"** each time.

## The channel (contract; names can be adjusted by the backend agent, the phone follows its final ones)

**Down, socket up** (frame, sent only to the chosen phone's socket):

```json
{ "type": "phone_action", "action_id": "<uuid>", "action": "navigate_to",
  "args": { "name": "Kemang Village", "lat": -6.26, "lng": 106.81, "query": null, "mode": "drive" },
  "expires_at": "<ISO, sent + 60 s>" }
```

`get_position` has `args: {}`. `mode`: `drive` / `two_wheeler` / `walk` / `transit` / `bicycle`.

**Down, no phone socket**: FCM data push
`{ type: "phone_action", action_id, action, args: "<JSON string>", expires_at }` (FCM data values are strings).

**Up** (frame when the socket is up, else `POST /api/phone/actions/{action_id}/result`, bearer token):

```json
{ "type": "phone_action_result", "action_id": "<uuid>",
  "status": "done | notified | refused | expired | failed",
  "reason": "switched_off | location_off | no_permission | locked | maps_missing | ...",
  "data": { "lat": 0, "lng": 0, "accuracy_m": 0, "fix_at": "<ISO>" } }
```

- `done`: Maps opened (or position returned in `data`, `get_position` only).
- `notified`: Android wouldn't let her open Maps; the "Tap to start navigation" notification is shown
  (`reason` says why, e.g. `locked`).
- `refused`: the owner's switch (`switched_off`) or a missing permission / location off.
- `expired`: the action arrived after `expires_at` and was dropped (a late push).
- First answer wins; repeats for the same `action_id` are ignored (idempotent).

**Waiting**: the tool waits ~**10 s** (`navigate_to`) / ~**15 s** (`get_position`, a fresh fix can take
10 s) like desktop `act()`. No answer → "sent, no answer yet: it may or may not have happened". A
**late result reaches her mind as news** ("Maps opened on their phone" / "couldn't open Maps: locked").
Not replayed after `expires_at`.

**Chat lines** (decisions 10, 17): each action and each position use leaves a quiet line in the
conversation: "Opened Maps → Kemang Village", "Couldn't open Maps (phone locked), sent a
notification", "Used your location once". The backend stores them in the conversation so they're in
history (storage and frame shape backend's choice; proposed frame
`{ type: "phone_activity", conversation_id, message_id, text, created_at }` and history entries the phone
renders as a quiet line, not a bubble). The web app shows or ignores them.

**Place search for Settings** (decision 21): `GET /api/phone/places/search?q=...` → `[{ name, address,
lat, lng }]`, basic fields only (no hours, cheaper tier). Destination coordinates are fine to return;
the rule is about where *you* are.

## Opening Maps on the phone (decision 4 + Q1)

Android 10+ blocks an app that isn't on screen from opening another app. The phone picks the first
row that applies:

| Situation | What happens | How |
|---|---|---|
| Her app on screen | Opens Maps | Plain intent |
| Unlocked, another app on screen | Opens Maps | Allowed by "Display over other apps" (Android 14). From Android 15 that only counts while one of her overlay windows is visible (the floating chibi, phase 11), else the next rows |
| Screen off / lock screen, **no PIN needed** (Smart Lock with the owner's earphones) | Wakes the screen, dismisses the swipe lock, opens Maps | Full-screen-intent notification → a tiny activity (`showWhenLocked`, `turnScreenOn`) → `KeyguardManager.requestDismissKeyguard` → on success open Maps and finish |
| Screen off, **PIN needed** (`KeyguardManager.isDeviceLocked()` true) | "Tap to start navigation" notification; result `notified`, `locked`; she tells you to unlock | No screen wake (pointless) |
| Anything refused / fails | Same notification | Fallback for every path |

- **Maps intent**: `google.navigation:q=<lat>,<lng>&mode=d|l|w|b` (`l` = two-wheeler); transit and
  text fallback via `https://www.google.com/maps/dir/?api=1&destination=...&travelmode=...`
  (+ `destination_place_id` when the backend has it). Package `com.google.android.apps.maps`; missing →
  `failed`, `maps_missing`. Google Maps only (decision 8).
- **Fallback notification**: its tap opens Maps navigating directly (PendingIntent for the Maps
  intent, not her chat). Removed when Maps opens or after **10 min**. Own channel "Actions" (high
  importance, no text from her chat in it).
- **Smart Lock check (device)**: whether One UI lets `requestDismissKeyguard` pass a trusted
  (Smart Lock) keyguard without a real swipe. If not, that row falls back to the notification.
- Full-screen intents survive Android 15 (they're exempt from the background-launch block), so the
  screen-off path doesn't depend on the chibi.

## Architecture (phone)

### 1. New Kotlin module `modules/jophiel-actions`

Separate from `jophiel-senses` (no JS-less work besides the push path, different lifetime).

- `openMaps(args)`: picks the row of the table above, returns the status / reason.
- `WakeActivity`: transparent, `showWhenLocked` + `turnScreenOn`, excluded from recents; dismisses the
  keyguard, opens Maps, finishes. Started only through a full-screen-intent notification.
- Fallback notification (native, so its tap can carry the Maps PendingIntent); auto-cancel after 10 min.
- Permission checks for Setup / Settings: `Settings.canDrawOverlays`,
  `NotificationManager.canUseFullScreenIntent` (Android 14+; granted below 14), with the matching
  settings screens (`ACTION_MANAGE_OVERLAY_PERMISSION`, `ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT`).
- Manifest (module's own): `SYSTEM_ALERT_WINDOW`, `USE_FULL_SCREEN_INTENT`, the activity, and a
  `<queries>` entry for the Maps package (Android 11 package visibility).
- **Position**: reuse the one-off fix that `jophiel-senses` already has for "I'm here now", extended
  with "last known if < 2 min" and a 10 s timeout. Coordinates leave the phone only in a
  `get_position` result.

### 2. JS side (`src/actions/`)

- `dispatch(action)`: one entry for both paths (frame or push). Checks, in order: expired → `expired`;
  the master switch → `refused`, `switched_off`; per action (`get_position`: Places group, permission,
  location on). Then runs it and sends the result.
- Results: socket frame when connected, else the `POST` (retry a few times with backoff while not
  expired; no WorkManager needed, answers are only useful briefly).
- `frames.ts`: `phone_action`, `phone_action_result`, `phone_activity` (and the history entry).
  Chat renders activity lines quietly (`impeccable` for the look; it's the first non-bubble row).
- Push: `parsePushData` gains `phone_action`; the background handler (already registered at bundle
  load, `src/push/background.ts`) calls `dispatch`. Starting activities from there goes through the
  native module (headless JS can't open Maps itself).
- Settings: **"Let Jophiel act on this phone"** (on by default) in `PhoneSettings`; mirrored to the
  native side so a push-woken app reads it without waiting for the full JS settings load.
- Developer screen: a "Test navigate_to" button that runs `dispatch` locally (lets the phone half be
  tried before the backend is done).

### 3. Setup: two new steps (skippable, plain-words why)

1. **Display over other apps**: "so she can open Maps (and later other apps) while you're in another
   app; the floating chibi uses it too".
2. **Full-screen notifications** (Android 14+ only): "so she can wake the screen to start navigation
   when the phone is in your pocket".

Settings → Permissions lists both.

### 4. Places: add by address (Settings → Phone senses → Places)

A text field and a **Search** button (no as-you-type suggestions) → the backend's place search → a list
of results → pick one → the usual name (prefilled, editable) and circle size. Then the same as
"I'm here now".

## Google Cloud setup (owner, written out in the PR)

1. A project with billing, enable Routes API, Places API (New), Geocoding API; one API key restricted to
   those APIs (server key, kept in the backend's env, never on the phone).
2. **Daily quota caps** just under the free monthly amounts (roughly a thirtieth of each): e.g. Places
   with hours (~1,000 / month free) ~30 / day; Routes with traffic (~5,000 / month) ~160 / day;
   two-wheeler routes (~1,000 / month) ~30 / day; reverse geocoding (~10,000 / month) ~300 / day.
   Check the free amounts on the pricing page when setting them; they change.
3. A **budget alert** (e.g. US$1). At a cap Google refuses; she says "Maps is unavailable right now".

## Build order

| Step | What | Done when |
|---|---|---|
| 7.0 | **Backend (backend agent):** the channel (frame, push, result endpoint, wait, late-result news, chat lines), `phone_action` with `navigate_to`, `get_position`, `get_route`, `search_places`, "where am I", place search endpoint; Maps key in config | Its own tests; a `phone_action` reaches a phone socket and a result unblocks the tool |
| 7.1 | Frames + `dispatch` + results over the socket; master switch; chat activity lines; `get_position` | Emulator: "how long to X?" → the phone answers a position, she gives a time, "Used your location once" shows |
| 7.2 | `jophiel-actions`: Maps intent, the table's first two rows, fallback notification | Emulator: app open → Maps navigating; another app on screen without the permission → notification, tap → Maps |
| 7.3 | Wake + keyguard path; Setup steps; Settings → Permissions rows | Emulator, screen off, no PIN: Maps opens; with a PIN: notification, no wake |
| 7.4 | Push-delivered actions (app closed / swiped) + `POST` results; expiry | Emulator: app swiped away → navigate reaches Maps or the notification; a push older than 60 s → `expired` |
| 7.5 | Places: add by address | A searched place saves and its circle works like a "here now" one |
| 7.6 | **S21 pass (owner):** Smart Lock with the earphones + screen off; PIN locked; another app on screen; app swiped away; position with the app closed; a late push | Results written to this file |
| 7.7 | Lint, typecheck, tests, PR | Merged to `main` |

Pure parts get unit tests (`bun test`): `parsePushData` for actions, expiry, the dispatch checks
(switch / Places group / permission), the "which row of the table" decision (as a pure function of
screen / keyguard / permissions / Android version, mirrored or tested in Kotlin), the Maps intent URLs
per mode.

## Risks

1. **One UI and the trusted keyguard**: if Samsung needs a real swipe even under Smart Lock, the
   pocket case falls back to the notification. Tested in 7.6.
2. **Late or dropped pushes** with the app swiped / "sleeping": the 60 s expiry keeps Maps from
   opening out of nowhere; the battery Unrestricted step (phase 5) helps delivery.
3. **Android 15 update**: "Display over other apps" alone stops opening apps; the full-screen path and
   the notification still work, the floating chibi (phase 11) restores the rest.
4. **Two-wheeler mode not offered** for a route: she's told and falls back to driving.
5. **Coordinates leaking** into logs or tool results: backend review point; a test asserts no
   `lat` / `lng` in tool outputs and that `get_position` results aren't persisted.

## Decided (with the owner, 2026-11-21)

1. Route start point: the phone sends its position once, for that lookup, never stored.
2. Travel mode: her mind decides; car when there's nothing to go on.
3. Confirming before navigating: no rule, no prompt change; her mind decides. She can say "on it"
   first (already works).
4. Opening Maps: the table above, incl. the screen-off Smart Lock path in phase 7; notification
   fallback for everything else; two new Setup steps.
5. Her tool waits ~10 s for the phone; a late answer becomes news for her mind.
6. She never sees coordinates, only results.
7. Position: last known < 2 min, else a fresh fix ≤ 10 s; also used for "nearby" searches; "where am
   I?" answered with a street / area name, only when asked.
8. Google Maps only. The backend resolves the destination and sends coordinates + name.
9. Actions older than 60 s are dropped (`expired`). Results go over the socket, else the API.
10. A quiet chat line for every action and every position use.
11. One master switch "Let Jophiel act on this phone", on by default; per-action switches can come in
    phase 8. The phase 6 Places (location) switch also blocks the one-off position.
12. The fallback notification opens Maps directly; gone when Maps opens or after 10 min.
13. Several phones: the most recently active one gets the action (from the database).
14. Phone tools only on reply turns, not her background mind.
15. Google: live traffic for routes, opening hours in searches, daily caps under the free amounts +
    a budget alert.
16. Places: add by address with a Search button (no as-you-type).
17. Once Maps navigates, phase 7 is done with it: no arrival tracking (phase 6 senses cover saved
    places); she can start a new trip but not stop or change one.
