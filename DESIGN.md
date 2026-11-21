# Jophiel phone: design system

Built from the shipped code (`src/theme/tokens.ts`, `src/components/`). The world is pinned by the
owner: warm paper and warm ink, one terracotta accent, a WhatsApp-familiar thread. Structure and
controls are Material 3 on Android; the brand shows through color roles, the ✦ mark, and two
signature details.

## Color

Material 3 role names; components never use raw hex. Light and dark follow the system setting.

| Role | Light | Dark | Used for |
|---|---|---|---|
| background | `#F3EEE6` | `#171512` | screen ground (warm paper / warm ink) |
| surface | `#F8F4EE` | `#1E1B17` | app bars |
| surfaceContainer | `#FFFCF8` | `#29251F` | her bubbles, text fields, composer pill |
| surfaceContainerHigh | `#EAE3D8` | `#342F28` | date pills, idle send button, tonal buttons |
| onSurface / onSurfaceVariant | `#221E19` / `#655D52` | `#EEE8DF` / `#B1A898` | text / secondary text |
| primary | `#A64B26` | `#E58C66` | terracotta: send button, links, section headers, her ✦, your ✓✓ |
| primaryContainer / onPrimaryContainer | `#F4D8C9` / `#3A1A0C` | `#5B2C19` / `#FBE5DA` | your bubbles; her mark's disc |
| onPrimaryContainerVariant | `#7A4A35` | `#E0B7A4` | time and 🕓 / ✓ on your bubbles |
| warnContainer / onWarnContainer | `#EFE0C4` / `#3D2E12` | `#3F3420` / `#F3E3C2` | "Can't reach Jophiel" banner, setup problems |

Brand surfaces outside the UI (launcher icon, splash, notification accent) use the original
terracotta `#B8572F`; it isn't used for text. Every text pair meets 4.5:1 and the ✓✓ icon 3:1 in both
themes (checked with a script over the token pairs).

## Type

System Roboto in Material 3 roles (`type` in tokens.ts): headlineSmall for screen titles on Login
and Setup, titleMedium for the app bar name, bodyLarge for messages, labelSmall for bubble times. All
sizes are sp and scale with the system font size. Monospace only for code in her messages.

## Shape and space

- Bubbles: radius 18; the first bubble of a run has a 6dp corner on the sender's side, where the
  picture sits (the tail). 2dp between bubbles of one run, 12dp between runs.
- Fields 12, buttons fully rounded (Material common buttons), touch targets ≥ 48dp.
- Spacing scale 4 / 8 / 12 / 16 / 24 / 32.
- Elevation is tonal (surface levels); only the snackbar casts a shadow.

## Components

- **Marks:** hers is the ✦ drawn as a vector (same path as the app icon) in primary on a
  primaryContainer disc; yours is a plain black circle (hairline outline in dark mode).
  Shown on the first bubble of each run.
- **Bubble:** hers left, yours right; Markdown in hers (bold, italics, lists, links, code); time
  in the corner, ticks after it on yours; "waited 9 h on the phone" when a queued message arrived
  late; "stopped" / "didn't finish" on her partial replies. A message the server won't take
  shows a red ⓘ and "Not sent · tap for options" (Try again / Delete). Long press copies.
- **Composer:** a pill field and a 48dp round button: send (filled terracotta when there's text),
  stop (tonal) while she replies and the field is empty.
- **Connection banner:** under the app bar; "Reconnecting…" (tonal) after 2 s, then after 15 s the
  warn banner "Can't reach Jophiel. Is the Mac on and Tailscale connected?" with "Try now".
- **Settings:** Material list with section headers in primary, switch rows, two-line rows.
- **Setup:** one step per screen: tonal icon tile, headline, plain explanation, "Done" read from
  Android, warn panel for problems, footer with Skip (text) and the step's action (filled).

## Signature details

1. Her ✦ **breathes** (slow scale/fade/turn) in the app bar and in the thread while she's thinking
   about your message. Static when the system's Remove animations is on.
2. Your **✓✓ turn terracotta** when she picks a message up; 🕓 and ✓ stay quiet.

## Motion

Material durations (150 / 250 / 400 ms). Fade for banners and the thinking row, a short terracotta
flash on a message opened from a notification. Respect Remove animations.
