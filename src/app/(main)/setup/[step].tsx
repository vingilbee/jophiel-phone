import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { checkHealth } from '@/api/auth'
import { AppText } from '@/components/AppText'
import { Button, Icon, type IconName } from '@/components/Controls'
import { pushEnabled } from '@/push/config'
import { registerNow } from '@/push/registration'
import { openAppSettings, openBatterySettings, requestNotificationPermission, showsBatteryStep } from '@/setup/permissions'
import { usePermissions } from '@/setup/usePermissions'
import { getSettings, updateSettings } from '@/settings/store'
import { radius, space, useColors } from '@/theme'

type StepId = 'connection' | 'notifications' | 'battery'

function steps(): StepId[] {
  return [
    'connection',
    ...(pushEnabled ? (['notifications'] as const) : []),
    ...(showsBatteryStep() ? (['battery'] as const) : []),
  ]
}

type Check = 'idle' | 'checking' | 'ok' | 'failed'

export default function SetupStep() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { step } = useLocalSearchParams<{ step: StepId }>()
  const all = steps()
  const index = Math.max(0, all.indexOf(step))
  const current = all[index] ?? 'connection'
  const [permissions, refresh] = usePermissions()
  const [check, setCheck] = useState<Check>('idle')

  // Opening Setup once is enough for it to stop opening by itself.
  useEffect(() => {
    if (!getSettings().setupSeen) updateSettings({ setupSeen: true })
  }, [])

  const runCheck = useCallback(async () => {
    setCheck('checking')
    try {
      const health = await checkHealth(getSettings().serverUrl)
      setCheck(health?.status === 'ok' ? 'ok' : 'failed')
    } catch {
      setCheck('failed')
    }
  }, [])

  useEffect(() => {
    if (current === 'connection') void runCheck()
  }, [current, runCheck])

  const next = () => {
    const following = all[index + 1]
    if (following) router.replace(`/setup/${following}`)
    else if (router.canGoBack()) router.back()
    else router.replace('/')
  }

  const done =
    current === 'connection'
      ? check === 'ok'
      : current === 'notifications'
        ? permissions.notifications === 'granted'
        : permissions.battery === 'granted'

  let icon: IconName
  let title: string
  let body: string
  let action: { label: string; onPress: () => void; loading?: boolean } | null
  let problem: string | null = null

  switch (current) {
    case 'connection':
      icon = 'lan-connect'
      title = 'Reaching your Mac'
      body = `Jophiel lives on your Mac. This phone talks to her at ${getSettings().serverUrl || 'the address you signed in with'}.`
      action = check === 'ok' ? null : { label: 'Check again', onPress: () => void runCheck(), loading: check === 'checking' }
      if (check === 'failed') {
        problem = "Can't reach it right now. Is the Mac on and awake? On your phone, is Tailscale connected? You can carry on; the app keeps trying by itself."
      }
      break
    case 'notifications':
      icon = 'bell-outline'
      title = 'Her messages, when you are away'
      body = "When she says something you haven't seen on the web app or here, your phone shows a notification. You can change or turn them off any time in Android's notification settings."
      action =
        permissions.notifications === 'blocked'
          ? { label: 'Open app settings', onPress: () => void openAppSettings() }
          : done
            ? null
            : {
                label: 'Allow notifications',
                onPress: () =>
                  void requestNotificationPermission().then((result) => {
                    refresh()
                    if (result === 'granted') void registerNow()
                  }),
              }
      if (permissions.notifications === 'blocked') {
        problem = 'Android won\'t ask again. In the app settings, tap Notifications and turn them on.'
      }
      break
    case 'battery':
      icon = 'battery-heart-variant'
      title = 'Keep her awake'
      body =
        'Samsung puts apps to sleep to save battery, and sleeping apps get notifications late. In App info, tap Battery and choose Unrestricted. Also make sure Jophiel is not in "Sleeping apps" or "Deep sleeping apps" (Settings → Battery → Background usage limits).'
      action = done ? null : { label: 'Open battery settings', onPress: () => void openBatterySettings() }
      break
  }

  const last = index === all.length - 1

  return (
    <View style={[styles.screen, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <AppText role="labelLarge" color="onSurfaceVariant">
          Setup · {index + 1} of {all.length}
        </AppText>
        <View style={[styles.iconDisc, { backgroundColor: colors.primaryContainer }]}>
          <Icon name={icon} size={32} color={colors.primary} />
        </View>
        <AppText role="headlineSmall" accessibilityRole="header">
          {title}
        </AppText>
        <AppText role="bodyLarge" color="onSurfaceVariant">
          {body}
        </AppText>

        {done ? (
          <View style={styles.done} accessibilityLiveRegion="polite">
            <Icon name="check-circle" size={20} color={colors.primary} />
            <AppText role="titleSmall" color="primary">
              Done
            </AppText>
          </View>
        ) : null}

        {problem ? (
          <View style={[styles.problem, { backgroundColor: colors.warnContainer }]} accessibilityLiveRegion="polite">
            <AppText role="bodyMedium" style={{ color: colors.onWarnContainer }}>
              {problem}
            </AppText>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Button label={done ? (last ? 'Finish' : 'Next') : 'Skip'} variant={done ? 'filled' : 'text'} onPress={next} />
        {action ? <Button label={action.label} onPress={action.onPress} loading={action.loading} variant="filled" /> : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, padding: space.xl, paddingTop: space.xxl, gap: space.lg },
  iconDisc: { width: 64, height: 64, borderRadius: radius.card, alignItems: 'center', justifyContent: 'center', marginTop: space.lg },
  done: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  problem: { borderRadius: radius.field, padding: space.lg },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
    gap: space.md,
  },
})
