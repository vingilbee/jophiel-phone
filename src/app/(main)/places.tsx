import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Alert, Pressable, StyleSheet, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/components/AppText'
import { Button, IconButton, ListRow, TextField } from '@/components/Controls'
import { currentLocation, sensesAvailable, type Fix } from '@/senses/native'
import {
  DEFAULT_RADIUS,
  MAX_PLACE_NAME,
  MAX_PLACES,
  newPlaceId,
  placeName,
  RADIUS_CHOICES,
  radiusLabel,
  type Place,
} from '@/senses/places'
import { locationPermission, openAppSettings, requestLocationPermission } from '@/setup/permissions'
import { getSettings, updateSettings, useSettings } from '@/settings/store'
import { radius as shape, space, useColors } from '@/theme'

type Editing = { mode: 'new'; fix: Fix } | { mode: 'edit'; id: string }

/** The circle sizes offered, plus the place's own if it was saved with another one. */
function sizeChoices(current: number): number[] {
  const choices: number[] = [...RADIUS_CHOICES]
  return choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b)
}

export default function Places() {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { places } = useSettings()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [name, setName] = useState('')
  const [size, setSize] = useState<number>(DEFAULT_RADIUS)
  const [nameError, setNameError] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)
  const [problem, setProblem] = useState<{ text: string; settings: boolean } | null>(null)

  const savePlaces = (next: Place[]) => updateSettings({ places: next })

  const startHere = async () => {
    setProblem(null)
    if (places.length >= MAX_PLACES) {
      setProblem({ text: `Android allows ${MAX_PLACES} places at most. Delete one to add another.`, settings: false })
      return
    }
    setLocating(true)
    try {
      let permission = await locationPermission()
      if (permission !== 'granted') permission = await requestLocationPermission()
      if (permission === 'blocked') {
        setProblem({ text: 'Android won’t ask again. In the app settings, tap Permissions → Location, allow it and turn on “Use precise location”.', settings: true })
        return
      }
      if (permission !== 'granted') {
        setProblem({ text: 'Places need precise location. Allow it (with “Precise” on) to add one.', settings: false })
        return
      }
      const fix = await currentLocation()
      if (!fix) {
        setProblem({ text: 'Couldn’t find where you are. Is location turned on? Try again, ideally near a window or outside.', settings: false })
        return
      }
      setName('')
      setNameError(null)
      setSize(DEFAULT_RADIUS)
      setEditing({ mode: 'new', fix })
    } finally {
      setLocating(false)
    }
  }

  const startEdit = (place: Place) => {
    setProblem(null)
    setName(place.name)
    setNameError(null)
    setSize(place.radius)
    setEditing({ mode: 'edit', id: place.id })
  }

  const save = () => {
    if (!editing) return
    const clean = placeName(name)
    if (!clean) {
      setNameError('Give it a name, like “home” or “the gym”.')
      return
    }
    const current = getSettings().places
    if (editing.mode === 'new') {
      const { latitude, longitude } = editing.fix
      savePlaces([...current, { id: newPlaceId(), name: clean, latitude, longitude, radius: size }])
    } else {
      savePlaces(current.map((place) => (place.id === editing.id ? { ...place, name: clean, radius: size } : place)))
    }
    setEditing(null)
  }

  const remove = (place: Place) => {
    Alert.alert(`Delete “${place.name}”?`, 'She won’t hear about arriving there or leaving any more.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          savePlaces(getSettings().places.filter((p) => p.id !== place.id))
          setEditing(null)
        },
      },
    ])
  }

  const editingPlace = editing?.mode === 'edit' ? places.find((p) => p.id === editing.id) ?? null : null
  const accuracy = editing?.mode === 'new' ? Math.round(editing.fix.accuracy) : null

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.appBar, { paddingTop: insets.top, backgroundColor: colors.surface }]}>
        <IconButton icon="arrow-left" label="Back" onPress={() => router.back()} color={colors.onSurface} />
        <AppText role="titleLarge" accessibilityRole="header">
          Places
        </AppText>
      </View>

      <KeyboardAwareScrollView bottomOffset={space.xl} contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}>
        <AppText role="bodyMedium" color="onSurfaceVariant" style={styles.intro}>
          She hears “Arrived at home” or “Left home”, with the name as you write it. The places and their positions stay on this
          phone; only the name is sent.
        </AppText>

        {editing ? (
          <View style={[styles.editor, { backgroundColor: colors.surfaceContainer, borderColor: colors.outlineVariant }]}>
            <AppText role="titleMedium" accessibilityRole="header">
              {editing.mode === 'new' ? 'New place, where you are now' : `Edit “${editingPlace?.name ?? ''}”`}
            </AppText>
            {accuracy !== null ? (
              <AppText role="bodySmall" color={accuracy > size ? 'error' : 'onSurfaceVariant'}>
                {accuracy > size
                  ? `Your position is only known to about ${accuracy} m, wider than the circle. Pick a bigger size, or try again outside.`
                  : `Position found, to about ${accuracy} m.`}
              </AppText>
            ) : null}
            <TextField
              label="Name"
              value={name}
              onChangeText={(text) => {
                setName(text)
                setNameError(null)
              }}
              maxLength={MAX_PLACE_NAME}
              autoCapitalize="none"
              autoFocus={editing.mode === 'new'}
              returnKeyType="done"
              onSubmitEditing={save}
              placeholder="home"
              error={nameError}
              supporting="She reads it as written."
            />
            <View style={styles.sizes}>
              <AppText role="labelLarge" color="onSurfaceVariant">
                Circle size
              </AppText>
              <View style={styles.chips} accessibilityRole="radiogroup">
                {sizeChoices(size).map((choice) => {
                  const selected = choice === size
                  return (
                    <Pressable
                      key={choice}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`${radiusLabel(choice)} circle`}
                      onPress={() => setSize(choice)}
                      android_ripple={{ color: colors.ripple }}
                      style={[
                        styles.chip,
                        {
                          backgroundColor: selected ? colors.primaryContainer : 'transparent',
                          borderColor: selected ? colors.primaryContainer : colors.outline,
                        },
                      ]}
                    >
                      <AppText role="labelLarge" color={selected ? 'onPrimaryContainer' : 'onSurfaceVariant'}>
                        {radiusLabel(choice)}
                      </AppText>
                    </Pressable>
                  )
                })}
              </View>
              <AppText role="bodySmall" color="onSurfaceVariant">
                Bigger circles notice arriving sooner and work better indoors.
              </AppText>
            </View>
            <View style={styles.editorActions}>
              {editingPlace ? <Button label="Delete" variant="text" onPress={() => remove(editingPlace)} /> : <View />}
              <View style={styles.editorRight}>
                <Button label="Cancel" variant="text" onPress={() => setEditing(null)} />
                <Button label="Save" onPress={save} />
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.addRow}>
            <Button
              label="I’m here now"
              icon="crosshairs-gps"
              onPress={() => void startHere()}
              loading={locating}
              disabled={!sensesAvailable}
              style={styles.addButton}
            />
          </View>
        )}

        {problem ? (
          <View style={[styles.problem, { backgroundColor: colors.warnContainer }]} accessibilityLiveRegion="polite">
            <AppText role="bodyMedium" style={{ color: colors.onWarnContainer }}>
              {problem.text}
            </AppText>
            {problem.settings ? <Button label="Open app settings" variant="tonal" onPress={() => void openAppSettings()} style={styles.problemButton} /> : null}
          </View>
        ) : null}

        {places.length === 0 ? (
          <AppText role="bodyMedium" color="onSurfaceVariant" style={styles.empty}>
            No places yet. Go somewhere you’d like her to know (home, work, the gym) and tap “I’m here now”.
          </AppText>
        ) : (
          places.map((place) => (
            <ListRow
              key={place.id}
              icon="map-marker-outline"
              title={place.name}
              supporting={`${radiusLabel(place.radius)} circle`}
              onPress={() => startEdit(place)}
            />
          ))
        )}
      </KeyboardAwareScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  appBar: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.xs, minHeight: 64 },
  intro: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md },
  addRow: { paddingHorizontal: space.lg, paddingBottom: space.md },
  addButton: { alignSelf: 'flex-start' },
  editor: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.lg,
    borderRadius: shape.card,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.lg,
  },
  sizes: { gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 40,
    minWidth: 48,
    paddingHorizontal: space.lg,
    borderRadius: shape.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  editorActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  editorRight: { flexDirection: 'row', gap: space.sm },
  problem: { borderRadius: shape.field, padding: space.lg, marginHorizontal: space.lg, marginBottom: space.md, gap: space.md },
  problemButton: { alignSelf: 'flex-start' },
  empty: { paddingHorizontal: space.lg, paddingVertical: space.md },
})
