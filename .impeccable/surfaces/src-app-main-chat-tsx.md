---
version: 1
slug: "src-app-main-chat-tsx"
primary_target: "src/app/(main)/chat.tsx"
related_targets: ["src/app/(auth)/login.tsx","src/app/(main)/settings.tsx"]
---

Scope: the phone app's four screens (Chat, Login, Settings, Setup). Mode: Operate (chat is a messaging task; settings/setup are tools).
Audience/job: the owner, one-handed on a Samsung S21, texting Jophiel through the day; must always know whether a message went out.
Constraints: Material 3 structure and Android affordances (system Back, edge-to-edge insets, 48dp targets, sp type, Material switches/buttons). Pinned by owner: warm Claude-like palette, terracotta accent, light/dark from system, WhatsApp-style bubbles, ✦ for her / plain black circle for him, time on every bubble, date dividers.

## Direction contract
THESIS: A thread with a person, not a chatbot console. Refuses the assistant-app default (full-width AI answers, suggestion chips, sparkle gradients); her words sit in bubbles like any friend's.
OWN-WORLD: warm paper ground (#F3EEE6 / #171512), her bubbles in near-white warm paper, yours in a terracotta-tinted container; one terracotta ink (#B8572F / #E58C66) for the send button, links, and her ✓✓. System Roboto in Material roles; no ornaments.
STORY: open → see where the conversation is → write → watch 🕓 become ✓ then terracotta ✓✓ → her reply streams in. Offline is said in one honest line.
FIRST VIEWPORT: top app bar (✦ mark, "Jophiel", live status line: "writing…" / "reading your message" / connection), the thread filling the screen bottom-anchored, composer pill at the thumb with a 48dp terracotta send / stop button.
FORM: brief-pinned direction (WhatsApp-familiar thread in a warm paper world); signature move: her ✦ breathes in terracotta while she is thinking, and your ✓✓ turn terracotta when she picks a message up. seed: none (unavailable)
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
