# Phase 8 — Phone actions + notifications as a sense

Goal: she knows what lands on your phone (every app's notifications, what's playing, the next turn on
a Maps trip) and can act on it: reply through a notification's reply button, control media and
volume, set alarms and timers, switch ringer / Do Not Disturb, dismiss a notification, open any app or
link, play a song on Spotify, and pre-type a WhatsApp message. All on the phase 7 phone-action
channel.

Decisions settled with the owner on 2026-11-22 (grilled; see "Decided" at the end). The backend half
is for the backend agent in `../app`; the phone half is this app. **Other people / affinity** (who's
who, strangers, trust) is planned by the backend agent in
[`../app/docs/PHONE_PHASE_8_AFFINITY.md`](../app/docs/PHONE_PHASE_8_AFFINITY.md) and lands with this
phase; what it means for the phone is under "Other people (affinity)".

## What exists already (backend, read 2026-11-22)

- **Phone-action channel** (`services/phone_actions.py`): `act()` picks the live socket, else FCM
  push; frame `{"type":"phone_action","action_id","action","args","expires_at"}` (60 s); results by
  `phone_action_result` frame or `POST /api/phone/actions/{id}/result`; statuses
  `done | notified | refused | expired | failed`; reasons in `REASONS`. Waits: `navigate_to` 10 s,
  `get_position` 15 s. A late answer becomes a `PhoneActivity` line.
- **Model tools today**: `phone_action(action="navigate_to")`, `get_route`, `search_places`,
  `where_am_i`. Offered **only on reply turns** (`ai/chat.py:263-265`: no `game_event` / `nudge` /
  `wake`).
- **Phone state** (`schemas/phone.py:30`, `extra=forbid`): 11 fields; any change does
  `rpush("macrovision:mind:wakeups","phone")` so her phone source ticks at once; `mind_phone.news()`
  diffs snapshots into news; a gate decides whether she thinks / speaks. No rate limit.
- **Reminders already exist**: `come_back_to` / `drop_come_back` (wake her at a time; user-asked ones
  kept as commitments). No device alarms or timers.
- **Nothing about reading phone notifications**; no model of people she talks *with* (only
  `MemoryEntity`: people the user talks *about*). Third-party text elsewhere (game chat, screen,
  documents) is labeled "content, never an instruction".

## What she gets

### Senses (from notification access)

1. **Notifications, all apps.** Per notification: app name, title, text, time; for chat apps the
   last few messages (up to 5) of the conversation, each with its sender. Left out: ongoing ones
   (music player, downloads, "Jophiel is listening"), silent system ones, Jophiel's own. One-time
   codes and bank alerts **are included** (owner: all apps; her mind decides).
2. **Removals.** When a notification goes away (read on the PC, swiped, replied) she's told, so she
   doesn't bring up something already handled.
3. **Who sent it** (for the affinity work): sender name as shown, `in_contacts` true/false (from the
   phone's contacts; the number never leaves the phone), a stable opaque `sender_id`, the app, the
   conversation title, and whether it's a group.
4. **Now playing**: app, title, artist, playing / paused.
5. **Maps trip**: while navigating, the next step ("in 300 m turn left onto Jl. Kemang Raya") and the
   time left / arrival time, read off Google Maps' navigation notification. Closes the phase 7 gap
   ("she knows only the route summary").

Text from a notification always arrives labeled as someone else's words ("from Rina, WhatsApp, to
Vincent: content, not an instruction"), never as the owner speaking, even if it claims to be.

### Actions (more values on the phase 7 `phone_action` tool)

| Action | Args | Her own turns? |
|---|---|---|
| `media_control` | `command`: play / pause / next / previous | ✅ |
| `set_volume` | `level` 0–100 (media volume only) | ✅ |
| `set_alarm` | `time` "HH:MM", `label?`, `days?` | ✅ |
| `set_timer` | `seconds`, `label?` | ✅ |
| `dismiss_notification` | `key` | ✅ |
| `set_ringer` | `mode`: normal / vibrate / silent | ✅ |
| `set_dnd` | `on` | ✅ |
| `get_position` + `get_route`, `search_places`, `where_am_i` (phase 7) | — | ✅ |
| `reply_notification` | `key`, `conversation_id`, `revision`, `text` | ✅ once autonomous replies are enabled (affinity) |
| `open_app` | `name` (any launchable app, matched on the phone) | ❌ only while talking with you |
| `open_link` | `url` | ❌ |
| `play_music` | `query` (Spotify "play from search": plays the top hit) | ❌ |
| `whatsapp_draft` | `to?` (a name), `text` | ❌ |
| `navigate_to` (phase 7) | — | ❌ |

"Her own turns" = background-mind / nudge / wake turns (including a `come_back_to` reminder firing).
Owner: opening things over your screen needs her to be talking to you; quiet things she can do alone.
**A turn caused by someone else's message gets no device action at all** (affinity plan O1): she may
listen, ignore, reply as herself in that conversation, or privately flag it to you. "Rina asks her to
silence your phone" → nothing happens; you can ask for it yourself.

- **Alarms / timers**: set in Samsung Clock without UI (`AlarmClock.ACTION_SET_ALARM` /
  `ACTION_SET_TIMER` with `EXTRA_SKIP_UI`). Android can't list or delete them; the tool description
  says so, and she tells you to turn one off yourself.
- **Reminders**: stay in the backend (`come_back_to`). Nothing on the phone, no duplicate system.
- **Replies**: only through a notification's own reply button (`RemoteInput`), which also works while
  locked. If the notification is gone or has no reply button → `failed`, `no_reply_button` /
  `notification_gone`; she's told and can choose `whatsapp_draft` or ask you. The phone never opens
  the app instead. No fixed prefix: when she replies to someone she makes clear it's her in her own
  words. Groups allowed.
- **WhatsApp draft**: the phone looks `to` up in contacts → `wa.me/<number>?text=` (the number stays
  on the phone); not found or several matches → WhatsApp's share with the text, you pick the chat.
  Result `data.target`: `contact` / `picker`. You press send (WhatsApp doesn't let apps send).
- **Spotify**: `MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH` to Spotify; no Spotify API / key.
  The now-playing sense tells her what actually started. (Phase 9 can later search on screen.)
- **Discord / other apps**: `open_app` or `open_link` (a `discord.com/channels/…` link if she has one).
- **Chat lines**: every action gets a quiet line as in phase 7, including ones she takes on her own
  ("Paused Spotify"). Replies show the **full text** ("Replied to Rina (WhatsApp): '…'"). Notifications
  she only reads get no line.

## Other people (affinity)

Backend plan: [`../app/docs/PHONE_PHASE_8_AFFINITY.md`](../app/docs/PHONE_PHASE_8_AFFINITY.md). She
keeps a record per person (familiarity, warmth, initiative, a short note), forms her own impression
from encounters, weighs what you tell her about people, and remembers what she said to whom, scoped
to the conversation it happened in. Only you are trusted: no one else gets your personal information
(where you are, when you'll arrive) unless you tell her to pass a specific detail to a named person.

How it settles the open questions:

- **O1 — what another person's message can cause**: listen, ignore, reply as herself in that
  conversation, or privately flag it to you. **No device actions**, enforced by the backend across
  queued work and later wakes.
- **O2 — replies on her own**: yes, once enabled, through a live reply button bound to that same
  conversation; she can also start a personal follow-up with someone she knows. If unsure, she asks
  you privately in the Jophiel app. She identifies herself when her words could be mistaken for yours.
- **O3 — before affinity works**: she may privately flag news to you; **independent replies to other
  people stay off until** sender / audience identification, audience-scoped recall and dispatch to
  that same audience all work (the backend's delivery checks 1–3). Replaces the labels-only fallback.

What the phone owes it:

- Per message: `sender`, `sender_id`, `identity` (how `sender_id` was made: `contact` | `name`),
  `in_contacts`, `event_id`; per notification: `conversation_id`, `is_group`, `revision`.
- **`conversation_id`** = HMAC (per-install secret) of package + the notification's conversation
  shortcut id when Android gives one (`Notification.getShortcutId`, set by WhatsApp / Telegram /
  Messages), else package + tag + conversation title (marked weaker the same way as `identity`).
  A group title or display name alone never identifies an audience.
- **`sender_id`** = HMAC of the contact's lookup key (`identity: contact`), else of name + app +
  `conversation_id` (`identity: name`: conversation-local, so two strangers called "Budi" in
  different chats never merge). A reinstall makes new ids → new records, by design.
- **`event_id`** = HMAC of `conversation_id` + sender + message time + text: the same message seen
  in two overlapping snapshots has one id, so it counts once.
- **`revision`**: a counter per key, bumped on every update of that notification.
- **Reply dispatch check (phone side too)**: the key still live, same package, same
  `conversation_id`, still has a reply button, `revision` not older than the action's (else `stale`),
  the **Messages** switch on (else `replies_paused`). Never falls back to another way of sending.
- **Pausing = turning the Messages switch off** (no separate switch). It's checked at dispatch, so it
  also stops a reply still being composed; off blocks every reply and draft, including ones you ask
  for. Resuming never sends an old draft. The phone mirrors the switch state to the backend so her
  mind knows replies are paused.
- **Replies on her own turns are switched on by the backend agent** (config) once its delivery checks
  1–3 pass, not by a phone switch. Replies you ask for work from the start.

Backend-only parts of that plan (not phone work): relationship tables, scoped recall, disclosure
rules, "how do you feel about Rina?", the reply-tone experiment.

## The contract (names can be adjusted by the backend agent; the phone follows its final ones)

### Notifications (new)

Socket frame while live, else `POST /api/phone/notifications` (same body), queued natively like the
phase 6 `Reporter` (WorkManager, network constraint, backoff):

```json
{
  "type": "phone_notifications",
  "posted": [{
    "key": "n_8f3a…",            // opaque, phone-made; used by reply / dismiss
    "revision": 3,               // bumped on every update of this key
    "app": "WhatsApp", "package": "com.whatsapp",
    "title": "Rina", "text": "are you coming tonight?",
    "conversation": "Rina", "conversation_id": "c_77d…", "conversation_identity": "shortcut",
    "is_group": false,
    "messages": [{"event_id": "e_a01…", "sender": "Rina", "sender_id": "p_1c…",
                  "identity": "contact", "in_contacts": true,
                  "text": "are you coming tonight?", "at": "2026-11-22T19:02:11+07:00"}],
    "can_reply": true,
    "posted_at": "2026-11-22T19:02:11+07:00"
  }],
  "removed": [{"key": "n_8f3a…", "reason": "cleared"}]
}
```

- The phone **coalesces per key over 5 s** (a busy group = one update with the latest messages);
  removals go at once. Sent whether the app is open or not (the listener runs while the app is
  closed).
- Backend keeps **only notifications still on the phone**: Redis, deleted on removal, TTL 24 h. **Not
  written to the database.** What she says or thinks about one can become a memory as usual.
- A post/removal wakes her phone source like a state change; the gate decides.
- The **Notifications** sense switch off → the phone stops sending and sends one "all removed".

### Phone state (two new fields on `PUT /api/phone/state` / `sense.phone`)

- `media`: `{app, title, artist, state: "playing"|"paused"}` or `null`.
- `navigation`: `{next_step, distance_text, eta_text}` or `null`; sent when the step text changes or
  the ETA moves by ≥ 1 min (not every distance tick).

### Actions

New `action` values and args as in the table; results reuse statuses. New reasons:
`no_notification_access`, `no_dnd_access`, `no_contacts_access`, `notification_gone`,
`no_reply_button`, `no_media_session`, `app_not_found`, `ambiguous`, `switched_off`, `stale`,
`replies_paused`.
`open_app` returns `data.opened` (the app's label); `whatsapp_draft` returns `data.target`.

### Backend list (backend agent)

1. The notifications frame + endpoint + Redis store + news for her mind (labeled third-party text).
2. `media` and `navigation` on the phone state; news for them.
3. The new `phone_action` values; tool descriptions (alarms can't be listed / removed; replies only
   while the notification has a reply button; drafts need you to press send).
4. Offer the ✅ actions on her own turns, but none on a turn caused by someone else's message (O1);
   `reply_notification` on her own turns only after the affinity delivery checks (O3).
5. **Phase 7 follow-up**: when an action went by push, wait longer (~20 s), and when a late answer
   comes, **replace** the "sent, no answer yet" line instead of adding one.
6. The affinity work (its own plan) consumes `sender_id` / `identity` / `in_contacts` /
   `conversation_id` / `event_id` / `is_group`, and the Messages switch state.

## Architecture (phone)

### 1. New Kotlin module `modules/jophiel-notifications`

- `JophielNotificationListener : NotificationListenerService` (manifest: `BIND_NOTIFICATION_LISTENER_SERVICE`).
  Filters (ongoing, `FLAG_FOREGROUND_SERVICE`, silent system categories, own package), extracts
  title / text / `MessagingStyle` messages, `can_reply` (an action with `RemoteInput`), coalesces per
  key 5 s, hands to JS when live else queues for the `POST` (same pattern as `jophiel-senses`'
  `Reporter`).
- Keeps the live `StatusBarNotification`s by key for `reply` (fill `RemoteInput`, send the
  PendingIntent) and `dismiss` (`cancelNotification`).
- **Contacts**: sender → `in_contacts` + `sender_id` via `PhoneLookup` / display-name match
  (`READ_CONTACTS`); per-install HMAC secret in the module's prefs.
- **Media**: `MediaSessionManager.getActiveSessions(listenerComponent)` → now playing + transport
  controls; reports `media` through `jophiel-senses`' reporter.
- **Maps trip**: parse Google Maps' navigation notification (`com.google.android.apps.maps`, ongoing,
  so it's read here and not sent as a notification) → `navigation`.

### 2. `modules/jophiel-actions` gains

`set_volume` (`AudioManager.STREAM_MUSIC`), `set_alarm` / `set_timer` (AlarmClock intents; manifest
`com.android.alarm.permission.SET_ALARM`), `set_ringer` / `set_dnd` (`NotificationManager` with
`isNotificationPolicyAccessGranted`), `open_app` (launcher apps query, name match; `<queries>` for
`MAIN/LAUNCHER`), `open_link`, `play_music` (play-from-search to `com.spotify.music`),
`whatsapp_draft`. Opening from the background uses the phase 7 overlay permission path.

### 3. JS side

- `src/actions/`: `dispatch` gains the new actions and per-group switch checks; frames for
  `phone_notifications`.
- `src/senses/`: Notifications group (switch + last value shown); `media` / `navigation` fields.
- Settings → Phone actions: master switch (phase 7) + **Media**, **Messages** (replies + drafts),
  **Alarms & timers**, **Opening apps**; all on by default. Mirrored natively (push-woken app).
- Developer screen: test buttons per action (try the phone half before the backend lands).

### 4. Setup: four new steps (skippable, plain-words why, in this order)

1. **Allow restricted settings** (App info → ⋮): Android 13+ blocks notification access for apps
   installed from an APK until this is on. Phase 9's accessibility step reuses it.
2. **Notification access**: notifications, replies, now playing, media control, Maps trip.
3. **Do Not Disturb access**: silent mode and DND on/off.
4. **Contacts**: who's a contact, WhatsApp drafts to a named person.

Opening apps / links, play from search, alarms and timers need no permission. Settings → Permissions
lists all four.

## Build order

| Step | What | Done when |
|---|---|---|
| 8.0 | **Backend (backend agent):** backend list 1–5 | Its own tests; a posted notification reaches her news; new actions round-trip |
| 8.1 | `jophiel-notifications`: listener, filters, coalescing, frame + `POST`; Notifications sense switch; Setup steps 1–2 | Emulator: a test notification → backend store; cleared → removed |
| 8.2 | Contacts: `in_contacts`, `sender_id`; Setup step 4 | A contact vs an unknown number flagged right |
| 8.3 | Media: now playing + `media_control` + `set_volume`; Maps trip parsing | Spotify playing → `media`; "pause" works; a Maps trip → `navigation` |
| 8.4 | `reply_notification`, `dismiss_notification` | Reply lands in WhatsApp (also locked); gone → `notification_gone` |
| 8.5 | Alarms / timers, ringer, DND (+ Setup step 3) | Alarm shows in Samsung Clock; silent / DND switch |
| 8.6 | `open_app`, `open_link`, `play_music`, `whatsapp_draft`; Settings switches | "open Gojek", Spotify plays a query, draft to a contact and via picker |
| 8.7 | **S21 pass (owner):** all of the above with the app closed / locked; busy group chat; Samsung's restricted settings | Results written to this file |
| 8.8 | Lint, typecheck, tests (`bun test` + `:jophiel-notifications:testDebugUnitTest`), PR | Merged to `main` |

Pure parts get unit tests: notification filtering and extraction (Kotlin, from built
`Notification`s), coalescing, `sender_id` stability, app-name matching, the WhatsApp target choice,
the Maps notification parser, per-action switch checks.

## Risks

1. **Samsung restricted settings**: if One UI hides the ⋮ menu until a first refused attempt, Setup
   must send you to try once, then to App info. Tested in 8.7.
2. **Maps' notification format** isn't an API; it changes with Maps updates. Parser fails soft
   (`navigation: null`).
3. **Spotify play-from-search** may only open search on some versions; she sees from now playing
   whether music started.
4. **Busy notifications** waking her mind often: 5 s coalescing + her gate; backend may add a rate
   cap if it shows in practice.
5. **Other people's words** in a model prompt: labeled third-party; no device actions from them (O1);
   disclosure rules per the affinity plan.
6. **Listener killed** by Samsung battery: the phase 5 Unrestricted step; Android rebinds the
   listener; `requestRebind` on app start.
7. **Weak conversation ids**: apps that don't set a conversation shortcut give only a title-based id
   (`conversation_identity: "title"`); the backend treats those as lower-confidence audiences.

## Decided (with the owner, 2026-11-22)

1. Notifications are a **sense**, from **all apps**.
2. Replying: her mind decides; owner gives her memories about what she can comfortably talk about.
3. Reminders stay in the backend (`come_back_to`); no phone reminders.
4. Her own turns may use: media, volume, alarms / timers, dismiss, ringer, DND, replies (per O2),
   position and the lookups. Opening apps / links, WhatsApp drafts and navigation only while talking
   with you.
5. A notification carries app, title, text, time, and the last messages for chats; ongoing / silent
   system / own left out; codes included.
6. Removals are reported.
7. No reply button / notification gone → fails with a reason; never opens the app instead.
8. Alarms and timers: set only; the tool says it can't list or remove them.
9. Now playing is a sense.
10. Spotify via play-from-search; no API key; phase 9 can use the screen later.
11. `open_app`: any installed app by name.
12. Maps trip (next step, time left) is a sense, now.
13. Master switch + one switch per group (Media, Messages, Alarms & timers, Opening apps,
    Notifications sense); all on.
14. Changes to one notification coalesced over 5 s; removals at once.
15. Sent whether the app is open or not.
16. Backend keeps only live notifications (Redis, ≤ 24 h), not in the database.
17. WhatsApp draft: contacts lookup on the phone, else the picker.
18. Add dismiss, ringer mode, DND (needs DND access).
19. A chat line for every action, own-turn ones too; replies with full text; none for reads.
20. Replies have no fixed prefix; she says it's her in her own words.
21. Other people's text is labeled as theirs, never the owner's voice.
22. Each message carries `in_contacts` (never the number).
23. She may read and reply in groups.
24. Media volume only (+ ringer mode).
25. Push-wait fix from phase 7 goes in the backend list.
26. Setup: restricted settings → notification access → DND access → contacts.
27. Other people / affinity: backend plan `../app/docs/PHONE_PHASE_8_AFFINITY.md`. Someone else's
    message never causes a device action; her own replies to others come once identity, scoped recall
    and same-audience dispatch work; the phone adds `conversation_id`, `identity`, `event_id`,
    `revision`; pausing her replies = the Messages switch off, checked at dispatch.
