import type { ChatHistoryItem, HistoryCompaction } from '../types/chat'

import { formatTimePrefix } from '../messages/datetime-prefix'

/**
 * Limits that decide when history is compacted and how much stays verbatim.
 *
 * The token values follow pi-durable. The ratios scale them down for models
 * with a small window, where the fixed values exceed the window.
 */
const compactionDefaults = {
  /** Window assumed when the provider reports none. It suits small local models and costs large models only an early summary. */
  contextWindow: 32_000,
  /** Space kept free for the reply, the tool schemas, and the estimate error. */
  reserveTokens: 16_384,
  /** Largest part of the window that the reserve can take. */
  reserveRatio: 0.25,
  /** Recent history that stays verbatim after a compaction. */
  keepRecentTokens: 20_000,
  /** Largest part of the window that the verbatim history can take. */
  keepRecentRatio: 0.4,
}

/** Flat cost of one image, recording, or file. Providers bill media by size, which stored references do not give. */
const MEDIA_TOKENS = 1_000

/** Longest tool result that the summary source keeps. A result is evidence for the summary, not content to repeat. */
const TOOL_RESULT_CHARACTER_LIMIT = 2_000

const SUMMARY_SYSTEM_PROMPT = [
  'You summarize a conversation between a user and an AI character.',
  'Do not continue the conversation. Do not answer its questions. Write only the summary.',
].join(' ')

const SUMMARY_INSTRUCTIONS = [
  'The text above is the earlier part of a conversation.',
  'A later request replaces that part with your summary, so the character must be able to continue from the summary alone.',
  'If the text starts with an earlier summary, keep its information and add the newer messages to it.',
  '',
  'Write these sections:',
  '',
  '## About the user',
  'Facts, preferences, people, and plans that the user shared.',
  '',
  '## What happened',
  'The topics and events in order, with dates when the text gives them.',
  '',
  '## Relationship and tone',
  'How the two speak to each other, running jokes, and promises that the character made.',
  '',
  '## Open threads',
  'Questions, tasks, and topics that are not finished.',
  '',
  'Write in the main language of the conversation. Keep names, numbers, and quotes exact. Use at most 600 words.',
].join('\n')

/** Prompt of the summary request. The orchestrator sends both parts without tools and without the character prompt. */
export interface SummaryPrompt {
  system: string
  user: string
}

/** A compaction that waits for its summary. */
export interface CompactionPlan {
  /** First message that stays verbatim. The caller stores the marker on it. */
  messageId: string
  prompt: SummaryPrompt
  /** Number of messages that the summary replaces in the prompt. */
  summarizedCount: number
  /** Estimated prompt size that started this compaction. */
  estimatedTokens: number
}

/**
 * Estimates the tokens of a text without a tokenizer.
 *
 * Latin text has about four characters for each token. CJK, kana, hangul, and
 * emoji have about one token for each character, so they are counted one by one.
 *
 * @example
 * estimateTokens('hello world!')
 * // => 3
 * estimateTokens('こんにちは')
 * // => 5
 */
export function estimateTokens(text: string): number {
  let narrow = 0
  let wide = 0
  for (const character of text) {
    // U+2E80 starts the CJK radicals. Every script above it that chat uses is tokenized densely.
    if (character.codePointAt(0)! >= 0x2E80)
      wide += 1
    else
      narrow += 1
  }
  return Math.ceil(narrow / 4) + wide
}

function clip(text: string) {
  if (text.length <= TOOL_RESULT_CHARACTER_LIMIT)
    return text
  return `${text.slice(0, TOOL_RESULT_CHARACTER_LIMIT)} [${text.length - TOOL_RESULT_CHARACTER_LIMIT} more characters]`
}

/**
 * Reads one stored message as text lines and a media count.
 *
 * The token estimate and the summary source share this reading, so both see
 * the same content. `clipResults` shortens tool results for the summary only.
 */
function readMessage(message: ChatHistoryItem, clipResults: boolean): { lines: string[], media: number } {
  const lines: string[] = []
  let media = 0
  const result = (text: string) => lines.push(`[Tool result]: ${clipResults ? clip(text) : text}`)

  if (message.role === 'assistant' && message.generationTranscript) {
    for (const round of message.generationTranscript.rounds) {
      const text = round.content.flatMap(part => part.type === 'text' || part.type === 'refusal' ? [part.text] : []).join('')
      if (text)
        lines.push(`Assistant: ${text}`)
      for (const invocation of round.toolInvocations) {
        lines.push(`[Assistant tool call]: ${invocation.name}(${invocation.arguments})`)
        if (invocation.execution.status !== 'succeeded' && invocation.execution.status !== 'failed')
          continue
        const output = invocation.execution.output.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
        media += invocation.execution.output.filter(part => part.type !== 'text').length
        if (output)
          result(output)
      }
    }
    return { lines, media }
  }

  const speaker = message.role === 'user'
    ? `${typeof message.createdAt === 'number' ? formatTimePrefix(message.createdAt) : ''}User`
    : message.role === 'assistant' ? 'Assistant' : message.role === 'error' ? 'Error' : message.role

  if (typeof message.content === 'string') {
    if (message.content)
      lines.push(`${speaker}: ${message.content}`)
  }
  else if (Array.isArray(message.content)) {
    let imageIndex = 0
    let audioIndex = 0
    const parts = message.content.map((part) => {
      if (part.type === 'text')
        return part.text
      if (part.type === 'refusal')
        return part.refusal
      media += 1
      if (part.type === 'image_url') {
        const description = message.imageDescriptions?.find(item => item.imageIndex === imageIndex)?.description
        imageIndex += 1
        return description ? `[Image: ${description}]` : '[Image]'
      }
      if (part.type === 'input_audio') {
        const transcript = message.audioTranscripts?.[audioIndex]
        audioIndex += 1
        return transcript ? `[Recording: ${transcript}]` : '[Recording]'
      }
      return '[File]'
    })
    if (parts.length)
      lines.push(`${speaker}: ${parts.join(' ')}`)
  }

  if (message.role === 'assistant') {
    for (const toolResult of message.tool_results ?? []) {
      if (typeof toolResult.result === 'string')
        result(toolResult.result)
    }
  }

  return { lines, media }
}

function estimateMessageTokens(message: ChatHistoryItem) {
  const { lines, media } = readMessage(message, false)
  return estimateTokens(lines.join('\n')) + media * MEDIA_TOKENS
}

/** Total tokens that the provider reported for the last request of this reply, which is the prompt size after the reply. */
function reportedContextTokens(message: ChatHistoryItem) {
  if (message.role !== 'assistant')
    return undefined
  const total = message.generationTranscript?.rounds.at(-1)?.modelCall?.usage?.totalTokens
  return total && total > 0 ? total : undefined
}

/**
 * Finds the newest compaction marker.
 *
 * Returns the index of the first message that the prompt keeps verbatim. Without a marker, that index is 0.
 */
export function findCompaction(history: readonly ChatHistoryItem[]): { start: number, compaction?: HistoryCompaction } {
  const start = history.findLastIndex(message => message.compaction)
  return start < 0 ? { start: 0 } : { start, compaction: history[start].compaction }
}

/**
 * Estimates the size of the next request.
 *
 * A provider report is exact, and it includes the system prompt, the tool schemas, and the side context.
 * The newest report that is younger than the marker is the base. Messages after it are estimated.
 * A report that is older than the marker measured the history before the summary replaced it, so it does not count.
 */
function estimatePromptTokens(history: readonly ChatHistoryItem[]) {
  const { start, compaction } = findCompaction(history)
  const active = history.filter((message, index) => index >= start || message.role === 'system')

  for (let index = active.length - 1; index >= 0; index -= 1) {
    const message = active[index]
    const reported = reportedContextTokens(message)
    if (reported === undefined)
      continue
    if (compaction && (message.createdAt ?? 0) <= compaction.createdAt)
      break
    return reported + active.slice(index + 1).reduce((sum, item) => sum + estimateMessageTokens(item), 0)
  }

  return active.reduce((sum, item) => sum + estimateMessageTokens(item), 0) + estimateTokens(compaction?.summary ?? '')
}

/**
 * Selects the first message that stays verbatim.
 *
 * The walk goes back from the newest message until it holds `keepRecentTokens`. The cut is the first user message
 * at or after that point, so the kept history starts where a turn starts and no tool result loses its call.
 * Returns `undefined` when the history after `start` is smaller than `keepRecentTokens`. A summary cannot help then,
 * because the system prompt or the side context fills the window.
 */
function selectCut(history: readonly ChatHistoryItem[], start: number, keepRecentTokens: number) {
  const candidates = history.flatMap((message, index) => index > start && message.role === 'user' && message.id ? [index] : [])
  let kept = 0
  for (let index = history.length - 1; index > start; index -= 1) {
    kept += estimateMessageTokens(history[index])
    if (kept >= keepRecentTokens)
      return candidates.find(candidate => candidate >= index) ?? candidates.at(-1)
  }
  return undefined
}

/**
 * Plans a compaction when the next request of a session does not fit the context window.
 *
 * The plan names the first message that stays verbatim and holds the prompt for the summary of the messages before it.
 * The caller sends the prompt to the model and stores the answer as a marker on that message. Prompt composition then
 * sends the summary in place of the older messages, which stay in storage.
 *
 * `contextWindow` is the token limit of the model. A missing or zero value selects the default window.
 * The function is synchronous, so a send that needs no compaction does not yield.
 *
 * Returns `undefined` when the request fits or when no earlier message can be summarized.
 */
export function planCompaction(history: readonly ChatHistoryItem[], contextWindow?: number): CompactionPlan | undefined {
  // Zero is how providers report an unknown window, so it selects the default like a missing value.
  const window = contextWindow || compactionDefaults.contextWindow
  const reserveTokens = Math.min(compactionDefaults.reserveTokens, Math.floor(window * compactionDefaults.reserveRatio))
  const keepRecentTokens = Math.min(compactionDefaults.keepRecentTokens, Math.floor(window * compactionDefaults.keepRecentRatio))

  const estimatedTokens = estimatePromptTokens(history)
  if (estimatedTokens <= window - reserveTokens)
    return undefined

  const { start, compaction: previous } = findCompaction(history)
  const cut = selectCut(history, start, keepRecentTokens)
  if (cut === undefined)
    return undefined

  const summarized = history.slice(start, cut).filter(message => message.role !== 'system')
  if (!summarized.length)
    return undefined

  const source = [
    ...(previous ? [`Earlier summary:\n${previous.summary}`] : []),
    ...summarized.flatMap(message => readMessage(message, true).lines),
  ].join('\n\n')

  return {
    messageId: history[cut].id!,
    prompt: { system: SUMMARY_SYSTEM_PROMPT, user: `${source}\n\n---\n\n${SUMMARY_INSTRUCTIONS}` },
    summarizedCount: summarized.length,
    estimatedTokens,
  }
}
