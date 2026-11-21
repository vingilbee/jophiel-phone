import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'
import { defaultServerUrl } from './defaults'

/**
 * Phone-side settings. Versioned so later phases can add fields: `migrate` fills new fields with
 * their defaults and never drops what's already stored.
 */
export interface PhoneSettings {
  version: 1
  serverUrl: string
  /** Setup was finished or skipped once; it no longer opens by itself. */
  setupSeen: boolean
  /** ISO time of the last open chat connection. */
  lastConnectedAt: string | null
  /** Phase 5: a voice call keeps going when you leave the app or lock the screen. */
  keepListeningInBackground: boolean
  /** Phase 5: the one-time battery prompt after the first background call was shown. */
  batteryPromptShown: boolean
}

const KEY = 'jophiel.settings'

export function defaults(): PhoneSettings {
  return {
    version: 1,
    serverUrl: defaultServerUrl(),
    setupSeen: false,
    lastConnectedAt: null,
    keepListeningInBackground: true,
    batteryPromptShown: false,
  }
}

export function migrate(raw: unknown): PhoneSettings {
  const base = defaults()
  if (!raw || typeof raw !== 'object') return base
  const stored = raw as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in base) || key === 'version') continue
    const expected = base[key as keyof PhoneSettings]
    const nullable = key === 'lastConnectedAt'
    if (typeof value === typeof expected || (nullable && (value === null || typeof value === 'string'))) {
      kept[key] = value
    }
  }
  return { ...base, ...kept, version: 1 }
}

let current: PhoneSettings = defaults()
let loaded = false
const listeners = new Set<() => void>()

export async function loadSettings(): Promise<PhoneSettings> {
  if (loaded) return current
  try {
    const raw = await AsyncStorage.getItem(KEY)
    current = migrate(raw ? JSON.parse(raw) : null)
  } catch {
    current = defaults()
  }
  loaded = true
  listeners.forEach((listener) => listener())
  return current
}

export function getSettings(): PhoneSettings {
  return current
}

export function updateSettings(patch: Partial<Omit<PhoneSettings, 'version'>>): PhoneSettings {
  current = { ...current, ...patch }
  listeners.forEach((listener) => listener())
  AsyncStorage.setItem(KEY, JSON.stringify(current)).catch(() => {})
  return current
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettings(): PhoneSettings {
  return useSyncExternalStore(subscribe, getSettings)
}
