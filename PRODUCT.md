# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

## Stack

Expo (dev build, latest SDK) + TypeScript, Bun, Expo Router, NativeWind, TanStack Query,
expo-secure-store. Local builds only (`bunx expo run:android`). See `PLAN.md`.

## Users

One person: the owner of the Jophiel backend account. Uses the app on a Samsung Galaxy
S21 (Android 14 / One UI 6), mostly one-handed, throughout the day, often in short
glances between other things.

## Product Purpose

Jophiel (an AI companion that already lives in a web app and on WhatsApp) on the phone as
a real app: one continuous conversation shared across web, WhatsApp and phone; her
unprompted messages reach the owner as notifications when they haven't seen them
elsewhere. Success: it feels like texting a close friend, and it is always honest about
whether a message has gone out.

## Positioning

It is not a chatbot client. She speaks first sometimes, picks messages up on her own
time ("✓✓" means she started on it, not that she replied), and the same conversation
follows the owner across every surface.

## Operating Context

- Reaches a backend running on the owner's Mac (emulator: `http://10.0.2.2:8000`;
  real phone later: Tailscale HTTPS). The Mac may be asleep or offline; the app must say
  so plainly and recover by itself.
- Messages written offline wait in a queue on the phone and go out in order later.
- Light and dark follow the phone's system setting.

## Capabilities and Constraints

- Milestone (phases 0–3): login, chat (text, streaming replies, her unprompted
  messages), WhatsApp-style ticks (🕓 waiting / ✓ saved / ✓✓ she picked it up), push
  notifications, settings, first-run setup.
- Not yet: voice, location, chibi avatar, phone control, photo upload, several
  conversations. No setting is shown before the feature behind it works.
- Login only, no signup.

## Brand Commitments

- Her mark is the ✦ glyph; the owner's picture is a plain black circle. Avatar design is
  out of scope (chibi art made separately).
- Own simple look, not the web app's DESIGN.md: warm, Claude-like palette (warm
  off-white / near-black grounds, terracotta-orange accent). Pinned by the owner.
- WhatsApp-familiar chat: her bubbles left, the owner's right, time on every bubble,
  date dividers.

## Product Principles

1. Intimate, not instrumental: it should feel like a person's thread, not a tool.
2. Honest state: every message's delivery state and the connection state are visible and true.
3. Nothing pretend: only controls that work today.
4. Calm: quiet by default; her words carry the screen.
