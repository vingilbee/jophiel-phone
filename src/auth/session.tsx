import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Device from 'expo-device'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, setUnauthorizedHandler } from '@/api/client'
import { fetchMe, requestToken, signOutRemote, type User } from '@/api/auth'
import { loadSettings, updateSettings } from '@/settings/store'
import { normalizeServerUrl } from '@/settings/defaults'
import { clearToken, getToken, setToken } from './token'

type Status = 'loading' | 'signedOut' | 'signedIn'

interface Session {
  status: Status
  user: User | null
  signIn: (server: string, email: string, password: string) => Promise<void>
  /** `remote: false` when the server already ended the session (401 / close 1008). */
  signOut: (options?: { remote?: boolean }) => Promise<void>
}

const USER_KEY = 'jophiel.user'
const SessionContext = createContext<Session | null>(null)

/** Hooks other modules run on sign-out (push unregisters, chat drops its queue). */
const signOutHooks = new Set<() => Promise<void> | void>()
export function onSignOut(hook: () => Promise<void> | void) {
  signOutHooks.add(hook)
  return () => {
    signOutHooks.delete(hook)
  }
}

/** The signed-in user saved at sign-in, or null if it's missing or unreadable (only used for display). */
async function readStoredUser(): Promise<User | null> {
  try {
    const stored = await AsyncStorage.getItem(USER_KEY)
    const user: unknown = stored ? JSON.parse(stored) : null
    if (user && typeof user === 'object' && typeof (user as User).email === 'string') return user as User
  } catch {
    // corrupt: drop it below
  }
  await AsyncStorage.removeItem(USER_KEY).catch(() => {})
  return null
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<User | null>(null)
  const signingOut = useRef(false)

  useEffect(() => {
    void (async () => {
      // Startup must always end in a screen: a storage failure can't leave the app blank.
      await loadSettings().catch(() => {})
      let token: string | null = null
      try {
        token = await getToken()
      } catch {
        // The keystore entry is unreadable (e.g. restored from a backup onto another phone).
        await clearToken().catch(() => {})
      }
      if (!token) {
        setStatus('signedOut')
        return
      }
      const user = await readStoredUser()
      setUser(user)
      setStatus('signedIn')
      if (!user) {
        // Fetch it again for Settings' "Signed in as"; a 401 here signs out as usual.
        fetchMe()
          .then(async (fresh) => {
            setUser(fresh)
            await AsyncStorage.setItem(USER_KEY, JSON.stringify(fresh))
          })
          .catch(() => {})
      }
    })()
  }, [])

  const signOut = useCallback(async ({ remote = true }: { remote?: boolean } = {}) => {
    if (signingOut.current) return
    signingOut.current = true
    try {
      for (const hook of signOutHooks) {
        try {
          await hook()
        } catch {
          // best effort: signing out must never get stuck
        }
      }
      if (remote) await signOutRemote().catch(() => {})
      await clearToken()
      await AsyncStorage.removeItem(USER_KEY)
      setUser(null)
      setStatus('signedOut')
    } finally {
      signingOut.current = false
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => void signOut({ remote: false }))
    return () => setUnauthorizedHandler(null)
  }, [signOut])

  const signIn = useCallback(async (serverInput: string, email: string, password: string) => {
    const server = normalizeServerUrl(serverInput)
    const deviceName = Device.deviceName || Device.modelName || 'Android phone'
    const result = await requestToken(server, email.trim(), password, deviceName)
    await setToken(result.token)
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(result.user))
    updateSettings({ serverUrl: server })
    setUser(result.user)
    setStatus('signedIn')
  }, [])

  const value = useMemo(() => ({ status, user, signIn, signOut }), [status, user, signIn, signOut])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession outside SessionProvider')
  return session
}

/** Plain-words message for a failed sign-in. */
export function signInErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'unauthorized') return 'Wrong email or password.'
    if (error.kind === 'unreachable') return "Can't reach the server. Is the Mac on, and is the address right?"
    if (error.kind === 'rate_limited') return 'Too many tries. Wait a minute, then try again.'
    if (error.status === 422) return 'Check the email address.'
    return error.message
  }
  return 'Something went wrong. Try again.'
}
