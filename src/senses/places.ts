import { clip } from './report'

/**
 * A named circle saved on the phone (Settings → Phone senses → Places). Only the name ever leaves
 * the phone; she reads it as written ("Arrived at home").
 */
export interface Place {
  id: string
  name: string
  latitude: number
  longitude: number
  /** Meters. */
  radius: number
}

export const MAX_PLACE_NAME = 60
/** Play Services allows 100 geofences per app. */
export const MAX_PLACES = 100
export const DEFAULT_RADIUS = 150
export const RADIUS_CHOICES = [100, 150, 250, 500, 1000] as const
export const MIN_RADIUS = 50
export const MAX_RADIUS = 5000

export function newPlaceId(): string {
  return `place-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Trimmed and at most 60 characters; empty → null (a place needs a name). */
export function placeName(input: string): string | null {
  const name = clip(input.trim().replace(/\s+/g, ' '), MAX_PLACE_NAME)
  return name === '' ? null : name
}

/** A stored place, or null if it isn't one (storage from another version, hand edits). */
export function checkPlace(raw: unknown): Place | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id === '' || typeof p.name !== 'string') return null
  const name = placeName(p.name)
  const { latitude, longitude, radius } = p
  if (!name || typeof latitude !== 'number' || typeof longitude !== 'number' || typeof radius !== 'number') return null
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null
  if (!Number.isFinite(radius)) return null
  return { id: p.id, name, latitude, longitude, radius: Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.round(radius))) }
}

/** Every valid place once (by id), at most 100. */
export function checkPlaces(raw: unknown): Place[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: Place[] = []
  for (const item of raw) {
    const place = checkPlace(item)
    if (!place || seen.has(place.id)) continue
    seen.add(place.id)
    out.push(place)
    if (out.length === MAX_PLACES) break
  }
  return out
}

/** "150 m", "1 km", "1.5 km". */
export function radiusLabel(meters: number): string {
  if (meters < 1000) return `${meters} m`
  const km = meters / 1000
  return `${Number.isInteger(km) ? km : km.toFixed(1)} km`
}
