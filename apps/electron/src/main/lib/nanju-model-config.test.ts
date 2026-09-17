import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FALLBACK_AC_PRESETS,
  FALLBACK_PHASE_MODELS,
  FALLBACK_PROXY_CANDIDATES,
  NANJU_PROXY_CANDIDATES_MAX,
  getConfigFallbackChains,
  getConfigGeneration,
  getUserNanjuModelOverridePath,
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
  // 恢复确定性默认缓存：禁用用户层与 override 层（builtin 自动 = 仓库内置 json，与代码兜底同值）
  reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null })
})

// ===== 层 3：代码兜底常量 =====

describe('FALLBACK_PHASE_MODELS / FALLBACK_AC_PRESETS（代码兜底常量，W13b 裁定值）', () => {
  test('六阶段主选 + fallbacks + per-phase 防御者覆盖（coding/architecture = GLM-5.3，用户 09-04 07:25 核心裁定）', () => {
    expect(FALLBACK_PHASE_MODELS.requirements).toEqual({
      channel: 'deepseek', model: 'deepseek-v4-pro',
      fallbacks: ['deepseek:deepseek-flash', 'glm-zhipu:glm-5.3-flash'],
    })
    expect(FALLBACK_PHASE_MODELS.prototype).toEqual({
      channel: 'minimax', model: 'MiniMax-M3',
      fallbacks: ['glm-zhipu:glm-5.3-flash'],
      // B2：visualReviewer 默认未设——与 author 同家族标记运行时解析同 UUID 渠道
      // （同端点自证），默认不启用独立视觉验证者；用户在 nanju-model-config 中
      // 显式配置 visualReviewer（异族端点）才启用该槽位
    })
    expect(FALLBACK_PHASE_MODELS.architecture).toEqual({
      channel: 'glm-zhipu', model: 'GLM-5.3',
      fallbacks: ['deepseek:deepseek-v4-pro'], // 用户指定备选
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
    expect(FALLBACK_PHASE_MODELS.planning).toEqual({
      channel: 'deepseek', model: 'deepseek-flash',
      fallbacks: ['glm-zhipu:glm-5.3-flash'],
    })
    expect(FALLBACK_PHASE_MODELS.coding).toEqual({
      channel: 'glm-zhipu', model: 'GLM-5.3',
      fallbacks: ['glm-zhipu:glm-5.3-flash', 'deepseek:deepseek-flash'],
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
    expect(FALLBACK_PHASE_MODELS.testing).toEqual({
      // W22 M#6（v0.17.106）：作者跨族换 deepseek-flash + fallbacks 对调；
      // W22 M#7：acAttacker per-phase 覆盖（三族矩阵：作者 ds / 攻 glm / 防 minimax）
      channel: 'deepseek', model: 'deepseek-flash',
      fallbacks: ['glm-zhipu:glm-5.3-flash', 'deepseek:deepseek-v4-pro'],
      acAttacker: { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
  })

  test('AC 两档预设兜底（W4 已定值不变）', () => {
    expect(FALLBACK_AC_PRESETS.light).toEqual({
      attacker: { channel: 'deepseek', model: 'deepseek-flash' },
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
          fallbacks: ['no-colon', 'deepseek:deepseek-flash', ':leading', 'trailing:'], // 4 条中 1 条合法
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
    expect(config.phases.coding.fallbacks).toEqual(['deepseek:deepseek-flash']) // 非法条目被丢弃
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
        { channelId: 'deepseek', modelId: 'deepseek-flash' },
        { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      ],
    })
    expect(resolvePhaseModelConfig('prototype')).toEqual({
      channel: 'minimax', model: 'MiniMax-M3',
      fallbacks: [{ channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }],
      // B2：默认未设 visualReviewer（用户可显式配置启用）
    })
    expect(resolvePhaseModelConfig('architecture')).toEqual({
      channel: 'glm-zhipu', model: 'GLM-5.3',
      fallbacks: [{ channelId: 'deepseek', modelId: 'deepseek-v4-pro' }],
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
    expect(resolvePhaseModelConfig('planning')).toEqual({
      channel: 'deepseek', model: 'deepseek-flash',
      fallbacks: [{ channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }],
    })
    expect(resolvePhaseModelConfig('coding')).toEqual({
      channel: 'glm-zhipu', model: 'GLM-5.3',
      fallbacks: [
        { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
        { channelId: 'deepseek', modelId: 'deepseek-flash' },
      ],
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
    expect(resolvePhaseModelConfig('testing')).toEqual({
      channel: 'deepseek', model: 'deepseek-flash',
      fallbacks: [
        { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
        { channelId: 'deepseek', modelId: 'deepseek-v4-pro' },
      ],
      acAttacker: { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
      acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
    })
  })

  test('resolveAcPreset 两档（quick=light / iterative=medium）', () => {
    reloadNanjuModelConfig({ userConfigPath: null, builtinConfigPath: null })
    expect(resolveAcPreset('light')).toEqual({
      attacker: { channel: 'deepseek', model: 'deepseek-flash' },
      defender: { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
    })
    expect(resolveAcPreset('medium')).toEqual({
      attacker: { channel: 'deepseek', model: 'deepseek-v4-pro' },
      defender: { channel: 'glm-zhipu', model: 'GLM-5.3' },
    })
  })

  test('per-phase AC 覆盖：architecture/coding 防御者 + testing 攻击者+防御者；requirements/prototype/planning 无覆盖（默认加载态；W22 M#7 起 testing 双覆盖）', () => {
    reloadNanjuModelConfig({ userConfigPath: null })
    for (const id of ['architecture', 'coding'] as const) {
      expect(resolvePhaseModelConfig(id).acDefender).toEqual({ channel: 'minimax', model: 'MiniMax-M3' })
      expect(resolvePhaseModelConfig(id).acAttacker).toBeUndefined()
    }
    // W22 三族矩阵：testing 作者 deepseek / 攻击者 glm（M#7 覆盖）/ 防御者 minimax
    expect(resolvePhaseModelConfig('testing').acAttacker).toEqual({ channel: 'glm-zhipu', model: 'glm-5.3-flash' })
    expect(resolvePhaseModelConfig('testing').acDefender).toEqual({ channel: 'minimax', model: 'MiniMax-M3' })
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
  test('默认链表：4 个 key（W22 M#6 后 testing 主选换 deepseek-flash，glm:glm-5.3-flash 不再是主选 key）；同 key 按阶段序取声明并集（glm:GLM-5.3 由 architecture 先、coding 追加；deepseek:v4-flash 由 planning 先、testing 追加）', () => {
    reloadNanjuModelConfig({ userConfigPath: null })
    const chains = getConfigFallbackChains()
    expect(chains['deepseek:deepseek-v4-pro']).toEqual([
      { channelId: 'deepseek', modelId: 'deepseek-flash' },
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
    ])
    expect(chains['minimax:MiniMax-M3']).toEqual([{ channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }])
    expect(chains['glm-zhipu:GLM-5.3']).toEqual([
      { channelId: 'deepseek', modelId: 'deepseek-v4-pro' },       // architecture 声明（用户指定备选）
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },        // coding 声明
      { channelId: 'deepseek', modelId: 'deepseek-flash' },     // coding 声明
    ])
    // W22 M#6：planning 先声明 [glm-5.3-flash]，testing 追加 [glm-5.3-flash（去重）, deepseek-v4-pro]
    expect(chains['deepseek:deepseek-flash']).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      { channelId: 'deepseek', modelId: 'deepseek-v4-pro' },
    ])
    // W22 M#6：testing 主选不再是 glm-zhipu:glm-5.3-flash → 该 key 从配置链表消失
    // （运行时由代码链 MODEL_FALLBACK_CHAINS 兑底同名链，行为不变）
    expect(chains['glm-zhipu:glm-5.3-flash']).toBeUndefined()
    expect(Object.keys(chains).sort()).toEqual([
      'deepseek:deepseek-flash', 'deepseek:deepseek-v4-pro',
      'glm-zhipu:GLM-5.3', 'minimax:MiniMax-M3',
    ])
  })

  test('配置链优先：glm:GLM-5.3 返回配置并集（≠ 代码链顺序，证明优先级）', () => {
    reloadNanjuModelConfig({ userConfigPath: null })
    const chain = getFallbackChain('glm-zhipu', 'GLM-5.3')
    expect(chain[0]).toEqual({ channelId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(chain).not.toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      { channelId: 'deepseek', modelId: 'deepseek-flash' },
    ])
  })

  test('配置缺项回退代码链：user 同时改写 planning+testing 主选后，deepseek:deepseek-flash 不再是配置 key → 走 MODEL_FALLBACK_CHAINS（W22 M#6 后 testing 主选也是该端点，需两者都改才缺项）', () => {
    const userPath = writeLayer('replan-planning', {
      phases: {
        planning: { channel: 'kimi', model: 'k3' },
        testing: { channel: 'kimi', model: 'k3' },
      },
    })
    reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: null })
    // deepseek:deepseek-flash 主选已不存在于任何阶段 → 配置链无该 key → 代码链兜底
    expect(getFallbackChain('deepseek', 'deepseek-flash')).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
    ])
    // 新主选继承低层声明的 fallbacks（字段级合并语义；planning 先声明、testing 追加并集）
    expect(getFallbackChain('kimi', 'k3')).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      { channelId: 'deepseek', modelId: 'deepseek-v4-pro' },
    ])
    // 任何链表都未覆盖的端点 → 空链 = 既有失败路径
    expect(getFallbackChain('deepseek', 'unknown-model')).toEqual([])
    // requirements 仍声明 deepseek:deepseek-v4-pro 主选 → 配置链在
    expect(getFallbackChain('deepseek', 'deepseek-v4-pro')[0]).toEqual({ channelId: 'deepseek', modelId: 'deepseek-flash' })
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

// ===== W23：层 1.5 UI 覆盖 + proxyCandidates + 配置代次 =====

describe('W23 层 1.5（UI 覆盖文件：user > override > builtin > 兜底）', () => {
  test('优先级：override 覆盖 builtin，user 覆盖 override；sources 逐层记录；路径按 config-paths 惯例', () => {
    const builtinPath = writeLayer('w23-builtin', { phases: { planning: { channel: 'deepseek', model: 'deepseek-flash' } } })
    const overridePath = writeLayer('w23-override', { phases: { planning: { channel: 'kimi', model: 'k3' } } })
    const userPath = writeLayer('w23-user', { phases: { planning: { channel: 'glm-zhipu', model: 'glm-5.3-flash' } } })
    let config = reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: overridePath, builtinConfigPath: builtinPath })
    expect(config.phases.planning.model).toBe('k3')
    expect(config.sources.override).toBe(overridePath)
    config = reloadNanjuModelConfig({ userConfigPath: userPath, overrideConfigPath: overridePath, builtinConfigPath: builtinPath })
    expect(config.phases.planning.model).toBe('glm-5.3-flash')
    expect(config.sources.user).toBe(userPath)
    expect(getUserNanjuModelOverridePath()).toContain('nanju-model-config-override.json')
  })

  test('override 层字段级覆盖语义与既有层一致（合法替换、非法 warn 保持低层）', () => {
    const builtinPath = writeLayer('w23b-builtin', { phases: { coding: { channel: 'glm-zhipu', model: 'GLM-5.3' } } })
    const overridePath = writeLayer('w23b-override', { phases: { coding: { model: '' } } } as unknown as NanjuModelConfigFile)
    const config = reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: overridePath, builtinConfigPath: builtinPath })
    expect(config.phases.coding.model).toBe('GLM-5.3')
  })

  test('overrideConfigPath:null 显式禁用该层（sources.override 缺省）', () => {
    const builtinPath = writeLayer('w23c-builtin', { phases: { planning: { channel: 'deepseek', model: 'deepseek-flash' } } })
    const config = reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null, builtinConfigPath: builtinPath })
    expect(config.phases.planning.model).toBe('deepseek-flash')
    expect(config.sources.override).toBeUndefined()
  })
})

describe('W23 proxyCandidates（根节，四层取值 + 校验容错）', () => {
  test('层 3 兜底常量托底（三层禁用仍非空）', () => {
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null, builtinConfigPath: null })
    expect(loadNanjuModelConfig().proxyCandidates).toEqual([...FALLBACK_PROXY_CANDIDATES])
  })

  test('四层取值：builtin 声明生效 → override 覆盖 → user 最高', () => {
    const builtinPath = writeLayer('pc-builtin', { proxyCandidates: [{ channelId: 'a', modelId: 'a1' }] })
    let config = reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null, builtinConfigPath: builtinPath })
    expect(config.proxyCandidates).toEqual([{ channelId: 'a', modelId: 'a1' }])
    const overridePath = writeLayer('pc-override', { proxyCandidates: [{ channelId: 'b', modelId: 'b1' }] })
    config = reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: overridePath, builtinConfigPath: builtinPath })
    expect(config.proxyCandidates).toEqual([{ channelId: 'b', modelId: 'b1' }])
    const userPath = writeLayer('pc-user', { proxyCandidates: [{ channelId: 'c', modelId: 'c1' }] })
    config = reloadNanjuModelConfig({ userConfigPath: userPath, overrideConfigPath: overridePath, builtinConfigPath: builtinPath })
    expect(config.proxyCandidates).toEqual([{ channelId: 'c', modelId: 'c1' }])
  })

  test('校验容错：非法元素跳过、>6 截断到前 6、全非法 = 继承低层', () => {
    const overridePath = writeLayer('pc-invalid', {
      proxyCandidates: [
        { channelId: '', modelId: 'x' },
        'not-an-object' as unknown as { channelId: string; modelId: string },
        { channelId: 'ok', modelId: 'ok1' },
      ],
    })
    let config = reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: overridePath, builtinConfigPath: null })
    expect(config.proxyCandidates).toEqual([{ channelId: 'ok', modelId: 'ok1' }])
    const seven = Array.from({ length: 7 }, (_, i) => ({ channelId: `c${i}`, modelId: `m${i}` }))
    const bigPath = writeLayer('pc-big', { proxyCandidates: seven })
    config = reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: bigPath, builtinConfigPath: null })
    expect(config.proxyCandidates).toHaveLength(NANJU_PROXY_CANDIDATES_MAX)
    expect(config.proxyCandidates[NANJU_PROXY_CANDIDATES_MAX - 1]).toEqual({ channelId: 'c5', modelId: 'm5' })
    const badPath = writeLayer('pc-allbad', { proxyCandidates: [null, 42] as unknown as Array<{ channelId: string; modelId: string }> })
    config = reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: badPath, builtinConfigPath: null })
    expect(config.proxyCandidates).toEqual([...FALLBACK_PROXY_CANDIDATES])
  })

  test('层 3 常量与 nanju-clarify-proxy-tool.PROXY_CHANNEL_CANDIDATES 锁定同值（源码文本锁定——动态 import 会传递引入 electron，bun 下不可用）', () => {
    const extract = (source: string, constName: string): Array<{ channelId: string; modelId: string }> => {
      const m = new RegExp(constName + String.raw`[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)`).exec(source)
      if (!m) throw new Error(constName + ' 常量未在源码中找到')
      const pairs = Array.from(m[1]!.matchAll(new RegExp(String.raw`\{\s*channelId:\s*'([^']+)'\s*,\s*modelId:\s*'([^']+)'\s*\}`, 'g')))
      return pairs.map((p) => ({ channelId: p[1]!, modelId: p[2]! }))
    }
    const toolSource = readFileSync(join(__dirname, 'nanju-clarify-proxy-tool.ts'), 'utf-8')
    expect(extract(toolSource, 'PROXY_CHANNEL_CANDIDATES')).toEqual([...FALLBACK_PROXY_CANDIDATES])
  })
})

describe('W23 配置代次（getConfigGeneration）', () => {
  test('每次 reload +1（router 脏缓存比对基准）', () => {
    const before = getConfigGeneration()
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null })
    expect(getConfigGeneration()).toBe(before + 1)
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null })
    expect(getConfigGeneration()).toBe(before + 2)
  })
})

// ═══════════════ W-B B2：visualReviewer 独立槽位（参数文件加载与覆盖语义）══════════════

describe('W-B B2：visualReviewer 独立槽位（与 author 解耦）', () => {
  test('默认层 3 兜底：prototype.visualReviewer 默认未设；其他阶段无 visualReviewer', () => {
    // B2：默认不复盖为 minimax/MiniMax-M3（同作者家族标记 → 同端点自证）——视觉验证者是
    // 异族裁决槽位，必须用户显式配置异族端点才启用；未配置时不渲染视觉验证者。
    expect(FALLBACK_PHASE_MODELS.prototype.visualReviewer).toBeUndefined()
    for (const id of ['requirements', 'architecture', 'planning', 'coding', 'testing'] as const) {
      expect(FALLBACK_PHASE_MODELS[id].visualReviewer).toBeUndefined()
    }
  })

  test('resolvePhaseModelConfig：默认 prototype 不包含 visualReviewer；其他阶段也不包含', () => {
    reloadNanjuModelConfig({ userConfigPath: null, builtinConfigPath: null })
    expect(resolvePhaseModelConfig('prototype').visualReviewer).toBeUndefined()
    for (const id of ['requirements', 'architecture', 'planning', 'coding', 'testing'] as const) {
      expect(resolvePhaseModelConfig(id).visualReviewer).toBeUndefined()
    }
  })

  test('用户覆盖可改写 visualReviewer（字段级独立覆盖；不与 author 同型合并）', () => {
    const userPath = tmpConfigPath('b2-visualreviewer-user')
    writeFileSync(userPath, JSON.stringify({
      phases: {
        prototype: {
          channel: 'glm-zhipu', // 用户显式让作者走 glm 系
          model: 'GLM-5.3',
          // 视觉验证者显式异族端点（避免同端点自证）
          visualReviewer: { channel: 'minimax', model: 'MiniMax-M3' },
        },
      },
    }))
    reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: null })
    const resolved = resolvePhaseModelConfig('prototype')
    expect(resolved.channel).toBe('glm-zhipu') // 作者被覆盖
    expect(resolved.model).toBe('GLM-5.3')
    expect(resolved.visualReviewer).toEqual({ channel: 'minimax', model: 'MiniMax-M3' }) // 视觉验证者独立覆盖生效
  })

  test('用户可显式设置 visualReviewer 为任意同族端点（与 author 跨族），参数文件不拒——同端点自证由 gate 接线检测', () => {
    // 本文件仅验证参数文件加载容错；同端点拒绝是 gate 接线职责，不是 model-config 职责。
    const userPath = tmpConfigPath('b2-visualreviewer-arbitrary')
    writeFileSync(userPath, JSON.stringify({
      phases: {
        prototype: {
          visualReviewer: { channel: 'kimi', model: 'k3-vision' },
        },
      },
    }))
    reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: null })
    expect(resolvePhaseModelConfig('prototype').visualReviewer).toEqual({ channel: 'kimi', model: 'k3-vision' })
  })

  test('字段级校验容错：visualReviewer 非法（非 {channel, model} 两键）→ warn 并保持低层值', () => {
    const userPath = tmpConfigPath('b2-visualreviewer-invalid')
    writeFileSync(userPath, JSON.stringify({
      phases: {
        prototype: {
          // channel 缺 model → 非法；channel 空串 → 非法；多余键 → 拒绝
          visualReviewer: { channel: 'minimax' }, // 缺 model
        },
      },
    }))
    reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: null })
    // 非法字段被丢弃 → visualReviewer 保持低层值（默认未设）
    expect(resolvePhaseModelConfig('prototype').visualReviewer).toBeUndefined()
  })

  test('字段级校验容错：visualReviewer 空 channel → warn 并保持低层值（与 acAttacker/acDefender 同样容错口径）', () => {
    const userPath = tmpConfigPath('b2-visualreviewer-empty-channel')
    writeFileSync(userPath, JSON.stringify({
      phases: {
        prototype: {
          visualReviewer: { channel: '', model: 'MiniMax-M3' },
        },
      },
    }))
    reloadNanjuModelConfig({ userConfigPath: userPath, builtinConfigPath: null })
    expect(resolvePhaseModelConfig('prototype').visualReviewer).toBeUndefined()
  })
})
