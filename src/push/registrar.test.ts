import { describe, expect, test } from 'bun:test'
import { PushRegistrar } from './registrar'

function setup() {
  const calls: string[] = []
  const env = { granted: false, backendUp: true }
  const registrar = new PushRegistrar({
    permissionGranted: async () => env.granted,
    token: async () => 'tok',
    register: async (token) => {
      if (!env.backendUp) throw new Error('down')
      calls.push(token)
    },
  })
  return { registrar, calls, env }
}

describe('push registration', () => {
  test('denied at start, allowed later in Android → the next foreground registers', async () => {
    const { registrar, calls, env } = setup()
    expect(await registrar.ensure()).toBe(false)
    env.granted = true
    expect(await registrar.ensure()).toBe(true)
    expect(calls).toEqual(['tok'])
  })

  test('registers once, not on every foreground', async () => {
    const { registrar, calls, env } = setup()
    env.granted = true
    await registrar.ensure()
    await registrar.ensure()
    await Promise.all([registrar.ensure(), registrar.ensure()])
    expect(calls).toEqual(['tok'])
  })

  test('backend down → retried on the next foreground / reconnect', async () => {
    const { registrar, calls, env } = setup()
    env.granted = true
    env.backendUp = false
    expect(await registrar.ensure()).toBe(false)
    env.backendUp = true
    expect(await registrar.ensure()).toBe(true)
    expect(calls).toEqual(['tok'])
  })

  test('a refreshed token is registered; sign-out resets', async () => {
    const { registrar, calls, env } = setup()
    env.granted = true
    await registrar.ensure()
    await registrar.tokenChanged('tok2')
    expect(calls).toEqual(['tok', 'tok2'])
    registrar.reset()
    expect(registrar.registered).toBe(false)
  })
})
