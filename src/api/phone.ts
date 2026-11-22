import { api } from './client'

/**
 * Backend phase 2: this session's phone device. Whether notifications show (and how) is Android's
 * own notification settings, not an app setting, so there is no PATCH.
 */
export function registerDevice(fcmToken: string, deviceName: string) {
  return api<unknown>('/api/phone/device', {
    method: 'PUT',
    body: { fcm_token: fcmToken, device_name: deviceName },
  })
}

export function deleteDevice() {
  return api<void>('/api/phone/device', { method: 'DELETE', timeoutMs: 5_000 })
}

/** Phase 7: the answer to one of her phone actions, when the socket isn't open. */
export function postActionResult(actionId: string, result: { status: string; reason?: string; data?: unknown }) {
  return api<unknown>(`/api/phone/actions/${encodeURIComponent(actionId)}/result`, {
    method: 'POST',
    body: result,
    timeoutMs: 8_000,
  })
}

/** Phase 7: a found place, for Settings → Places → add by address. */
export interface FoundPlace {
  name: string
  address: string
  latitude: number
  longitude: number
}

function foundPlace(raw: unknown): FoundPlace | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const { lat, lng } = p
  if (typeof p.name !== 'string' || !p.name.trim()) return null
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) return null
  if (typeof lng !== 'number' || !Number.isFinite(lng) || Math.abs(lng) > 180) return null
  return { name: p.name.trim(), address: typeof p.address === 'string' ? p.address.trim() : '', latitude: lat, longitude: lng }
}

/** Places matching `query` (the backend asks Google; basic fields only). */
export async function searchPlaces(query: string): Promise<FoundPlace[]> {
  const raw = await api<unknown>(`/api/phone/places/search?q=${encodeURIComponent(query)}`, { timeoutMs: 15_000 })
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : []
  return list.map(foundPlace).filter((p): p is FoundPlace => p !== null)
}
