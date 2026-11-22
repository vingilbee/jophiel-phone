# Phase 6 — Phone senses

Goal: the phone tells Jophiel what's happening on it (you picked up the phone, plugged in, got home,
put AirPods on, started moving), so her background mind can notice and react. Phone side only: the
backend is already built (by the backend agent, in `../app`).

Decisions settled with the owner on 2026-11-21 (see "Decided" at the end). Maps, the Maps key and
the phone-action channel were split off into phase 7 (see "Moved to phase 7").

## The backend contract (already built, read in `../app` on 2026-11-21)

- Schema: `PhoneStateReport` in `../app/backend/app/schemas/phone.py`. Fields, all optional:

  | Field | Values |
  |---|---|
  | `screen` | `"on"` / `"off"` |
  | `locked` | bool |
  | `battery` | int 0–100 |
  | `charging` | bool |
  | `headphones` | bool (wired or Bluetooth) |
  | `network` | `"wifi"` / `"cellular"` / `"none"` |
  | `wifi_name` | string ≤ 64 |
  | `dnd` | bool |
  | `ringer` | `"normal"` / `"vibrate"` / `"silent"` |
  | `motion` | `"still"` / `"walking"` / `"running"` / `"cycling"` / `"vehicle"` |
  | `place` | string ≤ 60, a **name** ("home"), never coordinates |
  | `observed_at` | ISO time the phone saw it (server clamps; older than 24 h = now) |

  `extra="forbid"`: unknown fields are rejected. **Partial**: only fields sent change. An explicit
  `null` means "no longer known" (left every place, motion unknown, a group switched off).
- **App open (socket up):** the same object as `phone` inside the existing `sense` frame
  (`chat.py` ~1764 reads `message.phone.fields()` and `message.phone.observed_at`).
- **No socket:** `PUT /api/phone/state` with `Authorization: Bearer <token>`; body = the object;
  reply `{ changed: [...] }`.
- The server keeps **latest values only, no history** (`services/phone_state.py`). Her mind turns
  changes into news ("They unlocked their phone", "Plugged in (battery 18%)", "Arrived at home",
  "Left home", "Headphones connected", "Now in a vehicle") in `services/mind_phone.py`. Arriving and
  leaving are already "light" reasons she may speak up; whether she does is her mind's choice.

## When the phone reports (owner decisions)

| Phone state | What she gets | Path |
|---|---|---|
| App on screen | All 11 fields, instantly | `phone` in `sense` frames |
| Voice call on in the background (phase 5 service keeps the process alive) | All 11 fields, instantly | `phone` in `sense` frames (socket stays open during a call) |
| App in the background or closed, no call | Only **place**, **motion**, **headphones (Bluetooth connect/disconnect)** | Android / Play Services wake the app briefly → Kotlin sends `PUT /api/phone/state` |
| After swiping the app from recents | Same three wake-ups continue | Stopped only by Android's "Force stop", the switches, or logging out |

- **No always-on service** and no extra notification (owner: she only reports while the app is
  open or in the background). The three wake-ups above run inside Google Play Services / Android,
  not in a service of ours.
- Without a call in the background she does **not** learn screen / unlock / battery / charging /
  wired headphones / network / Do Not Disturb / ringer changes. They're sent (as a fresh snapshot)
  next time the app opens or a call starts.

## What Android allows (researched 2026-11-21, Android 14 / S21)

| Field | Read / notified by | Wakes a closed app? | Permission |
|---|---|---|---|
| screen | `PowerManager.isInteractive`; `ACTION_SCREEN_ON/OFF` (registered in code) | No | none |
| locked | `KeyguardManager.isKeyguardLocked`; `ACTION_USER_PRESENT`, `ACTION_SCREEN_OFF` | No | none |
| battery, charging | `ACTION_BATTERY_CHANGED` (sticky), `BatteryManager` | No | none |
| headphones | `AudioManager.getDevices` + `registerAudioDeviceCallback`; Bluetooth `ACTION_CONNECTION_STATE_CHANGED` / `ACTION_ACL_*` in the manifest | Bluetooth only (on the implicit-broadcast exceptions list) | `BLUETOOTH_CONNECT` (runtime) |
| network, wifi_name | `ConnectivityManager.registerDefaultNetworkCallback`; SSID from `NetworkCapabilities.transportInfo` with `FLAG_INCLUDE_LOCATION_INFO` | Not used (see table above) | `ACCESS_NETWORK_STATE`; SSID needs `ACCESS_FINE_LOCATION` + location on |
| dnd | `NotificationManager.getCurrentInterruptionFilter`; `ACTION_INTERRUPTION_FILTER_CHANGED` | No | none to read |
| ringer | `AudioManager.getRingerMode`; `RINGER_MODE_CHANGED_ACTION` | No | none |
| motion | Activity Recognition **Transition API** (Play Services), PendingIntent → receiver | Yes | `ACTIVITY_RECOGNITION` (runtime; also declare the old `com.google.android.gms.permission.ACTIVITY_RECOGNITION`) |
| place | **`GeofencingClient`** (Play Services), PendingIntent → receiver | Yes | `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` |

Notes:
- Android 14 queues in-code receivers while the app is *cached*; they only fire promptly while the
  app is visible or a foreground service runs. That's exactly the "app open / call on" rows above.
- **expo-location is not used for geofences**: its docs say a terminated Android app isn't restarted
  for geofencing events. Native `GeofencingClient` with a manifest receiver is woken.
- Geofences and activity transitions are **cleared on reboot** (and on app update, data cleared,
  `GEOFENCE_NOT_AVAILABLE`): re-register on `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`.
  Limit 100 geofences per app. PendingIntents must be `FLAG_MUTABLE` (Android 12+).
- Geofence enter/exit typically lands within ~2 min (up to ~6). Motion latency: tens of seconds to
  a few minutes (unconfirmed, measure on the S21).

## Architecture

### 1. New Kotlin module `modules/jophiel-senses`

Separate from `jophiel-audio` (different lifetime: parts of it run with no JS at all). Adds
`play-services-location` and `androidx.work` in its `build.gradle`; manifest entries in the
module's own `AndroidManifest.xml` (no hand edits to `android/`).

- **Live readers** (in-code receivers + callbacks for every field). Started by JS while the app is
  visible or a call is live (`startLive()` / `stopLive()`), emitting `onChange(fields)`. A
  `snapshot()` function returns all current values (sent on connect / when the app opens).
  Battery: emit only when the integer percent changes.
- **Wake-up receivers** (manifest): geofence transitions, activity transitions, Bluetooth headset
  connection state. Each computes the new value, then:
  - if JS is live (module flag set by `startLive`), emit `onChange` (goes out in a `sense` frame);
  - otherwise enqueue a **WorkManager** one-time job (network constraint, backoff) that sends
    `PUT /api/phone/state` with `observed_at` = when the event happened. Offline reports wait
    and go out late with their real time (the server accepts up to 24 h).
  - `headphones` on a Bluetooth event is recomputed from `AudioManager.getDevices` (wired or BT),
    not taken from the event alone.
- **Credentials for the background path:** JS hands the module `{ serverUrl, token }` after login
  and on every app start (`setReporting`); stored in the module's app-private storage
  (EncryptedSharedPreferences). Logout → `clearReporting()`. A `401` from the PUT clears it too
  and stops background reports until the next login.
- **"Only what changed":** the module keeps the last value sent per field (+ when), and drops
  reports that change nothing. Exposed as `lastReported()` for Settings (§4).
- **Places / geofences:** `setPlaces(places)` registers one geofence per place (ENTER + EXIT,
  radius from the place). Place list mirrored natively so `BOOT_COMPLETED` /
  `MY_PACKAGE_REPLACED` can re-register without JS. `place` value:
  - ENTER → that place's name.
  - EXIT → if still inside another place, that one; else `null` ("Left home").
  - Overlapping places: the smallest circle wins.
  - App open with only "while using" location (no background permission → no geofences): on app
    open, one current-location read checks the circles and sets `place`.
- **Motion:** Transition API for STILL / WALKING / RUNNING / ON_BICYCLE / IN_VEHICLE (ENTER only)
  → `still` / `walking` / `running` / `cycling` / `vehicle`.
- **Current location (one-off)** for "I'm here now": `FusedLocationProviderClient.getCurrentLocation`
  (high accuracy). Coordinates stay on the phone; never sent.

### 2. JS side

- `src/senses/` (new): groups, settings glue, the bridge to the module, diffing for `sense` frames.
- `connection.ts` `sense()` source gains `phone`: the **full snapshot on connect**, afterwards only
  changed fields with `observed_at`; the heartbeat re-sends nothing extra. Types in
  `src/chat/frames.ts` (`PhoneState`, mirroring `PhoneStateReport`; keep the field list in one place).
- Live readers on when the app is `active` **or** a voice call is live (hook into `VoiceProvider` /
  AppState); off otherwise.
- Settings changes and places are pushed to the module on app start and on every change.

### 3. Groups and switches (Settings → **Phone senses**)

Seven groups, **all on by default**. A group switched off sends `null` once for its fields, then
stops (and unregisters its native part: geofences for Places, transitions for Motion).

| Group | Fields | Needs |
|---|---|---|
| Phone use | screen, locked | – |
| Battery | battery, charging | – |
| Headphones | headphones | Nearby devices (for Bluetooth) |
| Network | network, wifi_name | Location (for the Wi-Fi name only; network type works without) |
| Sound mode | dnd, ringer | – |
| Motion | motion | Physical activity |
| Places | place | Location precise + "Allow all the time" (closed-app arrivals); "while using" = only when the app opens |

- A group whose permission is missing shows **"Needs permission"** with a button (same request /
  settings flow as Setup).
- Under each group: **the last value sent and when** ("Battery 64 %, charging · 2 min ago",
  "Place: home · since 18:02"), from `lastReported()`. So the owner sees exactly what she knows.
- Stored in `PhoneSettings` (`migrate` fills defaults; add `senses: Record<Group, boolean>` and
  `places: Place[]`; extend `migrate` for the object/array types, which today only keeps
  same-`typeof` primitives).

### 4. Places (Settings → Phone senses → Places)

- List of places; add / rename / change size / delete.
- Add = **"I'm here now"** (one-off precise location) + a **freely typed name** + circle size
  (default **150 m**, adjustable, e.g. 100–1000 m). Typing an address comes in phase 7 (needs the
  Maps key on the server).
- Names are sent as typed (≤ 60 chars); she reads them as written.
- Places live **on the phone only**. Saving places by voice ("remember this spot as the gym") is a
  later backend memory task, which would then send the place to the phone.

### 5. Setup: three new steps (each skippable, plain-words why)

1. **Location**: precise first, then a second screen explaining "Allow all the time" and opening
   Android's page for it (on Android 11+ it can't be granted from a prompt). Places and the Wi-Fi
   name use it.
2. **Physical activity**: motion.
3. **Nearby devices**: seeing that AirPods / Bluetooth headphones connected.

`usePermissions` / `permissions.ts` gain the three (keep the "blocked stays blocked" handling).
Settings → Permissions lists them.

### 6. Logout

Stop live readers, unregister geofences and activity transitions, `clearReporting()`.
**Keep the places list** (and the switches) on the phone; logging back in re-registers them.

## Build order

| Step | What | Done when |
|---|---|---|
| 6.1 | Module skeleton; live readers for all 11 fields; `snapshot()`; `phone` in `sense` frames (snapshot on connect, then diffs) | Emulator: toggling battery/charging/network/screen in the emulator controls shows up in the server's phone state (`redis` `phone_state:<user>` or her "Now") |
| 6.2 | Settings → Phone senses: 7 groups, switches, last-sent values; `null` on switch-off | Switching a group off clears it on the server |
| 6.3 | Setup steps + permission handling for location, activity, nearby devices | Each step grants / skips / shows "blocked" correctly |
| 6.4 | Places screen; geofences; boot / update re-registration; WorkManager PUT path with credentials; logout | Emulator: app closed, a GPS route (emulator extended controls) into a place → "Arrived at home" reaches the server |
| 6.5 | Motion (Transition API) and Bluetooth headphones wake-ups | Works on the S21 with the app closed |
| 6.6 | **S21 pass (owner):** arrive / leave home with the app swiped away; reboot then arrive; AirPods in/out with the app closed; walking / in a vehicle; a call in the background (unlock, plug in show up); battery drain over a day | Results written to this file |
| 6.7 | Lint, typecheck, tests, PR | Merged to `main` |

Pure parts get unit tests (`bun test`): diffing / "only what changed", group → fields, place
resolution (enter / exit / overlapping), `migrate` of the new settings.

## Risks

1. **Samsung blocking wake-ups** for a swiped / "sleeping" app. Mitigation: battery Unrestricted
   (Setup step already exists); the S21 pass tests a swiped app.
2. **"Force stop"** blocks all wake-ups until the app is opened again (Android rule, nothing to do).
3. **Geofence accuracy indoors / small circles**: 150 m default; the owner can enlarge a place.
4. **Motion latency / false "vehicle"**: measured in 6.6; her mind already treats it as a soft fact.

## Moved to phase 7 (Maps + phone-action channel), open questions

Phase 7 = `search_places`, `get_route`, `navigate_to`, the Google Maps key, the general phone-action
tool, adding a place by typing an address. Already discussed with the owner (2026-11-21), to confirm
when phase 7 is planned:

- **Key:** yes, get a Google Maps Platform key (free monthly usage covers one person; billing
  account required). Per-SKU free caps since March 2025: opening hours (Places Enterprise) 1,000/mo,
  traffic routes (Routes Pro) 5,000/mo, two-wheeler routes (Enterprise) 1,000/mo.
- **Conflict to settle:** the backend never accepts coordinates, but `get_route` needs a starting
  point. Options to put to the owner and the backend agent: the action channel asks the phone for a
  one-off position used for that one request and never stored; or the route always starts from a
  named place.
- Q4 default travel mode: motorbike (two-wheeler; Google supports it in Indonesia/India, not Europe).
  Owner hasn't confirmed.
- Q7 no confirmation before starting navigation (proposed).
- Q9 opening Maps with the phone in the pocket: Android blocks background apps from opening other
  apps; "display over other apps" (needed for the floating chibi anyway) lifts that; otherwise a
  "tap to start navigation" notification (proposed: both).
- Maps intents: `google.navigation:q=<lat,lng>&mode=d|b|l|w` (`l` = two-wheeler); search
  `geo:0,0?q=...`.

## Decided (with the owner, 2026-11-21)

1. Phase 6 is phone senses only; Maps + actions are phase 7; later phases move up by one.
2. No always-on service: reports only while the app is open or a call keeps it alive in the
   background.
3. With the app closed, only place, motion and Bluetooth headphones still reach her (wake-ups by
   Android / Play Services); they continue after a swipe from recents.
4. Location reaches her as place names only (arrived / left); no position between places.
5. Seven switch groups, all on by default; missing permission shows "Needs permission".
6. Three new Setup steps: location (incl. "Allow all the time"), physical activity, nearby devices.
7. Places added in Settings by "I'm here now", free-typed name, 150 m adjustable circle.
   Address search waits for phase 7; voice saving is a later backend memory task.
8. Settings shows the last value sent per group.
9. Logout stops everything and removes the circles but keeps the places list.

## Implementation notes (2026-11-21, branch `phase-6-phone-senses`)

Steps 6.1–6.5 and the code half of 6.7 are written; the device checks of 6.1–6.6 are still the
owner's (see "Not yet verified").

- **Native module** `modules/jophiel-senses` (Kotlin, `expo.modules.jophielsenses`):
  `Readers` (each field now), `LiveReaders` (in-code receivers + audio-device and network
  callbacks, started by JS), `Background` (geofences + activity transitions, registered only when
  the group is on, the permission is there and credentials are stored), `Receivers` (geofence,
  motion, Bluetooth, boot / app-update restore), `Reporter` + `ReportWorker` (WorkManager PUT),
  `Store` (prefs; credentials AES-GCM with an Android-keystore key), `PlaceLogic` (pure).
- **Deviations from the text above, on purpose:**
  - Credentials are sealed with a keystore key directly, not `EncryptedSharedPreferences`
    (androidx.security-crypto is deprecated). Same protection.
  - Place resolution lives in Kotlin (it has to run with no JS), so its unit tests are JUnit:
    `cd android && ./gradlew :jophiel-senses:testDebugUnitTest`. Everything else pure is `bun test`
    (`src/senses/senses.test.ts`).
  - Network: VPNs are ignored (Tailscale is the default network on the S21 and hides Wi-Fi vs
    mobile); Wi-Fi wins when both are up. The type is read from all networks after callbacks settle
    (500 ms), so mobile data isn't reported for a moment at startup.
  - `locked`: Samsung locks some seconds after the screen goes off, so while live and screen-off the
    keyguard is re-read every 5 s until it locks (at most 31 min).
  - On app open (at most every 10 min, and right after places change) one precise fix re-checks the
    place, with or without "Allow all the time": it also catches a departure missed while the
    phone was off or location was switched off (geofences are dropped then, and "location back
    on" is not a broadcast a closed app receives; the next app open re-registers them).
  - On connect the full snapshot includes `null` for switched-off groups (harmless server-side:
    null → null is no change), so a switch-off made while offline still reaches her.
  - A background report older than 23 h is dropped instead of sent (the server would treat it as
    "now"). Retries: exponential from 30 s, up to 12 tries; 401 clears credentials, geofences and
    transitions until the next sign-in; other 4xx are dropped.
  - Headphones = wired, USB, A2DP, SCO, BLE headset, hearing aid. A Bluetooth car stereo or speaker
    also counts (Android can't tell them apart without more permissions).
- **Review fixes (PR #5):** a switch-off clear is stamped when the switch changes (it used to
  carry the last sighting's time, older than a reconnect's re-confirmation, so the server kept the
  value), and nothing later on a socket is stamped older than its whole-state frame; a queued
  background report drops fields whose group was switched off while it waited (nulls still go);
  place and motion are forgotten in JS too on switch-off, and a snapshot without them means
  "unknown", so switching back on waits for a fresh reading instead of resending the old one.
- **JS:** `src/senses/` (groups, `report.ts` value checks + diffing, controller, native bridge,
  `useSensesBridge` in the signed-in layout); `phone` in `sense` frames via `ConnectionSource.phone`
  (`connection.ts` sends the whole state as each socket's first frame, then only changes). Screens:
  Settings → Phone senses (`/senses`), Places (`/places`); Setup steps `location`,
  `location-always`, `activity`, `nearby`; Settings → Permissions rows.
- **Checked here:** typecheck, lint, `bun test` (135 pass), Kotlin unit tests (9 pass), a full
  `assembleDebug` with the merged manifest checked, and the payloads (full PUT body, a `sense`
  diff, the worker's body) validated against the backend's own `PhoneStateReport` /
  `SenseUpdateRequest`.

### Not yet verified (needs a device)

Everything in the "Done when" column of 6.1–6.6: values reaching `phone_state:<user>`, switch-off
clearing, Setup grant / skip / blocked on Android 14, emulator GPS route into a place with the app
closed, reboot re-registration, motion and AirPods with the app closed on the S21, battery drain.
