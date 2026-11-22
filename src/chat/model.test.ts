import { describe, expect, test } from 'bun:test'
import type { ServerFrame, StoredMessage } from './frames'
import { chatReducer, initialChatState, isReplying, isThinking, visibleItems, type ChatState } from './model'

const NOW = '2026-11-20T10:00:00.000Z'

function run(state: ChatState, ...frames: ServerFrame[]): ChatState {
  return frames.reduce((s, frame) => chatReducer(s, { type: 'frame', frame, now: NOW }), state)
}

function stored(partial: Partial<StoredMessage> & Pick<StoredMessage, 'id' | 'role' | 'content'>): StoredMessage {
  return {
    turn_id: null,
    status: 'completed',
    source_channel: 'web',
    created_at: '2026-11-20T09:00:00.000Z',
    ...partial,
  }
}

function enqueue(state: ChatState, turnId: string, content = 'hi', writtenAt = NOW): ChatState {
  return chatReducer(state, { type: 'enqueue', message: { turnId, content, writtenAt } })
}

describe('ticks', () => {
  test('waiting → saved on ack → seen on seen', () => {
    let s = enqueue(initialChatState, 't1')
    expect(visibleItems(s).map((i) => i.tick)).toEqual(['waiting'])
    s = run(s, { type: 'ack', turn_id: 't1', user_message_id: 'm1', conversation_id: 'c1' })
    expect(s.queue).toHaveLength(0)
    expect(visibleItems(s).map((i) => [i.id, i.tick])).toEqual([['m1', 'saved']])
    s = run(s, { type: 'seen', message_id: 'm1' })
    expect(visibleItems(s)[0]?.tick).toBe('seen')
  })

  test('history sets ticks from seen_at, and a seen that raced the snapshot survives it', () => {
    let s = run(initialChatState, { type: 'seen', message_id: 'm2' })
    s = run(s, {
      type: 'history',
      conversation_id: 'c1',
      messages: [
        stored({ id: 'm1', role: 'user', content: 'a', seen_at: NOW }),
        stored({ id: 'm2', role: 'user', content: 'b' }),
        stored({ id: 'm3', role: 'user', content: 'c' }),
      ],
    })
    expect(s.messages.map((m) => m.tick)).toEqual(['seen', 'seen', 'saved'])
  })

  test('a duplicate ack (resend) adds nothing', () => {
    let s = enqueue(initialChatState, 't1')
    const ack: ServerFrame = { type: 'ack', turn_id: 't1', user_message_id: 'm1', conversation_id: 'c1' }
    s = run(s, ack, ack)
    expect(s.messages).toHaveLength(1)
  })
})

describe('queue and history merge', () => {
  test('history drops queued messages it already holds (the ack was lost)', () => {
    let s = enqueue(enqueue(initialChatState, 't1', 'one'), 't2', 'two')
    s = run(s, {
      type: 'history',
      conversation_id: 'c1',
      messages: [stored({ id: 'm1', role: 'user', content: 'one', turn_id: 't1' })],
    })
    expect(s.queue.map((q) => q.turnId)).toEqual(['t2'])
    expect(visibleItems(s).map((i) => i.text)).toEqual(['one', 'two'])
  })

  test('restored queue keeps order and skips saved turns', () => {
    let s = run(initialChatState, {
      type: 'history',
      conversation_id: 'c1',
      messages: [stored({ id: 'm1', role: 'user', content: 'one', turn_id: 't1' })],
    })
    s = chatReducer(s, {
      type: 'restoreQueue',
      queue: [
        { turnId: 't1', content: 'one', writtenAt: NOW },
        { turnId: 't2', content: 'two', writtenAt: NOW },
      ],
    })
    expect(s.queue.map((q) => q.turnId)).toEqual(['t2'])
  })

  test('a message written long before it arrived records both times', () => {
    let s = enqueue(initialChatState, 't1', 'late', '2026-11-20T01:00:00.000Z')
    s = run(s, { type: 'ack', turn_id: 't1', user_message_id: 'm1', conversation_id: 'c1' })
    expect(s.messages[0]?.at).toBe('2026-11-20T01:00:00.000Z')
    expect(s.messages[0]?.arrivedAt).toBe(NOW)
  })

  test('silent and empty messages are not shown; sticker-only ones neither', () => {
    const s = run(initialChatState, {
      type: 'history',
      conversation_id: 'c1',
      messages: [
        stored({ id: 'a', role: 'assistant', content: '', status: 'silent' }),
        stored({ id: 'b', role: 'assistant', content: '[[sticker:wave]]' }),
        stored({ id: 'c', role: 'assistant', content: 'hello' }),
      ],
    })
    expect(s.messages.map((m) => m.id)).toEqual(['c'])
  })
})

describe('streaming', () => {
  test('tokens build a live reply that settles on done', () => {
    let s = enqueue(initialChatState, 't1')
    s = run(
      s,
      { type: 'ack', turn_id: 't1', user_message_id: 'u1', conversation_id: 'c1' },
      { type: 'seen', message_id: 'u1' },
    )
    expect(isThinking(s)).toBe(true)
    s = run(s, { type: 'token', turn_id: 't1', message_id: 'a1', content: 'Hel' })
    s = run(s, { type: 'token', turn_id: 't1', message_id: 'a1', content: 'lo' })
    expect(isThinking(s)).toBe(false)
    expect(isReplying(s)).toBe(true)
    expect(s.live[0]?.text).toBe('Hello')
    s = run(s, { type: 'done', turn_id: 't1' })
    expect(isReplying(s)).toBe(false)
    expect(s.live).toHaveLength(0)
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([['user', 'hi'], ['assistant', 'Hello']])
    expect(s.activeTurns).toEqual([])
  })

  test('a replay after reconnect does not double text', () => {
    let s = run(initialChatState, { type: 'token', turn_id: 't1', message_id: 'a1', content: 'Hel' })
    s = run(s, { type: 'history', conversation_id: 'c1', messages: [] })
    s = run(s, { type: 'token', turn_id: 't1', message_id: 'a1', content: 'Hel' }, { type: 'token', turn_id: 't1', message_id: 'a1', content: 'lo' })
    expect(s.live[0]?.text).toBe('Hello')
  })

  test('tokens for a message already in history are ignored', () => {
    let s = run(initialChatState, {
      type: 'history',
      conversation_id: 'c1',
      messages: [stored({ id: 'a1', role: 'assistant', content: 'Hello' })],
    })
    s = run(s, { type: 'token', turn_id: 't1', message_id: 'a1', content: 'Hello' })
    expect(s.live).toHaveLength(0)
  })

  test('stop keeps the partial reply', () => {
    let s = run(initialChatState, { type: 'token', turn_id: 't1', message_id: 'a1', content: 'Half' })
    s = run(s, { type: 'stopped', turn_id: 't1' })
    expect(s.messages[0]?.status).toBe('partial')
  })

  test('silent done stores nothing', () => {
    let s = run(initialChatState, { type: 'done', turn_id: 't1', status: 'silent' })
    expect(s.messages).toHaveLength(0)
    s = run(s, { type: 'token', turn_id: 't2', content: '' }, { type: 'done', turn_id: 't2', status: 'silent' })
    expect(s.messages).toHaveLength(0)
  })
})

describe('unprompted messages', () => {
  test('nudge frames become her message', () => {
    let s = run(
      initialChatState,
      { type: 'nudge_start', conversation_id: 'c1', reason: 'game', message_id: 'n1' },
      { type: 'nudge_token', content: 'Hey, ' },
      { type: 'nudge_token', content: 'you there?' },
    )
    expect(s.live[0]?.unprompted).toBe(true)
    s = run(s, { type: 'nudge_end' })
    expect(s.messages.map((m) => [m.id, m.text])).toEqual([['n1', 'Hey, you there?']])
  })

  test('a nudge already in history is not shown twice', () => {
    let s = run(initialChatState, {
      type: 'history',
      conversation_id: 'c1',
      messages: [stored({ id: 'n1', role: 'assistant', content: 'Hey' })],
    })
    s = run(s, { type: 'nudge_start', conversation_id: 'c1', reason: 'x', message_id: 'n1' }, { type: 'nudge_token', content: 'Hey' }, { type: 'nudge_end' })
    expect(s.messages).toHaveLength(1)
  })
})

describe('review fixes', () => {
  test('arrivedLate: 30 s is not late, 5 min is', () => {
    const { arrivedLate } = require('./model') as typeof import('./model')
    expect(arrivedLate('2026-11-20T10:00:00Z', '2026-11-20T10:00:30Z')).toBeNull()
    expect(arrivedLate('2026-11-20T10:00:00Z', '2026-11-20T10:05:00Z')).toBe('2026-11-20T10:05:00Z')
    expect(arrivedLate(null, '2026-11-20T10:05:00Z')).toBeNull()
  })

  test('a reloaded phone message that went straight out shows no wait', () => {
    const s = run(initialChatState, {
      type: 'history',
      conversation_id: 'c1',
      messages: [stored({ id: 'm1', role: 'user', content: 'hi', written_at: '2026-11-20T08:59:58.000Z' })],
    })
    expect(s.messages[0]?.arrivedAt).toBeNull()
  })

  test('a second ack does not split her streaming reply', () => {
    let s = enqueue(initialChatState, 't1')
    const ack: ServerFrame = { type: 'ack', turn_id: 't1', user_message_id: 'u1', conversation_id: 'c1' }
    s = run(s, ack, { type: 'token', turn_id: 't1', message_id: 'a1', content: 'Hel' }, ack, {
      type: 'token', turn_id: 't1', message_id: 'a1', content: 'lo',
    })
    expect(s.live.map((i) => i.text)).toEqual(['Hello'])
    s = run(s, { type: 'done', turn_id: 't1' })
    expect(s.messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['Hello'])
  })

  function waitingOnReply() {
    let s = enqueue(initialChatState, 't1')
    s = run(s, { type: 'ack', turn_id: 't1', user_message_id: 'u1', conversation_id: 'c1' }, { type: 'seen', message_id: 'u1' })
    expect(isThinking(s)).toBe(true)
    return s
  }
  const userMsg = stored({ id: 'u1', role: 'user', content: 'hi', turn_id: 't1', seen_at: NOW })

  test('reply already in history → not thinking', () => {
    const s = run(waitingOnReply(), {
      type: 'history', conversation_id: 'c1',
      messages: [userMsg, stored({ id: 'a1', role: 'assistant', content: 'Hello', turn_id: 't1' })],
    })
    expect(isThinking(s)).toBe(false)
    expect(s.activeTurns).toEqual([])
  })

  test('silent reply in history → not thinking', () => {
    const s = run(waitingOnReply(), {
      type: 'history', conversation_id: 'c1',
      messages: [userMsg, stored({ id: 'a1', role: 'assistant', content: '', status: 'silent', turn_id: 't1' })],
    })
    expect(isThinking(s)).toBe(false)
  })

  test('no reply and no replay → cleared when the grace period expires', () => {
    let s = run(waitingOnReply(), { type: 'history', conversation_id: 'c1', messages: [userMsg] })
    expect(isThinking(s)).toBe(true)
    s = chatReducer(s, { type: 'expireUnconfirmedTurns' })
    expect(isThinking(s)).toBe(false)
  })

  test('replay arrives → the turn stays active', () => {
    let s = run(waitingOnReply(), { type: 'history', conversation_id: 'c1', messages: [userMsg] })
    s = run(s, { type: 'token', turn_id: 't1', message_id: 'a1', content: 'Hel' })
    s = chatReducer(s, { type: 'expireUnconfirmedTurns' })
    expect(s.activeTurns).toEqual(['t1'])
    expect(isReplying(s)).toBe(true)
  })
})

describe('failed messages', () => {
  test('a failed message shows as failed; retry puts it back in line; delete drops it', () => {
    let s = enqueue(enqueue(initialChatState, 't1', 'bad'), 't2', 'good')
    s = chatReducer(s, { type: 'sendFailed', turnId: 't1' })
    expect(visibleItems(s).map((i) => i.tick)).toEqual(['failed', 'waiting'])
    s = chatReducer(s, { type: 'retryQueued', turnId: 't1' })
    // back in line behind the message still waiting, as the chat shows it
    expect(s.queue).toEqual([
      { turnId: 't2', content: 'good', writtenAt: NOW },
      { turnId: 't1', content: 'bad', writtenAt: NOW },
    ])
    expect(visibleItems(s).map((i) => [i.text, i.tick])).toEqual([['good', 'waiting'], ['bad', 'waiting']])
    s = chatReducer(s, { type: 'deleteQueued', turnId: 't1' })
    expect(s.queue.map((q) => q.turnId)).toEqual(['t2'])
  })
})

describe('server times without a time zone are UTC', () => {
  const { serverTime } = require('./frames') as typeof import('./frames')
  test('serverTime', () => {
    expect(serverTime('2026-11-21T07:17:00')).toBe('2026-11-21T07:17:00Z')
    expect(serverTime('2026-11-21T07:17:00.123456')).toBe('2026-11-21T07:17:00.123456Z')
    expect(serverTime('2026-11-21T07:17:00+00:00')).toBe('2026-11-21T07:17:00+00:00')
    expect(serverTime('2026-11-20T23:16:00-08:00')).toBe('2026-11-20T23:16:00-08:00')
    expect(serverTime('2026-11-21T07:17:00Z')).toBe('2026-11-21T07:17:00Z')
  })
  test('a message sent right away shows no wait, and her reply sorts into the same day', () => {
    const s = run(initialChatState, {
      type: 'history',
      conversation_id: 'c1',
      messages: [
        // what the backend really sends: written_at with an offset, created_at without
        stored({ id: 'u1', role: 'user', content: 'hi', written_at: '2026-11-21T07:16:00+00:00', created_at: '2026-11-21T07:16:01' }),
        stored({ id: 'a1', role: 'assistant', content: 'hey', created_at: '2026-11-21T07:17:00' }),
      ],
    })
    expect(s.messages[0]?.arrivedAt).toBeNull()
    expect(Date.parse(s.messages[1]!.at) - Date.parse(s.messages[0]!.at)).toBe(60_000)
  })
})

describe('phone activity lines (phase 7)', () => {
  const line: ServerFrame = {
    type: 'phone_activity',
    conversation_id: 'c1',
    message_id: 'p1',
    text: 'Opened Maps → Kemang Village',
    created_at: '2026-11-20T09:30:00',
  }

  test('a frame adds a quiet line once, in UTC', () => {
    let s = run(initialChatState, { type: 'history', conversation_id: 'c1', messages: [] }, line, line)
    const items = visibleItems(s)
    expect(items.map((i) => [i.id, i.activity, i.text, i.at])).toEqual([['p1', true, 'Opened Maps → Kemang Village', '2026-11-20T09:30:00Z']])
    s = run(s, { ...line, message_id: 'p2', conversation_id: 'other' })
    expect(visibleItems(s)).toHaveLength(1)
  })

  test('history entries of kind phone_activity are lines and do not settle a turn', () => {
    let s = enqueue(initialChatState, 't1')
    s = run(s, { type: 'ack', turn_id: 't1', user_message_id: 'm1', conversation_id: 'c1' })
    s = run(s, {
      type: 'history',
      conversation_id: 'c1',
      messages: [
        stored({ id: 'm1', role: 'user', content: 'take me to Kemang', turn_id: 't1' }),
        stored({ id: 'p1', role: 'assistant', content: 'Used your location once', turn_id: 't1', kind: 'phone_activity' }),
      ],
    })
    expect(visibleItems(s).map((i) => [i.id, i.activity, i.tick])).toEqual([
      ['m1', false, 'saved'],
      ['p1', true, null],
    ])
    expect(s.activeTurns).toEqual(['t1'])
  })
})
