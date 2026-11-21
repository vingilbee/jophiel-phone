/**
 * Jophiel's palette: warm paper and warm ink, one terracotta accent.
 * Roles follow Material 3 names so components never reach for raw hex.
 */
export interface Palette {
  background: string
  /** App bar, composer tray. */
  surface: string
  /** Text field, her bubble. */
  surfaceContainer: string
  surfaceContainerHigh: string
  onSurface: string
  onSurfaceVariant: string
  outline: string
  outlineVariant: string
  primary: string
  onPrimary: string
  /** Your bubble. */
  primaryContainer: string
  onPrimaryContainer: string
  /** Secondary text on your bubble (time, ticks). */
  onPrimaryContainerVariant: string
  error: string
  errorContainer: string
  onErrorContainer: string
  /** Connection banner. */
  warnContainer: string
  onWarnContainer: string
  scrim: string
  ripple: string
}

export const light: Palette = {
  background: '#F3EEE6',
  surface: '#F8F4EE',
  surfaceContainer: '#FFFCF8',
  surfaceContainerHigh: '#EAE3D8',
  onSurface: '#221E19',
  onSurfaceVariant: '#655D52',
  outline: '#8A8174',
  outlineVariant: '#DCD4C8',
  primary: '#A64B26',
  onPrimary: '#FFFFFF',
  primaryContainer: '#F4D8C9',
  onPrimaryContainer: '#3A1A0C',
  onPrimaryContainerVariant: '#7A4A35',
  error: '#B3261E',
  errorContainer: '#F9DEDC',
  onErrorContainer: '#410E0B',
  warnContainer: '#EFE0C4',
  onWarnContainer: '#3D2E12',
  scrim: 'rgba(20, 16, 12, 0.32)',
  ripple: 'rgba(34, 30, 25, 0.10)',
}

export const dark: Palette = {
  background: '#171512',
  surface: '#1E1B17',
  surfaceContainer: '#29251F',
  surfaceContainerHigh: '#342F28',
  onSurface: '#EEE8DF',
  onSurfaceVariant: '#B1A898',
  outline: '#8C8476',
  outlineVariant: '#3E3830',
  primary: '#E58C66',
  onPrimary: '#3E1606',
  primaryContainer: '#5B2C19',
  onPrimaryContainer: '#FBE5DA',
  onPrimaryContainerVariant: '#E0B7A4',
  error: '#F2B8B5',
  errorContainer: '#8C1D18',
  onErrorContainer: '#F9DEDC',
  warnContainer: '#3F3420',
  onWarnContainer: '#F3E3C2',
  scrim: 'rgba(0, 0, 0, 0.5)',
  ripple: 'rgba(238, 232, 223, 0.12)',
}

/** Material 3 type roles. Sizes are sp: React Native scales them with the system font size. */
export const type = {
  headlineSmall: { fontSize: 24, lineHeight: 32, fontWeight: '400' },
  titleLarge: { fontSize: 22, lineHeight: 28, fontWeight: '400' },
  titleMedium: { fontSize: 16, lineHeight: 24, fontWeight: '500', letterSpacing: 0.15 },
  titleSmall: { fontSize: 14, lineHeight: 20, fontWeight: '500', letterSpacing: 0.1 },
  bodyLarge: { fontSize: 16, lineHeight: 23, fontWeight: '400', letterSpacing: 0.2 },
  bodyMedium: { fontSize: 14, lineHeight: 20, fontWeight: '400', letterSpacing: 0.25 },
  bodySmall: { fontSize: 12, lineHeight: 16, fontWeight: '400', letterSpacing: 0.3 },
  labelLarge: { fontSize: 14, lineHeight: 20, fontWeight: '500', letterSpacing: 0.1 },
  labelMedium: { fontSize: 12, lineHeight: 16, fontWeight: '500', letterSpacing: 0.4 },
  labelSmall: { fontSize: 11, lineHeight: 14, fontWeight: '500', letterSpacing: 0.4 },
} as const

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const

export const radius = { bubble: 18, bubbleTight: 6, field: 12, pill: 999, card: 16 } as const

/** Material standard easing durations (ms). */
export const motion = { short: 150, medium: 250, long: 400 } as const
