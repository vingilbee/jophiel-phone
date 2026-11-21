// Copied verbatim from ../app/frontend/src/audio/pcmRingBuffer.test.ts at web commit db6ba59. Keep in step with it.
import { describe, expect, test } from 'bun:test'
import { createPcmRingBuffer } from './pcmRingBuffer'
import { speechOnsetPosition } from './vad'

/** Frame of `n` samples whose values are their absolute positions from `start`. */
const frame = (start: number, n: number) =>
  Int16Array.from({ length: n }, (_, i) => start + i)

const range = (start: number, end: number) =>
  Array.from({ length: end - start }, (_, i) => start + i)

describe('pcmRingBuffer', () => {
  test('tracks absolute positions and returns everything before it fills', () => {
    const ring = createPcmRingBuffer(10)
    ring.push(frame(0, 4))
    ring.push(frame(4, 3))
    expect(ring.endSamplePosition).toBe(7)
    expect(ring.startSamplePosition).toBe(0)
    expect([...ring.snapshotFrom(0)]).toEqual(range(0, 7))
    expect([...ring.snapshotFrom(5)]).toEqual([5, 6])
  })

  test('keeps sample order across wraparound', () => {
    const ring = createPcmRingBuffer(10)
    for (let pos = 0; pos < 37; pos += 4) ring.push(frame(pos, 4))
    expect(ring.endSamplePosition).toBe(40)
    expect(ring.startSamplePosition).toBe(30)
    expect([...ring.snapshotFrom(30)]).toEqual(range(30, 40))
    // A position inside the wrapped region still maps to the right samples.
    expect([...ring.snapshotFrom(33)]).toEqual(range(33, 40))
  })

  test('holds exactly its capacity', () => {
    const ring = createPcmRingBuffer(8)
    ring.push(frame(0, 8))
    expect([...ring.snapshotFrom(0)]).toEqual(range(0, 8))
    ring.push(frame(8, 1))
    expect([...ring.snapshotFrom(0)]).toEqual(range(1, 9))
  })

  test('clamps to the oldest sample held and to the end', () => {
    const ring = createPcmRingBuffer(10)
    ring.push(frame(0, 25))
    expect([...ring.snapshotFrom(-100)]).toEqual(range(15, 25))
    expect([...ring.snapshotFrom(3)]).toEqual(range(15, 25))
    expect(ring.snapshotFrom(25).length).toBe(0)
    expect(ring.snapshotFrom(40).length).toBe(0)
  })

  test('a frame larger than the ring leaves only its tail', () => {
    const ring = createPcmRingBuffer(10)
    ring.push(frame(0, 3))
    ring.push(frame(3, 24))
    expect(ring.endSamplePosition).toBe(27)
    expect([...ring.snapshotFrom(0)]).toEqual(range(17, 27))
  })

  test('snapshots are copies the next frame cannot overwrite', () => {
    const ring = createPcmRingBuffer(4)
    ring.push(frame(0, 4))
    const snap = ring.snapshotFrom(0)
    ring.push(frame(100, 4))
    expect([...snap]).toEqual([0, 1, 2, 3])
    snap[0] = 999
    expect([...ring.snapshotFrom(0)]).toEqual([100, 101, 102, 103])
  })

  test('clear restarts positions from zero', () => {
    const ring = createPcmRingBuffer(4)
    ring.push(frame(0, 6))
    ring.clear()
    expect(ring.endSamplePosition).toBe(0)
    expect(ring.snapshotFrom(0).length).toBe(0)
    ring.push(frame(0, 2))
    expect([...ring.snapshotFrom(0)]).toEqual([0, 1])
  })
})

describe('speechOnsetPosition', () => {
  test('backs off the confirming speech plus padding', () => {
    // 152ms of speech + 150ms padding at 16 kHz = 4832 samples back.
    expect(speechOnsetPosition(20_000, 152, 16_000, 150)).toBe(20_000 - 4832)
  })

  test('rounds the lead-in up rather than clipping a sample', () => {
    expect(speechOnsetPosition(1000, 0.01, 16_000, 0)).toBe(999)
  })

  test('never goes below the start of capture', () => {
    expect(speechOnsetPosition(1000, 150, 16_000, 150)).toBe(0)
  })

  test('the onset of 500ms ring pre-roll lands inside the ring', () => {
    const ring = createPcmRingBuffer(8000)
    for (let pos = 0; pos < 48_000; pos += 128) ring.push(frame(pos % 30_000, 128))
    const onset = speechOnsetPosition(ring.endSamplePosition, 152, 16_000, 150)
    expect(onset).toBeGreaterThanOrEqual(ring.startSamplePosition)
    expect(ring.snapshotFrom(onset).length).toBe(4832)
  })
})
