import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type ChannelManagerModule = typeof import('./channel-manager')

/**
 * W6 渠道 Key 加密形态回归测试。
 *
 * 核心不变量（对应根因修复）：
 * 1. decryptKey 解密失败绝不返回密文原串（返回密文 = 被当 API Key 发出 = 渠道 401 报废）；
 * 2. 新写入密文统一带 enc:v1: 标记，读取端可无歧义区分密文/明文；
 * 3. 存量无标记密文/明文向后兼容：密文漂移识别并拒绝，明文照常透传；
 * 4. 发送链防线：Key 为空或密文形态 → 抛错拒绝发送；
 * 5. 启动扫描：密文不可解 → 报 issue 不清空；可解存量密文 → 机会性迁移标记。
 */

/** 可在测试中切换的 safeStorage 状态，用于模拟密钥环漂移。 */
const safeStorageState = {
  available: true,
  failDecrypt: false,
}

/**
 * 模拟 Chromium os_crypt blob：`v11` 版本前缀 + 1 字节长度 + 载荷 + 填充到真实密文尺寸。
 * 真实实现为 AES-GCM（前缀+nonce+密文+tag ≈36B 起），测试用可逆编码并保持同等长度量级，
 * 以免被 looksLikeLegacyCiphertext 的 ≥16 字节下限误判。
 */
const MOCK_BLOB_PREFIX = 'v11'
const MOCK_BLOB_MIN_PAD = 32

function mockEncryptString(value: string): Buffer {
  const payload = Buffer.from(value, 'utf-8')
  const header = Buffer.concat([Buffer.from(MOCK_BLOB_PREFIX, 'latin1'), Buffer.from([payload.length])])
  return Buffer.concat([header, payload, Buffer.alloc(MOCK_BLOB_MIN_PAD, 0x7f)])
}

function mockDecryptString(value: Buffer): string {
  if (safeStorageState.failDecrypt) {
    throw new Error('mock: decryptString failed (keyring drifted)')
  }
  const prefix = Buffer.from(MOCK_BLOB_PREFIX, 'latin1')
  if (value.length < prefix.length + 1 || !value.subarray(0, prefix.length).equals(prefix)) {
    throw new Error('mock: invalid encrypted blob')
  }
  const payloadLength = value[prefix.length]!
  return value.subarray(prefix.length + 1, prefix.length + 1 + payloadLength).toString('utf-8')
}

let channelManager: ChannelManagerModule
let tempHome: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.available,
    encryptString: (value: string) => mockEncryptString(value),
    decryptString: (value: Buffer) => mockDecryptString(value),
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

function readStoredChannels(): Array<{ id: string; apiKey: string }> {
  return (JSON.parse(readFileSync(join(tempHome, '.proma', 'channels.json'), 'utf-8')) as {
    channels: Array<{ id: string; apiKey: string }>
  }).channels
}

interface TestChannelInput {
  id: string
  apiKey: string
  provider?: string
  name?: string
}

function makeChannel(input: TestChannelInput): Record<string, unknown> {
  return {
    id: input.id,
    name: input.name ?? input.id,
    provider: input.provider ?? 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: input.apiKey,
    models: [],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-channel-manager-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'
  channelManager = await import('./channel-manager')
})

beforeEach(() => {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
  safeStorageState.available = true
  safeStorageState.failDecrypt = false
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

describe('写入端形态：enc:v1: 统一标记', () => {
  test('Given 加密可用 When 创建/更新渠道 Then 存储带 enc:v1: 前缀且可解密还原', () => {
    const created = channelManager.createChannel({
      name: 'DeepSeek',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-plain-secret',
      models: [],
      enabled: true,
    })
    expect(created.apiKey.startsWith('enc:v1:')).toBe(true)

    const stored = readStoredChannels().find((c) => c.id === created.id)
    expect(stored?.apiKey.startsWith('enc:v1:')).toBe(true)
    expect(channelManager.decryptApiKey(created.id)).toBe('sk-plain-secret')
  })

  test('Given 加密不可用 When 创建渠道 Then 按既有设计明文存储', () => {
    safeStorageState.available = false
    const created = channelManager.createChannel({
      name: 'Plain',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-plain',
      models: [],
      enabled: true,
    })
    expect(created.apiKey).toBe('sk-plain')
    expect(channelManager.decryptApiKey(created.id)).toBe('sk-plain')
  })
})

describe('读取端三态：解密失败绝不返回密文', () => {
  test('Given enc:v1: 密文且解密失败 When 读取 Then 抛 ApiKeyDecryptError 而非返回密文', () => {
    safeStorageState.failDecrypt = true
    writeChannels([makeChannel({ id: 'ch1', name: 'MiniMax', apiKey: 'enc:v1:' + mockEncryptString('sk-real').toString('base64') })])

    expect(() => channelManager.decryptApiKey('ch1')).toThrow('重新输入')
    expect(() => channelManager.decryptApiKey('ch1')).toThrow(channelManager.ApiKeyDecryptError)
    // 关键断言：任何错误路径都不会把存储原串当 Key 返回
    try {
      channelManager.decryptApiKey('ch1')
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain('enc:v1:')
    }
  })

  test('Given 写入时加密可用、读取时不可用（漂移窗口）When 读取标记密文 Then 拒绝并报需重输', () => {
    writeChannels([makeChannel({ id: 'ch1', name: 'DeepSeek', apiKey: 'enc:v1:' + mockEncryptString('sk-real').toString('base64') })])
    safeStorageState.available = false

    expect(() => channelManager.decryptApiKey('ch1')).toThrow('密钥环不可用')
    expect(() => channelManager.decryptApiKey('ch1')).toThrow(channelManager.ApiKeyDecryptError)
  })

  test('Given 存量无标记密文（v11 blob base64）且密钥环不可用 When 读取 Then 拒绝而非透传密文', () => {
    safeStorageState.available = false
    const legacyCiphertext = mockEncryptString('sk-real').toString('base64')
    writeChannels([makeChannel({ id: 'legacy', name: 'DeepSeek', apiKey: legacyCiphertext })])

    expect(() => channelManager.decryptApiKey('legacy')).toThrow(channelManager.ApiKeyDecryptError)
    // 双保险：即使异常被吞也不能返回密文原串
    try {
      channelManager.decryptApiKey('legacy')
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).not.toContain(legacyCiphertext)
    }
  })

  test('Given 存量无标记密文且解密失败（密钥环变更）When 读取 Then 拒绝', () => {
    safeStorageState.failDecrypt = true
    const legacyCiphertext = mockEncryptString('sk-real').toString('base64')
    writeChannels([makeChannel({ id: 'legacy2', apiKey: legacyCiphertext })])

    expect(() => channelManager.decryptApiKey('legacy2')).toThrow(channelManager.ApiKeyDecryptError)
  })

  test('Given 存量明文（历史无加密环境写入）且当前解密失败 When 读取 Then 明文透传（向后兼容）', () => {
    // 加密可用但解密必然失败（明文不是合法 blob）→ 不得误判为密文
    safeStorageState.failDecrypt = true
    writeChannels([makeChannel({ id: 'plain', apiKey: 'sk-legacy-plain-key' })])

    expect(channelManager.decryptApiKey('plain')).toBe('sk-legacy-plain-key')
  })

  test('Given 加密不可用环境下的明文 When 读取 Then 直接透传', () => {
    safeStorageState.available = false
    writeChannels([makeChannel({ id: 'plain2', apiKey: 'sk-plain-again' })])

    expect(channelManager.decryptApiKey('plain2')).toBe('sk-plain-again')
  })
})

describe('发送链防线：Key 不为空且非密文形态', () => {
  test('Given 渠道 Key 为空 When 解析运行时 Key Then 拒绝并提示未配置', async () => {
    writeChannels([makeChannel({ id: 'empty', name: '预设渠道', apiKey: '' })])

    await expect(channelManager.resolveChannelRuntimeApiKey('empty')).rejects.toThrow('未配置 API Key')
  })

  test('Given 密文不可解 When 解析运行时 Key Then 拒绝且消息含渠道名', async () => {
    safeStorageState.failDecrypt = true
    writeChannels([makeChannel({ id: 'drift', name: 'MiniMax', apiKey: 'enc:v1:' + mockEncryptString('sk-real').toString('base64') })])

    await expect(channelManager.resolveChannelRuntimeApiKey('drift')).rejects.toThrow('MiniMax')
    await expect(channelManager.resolveChannelRuntimeApiKey('drift')).rejects.toThrow('重新输入')
  })

  test('Given 合法密文 When 解析运行时 Key Then 返回明文', async () => {
    writeChannels([makeChannel({ id: 'ok', apiKey: 'enc:v1:' + mockEncryptString('sk-good').toString('base64') })])

    await expect(channelManager.resolveChannelRuntimeApiKey('ok')).resolves.toBe('sk-good')
  })

  test('Given 密文不可解 When 连接测试 Then 返回本地失败结果且不发请求', async () => {
    safeStorageState.failDecrypt = true
    writeChannels([makeChannel({ id: 'drift3', name: 'DeepSeek', provider: 'deepseek', apiKey: 'enc:v1:' + mockEncryptString('sk-real').toString('base64') })])

    const result = await channelManager.testChannel('drift3')
    expect(result.success).toBe(false)
    expect(result.message).toContain('DeepSeek')
    expect(result.message).toContain('重新输入')
  })

  test('Given 渠道 Key 为空 When 连接测试 Then 返回本地提示而非发起请求', async () => {
    writeChannels([makeChannel({ id: 'empty2', name: '空Key', apiKey: '' })])

    const result = await channelManager.testChannel('empty2')
    expect(result.success).toBe(false)
    expect(result.message).toContain('尚未配置')
  })
})

describe('启动扫描：不静默、不清空、机会性迁移', () => {
  test('Given 存量无标记密文且可解密 When 扫描 Then 迁移为 enc:v1: 标记且无 issue', () => {
    const legacyCiphertext = mockEncryptString('sk-legacy').toString('base64')
    writeChannels([makeChannel({ id: 'legacy-ok', apiKey: legacyCiphertext })])

    const scan = channelManager.scanChannelKeyHealth()
    expect(scan.issues).toHaveLength(0)
    expect(scan.migratedCount).toBe(1)

    const stored = readStoredChannels().find((c) => c.id === 'legacy-ok')
    expect(stored?.apiKey.startsWith('enc:v1:')).toBe(true)
    expect(channelManager.decryptApiKey('legacy-ok')).toBe('sk-legacy')
  })

  test('Given 密文不可解 When 扫描 Then 报 issue 且不清空存储', () => {
    safeStorageState.failDecrypt = true
    const markedCiphertext = 'enc:v1:' + mockEncryptString('sk-broken').toString('base64')
    writeChannels([makeChannel({ id: 'broken', name: 'MiniMax', apiKey: markedCiphertext })])

    const scan = channelManager.scanChannelKeyHealth()
    expect(scan.migratedCount).toBe(0)
    expect(scan.issues).toHaveLength(1)
    expect(scan.issues[0]?.channelId).toBe('broken')
    expect(scan.issues[0]?.channelName).toBe('MiniMax')
    expect(scan.issues[0]?.reason).toContain('重新输入')

    // 不自动清空：存储原样保留
    const stored = readStoredChannels().find((c) => c.id === 'broken')
    expect(stored?.apiKey).toBe(markedCiphertext)
  })

  test('Given 密文形态但密钥环不可用（漂移）When 扫描 Then 报 issue', () => {
    safeStorageState.available = false
    const legacyCiphertext = mockEncryptString('sk-drift').toString('base64')
    writeChannels([makeChannel({ id: 'drifted', apiKey: legacyCiphertext })])

    const scan = channelManager.scanChannelKeyHealth()
    expect(scan.issues).toHaveLength(1)
    expect(scan.issues[0]?.reason).toContain('密钥环不可用')
    expect(readStoredChannels().find((c) => c.id === 'drifted')?.apiKey).toBe(legacyCiphertext)
  })

  test('Given 明文与空 Key 渠道 When 扫描 Then 无 issue 且不做加密迁移', () => {
    writeChannels([
      makeChannel({ id: 'plain', apiKey: 'sk-plain' }),
      makeChannel({ id: 'blank', apiKey: '' }),
    ])

    const scan = channelManager.scanChannelKeyHealth()
    expect(scan.issues).toHaveLength(0)
    expect(scan.migratedCount).toBe(0)
    expect(readStoredChannels().find((c) => c.id === 'plain')?.apiKey).toBe('sk-plain')
  })
})

describe('兜底：渠道不存在', () => {
  test('Given 渠道不存在 When 解密 Then 抛渠道不存在错误', () => {
    writeChannels([])
    expect(() => channelManager.decryptApiKey('nope')).toThrow('渠道不存在')
  })
})
