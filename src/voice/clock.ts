/**
 * Phase 5: `setTimeout` / `clearTimeout` on a native clock. React Native stops firing JS timers once
 * the app is in the background (they're driven by the display), but a voice call has to keep its
 * timers there: hold decision, audio grace, no-answer, yield, socket ack and reconnect backoff.
 *
 * Pure, so tests can run it on a fake clock; the app's instance is in ./timers.
 */

export interface NativeClock {
  setTimer: (id: number, ms: number) => void
  clearTimer: (id: number) => void
  onTimer: (listener: (id: number) => void) => { remove: () => void }
}

/** An opaque handle, like the one `setTimeout` returns. */
export type TimerHandle = number & { readonly __timer: unique symbol }

export interface Clock {
  setTimeout: (callback: () => void, ms?: number) => TimerHandle
  clearTimeout: (handle: TimerHandle | null | undefined) => void
}

/** With no native clock (an old build, tests), the JS timers. */
export function jsClock(): Clock {
  return {
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as TimerHandle,
    clearTimeout: (handle) => {
      if (handle != null) globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
    },
  }
}

export function createClock(native: NativeClock): Clock {
  let nextId = 1
  const pending = new Map<number, () => void>()
  let subscription: { remove: () => void } | null = null

  const listen = () => {
    subscription ??= native.onTimer((id) => {
      const callback = pending.get(id)
      if (!callback) return
      pending.delete(id)
      callback()
    })
  }

  return {
    setTimeout(callback, ms = 0) {
      listen()
      const id = nextId++
      pending.set(id, callback)
      native.setTimer(id, Math.max(0, ms))
      return id as TimerHandle
    },
    clearTimeout(handle) {
      if (handle == null) return
      const id = handle as number
      if (!pending.delete(id)) return
      native.clearTimer(id)
    },
  }
}
