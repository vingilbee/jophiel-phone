import { describe, expect, test } from 'bun:test'
import { decodeBase64, decodePcm16 } from '../voice/base64'
import { echoVerdict, sustainedLevel } from '../voice/echoTest'
import type { ClientFrame, ServerFrame, StoredMessage } from './frames'
import { chatReducer, initialChatState, isThinking, visibleItems, type ChatState } from './model'
import { VoiceChannel, type VoiceEvents } from './voice'

const NOW = '2026-11-21T10:00:00.000Z'

function harness(options: { ready?: boolean; conversationId?: string | null; known?: string[] } = {}) {
  const sent: ClientFrame[] = []
  const binary: Uint8Array[] = []
  const settled: string[] = []
  let ready = options.ready ?? true
  const channel = new VoiceChannel({
    send: (frame) => {
      if (!ready) return false
      sent.push(frame)
      return true
    },
    sendBinary: (bytes) => {
      binary.push(bytes)
      return ready
    },
    ready: () => ready,
    settleTurn: (turnId) => settled.push(turnId),
    knowsMessage: (id) => (options.known ?? []).includes(id),
    conversationId: () => options.conversationId ?? 'c1',
  })
  const calls: string[] = []
  const events: VoiceEvents = {
    onAudioStart: (rate, unprompted) => calls.push(`start:${rate}:${unprompted}`),
    onAudio: (pcm, rate) => calls.push(`audio:${pcm.length}:${rate}`),
    onAudioEnd: () => calls.push('end'),
    onAudioSegment: (segment, a, b) => calls.push(`segment:${segment}:${a}-${b}`),
    onBargeResolved: (action) => calls.push(`barge:${action}`),
    onReplyInterrupted: () => calls.push('interrupted'),
    onDisconnect: () => calls.push('disconnect'),
  }
  channel.events = events
  return { channel, sent, binary, settled, calls, setReady: (value: boolean) => { ready = value } }
}

const last = <T,>(items: T[]) => items[items.length - 1]
const pcmBuffer = (samples: number) => new Int16Array(samples).buffer

describe('voice turn', () => {
  test('start → audio → end → reply text resolves the turn', async () => {
    const { channel, sent, binary } = harness()
    expect(channel.startVoice('c1', 16000)).toBe(true)
    const start = sent[0] as Extract<ClientFrame, { type: 'voice_start' }>
    expect(start).toMatchObject({ type: 'voice_start', conversation_id: 'c1', sample_rate: 16000 })
    channel.sendAudio(new Int16Array([1, 2, 3]))
    expect(binary[0]?.byteLength).toBe(6)
    const reply = channel.endVoice('c1')
    expect(last(sent)).toEqual({ type: 'voice_end', turn_id: start.turn_id })
    for (const frame of [
      { type: 'transcript', turn_id: start.turn_id, content: 'hello' },
      { type: 'meta', conversation_id: 'c1' },
      { type: 'ack', turn_id: start.turn_id, user_message_id: 'u1', conversation_id: 'c1' },
      { type: 'token', turn_id: start.turn_id, message_id: 'a1', content: 'Hi ' },
      { type: 'token', turn_id: 'other-turn', content: 'not mine' },
      { type: 'token', turn_id: start.turn_id, message_id: 'a1', content: 'there' },
      { type: 'done', turn_id: start.turn_id },
    ] as ServerFrame[]) {
      expect(channel.handleFrame(frame)).toBe(true)
    }
    expect(await reply).toEqual({ conversationId: 'c1', reply: 'Hi there', status: 'completed' })
  })

  test('not ready (history not in yet): no utterance opens', async () => {
    const { channel, sent } = harness({ ready: false })
    expect(channel.startVoice(null, 16000)).toBe(false)
    expect(sent).toEqual([])
    await expect(channel.endVoice(null)).rejects.toThrow('Not connected')
  })

  test('an error answering the utterance is the voice loop\'s, not the chat\'s', async () => {
    const { channel } = harness()
    channel.startVoice('c1', 16000)
    const reply = channel.endVoice('c1')
    expect(channel.handleFrame({ type: 'error', detail: "Couldn't transcribe that." })).toBe(false)
    await expect(reply).rejects.toThrow("Couldn't transcribe that.")
  })

  test('an empty transcript ends with a bare done: the turn resolves with no reply', async () => {
    const { channel } = harness()
    channel.startVoice('c1', 16000)
    const reply = channel.endVoice('c1')
    channel.handleFrame({ type: 'done' })
    expect((await reply).reply).toBe('')
  })
})

describe('audio frames and fencing', () => {
  test('audio frames go to the voice loop only, binary inherits the rate', () => {
    const { channel, calls } = harness()
    expect(channel.handleFrame({ type: 'audio_start', turn_id: 't1', sample_rate: 24000 })).toBe(false)
    expect(channel.handleFrame({ type: 'audio_segment', turn_id: 't1', segment: 0, text_start: 0, text_end: 12 })).toBe(false)
    channel.handleBinary(pcmBuffer(480))
    expect(channel.handleFrame({ type: 'audio_end', turn_id: 't1' })).toBe(false)
    expect(calls).toEqual(['start:24000:false', 'segment:0:0-12', 'audio:480:24000', 'end'])
  })

  test('button barge-in fences the cut-off turn: its late audio and text never come back', async () => {
    const { channel, sent, settled, calls } = harness()
    channel.startVoice('c1', 16000)
    const first = (sent[0] as { turn_id: string }).turn_id
    const reply = channel.endVoice('c1')
    channel.handleFrame({ type: 'audio_start', turn_id: first, sample_rate: 24000 })
    expect(channel.interruptVoiceStart('c1', 16000)).toBe(true)
    const interrupt = last(sent) as Extract<ClientFrame, { type: 'voice_interrupt' }>
    expect(interrupt).toMatchObject({ type: 'voice_interrupt', cancel_turn_id: first, conversation_id: 'c1' })
    expect(interrupt.tentative).toBeUndefined()
    expect((await reply).status).toBe('cancelled')
    expect(settled).toEqual([first])
    // Late leftovers of the fenced turn.
    channel.handleBinary(pcmBuffer(100))
    expect(channel.handleFrame({ type: 'token', turn_id: first, content: 'late' })).toBe(false)
    expect(channel.handleFrame({ type: 'audio_start', turn_id: first, sample_rate: 24000 })).toBe(false)
    channel.handleBinary(pcmBuffer(100))
    expect(calls.filter((c) => c.startsWith('audio:'))).toEqual([])
    // The next reply lifts the fence.
    channel.handleFrame({ type: 'audio_start', turn_id: 'next', sample_rate: 24000 })
    channel.handleBinary(pcmBuffer(100))
    expect(last(calls)).toBe('audio:100:24000')
  })

  test('a nudge the chat already shows (or for another thread) is not spoken', () => {
    const { channel, calls } = harness({ known: ['n1'] })
    channel.handleFrame({ type: 'nudge_start', conversation_id: 'c1', reason: 'x', message_id: 'n1' })
    channel.handleFrame({ type: 'audio_start', sample_rate: 24000, unprompted: true })
    channel.handleFrame({ type: 'nudge_start', conversation_id: 'c2', reason: 'x', message_id: 'n2' })
    channel.handleFrame({ type: 'audio_start', sample_rate: 24000, unprompted: true })
    expect(calls).toEqual([])
    channel.handleFrame({ type: 'nudge_start', conversation_id: 'c1', reason: 'x', message_id: 'n3' })
    channel.handleFrame({ type: 'audio_start', sample_rate: 24000, unprompted: true })
    expect(calls).toEqual(['start:24000:true'])
  })

  test('reply_interrupted stops her where she is, then fences the turn', async () => {
    const { channel, calls, settled } = harness()
    channel.startVoice('c1', 16000)
    const reply = channel.endVoice('c1')
    channel.handleFrame({ type: 'ack', turn_id: 'x', user_message_id: 'u', conversation_id: 'c1' })
    expect(channel.handleFrame({ type: 'reply_interrupted', reason: 'game' })).toBe(true)
    expect(calls).toEqual(['interrupted'])
    expect((await reply).status).toBe('cancelled')
    expect(settled).toHaveLength(1)
  })

  test('heard is reported for the turn whose audio is playing', () => {
    const { channel, sent } = harness()
    expect(channel.reportHeard(10)).toBeNull()
    channel.handleFrame({ type: 'audio_start', turn_id: 'spoken', sample_rate: 24000 })
    expect(channel.reportHeard(42)).toBe('spoken')
    expect(last(sent)).toEqual({ type: 'voice_heard', turn_id: 'spoken', heard_chars: 42 })
  })
})

describe('hold (spoken barge-in)', () => {
  function speaking() {
    const h = harness()
    h.channel.startVoice('c1', 16000)
    const turn = (h.sent[0] as { turn_id: string }).turn_id
    const reply = h.channel.endVoice('c1')
    h.channel.handleFrame({ type: 'audio_start', turn_id: turn, sample_rate: 24000 })
    return { ...h, turn, reply }
  }

  test('a hold opens a tentative utterance without cancelling anything; resume restores the turn', () => {
    const { channel, sent, settled, calls, turn } = speaking()
    expect(channel.holdVoice('c1', 16000)).toBe(true)
    const hold = last(sent) as Extract<ClientFrame, { type: 'voice_interrupt' }>
    expect(hold).toMatchObject({ tentative: true, cancel_turn_id: turn })
    expect(channel.endHold()).toBe(true)
    expect(last(sent)).toEqual({ type: 'voice_end', turn_id: hold.new_turn_id })
    // A decision for some other hold changes nothing.
    channel.handleFrame({ type: 'barge_resolved', turn_id: 'stale', action: 'turn' })
    channel.handleFrame({ type: 'barge_resolved', turn_id: hold.new_turn_id, action: 'resume' })
    expect(calls.at(-1)).toBe('barge:resume')
    channel.resumeHold()
    expect(settled).toEqual([])
    // Her audio keeps flowing after a resume.
    channel.handleBinary(pcmBuffer(10))
    expect(calls.at(-1)).toBe('audio:10:24000')
  })

  test('commit cuts the reply off at once', async () => {
    const { channel, sent, settled, turn, reply } = speaking()
    channel.holdVoice('c1', 16000)
    const hold = last(sent) as Extract<ClientFrame, { type: 'voice_interrupt' }>
    channel.commitHold()
    expect(last(sent)).toEqual({ type: 'voice_interrupt_commit', turn_id: hold.new_turn_id })
    expect(settled).toEqual([turn])
    expect((await reply).status).toBe('cancelled')
  })

  test('decision "turn": the held utterance becomes the pending turn', async () => {
    const { channel, sent, turn } = speaking()
    channel.holdVoice('c1', 16000)
    const hold = last(sent) as Extract<ClientFrame, { type: 'voice_interrupt' }>
    channel.endHold()
    const adopted = channel.adoptHold('c1')
    channel.handleFrame({ type: 'token', turn_id: turn, content: 'old reply, fenced' })
    channel.handleFrame({ type: 'token', turn_id: hold.new_turn_id, content: 'new answer' })
    channel.handleFrame({ type: 'done', turn_id: hold.new_turn_id })
    expect((await adopted).reply).toBe('new answer')
  })
})

describe('leaving and dropping', () => {
  test('leaving drops the utterance but not her reply: its text keeps going to the chat', () => {
    const { channel, sent, settled, calls } = harness()
    channel.startVoice('c1', 16000)
    const turn = (sent[0] as { turn_id: string }).turn_id
    void channel.endVoice('c1')
    channel.handleFrame({ type: 'audio_start', turn_id: turn, sample_rate: 24000 })
    channel.leave()
    expect(last(sent)).toEqual({ type: 'voice_cancel' })
    expect(sent.some((f) => f.type === 'stop')).toBe(false)
    expect(settled).toEqual([])
    expect(channel.handleFrame({ type: 'token', turn_id: turn, content: 'more' })).toBe(true)
    channel.handleBinary(pcmBuffer(10))
    expect(calls.filter((c) => c.startsWith('audio:'))).toEqual([])
  })

  test('a dropped socket loses the audio, keeps the text, and settles the turn for the loop', async () => {
    const { channel, sent, calls, setReady } = harness()
    channel.startVoice('c1', 16000)
    const turn = (sent[0] as { turn_id: string }).turn_id
    const reply = channel.endVoice('c1')
    setReady(false)
    channel.handleClose()
    expect(calls).toEqual(['disconnect'])
    expect((await reply).status).toBe('cancelled')
    setReady(true)
    // The reconnect replays the turn: text yes, audio no.
    expect(channel.handleFrame({ type: 'token', turn_id: turn, content: 'replayed' })).toBe(true)
    expect(channel.handleFrame({ type: 'audio_start', turn_id: turn, sample_rate: 24000 })).toBe(false)
  })

  test('cancelling while a reply is awaited stops and settles that turn', async () => {
    const { channel, sent, settled } = harness()
    channel.startVoice('c1', 16000)
    const turn = (sent[0] as { turn_id: string }).turn_id
    const reply = channel.endVoice('c1')
    channel.cancelVoice()
    expect(sent.slice(-2)).toEqual([{ type: 'stop', conversation_id: 'c1', turn_id: turn }, { type: 'voice_cancel' }])
    expect(settled).toEqual([turn])
    expect((await reply).status).toBe('cancelled')
  })
})

describe('chat model with voice', () => {
  const run = (state: ChatState, ...frames: ServerFrame[]) =>
    frames.reduce((s, frame) => chatReducer(s, { type: 'frame', frame, now: NOW }), state)

  test('a transcript shows as your bubble; its ack gives it an id, then two ticks', () => {
    let s = run(initialChatState, { type: 'transcript', turn_id: 'v1', content: 'what time is it' })
    expect(visibleItems(s).map((i) => [i.role, i.text, i.tick])).toEqual([['user', 'what time is it', 'saved']])
    s = run(s, { type: 'ack', turn_id: 'v1', user_message_id: 'u1', conversation_id: 'c1' }, { type: 'seen', message_id: 'u1' })
    expect(visibleItems(s)).toHaveLength(1)
    expect(visibleItems(s)[0]).toMatchObject({ id: 'u1', tick: 'seen', key: 'v:v1' })
    expect(isThinking(s)).toBe(true)
  })

  test('heard marks the reply; settling a cut-off turn stops "thinking" and keeps the fade', () => {
    let s = run(
      initialChatState,
      { type: 'transcript', turn_id: 'v1', content: 'tell me' },
      { type: 'ack', turn_id: 'v1', user_message_id: 'u1', conversation_id: 'c1' },
      { type: 'token', turn_id: 'v1', message_id: 'a1', content: 'One two three four.' },
    )
    s = chatReducer(s, { type: 'heard', turnId: 'v1', heardChars: 8 })
    s = chatReducer(s, { type: 'settleTurn', turnId: 'v1' })
    expect(s.live).toEqual([])
    expect(s.activeTurns).toEqual([])
    const reply = s.messages.find((m) => m.id === 'a1')
    expect(reply).toMatchObject({ heardChars: 8, status: 'partial', streaming: false })
  })

  test('history carries heard_chars only when it cuts the reply short', () => {
    const base = { turn_id: 't', status: 'partial', source_channel: 'phone', created_at: '2026-11-21T09:00:00' } as const
    const s = run(initialChatState, {
      type: 'history',
      conversation_id: 'c1',
      messages: [
        { ...base, id: 'a1', role: 'assistant', content: 'Two large eggs. Add toast.', heard_chars: 9 },
        { ...base, id: 'a2', role: 'assistant', content: 'Short.', heard_chars: 6 },
      ] as StoredMessage[],
    })
    expect(s.messages.map((m) => m.heardChars)).toEqual([9, null])
  })
})

describe('helpers', () => {
  test('base64 decodes like the native side encodes', () => {
    expect(Array.from(decodeBase64('AAEC/w=='))).toEqual([0, 1, 2, 255])
    expect(Array.from(decodeBase64('AQID'))).toEqual([1, 2, 3])
    expect(Array.from(decodePcm16('AQD//w=='))).toEqual([1, -1])
  })

  test('echo verdict reads the sustained level against the barge-in threshold', () => {
    expect(sustainedLevel([0.5, 0.01, 0.01, 0.01], 20, 40)).toBeCloseTo(0.01)
    expect(sustainedLevel([0.02, 0.03, 0.04, 0.01], 20, 40)).toBeCloseTo(0.03)
    const ok = echoVerdict({ peakMic: 0.1, sustainedMic: 0.01, peakOutput: 0.3, threshold: 0.025, bargeInFired: false })
    expect(ok).toMatchObject({ percent: 40, ok: true })
    expect(echoVerdict({ peakMic: 0.1, sustainedMic: 0.05, peakOutput: 0.3, threshold: 0.025, bargeInFired: true }).ok).toBe(false)
  })
})

describe('hands on the phone', () => {
  test('a hands frame marks the turn busy until it closes or the turn ends, and never reaches the chat', () => {
    const { channel } = harness()
    expect(channel.handsBusy()).toBe(false)
    expect(channel.handleFrame({ type: 'hands', turn_id: 'work', open: true })).toBe(false)
    expect(channel.handsBusy()).toBe(true)
    channel.handleFrame({ type: 'hands', turn_id: 'work', open: false })
    expect(channel.handsBusy()).toBe(false)
    channel.handleFrame({ type: 'hands', turn_id: 'work', open: true })
    channel.handleFrame({ type: 'done', turn_id: 'work' })
    expect(channel.handsBusy()).toBe(false)
    channel.handleFrame({ type: 'hands', turn_id: 'work', open: true })
    channel.handleClose()
    expect(channel.handsBusy()).toBe(false)
  })
})
