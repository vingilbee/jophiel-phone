import * as SecureStore from 'expo-secure-store'

// The session token lives only in the Android keystore-backed secure store: never in plain storage,
// never logged.
const KEY = 'jophiel.session-token'

let cached: string | null | undefined

export async function getToken(): Promise<string | null> {
  if (cached !== undefined) return cached
  cached = await SecureStore.getItemAsync(KEY)
  return cached
}

export async function setToken(token: string): Promise<void> {
  cached = token
  await SecureStore.setItemAsync(KEY, token)
}

export async function clearToken(): Promise<void> {
  cached = null
  await SecureStore.deleteItemAsync(KEY)
}
