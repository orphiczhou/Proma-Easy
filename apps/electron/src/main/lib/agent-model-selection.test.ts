import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type ModelSelectionModule = typeof import('./agent-model-selection')
type ChannelManagerModule = typeof import('./channel-manager')

let modelSelection: ModelSelectionModule
let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  shell: {
    openExternal: async () => undefined,
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

function writeChannels(channels: unknown[]): void {
  const configDir = join(tempHome, '.proma')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'channels.json'),
    JSON.stringify({ version: 2, channels }),
    'utf-8',
  )
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-model-selection-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  channelManager = await import('./channel-manager')
  modelSelection = await import('./agent-model-selection')
})

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPromaDev === undefined) {
    delete process.env.PROMA_DEV
  } else {
    process.env.PROMA_DEV = originalPromaDev
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('pickDefaultModelForChannel（跨渠道未传 modelId 的默认选模）', () => {
  test('取第一个 enabled 模型（跳过未启用的）', () => {
    const channelId = 'chan-has-enabled'
    writeChannels([
      {
        id: channelId,
        name: '测试渠道',
        provider: 'openai',
        baseUrl: 'https://example.com',
        apiKey: '',
        enabled: true,
        models: [
          { id: 'disabled-a', name: 'A', enabled: false, source: 'manual' },
          { id: 'enabled-a', name: 'B', enabled: true, source: 'manual' },
          { id: 'enabled-b', name: 'C', enabled: true, source: 'manual' },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ])
    expect(
      modelSelection.pickDefaultModelForChannel({ channelId, purpose: '测试' }),
    ).toBe('enabled-a')
  })

  test('渠道无 enabled 模型时抛错', () => {
    const channelId = 'chan-no-enabled'
    writeChannels([
      {
        id: channelId,
        name: '空渠道',
        provider: 'openai',
        baseUrl: 'https://example.com',
        apiKey: '',
        enabled: true,
        models: [
          { id: 'disabled-a', name: 'A', enabled: false, source: 'manual' },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ])
    expect(() =>
      modelSelection.pickDefaultModelForChannel({ channelId, purpose: '测试' }),
    ).toThrow('没有任何已启用的模型')
  })

  test('渠道不存在时抛错', () => {
    expect(() =>
      modelSelection.pickDefaultModelForChannel({ channelId: 'no-such-channel', purpose: '测试' }),
    ).toThrow('不存在或未启用')
  })

  test('channelId 缺失时抛错', () => {
    expect(() =>
      modelSelection.pickDefaultModelForChannel({ channelId: undefined, purpose: '测试' }),
    ).toThrow('需要可用的 channelId')
  })
})
