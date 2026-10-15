import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { KitRef } from '@proj-airi/plugin-sdk'
import type { ToolKitRuntime } from '@proj-airi/plugin-sdk-tamagotchi/tools'
import type { WebSocketEvents } from '@proj-airi/server-sdk'

import { readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toolKit } from '@proj-airi/plugin-sdk-tamagotchi/kits/tool'
import { TamagotchiToolRegistry } from '@proj-airi/plugin-sdk-tamagotchi/tools'
import { ExtensionHost, parseExtensionManifest } from '@proj-airi/plugin-sdk/plugin-host'
import { createServer as createChannelServer } from '@proj-airi/server-runtime/server'
import { Client, WebSocketEventSource } from '@proj-airi/server-sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import extension from './index'

const channelToken = 'channel-secret'
const dushaToken = 'dusha-secret'

interface RecordedRequest {
  method: string
  path: string
  token: string | undefined
  body: Record<string, unknown> | undefined
}

/**
 * A stand-in for the Dusha HTTP service with the response shapes of Dusha 0.x.
 *
 * It plays the two mods of a typical companion:
 * - "love": a decision (system_one) picks intimacy, and a mod delta moves elation further. The expression follows intimacy.
 * - "angry": no decision, so the ingest response gives `affect: null`, and a mod delta moves irritability.
 */
function createFakeDusha() {
  const requests: RecordedRequest[] = []
  const affect = { base: { elation: 0.2, intimacy: 0.35, anxiety: 0.2, irritability: 0.15 }, mood: { elation: 0.2, intimacy: 0.35, anxiety: 0.2, irritability: 0.15 } }
  const proactiveEvents = [{
    id: '417da507-f6d6-48dc-9852-6f6009a4dea7',
    reason: 'silence',
    generation_instruction: 'Write one brief message to the user.',
    ruling_feeling: { dimension: 'anxiety', value: 0.6, neutral: 0.2, deviation: 0.4 },
  }]
  let nextMessageId = 1
  let failing = false
  const facts = new Set<string>()

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://dusha')
    let raw = ''
    for await (const chunk of request)
      raw += chunk
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    requests.push({ method: request.method ?? '', path: url.pathname, token: request.headers['x-companion-token'] as string | undefined, body })

    const reply = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }

    if (request.headers['x-companion-token'] !== dushaToken)
      return reply(401, { detail: 'invalid companion token' })
    if (failing && url.pathname === '/state/v1/messages') {
      failing = false
      return reply(500, { detail: 'database is locked' })
    }

    const route = `${request.method} ${url.pathname}`
    switch (route) {
      case 'POST /state/v1/messages': {
        const isLove = body?.role === 'user' && String(body.content).includes('love')
        if (isLove) {
          affect.base.intimacy = 0.45
          affect.base.elation = 0.84
        }
        if (body?.role === 'user' && String(body.content).includes('angry'))
          affect.base.irritability = 1
        return reply(200, { id: nextMessageId++, duplicate: false, affect: isLove ? { emotion: 'intimacy', increment: 0.1, decision_id: 1, state: affect } : null })
      }
      case 'GET /state/v1/affect':
        return reply(200, { ...structuredClone(affect), last_updated_at: '', last_user_message_at: null, last_proactive_sent_at: null, unanswered_proactive: 0 })
      case 'POST /state/v1/context':
        return reply(200, { injection: `<affect>elation ${affect.base.elation}</affect><query>${String(body?.query)}</query>`, records: [], search_hits: [], context: {} })
      case 'POST /state/v1/evergreen/facts': {
        const key = String(body?.key)
        if (facts.has(key))
          return reply(409, { detail: `fact key already exists: ${key}` })
        facts.add(key)
        return reply(200, { fact: { fact_id: 'f-1', revision: 1, key, text: body?.text, state: 'active', effective_state: 'active', priority: body?.priority } })
      }
      case 'GET /state/v1/proactive/events':
        return reply(200, { events: proactiveEvents.splice(0) })
      case 'POST /state/v1/proactive/events/417da507-f6d6-48dc-9852-6f6009a4dea7/ack':
        return reply(200, { event: { id: '417da507-f6d6-48dc-9852-6f6009a4dea7' } })
      default:
        return reply(404, { detail: `no route ${route}` })
    }
  }

  const server = createHttpServer((request, response) => void handle(request, response))
  return {
    server,
    requests,
    /** Makes the next message ingest fail with HTTP 500. */
    failNext: () => {
      failing = true
    },
  }
}

async function freePort() {
  const server = createNetServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

/** The host side of `kit.tool`, wired the same way stage-tamagotchi wires it into its tool registry. */
function createHostToolKit(registry: TamagotchiToolRegistry): KitRef<ReturnType<typeof toolKit.createClient>> {
  return {
    ...toolKit,
    createClient(runtime) {
      const owner = { ownerSessionId: runtime.sessionId, ownerExtensionId: runtime.extensionId, ownerModuleId: runtime.moduleId }
      const hostRuntime: ToolKitRuntime = {
        ...runtime,
        tools: {
          register: (input) => {
            registry.register({ ...owner, ...input })
          },
          registerToolsetPrompt: (input) => {
            registry.registerToolsetPrompt({ ...owner, toolset: input })
          },
        },
      }
      runtime.subscriptions.add({ dispose: () => registry.unregisterOwnerScope(runtime.sessionId, runtime.moduleId) })
      return toolKit.createClient(hostRuntime)
    },
  }
}

describe('airi-plugin-dusha in the extension host', () => {
  const dusha = createFakeDusha()
  const registry = new TamagotchiToolRegistry()
  const host = new ExtensionHost({ runtime: 'electron', airiVersion: '1.0.0' })
  const configPath = join(tmpdir(), `airi-dusha-${process.pid}.json`)
  const contextUpdates: WebSocketEvents['context:update'][] = []
  const sparkNotifies: WebSocketEvents['spark:notify'][] = []
  /** Prepare-related events in the order the stage received them. */
  const prepareLog: string[] = []
  let syncedModules: WebSocketEvents['registry:modules:sync']['modules'] = []
  let channel: ReturnType<typeof createChannelServer>
  let stage: Client
  let sessionId: string

  beforeAll(async () => {
    await new Promise<void>(resolve => dusha.server.listen(0, '127.0.0.1', resolve))
    const dushaPort = (dusha.server.address() as AddressInfo).port
    const channelPort = await freePort()
    channel = createChannelServer({ port: channelPort, hostname: '127.0.0.1', auth: { token: channelToken } })
    await channel.start()

    // The stage connects before the plugin, the way AIRI's renderer is up before extensions load.
    stage = new Client({ name: WebSocketEventSource.StageTamagotchi, url: `ws://127.0.0.1:${channelPort}/ws`, token: channelToken, autoConnect: false })
    stage.onEvent('context:update', (event) => {
      contextUpdates.push(event.data)
      prepareLog.push('context:update')
    })
    stage.onEvent('spark:notify', event => void sparkNotifies.push(event.data))
    stage.onEvent('character:emotion', event => void prepareLog.push(`character:emotion ${event.data.name}`))
    stage.onEvent('chat:prepare:response', event => void prepareLog.push(`chat:prepare:response ${event.data.turnId}`))
    stage.onEvent('registry:modules:sync', (event) => {
      syncedModules = event.data.modules
    })
    await stage.connect()

    await writeFile(configPath, JSON.stringify({
      dusha: { url: `http://127.0.0.1:${dushaPort}`, token: dushaToken },
      channel: { url: `ws://127.0.0.1:${channelPort}/ws`, token: channelToken },
    }))
    vi.stubEnv('AIRI_DUSHA_CONFIG', configPath)

    host.registerKit({ kitId: toolKit.id, version: toolKit.version, runtimes: ['electron'], capabilities: [] })
    host.registerKitApi(createHostToolKit(registry))
    const parsed = parseExtensionManifest(JSON.parse(await readFile(join(import.meta.dirname, '..', 'extension.airi.json'), 'utf-8')))
    if (!parsed.success)
      throw new Error('extension.airi.json is not a valid manifest')
    sessionId = (await host.startExtension(extension, { manifest: parsed.manifest })).id
  })

  afterAll(async () => {
    await host.stop(sessionId)
    stage.close()
    await channel.stop()
    await new Promise(resolve => dusha.server.close(resolve))
    await rm(configPath, { force: true })
    vi.unstubAllEnvs()
  })

  it('registers every Dusha tool and the toolset prompt with the tool kit', async () => {
    const { tools } = await registry.listSerializedXsaiTools()
    const prompts = await registry.listToolsetPrompts()

    expect(tools.map(tool => tool.name).sort()).toEqual([
      'affect_status',
      'evergreen_fact_history',
      'forget_evergreen_fact',
      'get_conversation_record',
      'remember_evergreen_fact',
      'review_evergreen_facts',
      'revise_evergreen_fact',
      'search_conversation_memory',
      'yumecho_add',
      'yumecho_done',
      'yumecho_list',
    ])
    expect(prompts.map(prompt => prompt.prompt.title)).toEqual(['Dusha memory'])
  })

  it('sends the first context when the channel becomes ready', async () => {
    await expect.poll(() => contextUpdates.length).toBeGreaterThan(0)

    expect(contextUpdates[0].lane).toBe('dusha')
    expect(contextUpdates[0].strategy).toBe('replace-self')
    expect(contextUpdates[0].text).toContain('<query></query>')
  })

  it('delivers a proactive event to the stage as spark:notify and acknowledges it', async () => {
    await expect.poll(() => sparkNotifies.length).toBe(1)

    expect(sparkNotifies[0].eventId).toBe('417da507-f6d6-48dc-9852-6f6009a4dea7')
    expect(sparkNotifies[0].note).toBe('Write one brief message to the user.\nOpen the message with <|ACT {"emotion":"awkward"}|>.')
    await expect.poll(() => dusha.requests.find(request => request.path.endsWith('/ack'))?.body).toEqual({
      consumer: 'airi',
      outcome: 'sent',
      text: '',
      error: '',
    })
  })

  it('announces itself to the stage as a chat preparer', async () => {
    await expect.poll(() => syncedModules.find(module => module.identity.id !== undefined && 'labels' in module.identity)?.identity).toMatchObject({
      extension: { id: 'airi-plugin-dusha' },
      labels: { 'chat-prepare': 'true' },
    })
  })

  it('prepares a turn: stores the message, shows the decided emotion, and sends the context before it answers', async () => {
    const requestsBefore = dusha.requests.length
    prepareLog.length = 0

    stage.send({ type: 'chat:prepare:request', data: { turnId: 'turn-1', sessionId: 'session-1', text: 'I love you' } })

    await expect.poll(() => prepareLog.at(-1)).toBe('chat:prepare:response turn-1')
    expect(prepareLog).toEqual(['character:emotion happy', 'context:update', 'chat:prepare:response turn-1'])
    const turnRequests = dusha.requests.slice(requestsBefore).map(request => `${request.method} ${request.path}`)
    expect(turnRequests.filter(route => !route.includes('proactive'))).toEqual([
      'GET /state/v1/affect',
      'POST /state/v1/messages',
      'GET /state/v1/affect',
      'POST /state/v1/context',
    ])
    expect(dusha.requests.find(request => request.path === '/state/v1/messages' && request.body?.content === 'I love you')?.body).toEqual({
      harness: 'airi',
      conversation_id: 'airi',
      route: 'airi',
      role: 'user',
      content: 'I love you',
    })
    expect(contextUpdates.at(-1)?.text).toBe([
      '<affect>elation 0.84</affect><query>I love you</query>',
      '<affect_shift>The user\'s last message stirred intimacy: it rose by 0.10 to 0.45. Open your reply with <|ACT {"emotion":"happy"}|> to show it.</affect_shift>',
    ].join('\n'))
  })

  it('stores only the reply after the turn, and leaves it out of the next context', async () => {
    const requestsBefore = dusha.requests.length

    stage.send({
      type: 'output:gen-ai:chat:message',
      data: {
        'message': { role: 'assistant', content: '<|ACT {"emotion":"happy"}|> I love you too.' },
        'gen-ai:chat': { message: { role: 'user', content: [{ type: 'text', text: 'I love you' }] }, composedMessage: [], contexts: {} },
      },
    })
    await expect.poll(() => dusha.requests.slice(requestsBefore).find(request => request.path === '/state/v1/messages')?.body).toMatchObject({
      role: 'assistant',
      content: 'I love you too.',
    })
    const replyId = dusha.requests.slice(requestsBefore).filter(request => request.path === '/state/v1/messages').length
    expect(replyId).toBe(1)

    prepareLog.length = 0
    stage.send({ type: 'chat:prepare:request', data: { turnId: 'turn-2', sessionId: 'session-1', text: 'I am angry at you' } })

    await expect.poll(() => prepareLog.at(-1)).toBe('chat:prepare:response turn-2')
    expect(prepareLog[0]).toBe('character:emotion angry')
    expect(dusha.requests.findLast(request => request.path === '/state/v1/context')?.body).toMatchObject({
      query: 'I am angry at you',
      exclude_message_ids: [3, 2],
    })
    expect(contextUpdates.at(-1)?.text).toContain('<affect_shift>The user\'s last message moved irritability the most: it rose by 0.85 to 1.00. Open your reply with <|ACT {"emotion":"angry"}|> to show it.</affect_shift>')
  })

  it('answers the prepare request even when Dusha fails, so the turn does not wait', async () => {
    dusha.failNext()
    prepareLog.length = 0

    stage.send({ type: 'chat:prepare:request', data: { turnId: 'turn-3', sessionId: 'session-1', text: 'hello' } })

    await expect.poll(() => prepareLog).toEqual(['chat:prepare:response turn-3'])
  })

  it('returns the Dusha result to the model, and maps a conflict to ok=false with its status', async () => {
    const input = { key: 'user.name', text: 'The user is Somme.', priority: null, review_after: null, expires_at: 'clear', reason: null }

    const saved = await registry.invoke('airi-plugin-dusha', 'remember_evergreen_fact', input)
    const duplicate = await registry.invoke('airi-plugin-dusha', 'remember_evergreen_fact', input)

    expect(saved).toMatchObject({ ok: true, fact: { key: 'user.name', priority: 50 } })
    expect(dusha.requests.findLast(request => request.path === '/state/v1/evergreen/facts')?.body).toEqual({
      key: 'user.name',
      text: 'The user is Somme.',
      priority: 50,
      reason: '',
      expires_at: null,
    })
    expect(duplicate).toEqual({ ok: false, error: 'fact key already exists: user.name', status: 409 })
  })

  it('rejects tool input that does not match the schema without calling Dusha', async () => {
    const requestsBefore = dusha.requests.length

    const result = await registry.invoke('airi-plugin-dusha', 'yumecho_done', { note_id: 3, reason: '   ' })

    expect(result).toMatchObject({ ok: false })
    expect(dusha.requests.length).toBe(requestsBefore)
  })

  it('removes its tools when the host stops the extension', async () => {
    await host.stop(sessionId)

    expect((await registry.listSerializedXsaiTools()).tools).toEqual([])
  })
})
