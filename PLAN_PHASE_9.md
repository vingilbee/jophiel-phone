# Phase 9 — Phone control

Goal: she uses the phone's screen the way you do. She sees what's on it, then taps, types, scrolls,
swipes and presses back / home, one step at a time, until the job is done. This covers anything the
phase 7–8 shortcuts can't do (pick the third song on an album in Spotify, open a WhatsApp chat that has
no notification and send a message, turn on the hotspot, read a long page).

It runs on the **real screen, in front of you**. Android has no hidden screen for this: you see apps
open and buttons pressed, like someone else's finger moving. Built on Android's accessibility service.

Decisions settled with the owner on 2026-11-23 (see "Decided" at the end). The backend half is for
the backend agent in `../app`; the phone half is this app.

## What she gets

### How she sees the screen (every step)

1. **A picture with numbers**: a screenshot where every item she can act on has a numbered box drawn
   on it (1 = the search box, 2 = the heart icon…).
2. **The same screen as text**: the numbered items (role, label or text, hint, state such as
   checked / selected / disabled / focused) plus the plain text on screen in reading order, the app
   in front and whether the keyboard is up.

### How she acts

- **By number (normal)**: "tap 2" makes the phone press that exact item through Android's
  accessibility service (`ACTION_CLICK` on the item itself), not a touch on a guessed point. It hits
  even if the layout moved a little.
- **By point (fallback)**: for things with no number (a spot on a map, a game, an unlabeled custom
  view) she taps a pixel of the screenshot; the phone maps it to the real screen and does a real
  touch. This can miss sometimes.

The actions are the same whether she reads the text or looks at the picture. The picture only helps
her understand the screen (icons without labels, layout, images).

### Actions (new `phone_action` values, phase 7 channel)

| Action | Args | Answers `done` with |
|---|---|---|
| `read_screen` | `wait_ms?` (0–5000: let something load first) | `screen` |
| `tap` | `screen`, `n` | `screen` (after it) |
| `long_press` | `screen`, `n` | `screen` |
| `type_text` | `screen`, `n`, `text`, `enter?` (press the keyboard's go / send / search key after) | `screen` |
| `scroll` | `screen`, `direction` up / down / left / right, `n?` (the list to scroll; default the biggest one) | `screen` |
| `tap_point` | `screen`, `x`, `y` (pixels of that screenshot) | `screen` |
| `tap_points` | `screen`, `points` ([x, y] each, 1–20), `gap_ms` (0–1000, default 150): tapped in order, settle and read once after the last | `screen` |
| `swipe` | `screen`, `x1`, `y1`, `x2`, `y2`, `ms?` (100–2000) | `screen` |
| `press` | `key`: back / home / recents / notifications / quick_settings | `screen` |
| `end_control` | — | (nothing; hides the banner) |
| `control_hold` | — | (nothing; shows the banner and restarts its 20 s: her hands are thinking between actions) |

- Every action except `end_control` and `control_hold` answers with the **screen after it settles** (no window change
  for 300 ms, at most 2 s), so she never needs a separate `read_screen` between steps.
- `screen` is the id of the screen she's looking at (`s1`, `s2`…). Numbers belong to that screen.
  Only the phone's latest screen is valid: an older id → `failed`, `stale_screen`. An item that has
  since disappeared → `failed`, `element_gone`. After any failure she calls `read_screen`.
- `type_text` replaces what's in the field (`ACTION_SET_TEXT`). Password fields work the same (she
  can't know your passwords; Android hides their text from her when reading).
- She can combine with phase 8: `open_app` first, then `read_screen`.

### When she can use it

- **Only while you're talking with her** (reply turns), like opening apps in phase 8: typed or
  spoken, in the app or in a background voice call. Never on her own turns, never because of
  someone else's message (phase 8's O1).
- **Phone unlocked and screen on.** Locked → `refused`, `locked`; screen off → `refused`,
  `screen_off`. She asks you to unlock. The Smart Lock path from phase 7 is **not** used here: with
  nobody looking at the screen, the banner and your touch can't stop her.
- **Not inside her own app.** When the Jophiel app is in front she can read it, but every action
  except `press` back / home answers `refused`, `own_app`. The master, Phone control and privacy
  switches are the owner's limits on her; she doesn't flip them herself.
- **Your new words end the old turn.** When you speak or send a message while she's working, that's
  a new turn: the old turn's remaining actions answer `refused`, `taken_over` (the backend cancels
  them; the phone also refuses any action whose `turn` is older than the newest one it has seen).
  She starts the new turn from a fresh `read_screen`.
- **At most 80 actions per turn** (like her desktop control). At the limit she stops and tells you
  how far she got.
- **Which apps**: any app. No allowed / blocked list (owner): the master switch and the new
  **Phone control** switch are the only limits. Whether to ask you before Send / Pay / Delete / Call
  is her judgment, not a code rule.

### Seeing that she's working, and stopping her

- While she's in control a small banner shows at the top: **"Jophiel is using your phone · Stop"**.
  It's drawn by the accessibility service itself (no extra permission) and hidden for the moment a
  screenshot is taken, so she never sees it.
- **Stop stops her** (2026-11-25: only the banner's Stop; touches elsewhere no longer count, since telling
  yours from her own injected gestures misfired). Stop ends her control at
  once: the banner goes, and every further action **for that turn** answers `refused`, `taken_over`.
  She's told you took over. Asking her again (a new turn) lets her start again.
- The banner hides on `end_control`, or 20 s after her last action or `control_hold` (2026-11-25: her hands send
  one every 8 s while a job runs, so the banner stays up for the whole job; a hold for a turn you stopped answers
  `taken_over`, so she learns of your Stop between actions too). That also ends her control:
  the next action shows the banner again.

## Privacy

What's on screen (picture and text) goes to the backend and the AI model. The phone keeps nothing
after the next screen replaces it. The backend **never** stores screens in the database.

**Short-term screen memory (backend):** so she can answer "what was that song you saw?" in a later
turn, the backend keeps her **last 10 screens as text only** (app, items, text; no pictures) **in
process memory**, each for **30 minutes**. A backend restart loses them (fine). They are wiped at
once when the master switch or the Phone control switch goes off (the phone's state report already
carries both). Pictures live only inside the turn that took them (the newest 3 in context).
Remembered screens are for recall only: their numbers can't be acted on (`stale_screen`); to act
she calls `read_screen`. What she *says* about a screen can become a memory as usual.

## The contract (names can be adjusted by the backend agent; the phone follows its final ones)

Frame and results as in phase 7. `args` always carry **`turn`** (the backend's id of the reply turn),
so a takeover lasts for exactly that turn. Without `turn`, a takeover blocks for 30 s.

`data.screen` (only with `done`):

```json
{
  "id": "s7",
  "app": "Spotify", "package": "com.spotify.music",
  "keyboard": false,
  "image": {"jpeg_base64": "…", "width": 720, "height": 1600},
  "image_missing": null,
  "items": [
    {"n": 1, "role": "text_field", "text": "", "hint": "What do you want to listen to?", "focused": true,
     "box": [24, 180, 672, 96]},
    {"n": 2, "role": "button", "label": "Play", "box": [600, 900, 96, 96]},
    {"role": "text", "text": "Recent searches"}
  ]
}
```

- `items` in reading order (top to bottom, left to right). Numbered ones (`n`) can be acted on; ones
  without `n` are text to read. `box` = `[x, y, w, h]` in screenshot pixels. Roles: `button`,
  `text_field`, `checkbox`, `switch`, `radio`, `tab`, `image`, `list`, `link`, `text`, `item`.
- `image`: JPEG, short edge 720 px, quality 70. With little or nothing numbered (a game), a light coordinate grid
  is drawn on her copy (a line every 100 px, labelled on every edge) and `image.grid` says its step (2026-11-25).
  ~100–200 KB of base64. `image_missing`: `secure` (the app
  forbids screenshots, e.g. banking or incognito tabs: text only), `not_supported` (below Android 11),
  `failed`; `image` is then null.
- At most 250 items and 12,000 characters of text; beyond that `truncated: true`.

New reasons: `no_accessibility` (service off), `locked`, `screen_off`, `taken_over`, `stale_screen`,
`element_gone`, `not_actionable` (e.g. `type_text` on something that isn't a field), `off_screen`
(a point outside the screenshot), `switched_off` (Phone control switch), `gesture_failed`, `own_app`
(acting inside the Jophiel app; back / home still work).

### Backend list (backend agent)

1. The new `phone_action` values with args, reasons and tool descriptions (numbers belong to the
   latest screen; tap by number, by point only for things without one; the screen after each action
   comes back with it; `taken_over` means you took the phone, stop).
2. **Show her the screenshots** as images (like the desktop `screenshot_hook`: the newest few in
   context, older ones as their text only) plus the `items` text.
3. Offer the tools **only on reply turns** (talking with you); never on her own turns or turns from
   others' messages.
4. Accept large results: `data.screen` up to ~1 MB on the socket frame and on
   `POST /api/phone/actions/{id}/result`.
5. Wait ~10 s for these actions (settle up to 2 s + screenshot).
6. A step limit of 80 actions per turn; at the limit she's told to stop and say how far she got.
7. Pass `turn` in `args`; send `end_control` when the turn ends with control still on (or let the
   phone's 20 s timeout do it). Spoken turns (voice mode, also from the background call) are reply
   turns too.
8. Don't store screens in the database. Chat lines: one per turn ("Used your phone in Spotify, 9
   steps") rather than one per tap.
9. **Short-term screen memory**: last 10 screens, text only, process memory, 30 min each; wiped when
   the master or Phone control switch goes off; shown to her as "screens you saw recently" (recall
   only, not actionable).
10. **A new turn ends the old one's control**: when the owner speaks or sends a message mid-run,
    cancel the old turn's pending phone actions; she continues in the new turn from `read_screen`.
11. Tool description: inside the Jophiel app she can read but not act (`own_app`); press back / home
    to leave it.

## Architecture (phone)

### 1. New Kotlin module `modules/jophiel-control`

- `JophielControlService : AccessibilityService` (manifest: `BIND_ACCESSIBILITY_SERVICE`, config XML
  with `canRetrieveWindowContent`, `canPerformGestures`, `canTakeScreenshot`,
  `flagRetrieveInteractiveWindows`, `flagReportViewIds`, `flagIncludeNotImportantViews`; events
  window-state and content changes only, for settling). A plain-words description for Android's
  accessibility page.
- `ScreenReader`: walks the interactive windows (app, system dialogs, notification shade; not the
  keyboard, not our banner) into items; numbers the actionable ones; keeps the latest screen's
  `AccessibilityNodeInfo`s by number.
- `Screenshot`: `takeScreenshot` (Android 11+), hide banner → capture → show; scale to 720 px wide,
  draw the numbered boxes, JPEG. Android allows roughly 3 screenshots a second
  (`ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT`): the settle wait usually covers it; on that error,
  wait the rest of the interval and retry once, then `image_missing: failed`. A secure window
  (`FLAG_SECURE`, e.g. banking) → `image_missing: secure`, text only (where Android doesn't report
  it, a capture that is entirely black counts as secure).
- Own app: if the front window's package is ours, every action except `press` back / home →
  `refused`, `own_app` (`read_screen` still works).
- `Actor`: by number with node actions (`ACTION_CLICK`, `ACTION_LONG_CLICK`, `ACTION_SET_TEXT`,
  `ACTION_IME_ENTER`, `ACTION_SCROLL_*`; a node that won't click → a gesture tap at its centre); by
  point and swipe with `dispatchGesture`; keys with `performGlobalAction`. Then waits for the screen
  to settle.
- `Banner`: a `TYPE_ACCESSIBILITY_OVERLAY` pill with Stop, plus `FLAG_WATCH_OUTSIDE_TOUCH` to catch
  your touches. Her own gestures are ignored (touches during her gesture + 300 ms). Takeover state
  per `turn`; an action whose `turn` is older than the newest seen → `taken_over`.
- Pure parts (`ControlLogic.kt`): item roles and labels, reading order, numbering, point mapping,
  args, the takeover and newer-turn rules, the own-app rule, the all-black-capture check. JUnit `:jophiel-control:testDebugUnitTest`.

### 2. JS side

- `src/actions/`: new actions in `protocol.ts` (args) and `run.ts`; group **control** in `groups.ts`
  (Settings → Her actions → **Phone control**, on by default).
- Setup: new step **Accessibility** after phase 8's "Allow restricted settings" (it reuses that). Settings →
  Permissions row. Developer screen: read the screen, show the numbered picture, tap a number.

## Build order

| Step | What | Done when |
|---|---|---|
| 9.0 | **Backend (backend agent):** backend list 1–8 | Its own tests; a fake phone round-trips a screen |
| 9.1 | Service + Setup step + `read_screen` (text) | Emulator: the developer screen lists the items of Settings |
| 9.2 | Screenshot + numbered boxes; `image_missing` | The developer screen shows the numbered picture |
| 9.3 | `tap`, `long_press`, `type_text`, `scroll`, `press`, `tap_point`, `swipe`; settling | Developer screen: search something in Settings by number |
| 9.4 | Banner, Stop, your touch → `taken_over`; newer turn → `taken_over`; own app → `own_app` | Touching during a run refuses the next action |
| 9.5 | JS dispatch, Phone control switch, Permissions row | Actions from the channel work; switch off → `switched_off` |
| 9.6 | **S21 pass (owner):** Spotify album pick, WhatsApp new chat, hotspot, a Flutter / game app, a secure screen | Results written to this file |
| 9.7 | Lint, typecheck, tests (`bun test` + `:jophiel-control:testDebugUnitTest`), PR | Merged to `main` |

## Risks

1. **Bank / e-wallet apps** may refuse to open while an accessibility service from outside the Play
   Store is on. Owner's call: switch her off in Android's accessibility settings before using them.
2. **Samsung turns accessibility services off** after a crash or when the app is reinstalled. Setup
   and Settings → Permissions show the state; she gets `no_accessibility` and tells you.
3. **Apps with poor accessibility** (games, some Flutter / custom views) give few or no numbers: she
   falls back to point taps from the picture.
4. **Your-touch detection** is a heuristic (outside-touch events from an overlay); a touch right as she
   acts might be missed or her own gesture mistaken for yours. Tested in 9.6.
5. **Secure screens** (banking, password entry, some video apps) come out black: text only.
6. **Cost and speed**: a screenshot every step is slower and costlier than text; each step waits for
   her to think, so a task takes seconds to a minute.

## Decided (with the owner, 2026-11-23)

1. She sees **both** every step: a screenshot with numbered boxes and the same screen as text.
2. She acts **by number** (the phone presses that exact item); point taps only for things without a
   number.
3. **No app list.** Any app; the master switch (+ the Phone control switch) is the limit. Banking:
   the owner switches the service off when needed.
4. **Her judgment** on Send / Pay / Delete / Call; no forced confirmation in code.
5. **Banner while she works; your touch stops her** (for that turn).
6. It happens **on the real screen**, in front of you, never hidden.

Settled with the owner on 2026-11-24 (second grilling):

7. **Reply turns only**, typed or spoken (in the app or a background voice call). Never her own
   turns, never someone else's message.
8. **Unlocked phone only**; no Smart Lock path (nobody watching = banner and touch can't stop her).
9. **Her own app: read only** (`own_app`), back / home still work. Her switches stay the owner's.
10. **Your new words end the old turn's control**; she restarts from the latest screen.
11. **Screens never in the database.** Short-term screen memory: last 10, text only, backend process
    memory, 30 minutes, wiped by the master or Phone control switch. Pictures only within their
    turn. Remembered screens are recall only.
12. **Banner and control end** on `end_control` or 20 s after her last action.
13. **80 actions per turn**, like desktop; at the limit she says how far she got.

## Implementation notes (phone half, 2026-11-24)

Built on branch `phase-9-phone-control`: steps 9.1–9.5 on the phone side, against this plan's contract
(the backend, 9.0, isn't built yet). The full debug APK builds, but nothing has run on an emulator
or the S21 yet. 9.6 is still open.

- **Module** `modules/jophiel-control`: `JophielControlService` (accessibility service + config XML
  and the plain-words description in the module's `res/`), `ScreenReader`, `Screenshot`, `Actor`,
  `Banner`, `Controller` (one action at a time on its own thread), and the pure `ControlLogic.kt`
  (args, roles, labels, reading order, numbering, point mapping, `TurnGate`, own-app rule, black
  check, screen JSON). Tests: `cd android && ./gradlew :jophiel-control:testDebugUnitTest`.
- **Checks, in order** (native): args (`bad_args`), `end_control`, switches (`switched_off`), service
  bound (`no_accessibility`), turn (`taken_over`), `screen_off`, `locked`, `own_app`, `stale_screen`.
  JS checks expiry, the master switch and the Phone control group first, as for phase 8's groups.
- **Reasons beyond the plan's list**: `unknown_action`, `bad_args` and `error` as in phase 7;
  `not_supported` for `type_text` with `enter` below Android 11 (no IME-enter action there).
- **Labels**: a numbered row with no text of its own is named by the texts inside it, joined with
  " · " ("Connections · Wi-Fi · Bluetooth"); those texts aren't repeated as plain items. Nodes whose
  centre a window above covers (dialog, shade, keyboard) are left out.
- **Takeover during an action**: if your touch comes while an action runs, that action answers
  `refused`, `taken_over` (no screen), even though the action itself already happened.
- **Banner**: while her own gesture runs, the banner lets touches through (so a point tap where it
  sits reaches the app, not Stop), and touches until 300 ms after aren't taken for yours. After the
  20 s idle timeout the latest screen stays valid; `end_control`, your touch or a switch going off
  drops it.
- **Switches**: `setAllowed` mirrors master + Phone control natively (useSensesBridge), so switching
  off ends control at once. Settings stored before phase 9 get Phone control on.
- **Setup**: new step "Accessibility" after "Notification access"; "Allow restricted settings" now
  stays until both notification access and accessibility are on. Settings → Permissions has an
  Accessibility row.
- **Developer screen → Phone control**: read / scroll / back / home / end, tap / long-press / type by
  number, tap the middle, and a takeover test (3 reads 4 s apart in one turn: touch the screen in
  between, and the later reads answer `taken_over`). "Wait 5 s first" gives time to switch to
  the app you're testing in.

### Backend follow-ups (for the backend agent)

1. The plan says the phone's state report "already carries" the master and Phone control
   switches. It doesn't: only `messages_on` is there. To wipe short-term screen memory when either
   goes off, the backend needs a new field (e.g. `control_on`). The phone will send it once the
   backend accepts it; sending it now would get sense frames rejected (extra=forbid).
   **Done:** the backend accepts it and the phone now sends it (no sense switch holds it back).
2. Expect `data.screen` up to ~1 MB on the socket and on `POST /api/phone/actions/{id}/result`
   (backend list item 4).

## Backend 9.0 (done, `../app` branch `feature/phone-phase-9-backend`, 2026-11-24)

The contract above is the final one, with these specifics for the phone:

- **New state field `control_on`** (`PUT /api/phone/state` and the socket's state frame): the master switch AND
  Phone control together, sent like `messages_on` (on change, and with the first report). `false` wipes her
  short-term screen memory at once and shows her "Phone control is switched off". Not sent yet = unknown (nothing
  wiped).
- `args.turn` is the backend's turn UUID as a string; a new turn id is the newest (no ordering beyond "not seen
  before"). The backend also refuses an older turn's actions itself (`taken_over`) and stops waiting on them.
- `data.screen`: as specified; item fields beyond the listed ones are ignored, `password: true` is read as "text
  hidden". `image.jpeg_base64` up to ~1.4 M chars. `end_control` answers `done` without data; every other control
  action's `done` must carry `data.screen` (else the result is rejected with 422).
- Waits: `read_screen` 15 s, the others 10 s (20 s once the action went by push).
- Reasons are shown to her as written in this file; `unknown_action` / `bad_args` from an older build are said as
  "their phone app is too old" / "didn't accept those arguments".
- One chat line per turn (`phone_activity`): "Used your phone in Spotify, 9 steps", "Looked at your phone's screen
  in Settings", with "(you took over)" / "(stopped at the step limit)".

## Follow-up (2026-11-24, after the first real test)

- **`gesture`**: several fingers at once, `fingers: [[x1, y1, x2, y2], …]` (1 to 5, screenshot pixels) moving
  together for `ms` (100 to 2000), like `swipe` otherwise. The backend's `phone_pinch` and `phone_gesture` send it
  (Hay Day's zoom needed a pinch).
- **`taken_over_after`**: your touch came while her action ran, so the action did happen. She's told it happened
  and stops. (Before, it answered `taken_over` and she said "Not done", which was wrong: in the test a Send she
  tapped went out while she said it hadn't.) `read_screen` still answers `taken_over`.
- **Takeover log**: each takeover logs what ended it (`stop` or a `touch` outside the banner), how long after her
  last action started, and which action was running: `adb logcat -s JophielControl`. In the test, three turns ended
  as taken over with no touch the user knew of, right after a tap by number or a back press.
