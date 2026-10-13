import type { ChatHistoryItem } from '../types/chat'

import { describe, expect, it } from 'vitest'

import { estimateTokens, findCompaction, planCompaction } from './history-compaction'

const system: ChatHistoryItem = { role: 'system', content: 'system prompt', id: 'system' }

/** Builds user and assistant pairs of about 100 tokens for each message. */
function createTurns(count: number, from = 0): ChatHistoryItem[] {
  return Array.from({ length: count }, (_, offset): ChatHistoryItem[] => {
    const index = from + offset
    return [
      { role: 'user', content: `question-${index} ${'u'.repeat(380)}`, id: `user-${index}`, createdAt: 1000 + index * 10 },
      { role: 'assistant', content: `answer-${index} ${'a'.repeat(380)}`, id: `assistant-${index}`, createdAt: 1005 + index * 10, slices: [], tool_results: [] },
    ]
  }).flat()
}

function reportedReply(id: string, createdAt: number, totalTokens: number): ChatHistoryItem {
  return {
    role: 'assistant',
    content: 'reported answer',
    id,
    createdAt,
    slices: [],
    tool_results: [],
    generationTranscript: {
      type: 'assistant',
      id,
      status: 'completed',
      rounds: [{
        id: `${id}-round`,
        modelCall: { model: 'model', finishReason: 'stop', usage: { inputTokens: totalTokens - 10, outputTokens: 10, totalTokens } },
        content: [{ type: 'text', text: 'reported answer' }],
        toolInvocations: [],
        projectionIssues: [],
      }],
    },
  }
}

describe('estimateTokens', () => {
  it('counts four latin characters for each token', () => {
    expect(estimateTokens('hello world!')).toBe(3)
  })

  it('counts each CJK character as one token', () => {
    expect(estimateTokens('こんにちは')).toBe(5)
  })
})

describe('planCompaction', () => {
  it('leaves a history that fits the window', () => {
    expect(planCompaction([system, ...createTurns(2)], 1000)).toBeUndefined()
  })

  it('summarizes the messages before the first kept user message', () => {
    const plan = planCompaction([system, ...createTurns(10)], 1000)

    // The window keeps 400 tokens, which is the four newest messages of about 100 tokens.
    expect(plan?.messageId).toBe('user-8')
    expect(plan?.summarizedCount).toBe(16)
    expect(plan?.prompt.user).toContain('question-0')
    expect(plan?.prompt.user).toContain('answer-7')
    expect(plan?.prompt.user).not.toContain('question-8')
    expect(plan?.prompt.user).not.toContain('system prompt')
  })

  it('folds the earlier summary into the next one', () => {
    const history = [system, ...createTurns(12)]
    history[5] = { ...history[5], compaction: { summary: 'first summary', createdAt: 900 } }

    const plan = planCompaction(history, 1000)

    expect(plan?.messageId).toBe('user-10')
    expect(plan?.prompt.user).toContain('Earlier summary:\nfirst summary')
    expect(plan?.prompt.user).toContain('question-2')
    expect(plan?.prompt.user).not.toContain('question-1 ')
  })

  it('uses the token report of the newest reply as the prompt size', () => {
    const history = [system, ...createTurns(10), reportedReply('reported', 2000, 300), { role: 'user', content: 'next', id: 'next', createdAt: 2010 } satisfies ChatHistoryItem]

    expect(planCompaction(history, 1000)).toBeUndefined()
  })

  it('ignores a token report that is older than the marker', () => {
    const history = [system, ...createTurns(2), reportedReply('reported', 2000, 900_000), ...createTurns(2, 2)]
    // The reply sits after the marker in the list, but its report measured the history before the summary.
    history[3] = { ...history[3], compaction: { summary: 'summary', createdAt: 3000 } }

    expect(planCompaction(history, 1000)).toBeUndefined()
  })

  it('does not plan when the recent history is smaller than the kept part', () => {
    const history = [system, ...createTurns(1), reportedReply('reported', 2000, 900_000), { role: 'user', content: 'next', id: 'next', createdAt: 2010 } satisfies ChatHistoryItem]

    expect(planCompaction(history, 1000)).toBeUndefined()
  })

  it('selects the default window when the provider reports zero', () => {
    expect(planCompaction([system, ...createTurns(10)], 0)).toBeUndefined()
  })

  it('describes media with the stored text', () => {
    const history: ChatHistoryItem[] = [
      system,
      {
        role: 'user',
        id: 'media',
        createdAt: 1000,
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'asset://image' } },
          { type: 'input_audio', input_audio: { data: 'asset://audio', format: 'wav' } },
        ],
        imageDescriptions: [{ imageIndex: 0, description: 'a red bicycle' }],
        audioTranscripts: ['good morning'],
      },
      ...createTurns(10),
    ]

    const plan = planCompaction(history, 1000)

    expect(plan?.prompt.user).toContain('look [Image: a red bicycle] [Recording: good morning]')
  })
})

describe('findCompaction', () => {
  it('returns the newest marker', () => {
    const history = createTurns(3)
    history[2] = { ...history[2], compaction: { summary: 'old', createdAt: 1 } }
    history[4] = { ...history[4], compaction: { summary: 'new', createdAt: 2 } }

    expect(findCompaction(history)).toEqual({ start: 4, compaction: { summary: 'new', createdAt: 2 } })
  })
})
