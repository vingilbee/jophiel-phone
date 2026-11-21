import { useColorScheme } from 'react-native'
import { dark, light, type Palette } from './tokens'

export * from './tokens'

/** Light and dark follow the phone's system setting. */
export function useColors(): Palette {
  return useColorScheme() === 'dark' ? dark : light
}

export function useIsDark(): boolean {
  return useColorScheme() === 'dark'
}
