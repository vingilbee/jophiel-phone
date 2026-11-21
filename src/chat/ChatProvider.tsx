import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { onSignOut } from '@/auth/session'
import { connectionPhase, type ConnectionPhase } from '@/connection/state'
import { updateSettings } from '@/settings/store'
import { clearPresentedNotifications } from '@/push/display'
import { retryPushRegistration } from '@/push/registration'
import { ChatConnection } from './connection'
import { chatReducer, initialChatState, isReplying, isThinking, visibleItems, type ChatAction, type ChatItem, type ChatState } from './model'
import { clearQueue, loadQueue, newTurnId, saveQueue } from './queue'

/** After this long in the background the socket closes; push takes over. */
const BACKGROUND_CLOSE_MS = 30_000
/** How long after a history snapshot a still-running turn has to show itself (its replayed stream). */
const REPLAY_GRACE_MS = 10_000

interface Chat {
  state: ChatState
  items: ChatItem[]
  replying: boolean
  thinking: boolean
  phase: ConnectionPhase
  send: (text: string) => void
  stop: () => void
  retryNow: () => void
  /** A failed message: put it back in line, or drop it. */
  retryMessage: (turnId: string) => void
  deleteMessage: (turnId: string) => void
  dismissError: () => void
  /** Report what the user is doing (typing / reading), for her sense of the moment. */
  setActivity: (activity: 'idle' | 'reading' | 'typing') => void
}

const ChatContext = createContext<Chat | null>(null)

function timezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatchReact] = useReducer(chatReducer, initialChatState)
  // The connection reads the state between renders (to pick the next message right after an ack),
  // so the ref is advanced eagerly with the same pure reducer React uses.
  const stateRef = useRef(state)
  const dispatch = useCallback((action: ChatAction) => {
    stateRef.current = chatReducer(stateRef.current, action)
    dispatchReact(action)
  }, [])
  const [open, setOpen] = useState(false)
  const [downSince, setDownSince] = useState<number | null>(() => Date.now())
  const [everConnected, setEverConnected] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const appState = useRef<AppStateStatus>((AppState.currentState ?? 'active') as AppStateStatus)
  const activity = useRef<'idle' | 'reading' | 'typing'>('reading')
  const queueLoaded = useRef(false)

  const connection = useMemo(
    () =>
      new ChatConnection(
        {
          onFrame: (frame) => dispatch({ type: 'frame', frame, now: new Date().toISOString() }),
          onSendFailed: (turnId) => dispatch({ type: 'sendFailed', turnId }),
          onOpenChange: (isOpen) => {
            setOpen(isOpen)
            if (isOpen) {
              setEverConnected(true)
              setDownSince(null)
              updateSettings({ lastConnectedAt: new Date().toISOString() })
              retryPushRegistration()
            } else {
              setDownSince((since) => since ?? Date.now())
            }
          },
        },
        {
          queue: () => stateRef.current.queue,
          conversationId: () => stateRef.current.conversationId,
          resumeTurnId: () => stateRef.current.live.find((item) => !item.unprompted)?.turnId ?? null,
          sense: () => ({
            timezone: timezone(),
            route: '/chat',
            activity: activity.current,
            visible: appState.current === 'active',
            last_active_at: new Date().toISOString(),
          }),
        },
      ),
    [dispatch],
  )

  // Restore the waiting queue, then connect.
  useEffect(() => {
    let cancelled = false
    void loadQueue().then((queue) => {
      if (cancelled) return
      dispatch({ type: 'restoreQueue', queue })
      queueLoaded.current = true
      if (AppState.currentState === 'active') {
        connection.start()
        // Launched fresh (not back from the background): her notifications are seen now too.
        void clearPresentedNotifications()
      }
    })
    return () => {
      cancelled = true
      connection.stop()
    }
  }, [connection, dispatch])

  // After a history snapshot, give the backend's replay of a running turn this long to show up.
  useEffect(() => {
    if (state.unconfirmedTurns.length === 0) return
    const timer = setTimeout(() => dispatch({ type: 'expireUnconfirmedTurns' }), REPLAY_GRACE_MS)
    return () => clearTimeout(timer)
  }, [state.unconfirmedTurns, dispatch])

  // Persist the queue on every change, and try to send.
  useEffect(() => {
    if (!queueLoaded.current) return
    void saveQueue(state.queue)
    connection.pump()
  }, [state.queue, connection])

  // Foreground: connect, clear her notifications. Background: close after a while.
  useEffect(() => {
    let closeTimer: ReturnType<typeof setTimeout> | null = null
    const subscription = AppState.addEventListener('change', (next) => {
      const was = appState.current
      appState.current = next
      if (next === 'active') {
        if (closeTimer) clearTimeout(closeTimer)
        closeTimer = null
        // Coming back from the background starts a fresh "down" clock: the socket was closed on purpose.
        setDownSince(connection.open ? null : Date.now())
        connection.start()
        connection.sendSense()
        void clearPresentedNotifications()
      } else if (was === 'active') {
        connection.sendSense()
        closeTimer = setTimeout(() => connection.stop(), BACKGROUND_CLOSE_MS)
      }
    })
    return () => {
      subscription.remove()
      if (closeTimer) clearTimeout(closeTimer)
    }
  }, [connection])

  // Drop the queue on sign-out: it belongs to this account.
  useEffect(
    () =>
      onSignOut(async () => {
        connection.stop()
        dispatch({ type: 'reset' })
        await clearQueue()
      }),
    [connection, dispatch],
  )

  // Tick the clock while disconnected, so the banner moves from "Reconnecting…" to "Can't reach".
  useEffect(() => {
    if (open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])

  const send = useCallback((text: string) => {
    const content = text.trim()
    if (!content) return
    dispatch({ type: 'enqueue', message: { turnId: newTurnId(), content, writtenAt: new Date().toISOString() } })
  }, [dispatch])

  const stop = useCallback(() => connection.stopReply(), [connection])
  const retryNow = useCallback(() => {
    setDownSince(Date.now())
    connection.retryNow()
  }, [connection])
  const retryMessage = useCallback((turnId: string) => dispatch({ type: 'retryQueued', turnId }), [dispatch])
  const deleteMessage = useCallback((turnId: string) => dispatch({ type: 'deleteQueued', turnId }), [dispatch])
  const dismissError = useCallback(() => dispatch({ type: 'clearError' }), [dispatch])
  const setActivity = useCallback(
    (next: 'idle' | 'reading' | 'typing') => {
      if (activity.current === next) return
      activity.current = next
      connection.sendSense()
    },
    [connection],
  )

  const value = useMemo<Chat>(
    () => ({
      state,
      items: visibleItems(state),
      replying: isReplying(state),
      thinking: isThinking(state),
      phase: connectionPhase(open, downSince, now, everConnected),
      send,
      stop,
      retryNow,
      retryMessage,
      deleteMessage,
      dismissError,
      setActivity,
    }),
    [state, open, downSince, now, everConnected, send, stop, retryNow, retryMessage, deleteMessage, dismissError, setActivity],
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat(): Chat {
  const chat = useContext(ChatContext)
  if (!chat) throw new Error('useChat outside ChatProvider')
  return chat
}
