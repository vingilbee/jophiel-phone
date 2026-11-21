import { useQuery } from '@tanstack/react-query'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { fetchCapabilities } from '@/api/auth'
import { useChat } from '@/chat/ChatProvider'
import { microphonePermission, requestMicrophonePermission } from '@/setup/permissions'
import { useSettings } from '@/settings/store'
import { audioAvailable } from './audio'
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

  useEffect(() => {
    void loadTuning()
  }, [])

  const session = useVoiceSession({
    conversationId: chat.state.conversationId,
    connected: voiceReady,
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
