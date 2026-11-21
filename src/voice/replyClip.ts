/**
 * The start of her last spoken reply, kept in memory for the Developer screen's echo test (a real
 * voice through the loudspeaker beats a test tone). Never saved or sent anywhere.
 */

const MAX_SECONDS = 12
/** A new reply replaces the stored clip once it has this much audio (a short "Mm." wouldn't do). */
const REPLACE_AFTER_SECONDS = 2

interface Clip {
  sampleRate: number
  chunks: Int16Array[]
  samples: number
}

let stored: Clip | null = null
let recording: Clip | null = null

/** A reply's audio starts. */
export function beginReplyClip(sampleRate: number) {
  recording = sampleRate > 0 ? { sampleRate, chunks: [], samples: 0 } : null
}

export function addReplyAudio(pcm: Int16Array) {
  const clip = recording
  if (!clip) return
  const room = clip.sampleRate * MAX_SECONDS - clip.samples
  if (room <= 0) {
    recording = null
    return
  }
  const part = pcm.length > room ? pcm.slice(0, room) : pcm.slice()
  clip.chunks.push(part)
  clip.samples += part.length
  if (!stored || stored === clip || clip.samples >= clip.sampleRate * REPLACE_AFTER_SECONDS) stored = clip
}

/** The stored clip, or null if she hasn't spoken since the app started. */
export function replyClip(): { sampleRate: number; pcm: Int16Array } | null {
  if (!stored || stored.samples === 0) return null
  const pcm = new Int16Array(stored.samples)
  let offset = 0
  for (const chunk of stored.chunks) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  return { sampleRate: stored.sampleRate, pcm }
}
