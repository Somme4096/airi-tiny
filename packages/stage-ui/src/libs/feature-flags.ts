import { boolean, record, string } from 'valibot'

export const featureFlagPreferencesSchema = record(string(), boolean())
export const featureFlagVariantPreferencesSchema = record(string(), string())

/** A client-owned experiment. Each choice is a device choice, and no server can change it. */
export interface FeatureFlag {
  key: string
  titleKey: string
  descriptionKey: string
  defaultEnabled: boolean
  /** Only the desktop app has the feature, so other apps neither list nor enable it. */
  desktopOnly?: boolean
  /**
   * The ways to run the feature. They exclude each other, so the user picks one while the feature is on. The first
   * option is the default.
   */
  variants?: {
    titleKey: string
    descriptionKey: string
    options: readonly { value: string, titleKey: string }[]
  }
}

export interface FeatureFlagDecision {
  enabled: boolean
  source: 'default' | 'local'
}

/**
 * The fullscreen mode of the desktop app, where settings and the chat open beside the character. It is a device
 * choice, off by default, and the standalone settings window stays the default.
 *
 * - `single-window`: the main window grows over the screen and shows the mode.
 * - `multi-window`: a window of its own shows the mode, and the main window stays on the desktop as it is.
 */
export const FULLSCREEN_WORKSPACE_FLAG = {
  key: 'fullscreen-workspace',
  titleKey: 'settings.pages.system.experimental.features.fullscreen_workspace.title',
  descriptionKey: 'settings.pages.system.experimental.features.fullscreen_workspace.description',
  defaultEnabled: false,
  desktopOnly: true,
  variants: {
    titleKey: 'settings.pages.system.experimental.features.fullscreen_workspace.window_mode.title',
    descriptionKey: 'settings.pages.system.experimental.features.fullscreen_workspace.window_mode.description',
    options: [
      { value: 'single-window', titleKey: 'settings.pages.system.experimental.features.fullscreen_workspace.window_mode.single_window' },
      { value: 'multi-window', titleKey: 'settings.pages.system.experimental.features.fullscreen_workspace.window_mode.multi_window' },
    ],
  },
} as const satisfies FeatureFlag

/** Only implemented experiments belong here. An empty catalog produces an empty settings page. */
export const featureFlags: readonly FeatureFlag[] = [FULLSCREEN_WORKSPACE_FLAG]

/** The variant of a feature: the saved one while the feature still offers it, otherwise the first one. */
export function resolveFeatureVariant(feature: FeatureFlag | undefined, saved: string | undefined): string | undefined {
  const options = feature?.variants?.options
  if (!options?.length)
    return undefined
  return options.some(option => option.value === saved) ? saved : options[0].value
}

/** The experiments that an app offers. An app other than the desktop app leaves out the desktop-only ones. */
export function offeredFeatureFlags(desktop: boolean): readonly FeatureFlag[] {
  return featureFlags.filter(feature => desktop || !feature.desktopOnly)
}

/** A saved device choice wins. Without one, the feature uses its default. */
export function resolveFeatureFlag(feature: FeatureFlag, preference: boolean | undefined): FeatureFlagDecision {
  return { enabled: preference ?? feature.defaultEnabled, source: preference === undefined ? 'default' : 'local' }
}
