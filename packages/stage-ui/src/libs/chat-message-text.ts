import type { ChatAssistantMessage, ChatHistoryItem } from '@proj-airi/core-agent'

/**
 * Returns the text that a user can read in one chat message.
 *
 * An assistant message returns its joined text slices, because slices carry the live transcript.
 * Other messages return their string content, or the joined text parts of a content array.
 * Tool calls, tool results, images, and recordings have no text and are not in the result.
 *
 * @example
 * extractMessageText({ role: 'user', content: [{ type: 'text', text: 'look:' }, imagePart] })
 * // => 'look:'
 */
export function extractMessageText(message: ChatHistoryItem): string {
  if (message.role === 'assistant') {
    // The discriminated union narrows `message` to a shape that includes
    // `slices`; reading via the narrowed alias keeps tsc happy without an
    // `as` cast.
    const assistant: ChatAssistantMessage = message
    if (Array.isArray(assistant.slices) && assistant.slices.length > 0) {
      const text = assistant.slices
        .filter((slice): slice is { type: 'text', text: string } => slice.type === 'text')
        .map(slice => slice.text)
        .join('')
      if (text)
        return text
    }
  }
  if (typeof message.content === 'string')
    return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string')
          return part
        if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part)
          return String(part.text ?? '')
        return ''
      })
      .join('')
  }
  return ''
}
