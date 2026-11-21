import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons'
import { forwardRef, useState, type ComponentProps, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Switch, TextInput, View, type TextInputInstance, type TextInputProps, type ViewStyle } from 'react-native'
import { radius, space, type, useColors } from '@/theme'
import { AppText } from './AppText'

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name']

export function Icon({ name, size = 24, color }: { name: IconName; size?: number; color: string }) {
  return <MaterialCommunityIcons name={name} size={size} color={color} />
}

type ButtonVariant = 'filled' | 'tonal' | 'text'

interface ButtonProps {
  label: string
  onPress: () => void
  variant?: ButtonVariant
  icon?: IconName
  loading?: boolean
  disabled?: boolean
  style?: ViewStyle
}

/** Material 3 common buttons: filled for the one primary action, tonal for secondary, text for the quiet way out. */
export function Button({ label, onPress, variant = 'filled', icon, loading, disabled, style }: ButtonProps) {
  const colors = useColors()
  const inactive = disabled || loading
  const background = variant === 'filled' ? colors.primary : variant === 'tonal' ? colors.surfaceContainerHigh : 'transparent'
  const foreground = variant === 'filled' ? colors.onPrimary : variant === 'tonal' ? colors.onSurface : colors.primary
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      onPress={onPress}
      disabled={inactive}
      android_ripple={{ color: colors.ripple, foreground: true }}
      style={[
        styles.button,
        variant === 'text' && styles.textButton,
        { backgroundColor: background, opacity: disabled ? 0.38 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={foreground} size="small" />
      ) : (
        <>
          {icon ? <Icon name={icon} size={18} color={foreground} /> : null}
          <AppText role="labelLarge" style={{ color: foreground }}>
            {label}
          </AppText>
        </>
      )}
    </Pressable>
  )
}

interface IconButtonProps {
  icon: IconName
  label: string
  onPress: () => void
  color?: string
  disabled?: boolean
}

/** 48dp touch target around a 24dp icon. */
export function IconButton({ icon, label, onPress, color, disabled }: IconButtonProps) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      android_ripple={{ color: colors.ripple, borderless: true, radius: 24 }}
      style={[styles.iconButton, disabled && styles.disabled]}
    >
      <Icon name={icon} color={color ?? colors.onSurfaceVariant} />
    </Pressable>
  )
}

interface FieldProps extends TextInputProps {
  label: string
  error?: string | null
  supporting?: string
}

/** Material 3 outlined text field, label above the box (readable at any font scale). */
export const TextField = forwardRef<TextInputInstance, FieldProps>(function TextField(
  { label, error, supporting, style, onFocus, onBlur, ...rest },
  ref,
) {
  const colors = useColors()
  const [focused, setFocused] = useState(false)
  const borderColor = error ? colors.error : focused ? colors.primary : colors.outline
  return (
    <View style={styles.field}>
      <AppText role="labelLarge" color={error ? 'error' : focused ? 'primary' : 'onSurfaceVariant'}>
        {label}
      </AppText>
      <TextInput
        ref={ref}
        {...rest}
        accessibilityLabel={label}
        onFocus={(e) => {
          setFocused(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          onBlur?.(e)
        }}
        placeholderTextColor={colors.onSurfaceVariant}
        selectionColor={colors.primary}
        cursorColor={colors.primary}
        style={[
          styles.input,
          type.bodyLarge,
          {
            color: colors.onSurface,
            backgroundColor: colors.surfaceContainer,
            borderColor,
            borderWidth: focused || error ? 2 : 1,
            paddingHorizontal: focused || error ? space.lg - 1 : space.lg,
          },
          style,
        ]}
      />
      {error || supporting ? (
        <AppText role="bodySmall" color={error ? 'error' : 'onSurfaceVariant'} accessibilityLiveRegion="polite">
          {error ?? supporting}
        </AppText>
      ) : null}
    </View>
  )
})

export function SectionHeader({ title }: { title: string }) {
  return (
    <AppText role="titleSmall" color="primary" accessibilityRole="header" style={styles.sectionHeader}>
      {title}
    </AppText>
  )
}

interface RowProps {
  title: string
  supporting?: string | null
  icon?: IconName
  trailing?: ReactNode
  onPress?: () => void
  danger?: boolean
}

/** Material list item: one or two lines, optional leading icon and trailing control. */
export function ListRow({ title, supporting, icon, trailing, onPress, danger }: RowProps) {
  const colors = useColors()
  const content = (
    <>
      {icon ? <Icon name={icon} color={danger ? colors.error : colors.onSurfaceVariant} /> : null}
      <View style={styles.rowText}>
        <AppText role="bodyLarge" color={danger ? 'error' : 'onSurface'}>
          {title}
        </AppText>
        {supporting ? (
          <AppText role="bodyMedium" color="onSurfaceVariant">
            {supporting}
          </AppText>
        ) : null}
      </View>
      {trailing}
    </>
  )
  if (!onPress) return <View style={styles.row}>{content}</View>
  return (
    <Pressable accessibilityRole="button" onPress={onPress} android_ripple={{ color: colors.ripple }} style={styles.row}>
      {content}
    </Pressable>
  )
}

interface SwitchRowProps {
  title: string
  supporting?: string
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
}

export function SwitchRow({ title, supporting, value, onValueChange, disabled }: SwitchRowProps) {
  const colors = useColors()
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      accessibilityLabel={title}
      accessibilityHint={supporting}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      android_ripple={{ color: colors.ripple }}
      style={[styles.row, disabled && { opacity: 0.38 }]}
    >
      <View style={styles.rowText}>
        <AppText role="bodyLarge">{title}</AppText>
        {supporting ? (
          <AppText role="bodyMedium" color="onSurfaceVariant">
            {supporting}
          </AppText>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        importantForAccessibility="no"
        trackColor={{ false: colors.surfaceContainerHigh, true: colors.primary }}
        thumbColor={value ? colors.onPrimary : colors.outline}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    overflow: 'hidden',
  },
  textButton: { paddingHorizontal: space.md },
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.38 },
  field: { gap: 6 },
  input: { minHeight: 56, borderRadius: radius.field, paddingVertical: space.md },
  sectionHeader: { paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.sm },
  row: {
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
  },
  rowText: { flex: 1, gap: 2 },
})
