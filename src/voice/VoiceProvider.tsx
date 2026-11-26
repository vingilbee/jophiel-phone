import { useQuery } from '@tanstack/react-query'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useRouter } from 'expo-router'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { fetchCapabilities } from '@/api/auth'
import { useChat } from '@/chat/ChatProvider'
import { batteryPermission, microphonePermission, requestMicrophonePermission, showsBatteryStep } from '@/setup/permissions'
import { getSettings, updateSettings, useSettings } from '@/settings/store'
import { audioAvailable, onCallAction, onCallServiceState, startCallService, stopCallService, updateCallNotification } from './audio'
import { callNotificationAction, callNotificationText } from './callNotification'
import { addReplyAudio, beginReplyClip } from './replyClip'
import { loadTuning } from './tuning'
import { useVoiceSession, type VoiceSession } from './useVoiceSession'

const KEEP_AWAKE_TAG = 'jophiel-voice-call'

export type StartOutcome = 'started' | 'denied' | 'blocked' | 'failed'

interface Voice {
  session: VoiceSession
  /** The server has voice (`/api/capabilities`) and this build has the audio module. */
  available: boolean
  /** The call is starting (permission prompt, mic opening). */
  starting: boolean
  /** Start a call: asks for the mic first if needed. Voice never starts by itself. */
  start: () => Promise<StartOutcome>
  /** A voice call is on (any state but off). */
  live: boolean
  /** She's thinking or speaking, or you're talking over her. */
  busy: boolean
}

const VoiceContext = createContext<Voice | null>(null)

/**
 * The voice call on the Chat screen: the ported web voice loop (useVoiceSession) wired to the chat
 * socket's voice channel and to the chat model (heard fades, senses).
 */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const chat = useChat()
  const settings = useSettings()
  const { voice: channel, voiceReady, setVoiceSense, markHeard } = chat
  const capabilities = useQuery({ queryKey: ['capabilities', settings.serverUrl], queryFn: fetchCapabilities })
  const [starting, setStarting] = useState(false)
  const router = useRouter()
  // Phase 5: the call service. Starting it is a request ('pending'); Android answers by promoting
  // it ('up') or refusing ('failed'). Only a refusal stops leaving the app from keeping the call.
  const [service, setService] = useState<'off' | 'pending' | 'up' | 'failed'>('off')
  const serviceUp = service === 'up'

  useEffect(() => {
    void loadTuning()
  }, [])

  const session = useVoiceSession({
    conversationId: chat.state.conversationId,
    connected: voiceReady,
    keepInBackground: settings.keepListeningInBackground && service !== 'failed',
    onHeard: markHeard,
    socket: useMemo(
      () => ({
        startVoice: (id: string | null, rate: number) => channel.startVoice(id, rate),
        sendAudio: (pcm: Int16Array) => channel.sendAudio(pcm),
        endVoice: (id: string | null) => channel.endVoice(id),
        cancelVoice: () => channel.cancelVoice(),
        leave: () => channel.leave(),
        interruptVoiceStart: (id: string | null, rate: number) => channel.interruptVoiceStart(id, rate),
        holdVoice: (id: string | null, rate: number) => channel.holdVoice(id, rate),
        commitHold: () => channel.commitHold(),
        endHold: () => channel.endHold(),
        resumeHold: () => channel.resumeHold(),
        stopHold: () => channel.stopHold(),
        adoptHold: (id: string | null) => channel.adoptHold(id),
        reportHeard: (heard: number) => channel.reportHeard(heard),
        reportVoiceLatency: (report: Parameters<typeof channel.reportVoiceLatency>[0]) => channel.reportVoiceLatency(report),
      }),
      [channel],
    ),
  })

  // The socket's voice events go to the session of this render (its callbacks read refs).
  const sessionRef = useRef(session)
  sessionRef.current = session
  useEffect(() => {
    channel.events = {
      onAudioStart: (rate, unprompted) => {
        if (sessionRef.current.state === 'off') return
        beginReplyClip(rate)
        if (unprompted) sessionRef.current.beginUnpromptedSpeech()
      },
      onAudio: (pcm, rate) => {
        if (sessionRef.current.state === 'off') return
        addReplyAudio(pcm)
        sessionRef.current.handleAudio(pcm, rate)
      },
      onAudioEnd: () => sessionRef.current.handleAudioEnd(),
      onAudioSegment: (segment, start, end) => sessionRef.current.handleAudioSegment(segment, start, end),
      onBargeResolved: (action) => sessionRef.current.handleBargeResolved(action),
      onReplyInterrupted: () => sessionRef.current.yieldToEvent(),
      onDisconnect: () => sessionRef.current.handleDisconnect(),
      onWorking: () => sessionRef.current.handleWorking(),
    }
    return () => {
      channel.events = {}
    }
  }, [channel])

  // Her senses: whether she may speak aloud to this phone, and whether you're talking.
  const live = session.state !== 'off'
  useEffect(() => {
    setVoiceSense({
      speaking: session.state === 'listening' && !session.muted,
      hearingEnabled: live && !session.muted,
      voiceState: session.state,
    })
  }, [session.state, session.muted, live, setVoiceSense])

  // The screen stays on during a call.
  useEffect(() => {
    if (!live) return
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {})
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {})
    }
  }, [live])

  // Phase 5: the call service (notification, wake and Wi-Fi locks) lives as long as the call. Started
  // for every call while the app is visible, even with the background setting off: Android 14
  // refuses to start it at the moment you leave.
  useEffect(() => {
    if (!live) return
    const requested = startCallService()
    setService(requested ? 'pending' : 'failed')
    // The call went live after you'd already left (the mic opened late), so the leaving rule never
    // saw it: apply it now. No service request, or the setting off, means it can't stay.
    if (AppState.currentState !== 'active' && (!requested || !getSettings().keepListeningInBackground)) {
      sessionRef.current.leave()
    }
    return () => {
      stopCallService()
      setService('off')
    }
  }, [live])

  // Phase 5: Android's answer. Refused (or the service stopped under a live call) while the app is
  // already in the background: nothing keeps the mic there, so end the call as in phase 4.
  useEffect(() => {
    const subscription = onCallServiceState((running) => {
      if (sessionRef.current.state === 'off') return
      setService(running ? 'up' : 'failed')
      if (!running && AppState.currentState !== 'active') sessionRef.current.leave()
    })
    return () => subscription.remove()
  }, [])

  // Phase 5: the notification follows the call's state.
  const notificationText = callNotificationText(session)
  const notificationAction = callNotificationAction(session)
  useEffect(() => {
    if (!live) return
    updateCallNotification(notificationText, notificationAction, session.muted)
  }, [live, notificationText, notificationAction, session.muted, serviceUp])

  // Phase 5: the notification's buttons and the headset button.
  useEffect(() => {
    const subscription = onCallAction((action) => {
      const current = sessionRef.current
      if (current.state === 'off') return
      switch (action) {
        case 'interrupt':
          current.interrupt()
          break
        case 'talk':
          current.pushToTalk()
          break
        case 'mute':
          current.setMuted(true)
          break
        case 'unmute':
          current.setMuted(false)
          break
        case 'end':
          current.disable()
          break
        case 'button':
          // Headset / AirPods button (best effort): Interrupt while she's busy, Talk now when idle.
          if (current.state === 'thinking' || current.state === 'speaking' || current.holding) current.interrupt()
          else if (current.state === 'idle' && !current.muted) current.pushToTalk()
          break
      }
    })
    return () => subscription.remove()
  }, [])

  // Phase 5: the first call that goes to the background while Samsung may put the app to sleep
  // opens the battery step once you're back (once; afterwards only Settings → Permissions shows it).
  const liveRef = useRef(live)
  liveRef.current = live
  // The qualifying call is noted at once; the battery state is read on return, so a quick return
  // can't beat the check, nor a late answer carry over to a later return.
  useEffect(() => {
    let backgroundCall = false
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        const current = getSettings()
        if (liveRef.current && current.keepListeningInBackground && !current.batteryPromptShown && showsBatteryStep()) {
          backgroundCall = true
        }
      } else if (next === 'active' && backgroundCall) {
        backgroundCall = false
        void batteryPermission().then((battery) => {
          if (battery !== 'denied' || getSettings().batteryPromptShown) return
          updateSettings({ batteryPromptShown: true })
          router.push('/setup/battery')
        })
      }
    })
    return () => subscription.remove()
  }, [router])

  const { enable } = session
  const start = useCallback(async (): Promise<StartOutcome> => {
    setStarting(true)
    try {
      let permission = await microphonePermission()
      if (permission !== 'granted') permission = await requestMicrophonePermission()
      if (permission === 'blocked') return 'blocked'
      if (permission !== 'granted') return 'denied'
      await enable()
      return 'started'
    } catch {
      return 'failed'
    } finally {
      setStarting(false)
    }
  }, [enable])

  const value = useMemo<Voice>(
    () => ({
      session,
      available: audioAvailable && capabilities.data?.voice_enabled === true,
      starting,
      start,
      live,
      busy: session.state === 'thinking' || session.state === 'speaking' || session.holding,
    }),
    [session, capabilities.data?.voice_enabled, starting, start, live],
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

export function useVoice(): Voice {
  const voice = useContext(VoiceContext)
  if (!voice) throw new Error('useVoice outside VoiceProvider')
  return voice
}
