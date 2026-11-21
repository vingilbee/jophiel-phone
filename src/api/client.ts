import { getSettings } from '@/settings/store'
import { getToken } from '@/auth/token'

/** What went wrong, in terms the screens can explain. */
export type ApiErrorKind = 'unauthorized' | 'unreachable' | 'rate_limited' | 'http'

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

let onUnauthorized: (() => void) | null = null

/** The auth provider registers this: any 401 ends the session on the phone. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler
}

export function notifyUnauthorized() {
  onUnauthorized?.()
}

export function baseUrl(): string {
  return getSettings().serverUrl
}

export function wsUrl(path: string): string {
  return baseUrl().replace(/^http/i, 'ws') + path
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Skip the bearer header (sign-in). */
  anonymous?: boolean
  /** Override the stored server address (login, before it's saved). */
  server?: string
  timeoutMs?: number
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous = false, server = baseUrl(), timeoutMs = 10_000 } = options
  if (!server) throw new ApiError('unreachable', 'No server address set.')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (!anonymous) {
    const token = await getToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(server + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    throw new ApiError('unreachable', "Can't reach the server.")
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401) {
    if (!anonymous) notifyUnauthorized()
    throw new ApiError('unauthorized', 'Not signed in.', 401)
  }
  if (response.status === 429) throw new ApiError('rate_limited', 'Too many attempts.', 429)
  if (!response.ok) {
    let detail = `Server error ${response.status}`
    try {
      const data = (await response.json()) as { detail?: unknown }
      if (typeof data.detail === 'string') detail = data.detail
    } catch {
      // not JSON
    }
    throw new ApiError('http', detail, response.status)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}
