/// <reference types="node" />
import { existsSync } from 'node:fs'
import type { ExpoConfig } from 'expo/config'

// Push needs a Firebase project's google-services.json (Phase 2). Without it the app still builds and
// runs; Settings and Setup just don't show notification controls (no switch before the feature works).
const googleServicesFile = './google-services.json'
const pushEnabled = existsSync(googleServicesFile)

const config: ExpoConfig = {
  name: 'Jophiel',
  slug: 'jophiel',
  scheme: 'jophiel',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  android: {
    package: 'com.jophiel.app',
    adaptiveIcon: {
      backgroundColor: '#C2603E',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
    },
    predictiveBackGestureEnabled: true,
    softwareKeyboardLayoutMode: 'resize',
    // Voice (phase 4): the mic, and the audio routing a voice call needs (loudspeaker / headphones).
    permissions: ['android.permission.POST_NOTIFICATIONS', 'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS'],
    ...(pushEnabled ? { googleServicesFile } : {}),
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    './plugins/withNotificationIcon',
    ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 160, backgroundColor: '#B8572F' }],
    // Plain HTTP (http://10.0.2.2:8000) works only in debug builds: the debug manifest that prebuild
    // generates allows cleartext; release builds keep Android's default (HTTPS only).
    ['expo-build-properties', { android: { minSdkVersion: 26 } }],
    ...(pushEnabled ? ['@react-native-firebase/app', '@react-native-firebase/messaging'] : []),
  ],
  experiments: { typedRoutes: true },
  extra: { pushEnabled },
}

export default config
