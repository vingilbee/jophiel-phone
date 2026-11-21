import Constants from 'expo-constants'

/**
 * Push needs google-services.json at build time (see app.config.ts) *and* a native build made
 * with it. The JS config is re-read on every dev reload, so it can say "yes" while the installed
 * app was built before the file existed; then the native Firebase app is missing and every
 * Firebase call throws "No Firebase App '[DEFAULT]'". So the native side has the last word.
 * Without push nothing push-related is shown: no switch before the feature works.
 */
function nativeFirebaseReady(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApps } = require('@react-native-firebase/app') as typeof import('@react-native-firebase/app')
    return getApps().length > 0
  } catch {
    return false
  }
}

const configured = Constants.expoConfig?.extra?.pushEnabled === true

export const pushEnabled: boolean = configured && nativeFirebaseReady()

if (configured && !pushEnabled && __DEV__) {
  console.warn(
    'Push is configured (google-services.json) but this build has no Firebase. Rebuild the native app: ' +
      'bunx expo prebuild --platform android --clean && bun run android',
  )
}
