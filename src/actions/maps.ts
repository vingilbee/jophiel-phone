import type { NavigateArgs, TravelMode } from './protocol'

/** `google.navigation` modes: d drive, l two-wheeler, w walk, b bicycle (transit has none). */
const NAVIGATION_MODE: Partial<Record<TravelMode, string>> = { drive: 'd', two_wheeler: 'l', walk: 'w', bicycle: 'b' }

/** Maps URLs' `travelmode`. */
const TRAVEL_MODE: Record<TravelMode, string> = {
  drive: 'driving',
  two_wheeler: 'two-wheeler',
  walk: 'walking',
  transit: 'transit',
  bicycle: 'bicycling',
}

/**
 * Where Maps starts navigating. Coordinates go straight into turn-by-turn
 * (`google.navigation:q=lat,lng&mode=…`); transit, and a text destination without coordinates, use a
 * Maps URL that opens directions ready to start. Opened with Maps' package, so never in a browser.
 */
export function mapsUrl(args: NavigateArgs): string {
  const navigation = NAVIGATION_MODE[args.mode]
  if (args.lat !== null && args.lng !== null && navigation) {
    return `google.navigation:q=${args.lat},${args.lng}&mode=${navigation}`
  }
  const destination = args.lat !== null && args.lng !== null ? `${args.lat},${args.lng}` : (args.query ?? '')
  const params = [
    'api=1',
    `destination=${encodeURIComponent(destination)}`,
    ...(args.placeId ? [`destination_place_id=${encodeURIComponent(args.placeId)}`] : []),
    `travelmode=${TRAVEL_MODE[args.mode]}`,
    'dir_action=navigate',
  ]
  return `https://www.google.com/maps/dir/?${params.join('&')}`
}

/** The destination as the notification names it ("To Kemang Village"). */
export function destinationTitle(args: NavigateArgs): string {
  return args.name ?? args.query ?? ''
}
