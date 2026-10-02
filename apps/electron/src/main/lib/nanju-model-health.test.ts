import { describe, expect, test } from 'bun:test'
import {
  classifyModelTier,
  computeNanjuModelHealth,
  normalizeModelIdForRename,
  recommendEndpointReplacement,
  recommendNanjuModelMatrix,
  type NanjuChannelSnapshot,
} from './nanju-model-health'
import { loadNanjuModelConfig, reloadNanjuModelConfig, type LoadedNanjuModelConfig } from './nanju-model-config'

/**
 * W23 §八 D1 红测：健康三态 / 档位判定 / 版本段归一 / 推荐确定性 / 改名场景 /
 * 硬约束两态（有解不选违约族、单族无解）。纯函数直测——config 对象字面量注入
 * （无文件 IO、无 mock.module；loadNanjuModelConfig 三层禁用 = 层 3 确定性默认）。
 */

/** 深拷贝有效配置（测试内改造个别槽位用） */
function cloneConfig(config: LoadedNanjuModelConfig): LoadedNanjuModelConfig {
  return JSON.parse(JSON.stringify(config)) as LoadedNanjuModelConfig
}

/** 渠道现状基线（dev 实例形态：deepseek/glm 字面 ID + minimax UUID 家族归并） */
const FULL_SNAPSHOTS: NanjuChannelSnapshot[] = [
  {
    channelId: 'deepseek',
    family: 'family-deepseek',
    models: [
      { modelId: 'deepseek-flash', enabled: true },
      { modelId: 'deepseek-v4-pro', enabled: true },
    ],
  },
  {
    channelId: 'glm-zhipu',
    family: 'family-glm',
    models: [
      { modelId: 'glm-5.3-flash', enabled: true },
      { modelId: 'GLM-5.3', enabled: true },
    ],
  },
  {
    channelId: 'mm-uuid-0001',
    family: 'family-minimax',
    models: [{ modelId: 'MiniMax-M3', enabled: true }],
  },
]

/** 确定性默认配置（层 1/1.5/2 全禁用 → 层 3 常量） */
function defaultConfig(): LoadedNanjuModelConfig {
  reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null, builtinConfigPath: null })
  return loadNanjuModelConfig()
}

// ===== 档位判定（快类优先） =====

describe('classifyModelTier（§三.2 快类优先判定）', () => {
  test('glm-5.3-flash 判快（同时含 5.3 不误判旗舰——设计点名场景）', () => {
    expect(classifyModelTier('glm-5.3-flash')).toBe('fast')
  })

  test('flash/turbo/air/lite 均判快；vision-exp 混合 flash 也判快（快类优先于视觉）', () => {
    expect(classifyModelTier('deepseek-flash')).toBe('fast')
    expect(classifyModelTier('qwen-turbo')).toBe('fast')
    expect(classifyModelTier('glm-air')).toBe('fast')
    expect(classifyModelTier('kimi-lite')).toBe('fast')
    expect(classifyModelTier('deepseek-v4-flash-vision-exp')).toBe('fast')
  })

  test('pro/5.3/M3 判旗舰；纯 vision 判视觉；无法归类 unknown', () => {
    expect(classifyModelTier('deepseek-v4-pro')).toBe('flagship')
    expect(classifyModelTier('GLM-5.3')).toBe('flagship')
    expect(classifyModelTier('MiniMax-M3')).toBe('flagship')
    expect(classifyModelTier('qvq-vision')).toBe('vision')
    expect(classifyModelTier('k3')).toBe('unknown')
  })
})

// ===== 版本段归一（改名检测） =====

describe('normalizeModelIdForRename（去 -v\\d+ 版本段）', () => {
  test('deepseek-v4-flash → deepseek-flash（厂家改名命中形态）', () => {
    expect(normalizeModelIdForRename('deepseek-v4-flash')).toBe('deepseek-flash')
  })

  test('多段与无段：deepseek-v4 → deepseek；glm-5.3 / MiniMax-M3 原样', () => {
    expect(normalizeModelIdForRename('deepseek-v4')).toBe('deepseek')
    expect(normalizeModelIdForRename('glm-5.3')).toBe('glm-5.3')
    expect(normalizeModelIdForRename('MiniMax-M3')).toBe('MiniMax-M3')
    expect(normalizeModelIdForRename('deepseek-v4-flash-vision-exp')).toBe('deepseek-flash-vision-exp')
  })
})

// ===== 健康三态 =====

describe('computeNanjuModelHealth（三态红灯 + 槽位命名）', () => {
  test('全有效：invalidCount=0；槽位命名覆盖 primary/fallbacks/acAttacker/acDefender/预设/代理', () => {
    const report = computeNanjuModelHealth(defaultConfig(), FULL_SNAPSHOTS)
    expect(report.invalidCount).toBe(0)
    const slots = report.slots.map((s) => s.slot)
    expect(slots).toContain('phases.requirements.primary')
    expect(slots).toContain('phases.requirements.fallbacks[0]')
    expect(slots).toContain('phases.testing.acAttacker')
    expect(slots).toContain('phases.coding.acDefender')
    expect(slots).toContain('acPresets.light.attacker')
    expect(slots).toContain('acPresets.medium.defender')
    expect(slots).toContain('proxyCandidates[0]')
    // 家族标记 'minimax'（prototype 主选）按快照 family 归族解析 → ok
    expect(report.slots.find((s) => s.slot === 'phases.prototype.primary')?.status).toBe('ok')
  })

  test('model-disabled（黄）：模型存在但 enabled=false', () => {
    const snapshots = FULL_SNAPSHOTS.map((c) =>
      c.channelId === 'deepseek'
        ? { ...c, models: c.models.map((m) => (m.modelId === 'deepseek-flash' ? { ...m, enabled: false } : m)) }
        : c,
    )
    const report = computeNanjuModelHealth(defaultConfig(), snapshots)
    expect(report.slots.find((s) => s.slot === 'phases.planning.primary')?.status).toBe('model-disabled')
    expect(report.invalidCount).toBeGreaterThan(0)
  })

  test('model-missing（红）：渠道存在但模型不存在（改名残留形态）', () => {
    const snapshots = FULL_SNAPSHOTS.map((c) =>
      c.channelId === 'deepseek'
        ? { ...c, models: [{ modelId: 'deepseek-flash', enabled: true }, { modelId: 'deepseek-v4-pro', enabled: true }] }
        : c,
    )
    const config = defaultConfig()
    config.phases.planning!.model = 'deepseek-v4-flash' // 旧名（厂家已改名）
    const report = computeNanjuModelHealth(config, snapshots)
    expect(report.slots.find((s) => s.slot === 'phases.planning.primary')?.status).toBe('model-missing')
  })

  test('channel-missing（红）：渠道整体不存在（含家族归族失败）', () => {
    const snapshots = FULL_SNAPSHOTS.filter((c) => c.family !== 'family-minimax')
    const report = computeNanjuModelHealth(defaultConfig(), snapshots)
    expect(report.slots.find((s) => s.slot === 'phases.prototype.primary')?.status).toBe('channel-missing')
  })
})

// ===== 单槽替换（recommendEndpointReplacement） =====

describe('recommendEndpointReplacement（单槽阶梯）', () => {
  test('有效端点 → null（有效即保留）', () => {
    expect(recommendEndpointReplacement('phases.coding.primary', 'glm-zhipu', 'GLM-5.3', defaultConfig(), FULL_SNAPSHOTS)).toBeNull()
  })

  test('改名命中：同渠道版本段归一优先（deepseek-v4-flash → deepseek-flash）', () => {
    const r = recommendEndpointReplacement('phases.planning.primary', 'deepseek', 'deepseek-v4-flash', defaultConfig(), FULL_SNAPSHOTS)
    expect(r).toEqual({ channelId: 'deepseek', modelId: 'deepseek-flash', reason: 'same-channel-rename' })
  })

  test('跨版本改名归一命中：v4-pro 失效且渠道有 v5-pro（归一同为 deepseek-pro）→ rename 命中优先于普通同档位', () => {
    // deepseek 渠道有 flash + v5-pro；v4-pro 失效：
    const snapshots: NanjuChannelSnapshot[] = [
      { channelId: 'deepseek', family: 'family-deepseek', models: [
        { modelId: 'deepseek-flash', enabled: true },
        { modelId: 'deepseek-v5-pro', enabled: true },
      ] },
      ...FULL_SNAPSHOTS.slice(1),
    ]
    const r = recommendEndpointReplacement('phases.requirements.primary', 'deepseek', 'deepseek-v4-pro', defaultConfig(), snapshots)
    // deepseek-v4-pro 与 deepseek-v5-pro 版本段归一后同为 deepseek-pro → 改名命中（优先于普通同档位）
    expect(r).toEqual({ channelId: 'deepseek', modelId: 'deepseek-v5-pro', reason: 'same-channel-rename' })
  })

  test('无任何可用替换 → null', () => {
    expect(recommendEndpointReplacement('phases.planning.primary', 'deepseek', 'deepseek-v4-flash', defaultConfig(), [])).toBeNull()
  })
})

// ===== 整套推荐（确定性 + 两态） =====

describe('recommendNanjuModelMatrix（§三 确定性 + 硬约束两态）', () => {
  test('全有效默认配置：无需变更（matrix=null + applyable=true + changes 空）', () => {
    const result = recommendNanjuModelMatrix(defaultConfig(), FULL_SNAPSHOTS)
    expect(result.applyable).toBe(true)
    expect(result.changes).toEqual([])
    expect(result.matrix).toBeNull()
  })

  test('确定性：同输入两次调用结果全等（deep equal 红测）', () => {
    const config = defaultConfig()
    config.phases.planning!.model = 'deepseek-v4-flash'
    config.phases.testing!.fallbacks = ['glm-zhipu:glm-5.3-flash', 'deepseek:deepseek-v4-pro']
    const a = recommendNanjuModelMatrix(config, FULL_SNAPSHOTS)
    const b = recommendNanjuModelMatrix(config, FULL_SNAPSHOTS)
    expect(a).toEqual(b)
  })

  test('改名场景红测：旧名失效 → health=red + recommend.to=deepseek:deepseek-flash（版本段归一命中）+ matrix 补丁可应用', () => {
    const config = defaultConfig()
    config.phases.planning!.model = 'deepseek-v4-flash'
    const health = computeNanjuModelHealth(config, FULL_SNAPSHOTS)
    expect(health.slots.find((s) => s.slot === 'phases.planning.primary')?.status).toBe('model-missing')
    const result = recommendNanjuModelMatrix(config, FULL_SNAPSHOTS)
    expect(result.applyable).toBe(true)
    const change = result.changes.find((c) => c.slot === 'phases.planning.primary')
    expect(change).toBeDefined()
    expect(change!.from).toBe('deepseek:deepseek-v4-flash')
    expect(change!.to).toBe('deepseek:deepseek-flash')
    expect(result.matrix).not.toBeNull()
    expect((result.matrix!.phases!.planning as { model?: string })?.model).toBe('deepseek-flash')
    expect((result.matrix!.phases!.planning as { channel?: string })?.channel).toBe('deepseek')
  })

  test('有解红测：防御者同族失效 → 重选不落违约族（glm 作者的防御者不得换成 glm 候选，落 minimax 规格族）', () => {
    const config = defaultConfig()
    // 用户配置把 coding 防御者改成 glm 系死端点（同作者族 + 失效）
    config.phases.coding!.acDefender = { channel: 'glm-zhipu', model: 'glm-4-dead' }
    const result = recommendNanjuModelMatrix(config, FULL_SNAPSHOTS)
    expect(result.applyable).toBe(true)
    const change = result.changes.find((c) => c.slot === 'phases.coding.acDefender')
    expect(change).toBeDefined()
    expect(change!.to).toBe('mm-uuid-0001:MiniMax-M3') // 规格族 minimax:旗舰 命中，非 glm 候选
    expect(change!.to.startsWith('glm-zhipu:')).toBe(false)
  })

  test('无解红测：单族渠道 → matrix=null + applyable=false + diversityViolations 非空（save 拒绝应用）', () => {
    const glmOnly: NanjuChannelSnapshot[] = [
      { channelId: 'glm-zhipu', family: 'family-glm', models: [
        { modelId: 'glm-5.3-flash', enabled: true },
        { modelId: 'GLM-5.3', enabled: true },
      ] },
    ]
    const result = recommendNanjuModelMatrix(defaultConfig(), glmOnly)
    expect(result.matrix).toBeNull()
    expect(result.applyable).toBe(false)
    expect(result.diversityViolations).toBeDefined()
    expect(result.diversityViolations!.length).toBeGreaterThan(0)
    // 违约项可读：含 slot 与 violation 说明
    for (const v of result.diversityViolations!) {
      expect(v.slot).toBeTruthy()
      expect(v.violation.length).toBeGreaterThan(5)
    }
  })

  test('coding↔testing 主选同族（用户误配）→ 有跨族替换时重选 testing 主选并保持跨族', () => {
    const config = defaultConfig()
    config.phases.testing!.channel = 'glm-zhipu'
    config.phases.testing!.model = 'GLM-5.3' // 与 coding 同族同模型（误配）
    const result = recommendNanjuModelMatrix(config, FULL_SNAPSHOTS)
    expect(result.applyable).toBe(true)
    const change = result.changes.find((c) => c.slot === 'phases.testing.primary')
    expect(change).toBeDefined()
    expect(change!.to.startsWith('deepseek:')).toBe(true) // 重选回 ds 族（规格 ds:快 → deepseek-flash）
    expect(change!.to).toBe('deepseek:deepseek-flash')
  })

  test('fallback 失效替换进 matrix 补丁的完整新链（字符串端点形态）', () => {
    const config = defaultConfig()
    config.phases.requirements!.fallbacks = ['deepseek:deepseek-v4-flash', 'glm-zhipu:glm-5.3-flash']
    const result = recommendNanjuModelMatrix(config, FULL_SNAPSHOTS)
    expect(result.applyable).toBe(true)
    expect((result.matrix!.phases!.requirements as { fallbacks?: string[] })?.fallbacks)
      .toEqual(['deepseek:deepseek-flash', 'glm-zhipu:glm-5.3-flash'])
  })

  test('代理候选失效替换：proxyCandidates 补丁全量下发（偏好序 [glm:快,...]）', () => {
    const config = defaultConfig()
    config.proxyCandidates = [
      { channelId: 'glm-zhipu', modelId: 'glm-4-flash-dead' },
      { channelId: 'deepseek', modelId: 'deepseek-flash' },
    ]
    const result = recommendNanjuModelMatrix(config, FULL_SNAPSHOTS)
    expect(result.applyable).toBe(true)
    expect(result.matrix!.proxyCandidates).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }, // 偏好序首个 glm:快 命中
      { channelId: 'deepseek', modelId: 'deepseek-flash' },
    ])
  })
})

// ===== W23 工程审查修复红测（should#3/#5）=====

describe('W23 审查修复：推荐诚实性与双档校验', () => {
  test('#3 渠道全空时零变更分支不得宣称「全部端点有效」，且保留失效槽位 notes', () => {
    const config = defaultConfig()
    const rec = recommendNanjuModelMatrix(config, [])
    expect(rec.changes).toHaveLength(0)
    expect(rec.notes.some((n) => n.includes('全部端点有效'))).toBe(false)
    expect(rec.notes.some((n) => n.includes('无法自动替换的失效端点'))).toBe(true)
    expect(rec.notes.some((n) => n.includes('无任何可用替换候选'))).toBe(true)
  })

  test('#5 light 档违约可被终检捕获（不再只查 medium）', () => {
    // 构造：requirements 作者 deepseek 系；light 预设 defender 故意配成 deepseek 系（与作者同族），
    // 且渠道池只有 deepseek+glm 两族但 defender 槽位可换 glm → 应产生 change 而非漏检；
    // 再构造无解形态：仅 deepseek 单族渠道 + light defender 同族 → violations 含 [light]
    // 注意：defaultConfig() 返回共享缓存对象，必须 clone 后再改（原地改会污染同进程后续测试）
    const config = cloneConfig(defaultConfig())
    config.acPresets.light.defender = { channel: 'deepseek', model: 'deepseek-flash' }
    const singleFamily = [
      { channelId: 'deepseek', family: 'family-deepseek', models: [{ modelId: 'deepseek-flash', enabled: true }, { modelId: 'deepseek-v4-pro', enabled: true }] },
    ]
    const rec = recommendNanjuModelMatrix(config, singleFamily)
    expect(rec.applyable).toBe(false)
    expect(rec.diversityViolations?.some((v) => v.violation.includes('[light]'))).toBe(true)
  })
})
