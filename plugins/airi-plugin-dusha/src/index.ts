import process from 'node:process'

import { createModule, defineExtension } from '@proj-airi/plugin-sdk'
import { registerTools } from '@proj-airi/plugin-sdk-tamagotchi/kits/tool'

import { DushaClient } from './client'
import { loadConfig, resolveConfigPath } from './config'
import { StageBridge } from './stage-bridge'
import { createTools } from './tools'

/**
 * AIRI extension for Dusha.
 *
 * Call stack:
 *
 * ExtensionHost.startExtension (stage-tamagotchi main process)
 *   -> setup
 *     -> {@link loadConfig}
 *     -> {@link registerTools} with {@link createTools}
 *     -> {@link StageBridge.start}
 *
 * The host disposes the module and runs the subscriptions on stop, reload, and disable. The bridge closes then.
 */
export default defineExtension({
  id: 'airi-plugin-dusha',
  async setup(ctx) {
    const config = await loadConfig(resolveConfigPath(process.env))
    const dusha = new DushaClient({
      url: config.dusha.url,
      token: config.dusha.token,
      harness: config.dusha.harness,
      conversationId: config.dusha.conversationId,
      timeoutSeconds: config.dusha.timeoutSeconds,
    })

    const module = await createModule(ctx, { id: 'dusha' })
    await registerTools(module, createTools(dusha))

    const bridge = new StageBridge({
      dusha,
      channel: config.channel,
      includeRecent: config.dusha.includeRecent,
      proactive: config.proactive,
      expression: config.expression,
    })
    ctx.subscriptions.add({ dispose: () => bridge.close() })
    bridge.start()
  },
})
