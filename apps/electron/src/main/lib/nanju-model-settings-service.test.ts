/**
 * W23 D2：南大向导·模型配置设置服务测试（自愈/IPC 域）。
 *
 * 覆盖：getState（无密钥出参/健康/渠道摘要）、save（白名单拒绝/null 删除/增量合并/
 * reload 生效/shadowed 遮蔽）、reset（文件删除+回落）、testEndpoints（渠道存在校验/
 * 并发池 ≤3/超时/解密失败不发网络/不接受 baseUrl 入参）、层 1.5 写点唯一性静态扫描。
 *
 * 隔离策略（同 D1 nanju-model-config.test.ts 惯例）：不用 mock.module（避免 bun 多
 * worker 分片下的跨文件 mock 泄漏）——配置层路径全部经 opts 显式注入 tmpdir 文件，
 * 渠道数据源/解密/直连测试经函数 opts 注入 fake（不发真网络）；afterEach 恢复确定性
 * 默认缓存（user 层禁用、builtin 层自动 = 仓库内置 json，与代码兜底同值）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel, ChannelDirectTestInput, ChannelTestResult } from '@proma/shared'
import {
  getNanjuModelState,
  resetNanjuModelSettings,
  saveNanjuModelSettings,
  testNanjuModelEndpoints,
  recommendNanjuModelSettings,
  type NanjuModelServiceOpts,
} from './nanju-model-settings-service'
import { loadNanjuModelConfig, reloadNanjuModelConfig } from './nanju-model-config'
import { getRoute } from './nanju-router'

/** 当前 describe 共享的 tmp 目录（afterEach 清理） */
let fixtureDir = ''

function fixturePath(name: string): string {
  fixtureDir = fixtureDir || mkdtempSync(join(tmpdir(), 'nanju-model-settings-'))
  return join(fixtureDir, `${name}.json`)
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

/** 全层禁用（纯层 3 兜底）+ fake 渠道数据源的 getState opts */
function baseOpts(listChannels?: () => Channel[]): NanjuModelServiceOpts {
  return {
    userConfigPath: null,
    overrideConfigPath: null,
    builtinConfigPath: null,
    ...(listChannels ? { listChannels } : {}),
  }
}

function fakeChannel(partial: Partial<Channel> & { id: string }): Channel {
  return {
    name: partial.id,
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'enc:fake',
    models: [],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as Channel
}

/** 双族渠道样本（family 归并：deepseek/glm-zhipu 前缀直命中；UUID 渠道走 provider 回退） */
function sampleChannels(): Channel[] {
  return [
    fakeChannel({
      id: 'deepseek',
      name: 'DeepSeek 主渠道',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      models: [
        { id: 'deepseek-v4-pro', name: 'v4-pro', enabled: true },
        { id: 'deepseek-flash', name: 'flash', enabled: true },
        { id: 'deepseek-old-name', name: 'old', enabled: false },
      ],
    }),
    fakeChannel({
      id: 'glm-zhipu',
      name: 'GLM 渠道',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: [
        { id: 'GLM-5.3', name: 'glm5.3', enabled: true },
        { id: 'glm-5.3-flash', name: 'flash', enabled: true },
      ],
    }),
  ]
}

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
  fixtureDir = ''
  // 恢复确定性默认缓存：禁用用户层（builtin 自动 = 仓库内置 json，与代码兜底同值）
  reloadNanjuModelConfig({ userConfigPath: null })
})

// ===== getState =====

describe('getNanjuModelState（初始态序列化）', () => {
  test('effective=层 3 兜底、health 三态、渠道摘要、sources 空、handLayerPresent=false', () => {
    const state = getNanjuModelState(baseOpts(sampleChannels))
    // effective：全层禁用 → 代码兜底常量
    expect(state.effective.phases.coding!.channel).toBe('glm-zhipu')
    expect(state.effective.phases.coding!.model).toBe('GLM-5.3')
    expect(state.effective.acPresets.medium.attacker.model).toBe('deepseek-v4-pro')
    expect(state.effective.proxyCandidates.length).toBeGreaterThan(0)
    // health：requirements 主选 deepseek:deepseek-v4-pro 在 fake 渠道里 enabled → ok；
    // 家族标记 'minimax'（prototype）无真实渠道 → channel-missing
    const reqPrimary = state.health.find((s) => s.slot === 'phases.requirements.primary')!
    expect(reqPrimary.status).toBe('ok')
    const protoPrimary = state.health.find((s) => s.slot === 'phases.prototype.primary')!
    expect(protoPrimary.status).toBe('channel-missing')
    // 渠道摘要：仅 id/name/enabledModelIds（disabled 模型不出现）
    expect(state.channels).toContainEqual({
      channelId: 'deepseek',
      name: 'DeepSeek 主渠道',
      enabledModelIds: ['deepseek-v4-pro', 'deepseek-flash'],
    })
    expect(state.sources).toEqual({})
    expect(state.handLayerPresent).toBe(false)
  })

  test('出参无密钥字段（apiKey/baseUrl 绝不出现）+ 层 1 存在时 handLayerPresent=true', () => {
    const layer1 = fixturePath('layer1-hand')
    writeJson(layer1, { phases: { coding: { model: 'hand-edit' } } })
    const state = getNanjuModelState({
      userConfigPath: layer1,
      overrideConfigPath: null,
      builtinConfigPath: null,
      listChannels: sampleChannels,
    })
    const serialized = JSON.stringify(state)
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('baseUrl')
    expect(state.handLayerPresent).toBe(true)
    // 层 1 生效（合并优先 1 > 1.5 > 2 > 3）
    expect(state.effective.phases.coding!.model).toBe('hand-edit')
    expect(state.sources.user).toBe(layer1)
  })
})

// ===== save =====

describe('saveNanjuModelSettings（白名单 + 增量合并 + reload + shadowed）', () => {
  test('增量合并：已有 override 字段保留，新字段写入；写盘后 reload 生效（config 缓存 + getRoute）', () => {
    const override = fixturePath('override')
    writeJson(override, { phases: { architecture: { acDefender: { channel: 'minimax', model: 'M3x' } } } })
    const resp = saveNanjuModelSettings(
      { phases: { coding: { model: 'glm-5.3-air' } } },
      { userConfigPath: null, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels },
    )
    // 落盘：architecture 覆盖保留 + coding.model 新增
    const onDisk = JSON.parse(readFileSync(override, 'utf-8')) as Record<string, unknown>
    expect((onDisk.phases as Record<string, unknown>).architecture).toBeDefined()
    expect(((onDisk.phases as Record<string, Record<string, unknown>>).coding!).model).toBe('glm-5.3-air')
    // reload 生效：state + 模块缓存 + getRoute（ROUTES 脏缓存重建，验收契约 2）
    expect(resp.state.effective.phases.coding!.model).toBe('glm-5.3-air')
    expect(loadNanjuModelConfig().phases.coding.model).toBe('glm-5.3-air')
    const codingNode = getRoute('iterative').find((n) => n.id === 'coding')!
    expect(codingNode.model).toBe('glm-5.3-air')
    // 无层 1 → 无遮蔽
    expect(resp.shadowed).toEqual([])
  })

  test('null 删除语义：save patch 字段 null = 从 override 移除该键（行级恢复）', () => {
    const override = fixturePath('override-del')
    saveNanjuModelSettings(
      { phases: { coding: { model: 'glm-5.3-air' } } },
      { userConfigPath: null, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels },
    )
    const resp = saveNanjuModelSettings(
      { phases: { coding: { model: null } } },
      { userConfigPath: null, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels },
    )
    // 键删除后 override 已无任何覆盖 → 文件整体移除（语义 = 无覆盖，低层透传）
    expect(existsSync(override)).toBe(false)
    // 有效值回落层 3
    expect(resp.state.effective.phases.coding!.model).toBe('GLM-5.3')
    expect(loadNanjuModelConfig().phases.coding.model).toBe('GLM-5.3')
  })

  test('proxyCandidates null 删除 + 合法覆盖写入（≤6 项）', () => {
    const override = fixturePath('override-proxy')
    saveNanjuModelSettings(
      { proxyCandidates: [{ channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }, { channelId: 'deepseek', modelId: 'deepseek-flash' }] },
      { userConfigPath: null, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels },
    )
    expect(loadNanjuModelConfig().proxyCandidates).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      { channelId: 'deepseek', modelId: 'deepseek-flash' },
    ])
    const resp = saveNanjuModelSettings(
      { proxyCandidates: null },
      { userConfigPath: null, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels },
    )
    // proxyCandidates 删除后 override 已无任何覆盖 → 文件整体移除
    expect(existsSync(override)).toBe(false)
    // 回落层 3 兜底候选
    expect(resp.state.effective.proxyCandidates.length).toBe(5)
  })

  test('未知顶层键 / 未知阶段键 / 未知角色键拒绝抛错（不落盘）', () => {
    const override = fixturePath('override-reject')
    const opts = { userConfigPath: null, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels }
    expect(() => saveNanjuModelSettings({ bogus: 1 } as never, opts)).toThrow('未知顶层键')
    expect(() => saveNanjuModelSettings({ phases: { delivered: { model: 'x' } } as never }, opts)).toThrow('未知阶段')
    expect(() => saveNanjuModelSettings({ phases: { coding: { wrongField: 'x' } as never } }, opts)).toThrow('未知字段')
    expect(() => saveNanjuModelSettings({ acPresets: { heavy: { attacker: { channel: 'a', model: 'b' } } } as never }, opts)).toThrow('未知档位')
    expect(() => saveNanjuModelSettings({ acPresets: { light: { judge: { channel: 'a', model: 'b' } } as never } }, opts)).toThrow('未知角色')
    // 全部拒绝后文件未创建
    expect(existsSync(override)).toBe(false)
  })

  test('proxyCandidates 非法拒绝：>6 项 / 元素多余键 / 空串；fallbacks 非法拒绝', () => {
    const override = fixturePath('override-proxy-reject')
    const opts = { userConfigPath: null, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels }
    const seven = Array.from({ length: 7 }, (_, i) => ({ channelId: 'deepseek', modelId: `m${i}` }))
    expect(() => saveNanjuModelSettings({ proxyCandidates: seven }, opts)).toThrow('超上限')
    expect(() =>
      saveNanjuModelSettings({ proxyCandidates: [{ channelId: 'a', modelId: 'b', extra: 1 } as never] }, opts),
    ).toThrow('仅允许 channelId/modelId')
    expect(() => saveNanjuModelSettings({ proxyCandidates: [{ channelId: '', modelId: 'b' }] }, opts)).toThrow('非空字符串')
    expect(() => saveNanjuModelSettings({ phases: { coding: { fallbacks: ['no-colon-string'] } } }, opts)).toThrow('channel:model')
    expect(() => saveNanjuModelSettings({ phases: { coding: { fallbacks: [] } } }, opts)).toThrow('空数组')
    expect(existsSync(override)).toBe(false)
  })

  test('shadowed：层 1 存在同字段且遮蔽本次修改 → 非空、含 path（验收契约 12）', () => {
    const layer1 = fixturePath('layer1-shadow')
    writeJson(layer1, { phases: { coding: { model: 'hand-edited' } } })
    const override = fixturePath('override-shadow')
    const resp = saveNanjuModelSettings(
      { phases: { coding: { model: 'ui-value' } } },
      { userConfigPath: layer1, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels },
    )
    expect(resp.shadowed.length).toBe(1)
    expect(resp.shadowed[0]!.field).toBe('phases.coding.model')
    expect(resp.shadowed[0]!.requested).toBe('ui-value')
    expect(resp.shadowed[0]!.effective).toBe('hand-edited')
    expect(resp.shadowed[0]!.shadowSource).toBe('layer1')
    expect(resp.shadowed[0]!.path).toBe(layer1)
    // effective 仍被层 1 遮蔽（防「修复成功但红灯不灭」的假修复循环）
    expect(resp.state.effective.phases.coding!.model).toBe('hand-edited')
  })

  test('层 1 不含该字段时不产生 shadowed（仅 effective≠requested 且层 1 声明才算遮蔽）', () => {
    const layer1 = fixturePath('layer1-noshadow')
    writeJson(layer1, { phases: { architecture: { model: 'other' } } })
    const override = fixturePath('override-noshadow')
    const resp = saveNanjuModelSettings(
      { phases: { coding: { model: 'ui-value' } } },
      { userConfigPath: layer1, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels },
    )
    expect(resp.shadowed).toEqual([])
    expect(resp.state.effective.phases.coding!.model).toBe('ui-value')
  })
})

// ===== reset =====

describe('resetNanjuModelSettings（恢复默认）', () => {
  test('删层 1.5 文件 → reload → 有效配置回落层 3（验收契约 10）', () => {
    const override = fixturePath('override-reset')
    const opts = { userConfigPath: null, overrideConfigPath: override, builtinConfigPath: null, listChannels: sampleChannels }
    saveNanjuModelSettings({ phases: { coding: { model: 'temp-model' } } }, opts)
    expect(existsSync(override)).toBe(true)
    const state = resetNanjuModelSettings(opts)
    expect(existsSync(override)).toBe(false)
    expect(state.effective.phases.coding!.model).toBe('GLM-5.3')
    expect(loadNanjuModelConfig().phases.coding.model).toBe('GLM-5.3')
    expect(state.sources.override).toBeUndefined()
    // 文件不存在时 reset 幂等（不抛错）
    expect(() => resetNanjuModelSettings(opts)).not.toThrow()
  })
})

// ===== testEndpoints =====

describe('testNanjuModelEndpoints（fake tester 注入，不发真网络）', () => {
  const channels = () => [
    fakeChannel({ id: 'deepseek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-flash', name: 'f', enabled: true }] }),
    fakeChannel({ id: 'glm-zhipu', provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm-5.3-flash', name: 'g', enabled: true }] }),
  ]

  test('渠道不存在项 → ok:false「渠道不存在」；入参非法项 → ok:false（不阻断其余项）', async () => {
    const results = await testNanjuModelEndpoints(
      [
        { channelId: 'ghost', modelId: 'x' },
        { channelId: '', modelId: 'y' },
        { channelId: 'deepseek', modelId: 'deepseek-flash' },
      ],
      {
        listChannels: channels,
        decryptApiKey: () => 'plain-key',
        testDirect: async () => ({ success: true, message: 'ok' }),
      },
    )
    expect(results.find((r) => r.channelId === 'ghost')?.ok).toBe(false)
    expect(results.find((r) => r.channelId === 'ghost')?.message).toBe('渠道不存在')
    expect(results.find((r) => r.channelId === '')?.ok).toBe(false)
    expect(results.find((r) => r.channelId === '')?.message).toContain('入参非法')
    const okItem = results.find((r) => r.channelId === 'deepseek')!
    expect(okItem.ok).toBe(true)
    expect(typeof okItem.latencyMs).toBe('number')
  })

  test('成功项 latencyMs / 失败项 message 透传；baseUrl 一律取自渠道记录（不接受入参）', async () => {
    const seenInputs: ChannelDirectTestInput[] = []
    const results = await testNanjuModelEndpoints(
      [
        { channelId: 'deepseek', modelId: 'deepseek-flash' },
        { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      ],
      {
        listChannels: channels,
        decryptApiKey: () => 'plain-key',
        testDirect: async (input) => {
          seenInputs.push(input)
          return input.provider === 'deepseek'
            ? { success: true, message: '连接正常' }
            : { success: false, message: '401 unauthorized' }
        },
      },
    )
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.latencyMs).toBeGreaterThanOrEqual(0)
    expect(results[1]!.ok).toBe(false)
    expect(results[1]!.message).toBe('401 unauthorized')
    // testDirect 收到的 baseUrl 来自渠道记录（防 SSRF：入参只有 channelId/modelId）
    expect(seenInputs[0]!.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(seenInputs[1]!.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(seenInputs[0]!.apiKey).toBe('plain-key')
    expect(seenInputs[0]!.modelId).toBe('deepseek-flash')
  })

  test('并发池峰值 ≤3（6 端点、单项 15ms 延迟）；去重后唯一端点各出一条', async () => {
    let inFlight = 0
    let peak = 0
    const endpoints = [
      { channelId: 'deepseek', modelId: 'm1' },
      { channelId: 'deepseek', modelId: 'm2' },
      { channelId: 'deepseek', modelId: 'm3' },
      { channelId: 'deepseek', modelId: 'm4' },
      { channelId: 'glm-zhipu', modelId: 'm5' },
      { channelId: 'glm-zhipu', modelId: 'm6' },
      { channelId: 'glm-zhipu', modelId: 'm6' }, // 重复项（去重）
    ]
    const results = await testNanjuModelEndpoints(endpoints, {
      listChannels: channels,
      decryptApiKey: () => 'plain-key',
      testDirect: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 15))
        inFlight -= 1
        return { success: true, message: 'ok' }
      },
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThanOrEqual(2) // 池确实并行
    expect(results.length).toBe(6) // 重复项去重
    expect(results.every((r) => r.ok)).toBe(true)
  })

  test('单项超时：ok:false + 超时消息（注入 timeoutMs 避免真等 15s）；超时后不产生 unhandledRejection', async () => {
    const results = await testNanjuModelEndpoints([{ channelId: 'deepseek', modelId: 'deepseek-flash' }], {
      listChannels: channels,
      decryptApiKey: () => 'plain-key',
      testDirect: () => new Promise<ChannelTestResult>(() => {}), // 永不 resolve
      timeoutMs: 30,
    })
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.message).toContain('超时')
    expect(results[0]!.latencyMs).toBeGreaterThanOrEqual(25)
    // 等待一个宏任务周期确认无未处理拒绝抛出
    await new Promise((r) => setTimeout(r, 10))
  })

  test('解密失败：ok:false 且绝不发网络请求（tester 零调用）', async () => {
    let testerCalls = 0
    const results = await testNanjuModelEndpoints([{ channelId: 'deepseek', modelId: 'deepseek-flash' }], {
      listChannels: channels,
      decryptApiKey: () => {
        throw new Error('密文无法还原')
      },
      testDirect: async () => {
        testerCalls += 1
        return { success: true, message: 'should-not-happen' }
      },
    })
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.message).toContain('API Key')
    expect(testerCalls).toBe(0)
  })

  test('空 Key：ok:false 提示未配置（同 testChannel 惯例）', async () => {
    let testerCalls = 0
    const results = await testNanjuModelEndpoints([{ channelId: 'deepseek', modelId: 'deepseek-flash' }], {
      listChannels: channels,
      decryptApiKey: () => '',
      testDirect: async () => {
        testerCalls += 1
        return { success: true, message: 'x' }
      },
    })
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.message).toContain('尚未配置 API Key')
    expect(testerCalls).toBe(0)
  })
})

// ===== recommend（薄封装：确定性矩阵透传 D1） =====

describe('recommendNanjuModelSettings（快照 + D1 矩阵透传）', () => {
  test('fake 渠道快照注入 → 返回 D1 NanjuRecommendResult 形状', () => {
    const result = recommendNanjuModelSettings(baseOpts(sampleChannels))
    expect(typeof result.applyable).toBe('boolean')
    expect(Array.isArray(result.changes)).toBe(true)
    expect(Array.isArray(result.notes)).toBe(true)
    // 渠道含 GLM-5.3 enabled → coding 主选有效无需变更（确定性：同输入两次调用全等）
    const again = recommendNanjuModelSettings(baseOpts(sampleChannels))
    expect(again).toEqual(result)
  })
})

// ===== 层 1.5 写点唯一性静态扫描（验收契约 1） =====

describe('层 1.5 写点唯一性静态扫描', () => {
  test('src/main + src/preload 内 override 文件名的 writeFileSync/appendFileSync 调用行总数 === 1', () => {
    // 拆两段拼接，避免本测试文件自身因常量声明行意外命中扫描口径
    const literal = 'nanju-model-config' + '-override.json'
    const collectTsFiles = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) collectTsFiles(full, out)
        else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const mainSrc = join(import.meta.dir, '..')
    const preloadSrc = join(import.meta.dir, '..', '..', 'preload')
    const files = [...collectTsFiles(mainSrc), ...collectTsFiles(preloadSrc)]
    expect(files.length).toBeGreaterThan(100) // 递归确实覆盖了源码树
    const hitLines: string[] = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf-8').split('\n')
      for (const line of lines) {
        if (/writeFileSync|appendFileSync/.test(line) && line.includes(literal)) hitLines.push(`${file}: ${line.trim()}`)
      }
    }
    expect(hitLines.length).toBe(1)
    // 唯一写点必须落在 D2 service 的原子写函数里
    expect(hitLines[0]).toContain('nanju-model-settings-service.ts')
  })
})

// ===== W23 工程审查修复红测（should#4）=====
test('save 拒绝空数组 proxyCandidates（清空须用 null，与 fallbacks 空集合语义对齐）', () => {
  expect(() => saveNanjuModelSettings(
    { proxyCandidates: [] },
    { userConfigPath: null, overrideConfigPath: fixturePath('override-empty-proxy'), builtinConfigPath: null, listChannels: sampleChannels },
  )).toThrow('不允许空数组')
})
