import { Text, type TextProps, type TextStyle } from 'react-native'
import { type, useColors, type Palette } from '@/theme'

export type TypeRole = keyof typeof type

interface Props extends Omit<TextProps, 'role'> {
  role?: TypeRole
  color?: keyof Palette
  weight?: TextStyle['fontWeight']
}

/** Text in a Material type role and a palette color. Never a hand-picked size. */
export function AppText({ role = 'bodyLarge', color = 'onSurface', weight, style, ...rest }: Props) {
  const colors = useColors()
  return (
    <Text
      {...rest}
      style={[type[role] as TextStyle, { color: colors[color] }, weight ? { fontWeight: weight } : null, style]}
    />
  )
}
