import Constants from 'expo-constants'

/**
 * Push is compiled in only when google-services.json was present at build time (see app.config.ts).
 * Without it nothing push-related is shown: no switch before the feature works.
 */
export const pushEnabled: boolean = Constants.expoConfig?.extra?.pushEnabled === true
