import { Emotion } from '@proj-airi/stage-ui/constants/emotions'
import { describe, expect, it } from 'vitest'

import { describeRulingExpression, describeShift, messageShift, shiftEmotion } from './affect'

const expression = { minDelta: 0.03, emotions: { elation: Emotion.Happy, intimacy: Emotion.Happy, anxiety: Emotion.Awkward, irritability: Emotion.Angry } }

describe('messageShift', () => {
  // A decision (system_one) picked intimacy (+0.10), and a mod delta moved elation further (+0.64).
  // The decision is the companion's own judgment, so the expression follows it.
  it('follows the decided emotion even when another dimension moved further', () => {
    const shift = messageShift(
      'intimacy',
      { intimacy: 0.35, elation: 0.2 },
      { intimacy: 0.45, elation: 0.84 },
    )

    expect(shift).toEqual({ dimension: 'intimacy', delta: 0.1, value: 0.45, decided: true })
  })

  // Without a decision the ingest response gives `affect: null`, but mod deltas still moved irritability.
  it('falls back to the largest move when no decision picked an emotion', () => {
    const shift = messageShift(undefined, { elation: 0.2, irritability: 0.15 }, { elation: 0.21, irritability: 1 })

    expect(shift).toEqual({ dimension: 'irritability', delta: 0.85, value: 1, decided: false })
  })

  it('treats a fall as a change of the same size as a rise', () => {
    const shift = messageShift(undefined, { elation: 0.5, anxiety: 0.6 }, { elation: 0.55, anxiety: 0.3 })

    expect(shift).toEqual({ dimension: 'anxiety', delta: -0.3, value: 0.3, decided: false })
  })

  it('skips dimensions that only one snapshot has', () => {
    expect(messageShift(undefined, { elation: 0.2 }, { elation: 0.25, wonder: 0.9 })?.dimension).toBe('elation')
    expect(messageShift('wonder', { elation: 0.2 }, { elation: 0.25 })).toBeUndefined()
  })
})

describe('shiftEmotion', () => {
  it('shows a decided emotion, also at its cap', () => {
    expect(shiftEmotion({ dimension: 'irritability', delta: 0, value: 1, decided: true }, expression)).toBe('angry')
  })

  it('shows an undecided rise from the minimum change', () => {
    expect(shiftEmotion({ dimension: 'elation', delta: 0.03, value: 0.23, decided: false }, expression)).toBe('happy')
    expect(shiftEmotion({ dimension: 'elation', delta: 0.02, value: 0.22, decided: false }, expression)).toBeUndefined()
  })

  it('shows nothing for an undecided fall or an unmapped dimension', () => {
    expect(shiftEmotion({ dimension: 'anxiety', delta: -0.3, value: 0.3, decided: false }, expression)).toBeUndefined()
    expect(shiftEmotion({ dimension: 'wonder', delta: 0.5, value: 0.5, decided: true }, expression)).toBeUndefined()
  })
})

describe('describeShift', () => {
  it('names the expression of a decided emotion', () => {
    const hint = describeShift({ dimension: 'intimacy', delta: 0.1, value: 0.45, decided: true }, expression)

    expect(hint).toBe('<affect_shift>The user\'s last message stirred intimacy: it rose by 0.10 to 0.45. Open your reply with <|ACT {"emotion":"happy"}|> to show it.</affect_shift>')
  })

  // A value at its cap cannot rise, but the decision still says the message stirred that feeling.
  it('names the expression of a decided emotion at its cap', () => {
    const hint = describeShift({ dimension: 'irritability', delta: 0, value: 1, decided: true }, expression)

    expect(hint).toBe('<affect_shift>The user\'s last message stirred irritability: it stays at 1.00. Open your reply with <|ACT {"emotion":"angry"}|> to show it.</affect_shift>')
  })

  it('names the expression for an undecided rise', () => {
    const hint = describeShift({ dimension: 'irritability', delta: 0.85, value: 1, decided: false }, expression)

    expect(hint).toBe('<affect_shift>The user\'s last message moved irritability the most: it rose by 0.85 to 1.00. Open your reply with <|ACT {"emotion":"angry"}|> to show it.</affect_shift>')
  })

  it('names no expression for an undecided fall', () => {
    const hint = describeShift({ dimension: 'anxiety', delta: -0.3, value: 0.3, decided: false }, expression)

    expect(hint).toBe('<affect_shift>The user\'s last message moved anxiety the most: it fell by 0.30 to 0.30.</affect_shift>')
  })

  it('names no expression for a dimension without a mapping', () => {
    const hint = describeShift({ dimension: 'wonder', delta: 0.2, value: 0.5, decided: true }, expression)

    expect(hint).not.toContain('<|ACT')
    expect(hint).toContain('stirred wonder')
  })

  it('stays empty for an undecided change below the minimum', () => {
    expect(describeShift({ dimension: 'elation', delta: 0.01, value: 0.21, decided: false }, expression)).toBe('')
    expect(describeShift(undefined, expression)).toBe('')
  })
})

describe('describeRulingExpression', () => {
  it('maps the ruling feeling of a proactive event', () => {
    expect(describeRulingExpression('anxiety', expression.emotions)).toBe('Open the message with <|ACT {"emotion":"awkward"}|>.')
    expect(describeRulingExpression('wonder', expression.emotions)).toBe('')
  })
})
