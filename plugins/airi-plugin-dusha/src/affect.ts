import type { Emotion } from '@proj-airi/stage-ui/constants/emotions'

import type { AffectValues } from './client'

/** How one user message moved affect, and the dimension that the expression follows. */
export interface AffectShift {
  dimension: string
  /** `after - before`. Negative when the dimension fell. */
  delta: number
  value: number
  /**
   * `true` when a Dusha decision, for example the system_one mod, picked this dimension.
   * `false` when no decision picked one and the dimension is only the largest move, for example from mod `deltas`.
   */
  decided: boolean
}

/**
 * Finds the dimension that the expression follows for one user message.
 *
 * Precedence:
 * 1. The emotion that a Dusha decision picked, from the ingest response. The decision is the companion's own judgment
 *    of the message, so it wins even when mod `deltas` moved another dimension further.
 * 2. Otherwise the largest absolute change between the `base` snapshots. Without a decision the ingest response gives
 *    `affect: null`, although mod `deltas` can still move affect.
 *
 * Decay between the two snapshots is in the order of 1e-4, far below any change that a message makes.
 *
 * @example
 * messageShift('intimacy', { elation: 0.2, intimacy: 0.35 }, { elation: 0.84, intimacy: 0.45 })
 * // => { dimension: 'intimacy', delta: 0.1, value: 0.45, decided: true }
 * messageShift(undefined, { elation: 0.2, intimacy: 0.35 }, { elation: 0.84, intimacy: 0.45 })
 * // => { dimension: 'elation', delta: 0.64, value: 0.84, decided: false }
 */
export function messageShift(decided: string | undefined, before: AffectValues, after: AffectValues): AffectShift | undefined {
  if (decided !== undefined) {
    const value = after[decided]
    if (value === undefined)
      return undefined
    return { dimension: decided, delta: round(value - (before[decided] ?? value)), value, decided: true }
  }

  let strongest: AffectShift | undefined
  for (const [dimension, value] of Object.entries(after)) {
    const previous = before[dimension]
    if (previous === undefined)
      continue

    const delta = round(value - previous)
    if (!strongest || Math.abs(delta) > Math.abs(strongest.delta))
      strongest = { dimension, delta, value, decided: false }
  }
  return strongest
}

/**
 * Selects the AIRI emotion that shows a shift, or `undefined` when the shift shows none.
 *
 * - A decided dimension always shows its emotion. A value at its cap can barely rise, but the feeling is still there.
 * - An undecided dimension needs a rise of at least `minDelta`. A fall means a feeling faded, and no single
 *   expression shows that.
 *
 * @example
 * shiftEmotion({ dimension: 'intimacy', delta: 0, value: 1, decided: true }, { minDelta: 0.03, emotions: { intimacy: 'happy' } })
 * // => 'happy'
 */
export function shiftEmotion(
  shift: AffectShift | undefined,
  options: { minDelta: number, emotions: Record<string, Emotion> },
): Emotion | undefined {
  if (!shift || (!shift.decided && shift.delta < options.minDelta))
    return undefined
  return options.emotions[shift.dimension]
}

/**
 * Writes the hint that tells the model which feeling moved and which expression to open with.
 *
 * AIRI's runtime prompt already tells the model to start every reply with an ACT token. The hint picks the emotion
 * for that token with {@link shiftEmotion}. An undecided change below `minDelta` gives no hint.
 *
 * @example
 * describeShift({ dimension: 'irritability', delta: 0.85, value: 1, decided: false }, { minDelta: 0.03, emotions: { irritability: 'angry' } })
 * // => '<affect_shift>The user\'s last message moved irritability the most: it rose by 0.85 to 1.00.
 * //     Open your reply with <|ACT {"emotion":"angry"}|> to show it.</affect_shift>'
 */
export function describeShift(
  shift: AffectShift | undefined,
  options: { minDelta: number, emotions: Record<string, Emotion> },
): string {
  if (!shift || (!shift.decided && Math.abs(shift.delta) < options.minDelta))
    return ''

  const change = Math.abs(shift.delta) < 0.005
    ? `it stays at ${shift.value.toFixed(2)}`
    : `it ${shift.delta > 0 ? 'rose' : 'fell'} by ${Math.abs(shift.delta).toFixed(2)} to ${shift.value.toFixed(2)}`
  const sentences = [
    shift.decided
      ? `The user's last message stirred ${shift.dimension}: ${change}.`
      : `The user's last message moved ${shift.dimension} the most: ${change}.`,
  ]

  const emotion = shiftEmotion(shift, options)
  if (emotion)
    sentences.push(`Open your reply with ${actToken(emotion)} to show it.`)

  return `<affect_shift>${sentences.join(' ')}</affect_shift>`
}

/**
 * Writes the expression line for a proactive message from the ruling feeling of the event.
 *
 * @example
 * describeRulingExpression('longing', { longing: 'sad' })
 * // => 'Open the message with <|ACT {"emotion":"sad"}|>.'
 */
export function describeRulingExpression(dimension: string, emotions: Record<string, Emotion>): string {
  const emotion = emotions[dimension]
  return emotion ? `Open the message with ${actToken(emotion)}.` : ''
}

function actToken(emotion: Emotion) {
  return `<|ACT ${JSON.stringify({ emotion })}|>`
}

/** Dusha rounds stored values to 4 places. Rounding the difference hides float noise such as 0.6399999999. */
function round(value: number) {
  return Math.round(value * 10_000) / 10_000
}
