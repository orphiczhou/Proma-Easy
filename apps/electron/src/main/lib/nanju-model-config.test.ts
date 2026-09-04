import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FALLBACK_AC_PRESETS,
  FALLBACK_PHASE_MODELS,
  getConfigFallbackChains,
  loadNanjuModelConfig,
  reloadNanjuModelConfig,
  resolveAcPreset,
  resolveBuiltinNanjuModelConfigPath,
  resolvePhaseModelConfig,
  type NanjuModelConfigFile,
} from './nanju-model-config'
import { getFallbackChain } from './nanju-model-fallback'
import { AC_PRESETS, getPhaseNode } from './nanju-router'

/**
 * W13b 模型参数文件测试（两层外置 + 校验容错 + resolve + 链编译 + 一致性锁定）。
 *
 * 隔离策略：不用 mock.module（避免 bun 多 worker 分片下的跨文件 mock 泄漏，见 w13-report
 * §6 工程笔记）——层路径全部经 loadNanjuModelConfig/reloadNanjuModelConfig 的 opts 显式注入
 * tmpdir 文件；afterEach 恢复默认缓存（user 层禁用、builtin 层自动 = 仓库内置 json，
 * 与代码兜底同值），保证同 worker 后续文件看到确定性状态。
 */

/** 当前 describe 共享的 tmp 目录（afterEach 清理） */
let fixtureDir = ''

function tmpConfigPath(name: string): string {
  fixtureDir = fixtureDir || mkdtempSync(join(tmpdir(), 'nanju-model-config-'))
  return join(fixtureDir, `${name}.json`)
}

/** 写一层配置文件并返回绝对路径 */
function writeLayer(name: string, content: NanjuModelConfigFile | string): string {
  const path = tmpConfigPath(name)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return path
}

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true })
  fixtureDir = ''
  // 恢复确定性默认缓存：禁用用户层（builtin 自动 = 仓库内置 json，与代码兜底同值）
  reloadNanjuModelConfig({ userConfigPath: null })
})

// ===== 层 3：代码兜底常量 =====

describe('FALLBACK_PHASE_MODELS / FALLBACK_AC_PRESETS（代码兜底常量，W13b 裁定值）', () => {
  test('六阶段主选 + fallbacks + per-phase 防御者覆盖（coding/architecture = GLM-5.3，用户 09-04 07:25 核心裁定）', () => {
    expect(FALLBACK_PHASE_MODELS.requirements).toEqual({
      channel: 'deepseek', model: 'deepseek-v4-pro',
      fallbacks: ['deepseek:deepseek-v4-flash', 'glm-zhipu:glm-5.3-flash'],
    })
    expect(FALLBACK_PHASE_MODELS.prototype).toEqual({
      channel: 'minimax', model: 'MiniMax-M3',
      fallbacks: ['glm-zhipu:glm-5.3-flash'],
    })
    expect(FALLBACK_PHASE_MODELS.architecture).toEqual({
      channel: 'glm-zhipu', model: 'GLM-5.3',
      fallbacks: ['deepseek:deepseek-v4-pro'], // 用户指定备选
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
    expect(FALLBACK_PHASE_MODELS.planning).toEqual({
      channel: 'deepseek', model: 'deepseek-v4-flash',
      fallbacks: ['glm-zhipu:glm-5.3-flash'],
    })
    expect(FALLBACK_PHASE_MODELS.coding).toEqual({
      channel: 'glm-zhipu', model: 'GLM-5.3',
      fallbacks: ['glm-zhipu:glm-5.3-flash', 'deepseek:deepseek-v4-flash'],
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
    expect(FALLBACK_PHASE_MODELS.testing).toEqual({
      channel: 'glm-zhipu', model: 'glm-5.3-flash',
      fallbacks: ['deepseek:deepseek-v4-flash'],
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
  })

  test('AC 两档预设兜底（W4 已定值不变）', () => {
    expect(FALLBACK_AC_PRESETS.light).toEqual({
      attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' },
      defender: { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
    })
    expect(FALLBACK_AC_PRESETS.medium).toEqual({
      attacker: { channel: 'deepseek', model: 'deepseek-v4-pro' },
      defender: { channel: 'glm-zhipu', model: 'GLM-5.3' },
    })
  })
})

// ===== 两层加载与覆盖 =====

describe('两层加载（用户覆盖 > 内置 > 代码兜底）', () => {
  test('两层全禁用 → 逐字段回退代码兜底常量', () => {
    const config = reloadNanjuModelConfig({ userConfigPath: null, builtinConfigPath: null })
    expect(config.phases).toEqual(FALLBACK_PHASE_MODELS)
    expect(config.acPresets).toEqual(FALLBACK_AC_PRESETS)
    expect(config.sources.builtin).toBeUndefined()
    expect(config.sources.user).toBeUndefined()
  })

  test('内置层覆盖代码兜底（phase 字段 + acPresets 档位）', () => {
    const builtinPath = writeLayer('builtin-override', {
      phases: {
        coding: { model: 'GLM-Custom' },
        planning: { fallbacks: ['kimi:k3'] },
      },
      acPresets: {
        light: { defender: { channel: 'minimax', model: 'MiniMax-M3' } },
      },
    })
    const config = reloadNanjuModelConfig({ userConfigPath: null, builtinConfigPath: builtinPath })
    expect(config.sources.builtin).toBe(builtinPath)
    // model 覆盖、channel 继承兜底
    expect(config.phases.coding).toMatchObject({ channel: 'glm-zhipu', model: 'GLM-Custom' })
    expect(config.phases.planning.fallbacks).toEqual(['kimi:k3'])
    expect(config.acPresets.light.defender).toEqual({ channel: 'minimax', model: 'MiniMax-M3' })
    // 未提及的档位/阶段不受影响
    expect(config.acPresets.medium).toEqual(FALLBACK_AC_PRESETS.medium)
    expect(config.phases.testing).toEqual(FALLBACK_PHASE_MODELS.testing)
  })

  test('用户层覆盖内置层（字段级：user 只写 model，channel 继承内置）', () => {
    const builtinPath = writeLayer('ub-builtin', {
      phases: { coding: { channel: 'glm-zhipu', model: 'GLM-Builtin' } },
    })
    const userPath = writeLayer('ub-user', {
      phases: { coding: { model: 'GLM-User' } },
    })
    const config = reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: builtinPath })
    expect(config.phases.coding).toMatchObject({ channel: 'glm-zhipu', model: 'GLM-User' })
    expect(config.sources.user).toBe(userPath)
    expect(config.sources.builtin).toBe(builtinPath)
  })

  test('层文件缺失 → 跳层不报错（user 不存在 = 只用内置 + 兜底）', () => {
    const builtinPath = writeLayer('missing-user-builtin', {
      phases: { coding: { model: 'GLM-Builtin' } },
    })
    const config = reloadNanjuModelConfig({
      userConfigPath: join(fixtureDir, 'not-exist.json'),
      builtinConfigPath: builtinPath,
    })
    expect(config.sources.user).toBeUndefined()
    expect(config.phases.coding.model).toBe('GLM-Builtin')
  })

  test('非法 JSON / 根结构非对象 → warn 跳层，不整体拒绝', () => {
    const badJson = writeLayer('bad-json', '{ not valid json !!!')
    const badRoot = writeLayer('bad-root', '[1, 2, 3]')
    const config = reloadNanjuModelConfig({
      userConfigPath: badJson,
      builtinConfigPath: badRoot,
    })
    // 两层全跳 → 兜底值
    expect(config.sources.user).toBeUndefined()
    expect(config.sources.builtin).toBeUndefined()
    expect(config.phases).toEqual(FALLBACK_PHASE_MODELS)
  })

  test('字段级校验容错：非法项跳过用兜底 + warn（不整体拒绝），合法项照常生效', () => {
    const userPath = writeLayer('invalid-fields', {
      version: 1,
      phases: {
        // 未知阶段：warn 后忽略（故意越界类型，经 cast 写入文件）
        unknown_phase: { channel: 'x', model: 'y' },
        coding: {
          channel: '   ',              // 非法（空白）→ 保持兜底 glm-zhipu
          model: 'GLM-User',           // 合法 → 生效
          fallbacks: ['no-colon', 'deepseek:deepseek-v4-flash', ':leading', 'trailing:'], // 4 条中 1 条合法
          acDefender: { channel: 'minimax' }, // 缺 model → 非法，保持兜底覆盖值
        },
      } as unknown as NanjuModelConfigFile['phases'],
      acPresets: {
        light: { attacker: { channel: '', model: '' } }, // 非法 → 保持兜底
      },
    })
    const config = reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: null })
    expect(config.phases.coding.channel).toBe('glm-zhipu') // 非法字段保持兜底
    expect(config.phases.coding.model).toBe('GLM-User')   // 合法字段生效
    expect(config.phases.coding.fallbacks).toEqual(['deepseek:deepseek-v4-flash']) // 非法条目被丢弃
    expect(config.phases.coding.acDefender).toEqual({ channel: 'minimax', model: 'MiniMax-M3' }) // 非法覆盖不动兜底值
    expect(config.acPresets.light.attacker).toEqual(FALLBACK_AC_PRESETS.light.attacker)
  })

  test('fallbacks 空数组/全非法视为未声明（继承低层，不支持用空数组清链）', () => {
    const userPath = writeLayer('empty-fallbacks', {
      phases: { coding: { fallbacks: [] } },
    })
    const config = reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: null })
    expect(config.phases.coding.fallbacks).toEqual(FALLBACK_PHASE_MODELS.coding.fallbacks)
  })

  test('模块缓存：无 opts 两次加载同引用；reload 重算返回新对象', () => {
    reloadNanjuModelConfig({ userConfigPath: null, builtinConfigPath: null })
    const a = loadNanjuModelConfig()
    const b = loadNanjuModelConfig()
    expect(b).toBe(a)
    const c = reloadNanjuModelConfig({ userConfigPath: null, builtinConfigPath: null })
    expect(c).not.toBe(a)
    expect(c).toEqual(a) // 内容等价（同两层禁用输入）
  })
})

// ===== resolve 函数 =====

describe('resolvePhaseModelConfig / resolveAcPreset', () => {
  test('resolvePhaseModelConfig 全六阶段（纯兜底，两层禁用）：主选 + fallbacks 端点化', () => {
    reloadNanjuModelConfig({ userConfigPath: null, builtinConfigPath: null })
    expect(resolvePhaseModelConfig('requirements')).toEqual({
      channel: 'deepseek', model: 'deepseek-v4-pro',
      fallbacks: [
        { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },
        { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      ],
    })
    expect(resolvePhaseModelConfig('prototype')).toEqual({
      channel: 'minimax', model: 'MiniMax-M3',
      fallbacks: [{ channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }],
    })
    expect(resolvePhaseModelConfig('architecture')).toEqual({
      channel: 'glm-zhipu', model: 'GLM-5.3',
      fallbacks: [{ channelId: 'deepseek', modelId: 'deepseek-v4-pro' }],
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
    expect(resolvePhaseModelConfig('planning')).toEqual({
      channel: 'deepseek', model: 'deepseek-v4-flash',
      fallbacks: [{ channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }],
    })
    expect(resolvePhaseModelConfig('coding')).toEqual({
      channel: 'glm-zhipu', model: 'GLM-5.3',
      fallbacks: [
        { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
        { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },
      ],
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
    expect(resolvePhaseModelConfig('testing')).toEqual({
      channel: 'glm-zhipu', model: 'glm-5.3-flash',
      fallbacks: [{ channelId: 'deepseek', modelId: 'deepseek-v4-flash' }],
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
  })

  test('resolveAcPreset 两档（quick=light / iterative=medium）', () => {
    reloadNanjuModelConfig({ userConfigPath: null, builtinConfigPath: null })
    expect(resolveAcPreset('light')).toEqual({
      attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' },
      defender: { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
    })
    expect(resolveAcPreset('medium')).toEqual({
      attacker: { channel: 'deepseek', model: 'deepseek-v4-pro' },
      defender: { channel: 'glm-zhipu', model: 'GLM-5.3' },
    })
  })

  test('per-phase AC 防御者覆盖：coding/architecture/testing = minimax:MiniMax-M3；requirements/prototype/planning 无覆盖（默认加载态）', () => {
    reloadNanjuModelConfig({ userConfigPath: null })
    for (const id of ['architecture', 'coding', 'testing'] as const) {
      expect(resolvePhaseModelConfig(id).acDefender).toEqual({ channel: 'minimax', model: 'MiniMax-M3' })
    }
    for (const id of ['requirements', 'prototype', 'planning'] as const) {
      expect(resolvePhaseModelConfig(id).acDefender).toBeUndefined()
      expect(resolvePhaseModelConfig(id).acAttacker).toBeUndefined()
    }
  })

  test('用户覆盖可改写 per-phase 防御者（覆盖能力随参数文件下发）', () => {
    const userPath = writeLayer('custom-defender', {
      phases: { coding: { acDefender: { channel: 'kimi', model: 'k3' } } },
    })
    reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: null })
    expect(resolvePhaseModelConfig('coding').acDefender).toEqual({ channel: 'kimi', model: 'k3' })
    // 其他阶段不受影响
    expect(resolvePhaseModelConfig('testing').acDefender).toEqual({ channel: 'minimax', model: 'MiniMax-M3' })
  })
})

// ===== fallback 链编译（配置优先 / 代码链兜底） =====

describe('getConfigFallbackChains + getFallbackChain（W13b 配置优先接线）', () => {
  test('默认链表：5 个 key；同 key（glm-zhipu:GLM-5.3）按阶段序取声明并集（architecture 先、coding 追加）', () => {
    reloadNanjuModelConfig({ userConfigPath: null })
    const chains = getConfigFallbackChains()
    expect(chains['deepseek:deepseek-v4-pro']).toEqual([
      { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
    ])
    expect(chains['minimax:MiniMax-M3']).toEqual([{ channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }])
    expect(chains['glm-zhipu:GLM-5.3']).toEqual([
      { channelId: 'deepseek', modelId: 'deepseek-v4-pro' },       // architecture 声明（用户指定备选）
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },        // coding 声明
      { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },     // coding 声明
    ])
    expect(chains['deepseek:deepseek-v4-flash']).toEqual([{ channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }])
    expect(chains['glm-zhipu:glm-5.3-flash']).toEqual([{ channelId: 'deepseek', modelId: 'deepseek-v4-flash' }])
    expect(Object.keys(chains).sort()).toEqual([
      'deepseek:deepseek-v4-flash', 'deepseek:deepseek-v4-pro',
      'glm-zhipu:GLM-5.3', 'glm-zhipu:glm-5.3-flash', 'minimax:MiniMax-M3',
    ])
  })

  test('配置链优先：glm:GLM-5.3 返回配置并集（≠ 代码链顺序，证明优先级）', () => {
    reloadNanjuModelConfig({ userConfigPath: null })
    const chain = getFallbackChain('glm-zhipu', 'GLM-5.3')
    expect(chain[0]).toEqual({ channelId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(chain).not.toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },
    ])
  })

  test('配置缺项回退代码链：user 改写 planning 主选后，deepseek:deepseek-v4-flash 不再是配置 key → 走 MODEL_FALLBACK_CHAINS', () => {
    const userPath = writeLayer('replan-planning', {
      phases: { planning: { channel: 'kimi', model: 'k3' } }, // 无 fallbacks → 不入配置链表
    })
    reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: null })
    // deepseek:deepseek-v4-flash 主选已不存在于任何阶段 → 配置链无该 key → 代码链兜底
    expect(getFallbackChain('deepseek', 'deepseek-v4-flash')).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
    ])
    // 新主选继承低层声明的 fallbacks（字段级合并语义）
    expect(getFallbackChain('kimi', 'k3')).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
    ])
    // 任何链表都未覆盖的端点 → 空链 = 既有失败路径
    expect(getFallbackChain('deepseek', 'unknown-model')).toEqual([])
    // requirements 仍声明 deepseek:deepseek-v4-pro 主选 → 配置链在
    expect(getFallbackChain('deepseek', 'deepseek-v4-pro')[0]).toEqual({ channelId: 'deepseek', modelId: 'deepseek-v4-flash' })
  })
})

// ===== 一致性锁定（内置 json ↔ 代码兜底 ↔ 路由实际消费） =====

describe('一致性锁定（内置 json 与代码兜底同值；路由实际消费配置）', () => {
  /** 仓库内置 json 的稳定定位：cwd 自动探测，失败时退回 import.meta.dir 相对路径 */
  function repoBuiltinPath(): string {
    const auto = resolveBuiltinNanjuModelConfigPath()
    if (existsSync(auto)) return auto
    return join(import.meta.dir, '..', '..', '..', 'resources', 'nanju-model-config.json')
  }

  test('内置 resources/nanju-model-config.json 与 FALLBACK_PHASE_MODELS / FALLBACK_AC_PRESETS 深相等', () => {
    const path = repoBuiltinPath()
    expect(existsSync(path)).toBe(true)
    const file = JSON.parse(readFileSync(path, 'utf-8')) as {
      phases: typeof FALLBACK_PHASE_MODELS
      acPresets: typeof FALLBACK_AC_PRESETS
    }
    expect(file.phases).toEqual(FALLBACK_PHASE_MODELS)
    expect(file.acPresets).toEqual(FALLBACK_AC_PRESETS)
  })

  test('nanju-router 的 AC_PRESETS 再导出与 FALLBACK_AC_PRESETS 同值（预设兜底单点定义）', () => {
    expect(AC_PRESETS).toBe(FALLBACK_AC_PRESETS)
    expect(AC_PRESETS).toEqual(FALLBACK_AC_PRESETS)
  })

  test('端到端：两模式全部路由节点的 channel/model/防御者覆盖位与 resolvePhaseModelConfig 一致（路由确实经配置消费）', () => {
    reloadNanjuModelConfig({ userConfigPath: null })
    for (const mode of ['quick', 'iterative'] as const) {
      for (const phaseId of ['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing'] as const) {
        const node = getPhaseNode(mode, phaseId)
        if (mode === 'quick' && phaseId === 'planning') {
          expect(node).toBeUndefined() // quick 无 planning
          continue
        }
        expect(node).toBeDefined()
        const cfg = resolvePhaseModelConfig(phaseId)
        expect(node?.channel).toBe(cfg.channel)
        expect(node?.model).toBe(cfg.model)
        expect(node?.acDefenderChannel).toBe(cfg.acDefender?.channel)
        expect(node?.acDefenderModel).toBe(cfg.acDefender?.model)
      }
    }
  })

  test('electron-builder extraResources 收录内置参数文件（打包层接线）', () => {
    const builder = readFileSync(join(import.meta.dir, '..', '..', '..', 'electron-builder.yml'), 'utf-8')
    expect(builder).toContain('resources/nanju-model-config.json')
    expect(builder).toContain('to: nanju-model-config.json')
  })
})
