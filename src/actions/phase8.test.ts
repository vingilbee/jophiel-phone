import { describe, expect, test } from 'bun:test'
import { fakeDeps, recordingDevice, sw } from './testing'
import { defaultActionGroups } from './groups'
import {
  alarmArgs,
  draftArgs,
  mediaArgs,
  openLinkArgs,
  replyArgs,
  ringerArgs,
  timerArgs,
  volumeArgs,
  type PhoneAction,
} from './protocol'
import { precheck, runAction, type DeviceDeps } from './run'

const NOW = Date.parse('2026-11-22T19:00:00.000Z')

function act(name: string, args: Record<string, unknown> = {}): PhoneAction {
  return { actionId: `id-${name}`, action: name, args, expiresAt: NOW + 60_000 }
}

describe('phase 8 args', () => {
  test('media and volume', () => {
    expect(mediaArgs({ command: 'pause' })).toBe('pause')
    expect(mediaArgs({ command: 'stop' })).toBeNull()
    expect(volumeArgs({ level: 42.6 })).toBe(43)
    expect(volumeArgs({ level: 140 })).toBe(100)
    expect(volumeArgs({ level: -3 })).toBe(0)
    expect(volumeArgs({ level: '40' })).toBeNull()
  })

  test('alarms: HH:MM, days as Calendar numbers', () => {
    expect(alarmArgs({ time: '07:30' })).toEqual({ hour: 7, minute: 30, label: null, days: [] })
    expect(alarmArgs({ time: '6:05', label: ' Gym ', days: ['Friday', 'mon', 'MON', 'sun'] })).toEqual({ hour: 6, minute: 5, label: 'Gym', days: [1, 2, 6] })
    expect(alarmArgs({ time: '24:00' })).toBeNull()
    expect(alarmArgs({ time: '7.30' })).toBeNull()
    expect(alarmArgs({ time: '07:30', days: ['someday'] })).toBeNull()
    expect(alarmArgs({ time: '07:30', days: 'mon' })).toBeNull()
  })

  test('timers: 1 s to 24 h', () => {
    expect(timerArgs({ seconds: 300, label: 'Pasta' })).toEqual({ seconds: 300, label: 'Pasta' })
    expect(timerArgs({ seconds: 0 })).toBeNull()
    expect(timerArgs({ seconds: 86_401 })).toBeNull()
  })

  test('ringer', () => {
    expect(ringerArgs({ mode: 'silent' })).toBe('silent')
    expect(ringerArgs({ mode: 'loud' })).toBeNull()
  })

  test('reply: key and text required, the rest when given', () => {
    expect(replyArgs({ key: 'n_1', conversation_id: 'c_1', revision: 3, text: 'on my way' })).toEqual({
      key: 'n_1',
      conversationId: 'c_1',
      revision: 3,
      text: 'on my way',
    })
    expect(replyArgs({ key: 'n_1', text: 'hi', revision: 1.5 })).toEqual({ key: 'n_1', conversationId: null, revision: null, text: 'hi' })
    expect(replyArgs({ key: 'n_1', text: '  ' })).toBeNull()
    expect(replyArgs({ text: 'hi' })).toBeNull()
    expect(replyArgs({ key: 'n_1', text: 'x'.repeat(4_001) })).toBeNull()
  })

  test('links: http(s) only', () => {
    expect(openLinkArgs({ url: 'https://discord.com/channels/1/2' })).toBe('https://discord.com/channels/1/2')
    expect(openLinkArgs({ url: 'intent://evil#Intent;end' })).toBeNull()
    expect(openLinkArgs({ url: 'javascript:alert(1)' })).toBeNull()
    expect(openLinkArgs({ url: 'https://localhost' })).toBeNull()
  })

  test('drafts: text required, to optional', () => {
    expect(draftArgs({ to: 'Rina', text: 'see you at 8' })).toEqual({ to: 'Rina', text: 'see you at 8' })
    expect(draftArgs({ text: 'see you' })).toEqual({ to: null, text: 'see you' })
    expect(draftArgs({ to: 'Rina' })).toBeNull()
  })
})

describe('phase 8 switches', () => {
  const on = sw(true, true)

  test('a group switched off refuses its actions only', () => {
    const noMedia = { ...on, groups: { ...defaultActionGroups(), media: false } }
    expect(precheck(act('media_control'), NOW, noMedia)).toEqual({ status: 'refused', reason: 'switched_off' })
    expect(precheck(act('set_volume'), NOW, noMedia)).toEqual({ status: 'refused', reason: 'switched_off' })
    expect(precheck(act('set_alarm'), NOW, noMedia)).toBeNull()
    const noOpening = { ...on, groups: { ...defaultActionGroups(), opening: false } }
    for (const name of ['open_app', 'open_link', 'play_music']) {
      expect(precheck(act(name), NOW, noOpening)).toEqual({ status: 'refused', reason: 'switched_off' })
    }
    const noAlarms = { ...on, groups: { ...defaultActionGroups(), alarms: false } }
    expect(precheck(act('set_timer'), NOW, noAlarms)).toEqual({ status: 'refused', reason: 'switched_off' })
  })

  test('Messages off pauses replies and drafts, even ones you ask for', () => {
    const paused = { ...on, groups: { ...defaultActionGroups(), messages: false } }
    expect(precheck(act('reply_notification'), NOW, paused)).toEqual({ status: 'refused', reason: 'replies_paused' })
    expect(precheck(act('whatsapp_draft'), NOW, paused)).toEqual({ status: 'refused', reason: 'replies_paused' })
    expect(precheck(act('dismiss_notification'), NOW, paused)).toBeNull()
  })

  test('reply and dismiss need the Notifications sense', () => {
    const blind = { ...on, notificationsOn: false }
    expect(precheck(act('reply_notification'), NOW, blind)).toEqual({ status: 'refused', reason: 'switched_off' })
    expect(precheck(act('dismiss_notification'), NOW, blind)).toEqual({ status: 'refused', reason: 'switched_off' })
    expect(precheck(act('media_control'), NOW, blind)).toBeNull()
  })

  test('the master switch still comes first; ringer and DND need only it', () => {
    expect(precheck(act('set_ringer'), NOW, sw(false, true))).toEqual({ status: 'refused', reason: 'switched_off' })
    const allGroupsOff = { ...on, groups: { media: false, messages: false, alarms: false, opening: false } }
    expect(precheck(act('set_ringer'), NOW, allGroupsOff)).toBeNull()
    expect(precheck(act('set_dnd'), NOW, allGroupsOff)).toBeNull()
  })
})

describe('phase 8 dispatch', () => {
  function run(name: string, args: Record<string, unknown>, device?: Partial<DeviceDeps>) {
    const calls: [string, unknown[]][] = []
    const { deps, delivered } = fakeDeps({ now: () => NOW, device: { ...recordingDevice(calls), ...device } })
    return runAction(act(name, args), deps).then((result) => ({ result, calls, delivered }))
  }

  test('each action reaches its native call with checked args', async () => {
    expect((await run('media_control', { command: 'next' })).calls).toEqual([['mediaControl', ['next']]])
    expect((await run('set_volume', { level: 30 })).calls).toEqual([['setVolume', [30]]])
    expect((await run('set_alarm', { time: '07:00', days: ['mon'] })).calls).toEqual([['setAlarm', [{ hour: 7, minute: 0, label: null, days: [2] }]]])
    expect((await run('set_timer', { seconds: 60 })).calls).toEqual([['setTimer', [60, null]]])
    expect((await run('set_ringer', { mode: 'vibrate' })).calls).toEqual([['setRinger', ['vibrate']]])
    expect((await run('set_dnd', { on: false })).calls).toEqual([['setDnd', [false]]])
    expect((await run('dismiss_notification', { key: 'n_1' })).calls).toEqual([['dismiss', ['n_1']]])
    expect((await run('open_app', { name: 'Gojek' })).calls).toEqual([['openApp', ['Gojek']]])
    expect((await run('play_music', { query: 'Hindia' })).calls).toEqual([['playMusic', ['Hindia']]])
    expect((await run('whatsapp_draft', { text: 'hi' })).calls).toEqual([['whatsappDraft', [null, 'hi']]])
  })

  test('bad args never reach native', async () => {
    const { result, calls } = await run('set_volume', { level: 'loud' })
    expect(result).toEqual({ status: 'failed', reason: 'bad_args' })
    expect(calls).toEqual([])
  })

  test('native answers pass through: reasons and data', async () => {
    const opened = await run('open_app', { name: 'gojek' }, { openApp: async () => ({ status: 'done', reason: null, data: { opened: 'Gojek' } }) })
    expect(opened.delivered).toEqual([['id-open_app', { status: 'done', data: { opened: 'Gojek' } }]])
    const draft = await run('whatsapp_draft', { to: 'Rina', text: 'hi' }, {
      whatsappDraft: async () => ({ status: 'notified', reason: 'background', data: { target: 'picker' } }),
    })
    // The backend takes `data` only with `done`: a notified draft goes without its target.
    expect(draft.result).toEqual({ status: 'notified', reason: 'background' })
    const gone = await run('reply_notification', { key: 'n_1', text: 'hi' }, { reply: async () => ({ status: 'failed', reason: 'notification_gone' }) })
    expect(gone.result).toEqual({ status: 'failed', reason: 'notification_gone' })
  })
})
