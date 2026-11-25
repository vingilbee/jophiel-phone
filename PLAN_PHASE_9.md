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
| `swipe` | `screen`, `x1`, `y1`, `x2`, `y2`, `ms?` (100–2000) | `screen` |
| `press` | `key`: back / home / recents / notifications / quick_settings | `screen` |
| `end_control` | — | (nothing; hides the banner) |

- Every action except `end_control` answers with the **screen after it settles** (no window change
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
- **Your touch stops her.** Touching the screen anywhere (or the banner's Stop) ends her control at
  once: the banner goes, and every further action **for that turn** answers `refused`, `taken_over`.
  She's told you took over. Asking her again (a new turn) lets her start again.
- The banner hides on `end_control`, or 20 s after her last action. That also ends her control:
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
- `image`: JPEG, 720 px wide, quality 70 (~100–200 KB of base64). `image_missing`: `secure` (the app
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
