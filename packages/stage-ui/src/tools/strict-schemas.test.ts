import { describe, expect, it, vi } from 'vitest'

import { installStrictToolSchemaMatchers } from '../testing/strict-tool-schema'
import { debug } from './debug'
import { createHomeAssistantTools } from './home-assistant'
import { createJudgeRecipeTool } from './judge-recipe'
import { mcp } from './mcp'
import { createMemoryTools } from './memory'
import { createProposeRecipeTool } from './propose-recipe'
import { createUseRecipeTool } from './use-recipe'
import { createWakeWordTool } from './wake-words'
import { createWebSearchTools } from './web-search'

installStrictToolSchemaMatchers()

describe('stage-ui tool schemas', () => {
  // ROOT CAUSE:
  //
  // A Responses provider sends each tool with `strict: true`. One open object or optional
  // property rejects the whole request. `tool()` closes only the root and its direct properties,
  // so OpenCode Go rejected the nested wake word item.
  it('satisfy the strict tool rules of Responses providers', async () => {
    const tools = [
      ...await debug(),
      ...await createHomeAssistantTools({ callService: vi.fn(), getState: vi.fn(), listEntities: vi.fn() }, {}),
      ...await createJudgeRecipeTool({ decisions: [], recipes: [], start: vi.fn() }),
      ...await mcp(),
      ...await createMemoryTools({ read: vi.fn(), write: vi.fn(), forget: vi.fn() }),
      ...await createProposeRecipeTool({ propose: vi.fn() }),
      ...await createUseRecipeTool({ recipes: () => [], start: vi.fn() }),
      await createWakeWordTool({ characterId: 'character', setWords: vi.fn() }),
      ...await createWebSearchTools({ apiKey: 'test-key' }),
    ]

    expect(tools).toSatisfyStrictToolSchemas()
  })
})
