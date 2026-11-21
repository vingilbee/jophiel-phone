// Copied verbatim from ../app/frontend/src/audio/heardText.test.ts at web commit db6ba59. Keep in step with it.
import { expect, test } from 'bun:test'
import { heardCut } from './heardText'

const REPLY = 'Two large eggs have twelve grams of protein. That is a solid breakfast. Add toast for carbs.'

// Same cases as backend tests/test_voice_heard.py, so the faded text is
// exactly the part the assistant knows wasn't heard.
test.each([
  [null, REPLY.length],
  [REPLY.length, REPLY.length],
  [45, 45],
  [66, 'Two large eggs have twelve grams of protein. That is a solid '.length],
  [0, 0],
  [2, 0],
])('heardCut(%p)', (heardChars, expected) => {
  expect(heardCut(REPLY, heardChars)).toBe(expected)
})
