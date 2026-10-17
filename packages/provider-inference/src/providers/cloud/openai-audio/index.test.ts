import type { SpeechProvider } from '@xsai-ext/providers/utils'

import { generateSpeech } from '@xsai/generate-speech'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { providerOpenAICompatibleAudioSpeech } from '.'

/** Captures the JSON body of each request that the provider sends over the ambient `fetch`. */
function installServer(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = []

  vi.stubGlobal('fetch', async (_input: URL | RequestInfo, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(new Uint8Array([82, 73, 70, 70]))
  })

  return bodies
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openAI compatible speech provider', () => {
  it('requests WAV audio so that servers without an mp3 default accept the request', async () => {
    // ROOT CAUSE:
    //
    // Some compatible servers have no default `response_format` and return 400.
    // `createOpenAI` never sets the field.
    //
    // Unsupported response_format=None.
    //
    // We fixed this by always requesting WAV.
    const bodies = installServer()
    const provider = await providerOpenAICompatibleAudioSpeech.createProvider({ apiKey: 'key', baseUrl: 'http://localhost:8000/v1' }) as SpeechProvider

    await generateSpeech({ ...provider.speech('irodori-tts'), input: 'Hello', voice: 'default' })

    expect(bodies).toHaveLength(1)
    expect(bodies[0].response_format).toBe('wav')
    expect(bodies[0].model).toBe('irodori-tts')
  })
})
