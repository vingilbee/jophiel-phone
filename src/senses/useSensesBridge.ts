import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { onSignOut } from '@/auth/session'
import { getToken } from '@/auth/token'
import { locationPermission } from '@/setup/permissions'
import { getSettings, useSettings } from '@/settings/store'
import { checkPlaceNow, clearReporting, configureNative, phoneSenses, sensesAvailable, setReporting } from './native'

/** At most one "where am I" fix per this long when the app opens (each one wakes the GPS). */
const PLACE_CHECK_EVERY_MS = 10 * 60_000

let lastPlaceCheck = 0

/**
 * On app open, the place from one fix. Without "Allow all the time" there are no geofences, so
 * this is the only way she learns it; with it, it catches a departure missed while the phone was
 * off. `force`: the places just changed.
 */
async function maybeCheckPlace(force: boolean) {
  const { senses, places } = getSettings()
  if (!senses.places || places.length === 0) return
  if (!force && Date.now() - lastPlaceCheck < PLACE_CHECK_EVERY_MS) return
  if ((await locationPermission()) !== 'granted') return
  lastPlaceCheck = Date.now()
  await checkPlaceNow()
}

/**
 * Phase 6, signed in: hands the module the server and token for background reports, keeps its
 * switches and places in step with Settings (re-applied when the app comes back, since a
 * permission may have changed in Android's settings), and stops everything on logout. Mounted
 * once, in the signed-in layout.
 */
export function useSensesBridge() {
  const settings = useSettings()
  const previous = useRef<{ places: unknown; placesOn: boolean } | null>(null)

  useEffect(() => {
    if (!sensesAvailable) return
    let cancelled = false
    void getToken().then((token) => {
      if (!cancelled && token) setReporting(getSettings().serverUrl, token)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!sensesAvailable) return
    configureNative(settings.senses, settings.places)
    phoneSenses.setSwitches(settings.senses)
    // A fix now when the places changed or Places was switched on; otherwise the app-open rule.
    const before = previous.current
    previous.current = { places: settings.places, placesOn: settings.senses.places }
    const placesChanged = before !== null && (before.places !== settings.places || (!before.placesOn && settings.senses.places))
    if (AppState.currentState === 'active') void maybeCheckPlace(placesChanged)
  }, [settings.senses, settings.places])

  useEffect(() => {
    if (!sensesAvailable) return
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return
      const { senses, places } = getSettings()
      configureNative(senses, places)
      void maybeCheckPlace(false)
    })
    return () => subscription.remove()
  }, [])

  useEffect(
    () =>
      onSignOut(() => {
        phoneSenses.reset()
        clearReporting()
        lastPlaceCheck = 0
      }),
    [],
  )
}
