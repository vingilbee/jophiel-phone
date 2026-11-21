import { describe, expect, test } from 'bun:test'
import { bannerText, connectionPhase, reconnectDelay } from '../connection/state'
import { dayLabel, delayLabel, toRows } from './format'
import { parseBlocks, parseInline } from './markdown'
import type { ChatItem } from './model'
import { ACK_TIMEOUT_MS, newTurnId, pickNextSend } from './queue'

describe('send queue', () => {
  const queue = [
    { turnId: 'a', content: '1', writtenAt: '' },
    { turnId: 'b', content: '2', writtenAt: '' },
  ]
  test('sends the head first, one at a time', () => {
    expect(pickNextSend(queue, null, 0)?.turnId).toBe('a')
    expect(pickNextSend(queue, { turnId: 'a', sentAt: 0 }, 1000)).toBeNull()
  })
  test('resends the same id after the ack timeout', () => {
    expect(pickNextSend(queue, { turnId: 'a', sentAt: 0 }, ACK_TIMEOUT_MS)?.turnId).toBe('a')
  })
  test('moves on once the head was acked', () => {
    expect(pickNextSend(queue.slice(1), { turnId: 'a', sentAt: 0 }, 10)?.turnId).toBe('b')
    expect(pickNextSend([], null, 0)).toBeNull()
  })
  test('turn ids are v4 uuids', () => {
    expect(newTurnId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('reconnect', () => {
  test('backoff 1, 2, 5, 10, 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([1000, 2000, 5000, 10000, 30000, 30000, 30000])
  })
  test('banner: hidden briefly, then reconnecting, then unreachable', () => {
    expect(connectionPhase(true, null, 0, true)).toBe('connected')
    expect(connectionPhase(false, 0, 1000, true)).toBe('connected')
    expect(connectionPhase(false, 0, 3000, true)).toBe('reconnecting')
    expect(connectionPhase(false, 0, 3000, false)).toBe('connecting')
    expect(connectionPhase(false, 0, 15_000, true)).toBe('unreachable')
    expect(bannerText('unreachable')).toContain('Tailscale')
  })
})

describe('format', () => {
  const now = new Date(2026, 10, 20, 12, 0)
  test('day labels', () => {
    expect(dayLabel(new Date(2026, 10, 20, 8).toISOString(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 10, 19, 23).toISOString(), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 10, 12).toISOString(), now)).toBe('12 Nov')
    expect(dayLabel(new Date(2025, 0, 3).toISOString(), now)).toBe('3 Jan 2025')
  })
  test('delay labels', () => {
    expect(delayLabel('2026-11-20T01:00:00Z', '2026-11-20T10:00:00Z')).toBe('9 h')
    expect(delayLabel('2026-11-20T09:35:00Z', '2026-11-20T10:00:00Z')).toBe('25 min')
  })
  test('runs and dividers', () => {
    const item = (role: 'user' | 'assistant', at: Date): ChatItem => ({
      key: Math.random().toString(), id: null, turnId: null, role, text: 'x', at: at.toISOString(),
      arrivedAt: null, tick: null, status: 'completed', streaming: false, unprompted: false, imageIds: [], assetIds: [],
    })
    const rows = toRows([
      item('assistant', new Date(2026, 10, 19, 9)),
      item('assistant', new Date(2026, 10, 20, 9)),
      item('assistant', new Date(2026, 10, 20, 9, 1)),
      item('user', new Date(2026, 10, 20, 9, 2)),
    ], now)
    expect(rows.map((r) => r.dayDivider)).toEqual(['Yesterday', 'Today', null, null])
    expect(rows.map((r) => r.firstOfRun)).toEqual([true, true, false, true])
    expect(rows.map((r) => r.lastOfRun)).toEqual([true, false, true, true])
  })
})

describe('markdown', () => {
  test('inline styles', () => {
    expect(parseInline('a **b** *c* `d` [e](https://x.y) f')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'italic', children: [{ kind: 'text', text: 'c' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'd' },
      { kind: 'text', text: ' ' },
      { kind: 'link', url: 'https://x.y', children: [{ kind: 'text', text: 'e' }] },
      { kind: 'text', text: ' f' },
    ])
  })
  test('bare urls, snake_case, and lone asterisks stay sane', () => {
    expect(parseInline('see https://example.com/a.')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', url: 'https://example.com/a', children: [{ kind: 'text', text: 'https://example.com/a' }] },
      { kind: 'text', text: '.' },
    ])
    expect(parseInline('my_var_name')).toEqual([{ kind: 'text', text: 'my_var_name' }])
    expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', text: '2 * 3 = 6' }])
  })
  test('blocks', () => {
    const blocks = parseBlocks('Hi\nthere\n\n- one\n- two\n\n1. a\n2. b\n\n```py\nprint(1)\n```\n# Title')
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'list', 'list', 'code', 'heading'])
    expect(blocks[3]).toEqual({ kind: 'code', text: 'print(1)', language: 'py' })
    const ordered = blocks[2]
    expect(ordered?.kind === 'list' && ordered.ordered && ordered.items.length).toBe(2)
  })
})

describe('push plan', () => {
  const { parsePushData, messageNotification, summaryFor, HIDDEN_TEXT, SUMMARY_ID } = require('../push/plan') as typeof import('../push/plan')
  test('parses data-only payloads', () => {
    expect(parsePushData({ type: 'message', message_id: 'm1', conversation_id: 'c1' })).toEqual({
      type: 'message', messageId: 'm1', conversationId: 'c1', text: null,
    })
    expect(parsePushData({ type: 'clear', conversation_id: 'c1' })).toEqual({ type: 'clear', conversationId: 'c1' })
    expect(parsePushData({ type: 'message' })).toBeNull()
    expect(parsePushData({ type: 'other' })).toBeNull()
  })
  test('text hidden unless the push carries it, trimmed', () => {
    expect(messageNotification({ type: 'message', messageId: 'm', conversationId: null, text: null }).body).toBe(HIDDEN_TEXT)
    const long = 'word '.repeat(100)
    const body = messageNotification({ type: 'message', messageId: 'm', conversationId: null, text: long }).body
    expect(body.length).toBeLessThanOrEqual(200)
    expect(body.endsWith('…')).toBe(true)
  })
  test('stacking: a summary from the second message on', () => {
    expect(summaryFor([], 'a')).toBeNull()
    expect(summaryFor(['a'], 'a')).toBeNull()
    expect(summaryFor(['a', SUMMARY_ID], 'b')).toEqual({ title: 'Jophiel · 2 messages', count: 2 })
    expect(summaryFor(['a', 'b', SUMMARY_ID], 'c')?.title).toBe('Jophiel · 3 messages')
  })
})

describe('rejected messages do not block the queue', () => {
  const { addStrike, MAX_STRIKES } = require('./queue') as typeof import('./queue')
  test('the queue moves past a failed message', () => {
    const queue = [
      { turnId: 'a', content: '1', writtenAt: '', failed: true },
      { turnId: 'b', content: '2', writtenAt: '' },
    ]
    expect(pickNextSend(queue, null, 0)?.turnId).toBe('b')
    expect(pickNextSend([queue[0]!], null, 0)).toBeNull()
  })
  test(`marked failed after ${MAX_STRIKES} strikes`, () => {
    const strikes = new Map<string, number>()
    const results = Array.from({ length: MAX_STRIKES }, () => addStrike(strikes, 'a'))
    expect(results).toEqual([...Array(MAX_STRIKES - 1).fill(false), true])
    expect(strikes.has('a')).toBe(false)
  })
})
