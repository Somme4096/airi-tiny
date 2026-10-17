import type { FeatureFlag } from './feature-flags'

import { describe, expect, it } from 'vitest'

import { featureFlags, FULLSCREEN_WORKSPACE_FLAG, offeredFeatureFlags, resolveFeatureFlag, resolveFeatureVariant } from './feature-flags'

const feature: FeatureFlag = { key: 'test-feature', titleKey: 'test.title', descriptionKey: 'test.description', defaultEnabled: false }

describe('feature flag decisions', () => {
  it('uses the default until the device saves a choice', () => {
    expect(resolveFeatureFlag(feature, undefined)).toEqual({ enabled: false, source: 'default' })
    expect(resolveFeatureFlag({ ...feature, defaultEnabled: true }, undefined)).toEqual({ enabled: true, source: 'default' })
    expect(resolveFeatureFlag(feature, true)).toEqual({ enabled: true, source: 'local' })
    expect(resolveFeatureFlag({ ...feature, defaultEnabled: true }, false)).toEqual({ enabled: false, source: 'local' })
  })

  // The standalone settings window stays the default, so a user opts in to the fullscreen mode.
  it('registers the main window fullscreen mode as an off-by-default choice', () => {
    expect(featureFlags).toContain(FULLSCREEN_WORKSPACE_FLAG)
    expect(resolveFeatureFlag(FULLSCREEN_WORKSPACE_FLAG, undefined)).toEqual({ enabled: false, source: 'default' })
  })

  // The web and mobile apps have no main window, so their experiments page leaves the mode out.
  it('offers desktop-only experiments only in the desktop app', () => {
    expect(offeredFeatureFlags(true)).toContain(FULLSCREEN_WORKSPACE_FLAG)
    expect(offeredFeatureFlags(false)).not.toContain(FULLSCREEN_WORKSPACE_FLAG)
  })

  // A device can keep a choice that a later version no longer offers. The feature then runs its first variant.
  it('resolves the saved variant, and falls back to the first one for a missing or unknown choice', () => {
    expect(resolveFeatureVariant(FULLSCREEN_WORKSPACE_FLAG, 'multi-window')).toBe('multi-window')
    expect(resolveFeatureVariant(FULLSCREEN_WORKSPACE_FLAG, undefined)).toBe('single-window')
    expect(resolveFeatureVariant(FULLSCREEN_WORKSPACE_FLAG, 'removed-mode')).toBe('single-window')
    expect(resolveFeatureVariant(feature, 'multi-window')).toBeUndefined()
  })
})
