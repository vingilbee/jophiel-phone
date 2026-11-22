import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { onSignOut } from '@/auth/session'
import { connectionPhase, type ConnectionPhase } from '@/connection/state'
import { updateSettings } from '@/settings/store'
import { clearPresentedNotifications } from '@/push/display'
import { retryPushRegistration } from '@/push/registration'
import { phoneSenses } from '@/senses/native'
import { ChatConnection } from './connection'
import type { VoiceState } from './frames'
import { chatReducer, initialChatState, isReplying, isThinking, visibleItems, type ChatAction, type ChatItem, type ChatState } from './model'
import { clearQueue, loadQueue, newTurnId, saveQueue } from './queue'
import { clearTimeout as clearNativeTimeout, setTimeout as setNativeTimeout, type TimerHandle } from '@/voice/timers'
import type { VoiceChannel } from './voice'

/**
 * After this long in the background the socket closes; push takes over. Not while a voice call is
 * on (phase 5): then it starts when the call ends. On the native clock, since JS timers don't fire
 * in the background.
 */
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
  /** Voice turns and audio on the chat socket. */
  voice: VoiceChannel
  /** Connected and the history is in: a voice turn can start. */
  voiceReady: boolean
  /** Report the voice call's state (her senses: can she speak aloud here, are you talking). */
  setVoiceSense: (sense: VoiceSense) => void
  /** A spoken reply was cut off after you heard `heardChars` of it: fade the rest. */
  markHeard: (turnId: string, heardChars: number) => void
}

export interface VoiceSense {
  /** The mic is open and capturing your turn. */
  speaking: boolean
  /** A call is on and the mic isn't muted. */
  hearingEnabled: boolean
  voiceState: VoiceState
}

const VOICE_OFF: VoiceSense = { speaking: false, hearingEnabled: false, voiceState: 'off' }

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
  const voiceSense = useRef<VoiceSense>(VOICE_OFF)
  const queueLoaded = useRef(false)
  const closeTimer = useRef<TimerHandle | null>(null)
  const [voiceReady, setVoiceReady] = useState(false)

  const connection = useMemo(
    () =>
      new ChatConnection(
        {
          onFrame: (frame) => dispatch({ type: 'frame', frame, now: new Date().toISOString() }),
          onSendFailed: (turnId) => dispatch({ type: 'sendFailed', turnId }),
          onSettleTurn: (turnId) => dispatch({ type: 'settleTurn', turnId }),
          onReadyChange: setVoiceReady,
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
            activity: voiceSense.current.speaking ? 'speaking' : activity.current,
            visible: appState.current === 'active',
            last_active_at: new Date().toISOString(),
            hearing_enabled: voiceSense.current.hearingEnabled,
            wake_armed: false,
            voice_state: voiceSense.current.voiceState,
          }),
          phone: (full) => phoneSenses.report(full),
          phoneSent: (report, full) => phoneSenses.markSent(report, full),
          knowsMessage: (messageId) => stateRef.current.messages.some((m) => m.id === messageId),
        },
      ),
    [dispatch],
  )

  /**
   * Phase 6: the phone's live senses run while the app is on screen or a call keeps it alive in the
   * background (reported in `sense` frames); otherwise only the closed-app wake-ups report.
   */
  const updateSensesLive = useCallback(() => {
    phoneSenses.setLive(appState.current === 'active' || voiceSense.current.voiceState !== 'off')
  }, [])

  useEffect(() => {
    const link = { sendSense: () => connection.sendSense(), isOpen: () => connection.open }
    phoneSenses.attach(link)
    updateSensesLive()
    return () => {
      phoneSenses.detach(link)
      phoneSenses.setLive(false)
    }
  }, [connection, updateSensesLive])

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

  const cancelBackgroundClose = useCallback(() => {
    clearNativeTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])

  /** In the background with no call on: close in a while. */
  const scheduleBackgroundClose = useCallback(() => {
    if (appState.current === 'active' || voiceSense.current.voiceState !== 'off' || closeTimer.current !== null) return
    closeTimer.current = setNativeTimeout(() => {
      closeTimer.current = null
      connection.stop()
    }, BACKGROUND_CLOSE_MS)
  }, [connection])

  // Foreground: connect, clear her notifications. Background: close after a while.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const was = appState.current
      appState.current = next
      updateSensesLive()
      if (next === 'active') {
        cancelBackgroundClose()
        // Coming back from the background starts a fresh "down" clock: the socket was closed on purpose.
        setDownSince(connection.open ? null : Date.now())
        connection.start()
        connection.sendSense()
        void clearPresentedNotifications()
      } else if (was === 'active') {
        connection.sendSense()
        scheduleBackgroundClose()
      }
    })
    return () => {
      subscription.remove()
      cancelBackgroundClose()
    }
  }, [connection, cancelBackgroundClose, scheduleBackgroundClose, updateSensesLive])

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

  const setVoiceSense = useCallback(
    (next: VoiceSense) => {
      const previous = voiceSense.current
      if (
        previous.speaking === next.speaking &&
        previous.hearingEnabled === next.hearingEnabled &&
        previous.voiceState === next.voiceState
      ) {
        return
      }
      voiceSense.current = next
      updateSensesLive()
      connection.sendSense()
      // Phase 5: a call that ends in the background lets the socket close as usual.
      if (next.voiceState === 'off') scheduleBackgroundClose()
      else cancelBackgroundClose()
    },
    [connection, cancelBackgroundClose, scheduleBackgroundClose, updateSensesLive],
  )
  const markHeard = useCallback(
    (turnId: string, heardChars: number) => dispatch({ type: 'heard', turnId, heardChars }),
    [dispatch],
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
      voice: connection.voice,
      voiceReady,
      setVoiceSense,
      markHeard,
    }),
    [
      state,
      open,
      downSince,
      now,
      everConnected,
      send,
      stop,
      retryNow,
      retryMessage,
      deleteMessage,
      dismissError,
      setActivity,
      connection,
      voiceReady,
      setVoiceSense,
      markHeard,
    ],
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat(): Chat {
  const chat = useContext(ChatContext)
  if (!chat) throw new Error('useChat outside ChatProvider')
  return chat
}
