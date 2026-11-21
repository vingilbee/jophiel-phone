// The push background handler must be registered before the app mounts: Android may start the JS
// runtime headless just to handle a data message while the app is closed.
import './src/push/background'
import 'expo-router/entry'
