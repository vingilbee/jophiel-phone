import { api } from './client'

export interface User {
  id: string
  name: string
  email: string
  created_at: string
}

export interface TokenOut {
  token: string
  user: User
  expires_at: string
}

export function requestToken(server: string, email: string, password: string, deviceName: string) {
  return api<TokenOut>('/api/auth/token', {
    method: 'POST',
    server,
    anonymous: true,
    body: { email, password, device_name: deviceName },
  })
}

/** Ends this phone's session on the server (and, from phase 2, removes its device row). */
export function signOutRemote() {
  return api<void>('/api/auth/signout', { method: 'POST', timeoutMs: 5_000 })
}

export function fetchMe() {
  return api<User>('/api/auth/me')
}

export function checkHealth(server: string) {
  return api<{ status: string }>('/health', { server, anonymous: true, timeoutMs: 6_000 })
}

export interface Capabilities {
  voice_enabled?: boolean
  desktop_enabled?: boolean
  /** Not served yet by every backend; shown in About when present. */
  version?: string
}

export function fetchCapabilities() {
  return api<Capabilities>('/api/capabilities', { anonymous: true })
}
