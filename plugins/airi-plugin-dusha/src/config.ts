import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'
import { Emotion, EMOTION_VALUES } from '@proj-airi/stage-ui/constants/emotions'

import * as v from 'valibot'

/**
 * Maps a Dusha dimension to the AIRI emotion that shows its rise.
 *
 * The keys are the dimensions in the default Dusha `emotions.json`. A companion with custom dimensions
 * extends or replaces entries through `expression.emotions` in the config file.
 */
const defaultExpressionEmotions: Record<string, Emotion> = {
  vitality: Emotion.Happy,
  fatigue: Emotion.Sad,
  longing: Emotion.Sad,
  intimacy: Emotion.Happy,
  possessiveness: Emotion.Awkward,
  lust: Emotion.Awkward,
  jealousy: Emotion.Angry,
  anxiety: Emotion.Awkward,
  protectiveness: Emotion.Think,
  fear: Emotion.Surprise,
  contentment: Emotion.Happy,
  elation: Emotion.Happy,
  seeking: Emotion.Curious,
  play: Emotion.Happy,
  dejection: Emotion.Sad,
  irritability: Emotion.Angry,
}

const nonEmptyString = v.pipe(v.string(), v.trim(), v.nonEmpty())

const configSchema = v.strictObject({
  dusha: v.optional(v.strictObject({
    url: v.optional(v.pipe(nonEmptyString, v.url()), 'http://127.0.0.1:8765'),
    /** Sent as `X-Companion-Token`. Empty when the Dusha service runs without auth. */
    token: v.optional(v.string(), ''),
    /** Dusha keys stored conversations and proactive events by this name. */
    harness: v.optional(nonEmptyString, 'airi'),
    conversationId: v.optional(nonEmptyString, 'airi'),
    timeoutSeconds: v.optional(v.pipe(v.number(), v.minValue(1)), 60),
    /**
     * AIRI already sends its own chat history to the model, so recent records stay out of the injection by default.
     * Turn this on only when the AIRI history is short or cleared often.
     */
    includeRecent: v.optional(v.boolean(), false),
  }), {}),
  channel: v.optional(v.strictObject({
    url: v.optional(nonEmptyString, 'ws://localhost:6121/ws'),
    /** The token from AIRI Settings > Connection. */
    token: v.optional(v.string(), ''),
  }), {}),
  proactive: v.optional(v.strictObject({
    enabled: v.optional(v.boolean(), true),
    pollIntervalSeconds: v.optional(v.pipe(v.number(), v.minValue(5)), 30),
  }), {}),
  expression: v.optional(v.strictObject({
    enabled: v.optional(v.boolean(), true),
    /** A smaller change of the strongest dimension sends no expression hint. */
    minDelta: v.optional(v.pipe(v.number(), v.minValue(0)), 0.03),
    /** Merged over the default map. An entry for an existing dimension replaces it. */
    emotions: v.optional(v.record(nonEmptyString, v.picklist(EMOTION_VALUES)), {}),
  }), {}),
})

type ParsedConfig = v.InferOutput<typeof configSchema>

/** Resolved plugin settings. Every field has a value after {@link loadConfig}. */
export type DushaPluginConfig = ParsedConfig & {
  expression: ParsedConfig['expression'] & { emotions: Record<string, Emotion> }
}

/**
 * Returns the config file path that {@link loadConfig} reads.
 *
 * `AIRI_DUSHA_CONFIG` wins so that tests and several AIRI profiles can point at their own file.
 * Otherwise the file lives under the XDG config root, outside the extension folder, because a folder import
 * replaces the extension folder on each update.
 *
 * @example
 * resolveConfigPath({ HOME: '/home/airi' })
 * // => '/home/airi/.config/airi-dusha/config.json'
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.AIRI_DUSHA_CONFIG)
    return env.AIRI_DUSHA_CONFIG

  const configRoot = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configRoot, 'airi-dusha', 'config.json')
}

/**
 * Reads and validates the plugin config file.
 *
 * A missing file gives the defaults, so the plugin can start against a local Dusha service with no setup.
 * A file that is not valid JSON or does not match the schema throws, and the extension host reports the
 * setup failure.
 */
export async function loadConfig(path: string): Promise<DushaPluginConfig> {
  let raw: unknown = {}
  try {
    raw = JSON.parse(await readFile(path, 'utf-8'))
  }
  catch (error) {
    if (!isMissingFile(error))
      throw new Error(`Cannot read the Dusha plugin config at ${path}: ${errorMessageFrom(error)}`)
  }

  const result = v.safeParse(configSchema, raw)
  if (!result.success)
    throw new Error(`The Dusha plugin config at ${path} is not valid: ${v.summarize(result.issues)}`)

  const config = result.output
  return {
    ...config,
    expression: {
      ...config.expression,
      emotions: { ...defaultExpressionEmotions, ...config.expression.emotions },
    },
  }
}

function isMissingFile(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
