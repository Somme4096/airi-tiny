import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig, resolveConfigPath } from './config'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'airi-dusha-config-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('gives the defaults when the file does not exist', async () => {
    const config = await loadConfig(join(directory, 'missing.json'))

    expect(config.dusha.url).toBe('http://127.0.0.1:8765')
    expect(config.dusha.harness).toBe('airi')
    expect(config.dusha.includeRecent).toBe(false)
    expect(config.channel.url).toBe('ws://localhost:6121/ws')
    expect(config.proactive).toEqual({ enabled: true, pollIntervalSeconds: 30 })
    expect(config.expression.emotions.elation).toBe('happy')
  })

  it('fills the fields that a partial file leaves out and merges the expression map', async () => {
    const path = join(directory, 'config.json')
    await writeFile(path, JSON.stringify({
      dusha: { url: 'http://192.168.0.100:8765', token: 'secret' },
      expression: { emotions: { elation: 'surprised', wonder: 'curious' } },
    }))

    const config = await loadConfig(path)

    expect(config.dusha.url).toBe('http://192.168.0.100:8765')
    expect(config.dusha.token).toBe('secret')
    expect(config.dusha.timeoutSeconds).toBe(60)
    expect(config.expression.emotions.elation).toBe('surprised')
    expect(config.expression.emotions.wonder).toBe('curious')
    expect(config.expression.emotions.dejection).toBe('sad')
  })

  it('rejects an unknown key, so a typo does not silently keep a default', async () => {
    const path = join(directory, 'config.json')
    await writeFile(path, JSON.stringify({ dusha: { tokn: 'secret' } }))

    await expect(loadConfig(path)).rejects.toThrow(/is not valid/)
  })

  it('rejects an expression that AIRI cannot show', async () => {
    const path = join(directory, 'config.json')
    await writeFile(path, JSON.stringify({ expression: { emotions: { elation: 'ecstatic' } } }))

    await expect(loadConfig(path)).rejects.toThrow(/is not valid/)
  })

  it('reports a file that is not JSON', async () => {
    const path = join(directory, 'config.json')
    await writeFile(path, '{ url: ')

    await expect(loadConfig(path)).rejects.toThrow(/Cannot read the Dusha plugin config/)
  })
})

describe('resolveConfigPath', () => {
  it('prefers AIRI_DUSHA_CONFIG, then XDG_CONFIG_HOME', () => {
    expect(resolveConfigPath({ AIRI_DUSHA_CONFIG: '/etc/dusha.json', XDG_CONFIG_HOME: '/xdg' })).toBe('/etc/dusha.json')
    expect(resolveConfigPath({ XDG_CONFIG_HOME: join('/xdg') })).toBe(join('/xdg', 'airi-dusha', 'config.json'))
  })
})
