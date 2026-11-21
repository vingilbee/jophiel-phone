/**
 * Registers this phone's FCM token with the backend, once, and keeps trying until it works:
 * `ensure()` is cheap to call on every foreground and every chat reconnect. Pure (dependencies
 * injected) so it's unit-tested.
 */
export interface RegistrarDeps {
  permissionGranted: () => Promise<boolean>
  token: () => Promise<string | null>
  register: (token: string) => Promise<void>
}

export class PushRegistrar {
  private registeredToken: string | null = null
  private pending: Promise<boolean> | null = null

  constructor(private readonly deps: RegistrarDeps) {}

  get registered(): boolean {
    return this.registeredToken !== null
  }

  /** Register if not yet done. Resolves true once this phone is registered. */
  ensure(): Promise<boolean> {
    if (this.registeredToken) return Promise.resolve(true)
    this.pending ??= this.attempt(null).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  /** FCM rotated the token: the new one has to reach the backend. */
  async tokenChanged(token: string): Promise<boolean> {
    this.registeredToken = null
    if (this.pending) await this.pending.catch(() => false)
    this.pending = this.attempt(token).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  /** Signed out: the next session registers again. */
  reset() {
    this.registeredToken = null
  }

  private async attempt(known: string | null): Promise<boolean> {
    try {
      if (!(await this.deps.permissionGranted())) return false
      const token = known ?? (await this.deps.token())
      if (!token) return false
      await this.deps.register(token)
      this.registeredToken = token
      return true
    } catch {
      // Backend down or unreachable: the next foreground or reconnect tries again.
      return false
    }
  }
}
