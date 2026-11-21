import * as Device from 'expo-device'

/** The Android emulator reaches the Mac's localhost at 10.0.2.2. A real phone uses the Tailscale address. */
export const EMULATOR_SERVER_URL = 'http://10.0.2.2:8000'

export function defaultServerUrl(): string {
  return Device.isDevice ? '' : EMULATOR_SERVER_URL
}

/** Trim, drop a trailing slash, and add http(s):// when it was left out. */
export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  if (url && !/^https?:\/\//i.test(url)) {
    url = (/^(10\.|192\.168\.|127\.|localhost)/.test(url) ? 'http://' : 'https://') + url
  }
  return url
}
