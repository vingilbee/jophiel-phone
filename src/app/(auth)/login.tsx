import { useRef, useState } from 'react'
import { StyleSheet, View, type TextInputInstance } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { signInErrorMessage, useSession } from '@/auth/session'
import { AppText } from '@/components/AppText'
import { Button, TextField } from '@/components/Controls'
import { JophielMark } from '@/components/Marks'
import { getSettings } from '@/settings/store'
import { space } from '@/theme'

export default function Login() {
  const { signIn } = useSession()
  const insets = useSafeAreaInsets()
  const [server, setServer] = useState(() => getSettings().serverUrl)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emailRef = useRef<TextInputInstance>(null)
  const passwordRef = useRef<TextInputInstance>(null)

  const serverMissing = !server.trim()
  const canSubmit = !serverMissing && email.trim().length > 0 && password.length > 0

  const submit = async () => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError(null)
    try {
      await signIn(server, email, password)
    } catch (err) {
      setError(signInErrorMessage(err))
      setBusy(false)
    }
  }

  return (
    <KeyboardAwareScrollView
      bottomOffset={space.xl}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.page, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + space.xl }]}
    >
      <View style={styles.head}>
        <JophielMark size={56} />
        <AppText role="headlineSmall" accessibilityRole="header">
          Jophiel
        </AppText>
        <AppText role="bodyLarge" color="onSurfaceVariant">
          Sign in with your Jophiel account.
        </AppText>
      </View>

      <View style={styles.form}>
        <TextField
          ref={emailRef}
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          submitBehavior="submit"
        />
        <TextField
          ref={passwordRef}
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <TextField
          label="Server address"
          value={server}
          onChangeText={setServer}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://your-mac.your-tailnet.ts.net"
          supporting="Your Mac's address. In the emulator it's http://10.0.2.2:8000."
          returnKeyType="go"
          onSubmitEditing={submit}
        />

        {error ? (
          <View accessibilityLiveRegion="assertive">
            <AppText role="bodyMedium" color="error">
              {error}
            </AppText>
          </View>
        ) : null}

        <Button label="Sign in" onPress={submit} loading={busy} disabled={!canSubmit} style={styles.submit} />
      </View>
    </KeyboardAwareScrollView>
  )
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, paddingHorizontal: space.xl, gap: space.xxl },
  head: { gap: space.sm, alignItems: 'flex-start' },
  form: { gap: space.lg },
  submit: { marginTop: space.sm, alignSelf: 'stretch' },
})
