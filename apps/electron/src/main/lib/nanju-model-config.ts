/**
 * 南大向导全环节模型参数文件（W13b，v0.17.75）
 *
 * 两层外置加载（用户 09-04 07:25 核心裁定 + 工单 v2 §0）：
 *   层 1（用户覆盖）~/.proma/nanju-model-config.json（开发模式 ~/.proma-dev/，config-paths 惯例）
 *   层 2（内置）    resources/nanju-model-config.json（electron-builder extraResources 打包；
 *                   dev cwd 探测候选同 nanju-engineering-template 惯例）
 *   层 3（代码兜底）本文件 FALLBACK_PHASE_MODELS / FALLBACK_AC_PRESETS 常量
 * 合并语义：字段级覆盖（高层合法字段逐项替换低层值），非法项跳过用兜底 + warn（不整体拒绝）。
 *
 * 消费方：
 * - nanju-router.ts：PhaseNode 的 channel/model/ac* 覆盖位 + resolveACActors 的攻防预设
 *   （代码内原硬编码值保留为层 3 兜底常量，与内置 json 同值——一致性由
 *   nanju-model-config.test.ts 锁定测试保证）
 * - nanju-model-fallback.ts：getFallbackChain 优先读 phases[].fallbacks 编译链（配置缺项
 *   回退代码链 MODEL_FALLBACK_CHAINS，两层兼容）
 *
 * 缓存与生效：模块级缓存，进程内首次加载后复用；改参数文件需重启应用（重启生效）。
 * 测试注入：loadNanjuModelConfig / reloadNanjuModelConfig 的 opts 支持显式指定/禁用各层
 * 路径（不依赖 mock.module，避免 bun 多 worker 分片下的跨文件 mock 泄漏）。
 *
 * 注意：本模块被 nanju-router 于模块加载期消费（构建 ROUTES），因此只允许 type-only
 * import nanju-router（运行时反向依赖会成环）；文件 IO 全部 try/catch 容错（读不到 =
 * 跳层，绝不阻断路由构建）。
 */

import type { PhaseId, TaskWeight } from './nanju-router'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ===== 类型 =====

/** 参与模型配置的六个阶段（delivered 是终态哨兵，无 L2 委派） */
export type NanjuModelPhaseId = Exclude<PhaseId, 'delivered'>

/** 六阶段固定序（fallback 链编译的同 key 合并顺序基准） */
export const NANJU_MODEL_PHASE_ORDER: readonly NanjuModelPhaseId[] = [
  'requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing',
]

const PHASE_ID_SET: ReadonlySet<string> = new Set(NANJU_MODEL_PHASE_ORDER)

/** AC 攻/防角色（渠道 + 模型；channel 可为家族标记如 'minimax'，运行时解析见 nanju-router-prompt.ts） */
export interface NanjuACActor {
  channel: string
  model: string
}

/** 渠道 + 模型端点（fallback 链节点形态，与 nanju-model-fallback.ModelEndpoint 结构同构） */
export interface NanjuModelEndpoint {
  channelId: string
  modelId: string
}

/** 参数文件的阶段条目（全部字段可选——仅覆盖用户想改的字段，其余继承低层） */
export interface PhaseModelEntry {
  channel: string
  model: string
  /** 降级链（'channel:model' 字符串数组，依次降级） */
  fallbacks?: string[]
  /** per-phase AC 攻击者显式覆盖（缺省 = 按 taskWeight 取 acPresets 预设） */
  acAttacker?: NanjuACActor
  /** per-phase AC 防御者显式覆盖（家族多样性必查项：作者 glm 系阶段的防御者必须异族） */
  acDefender?: NanjuACActor
}

/** AC 攻防预设条目 */
export interface AcPresetEntry {
  attacker: NanjuACActor
  defender: NanjuACActor
}

/** 参数文件根结构（两层文件共用同一 schema） */
export interface NanjuModelConfigFile {
  version?: number
  phases?: Partial<Record<NanjuModelPhaseId, Partial<PhaseModelEntry>>>
  acPresets?: Partial<Record<TaskWeight, Partial<AcPresetEntry>>>
}

/** 加载完成的有效配置（三层合并后；六阶段字段全部齐备） */
export interface LoadedNanjuModelConfig {
  phases: Record<NanjuModelPhaseId, PhaseModelEntry>
  acPresets: Record<TaskWeight, AcPresetEntry>
  /** 实际参与合并的层来源（可观测：排查配置为何未生效） */
  sources: { builtin?: string; user?: string }
}

// ===== 层 3：代码兜底常量（与内置 resources/nanju-model-config.json 同值，锁定测试保证一致） =====

/**
 * 六阶段默认模型 + fallback 链 + per-phase AC 覆盖。
 *
 * W13b 裁定（用户 09-04 07:25，补做 W13 未执行的 core 裁定）：
 * - coding：glm-zhipu:GLM-5.3（备选链 glm-5.3-flash → deepseek-v4-flash）
 * - architecture：glm-zhipu:GLM-5.3（备选 deepseek-v4-pro，用户指定备选）
 * - coding/architecture AC 防御者显式覆盖 minimax:MiniMax-M3——作者 glm 系与两档预设
 *   防御者（light=glm-5.3-flash / medium=GLM-5.3，均 glm 系）同族，assertACFamilyDiversity
 *   构建期必抛错；攻者两档均 deepseek 系 → 防御者唯一可用异族 = minimax 系（W13 testing 先例）
 * - testing/planning 沿用 W13 裁定（glm-5.3-flash / deepseek-v4-flash），requirements/prototype 保持
 *
 * fallback 链编译说明：链按端点 key（channel:model）合并——多阶段共用同一主选端点时
 * （architecture 与 coding 共用 glm-zhipu:GLM-5.3），按 NANJU_MODEL_PHASE_ORDER 顺序取
 * 各阶段声明链的并集（去重保序）。delegate 执行链不携带 phase 上下文，只能按端点查链。
 */
export const FALLBACK_PHASE_MODELS: Record<NanjuModelPhaseId, PhaseModelEntry> = {
  requirements: {
    channel: 'deepseek',
    model: 'deepseek-v4-pro',
    fallbacks: ['deepseek:deepseek-v4-flash', 'glm-zhipu:glm-5.3-flash'],
  },
  prototype: {
    // 'minimax' 是家族标记（渠道 ID 是 UUID，运行时解析，见 nanju-router-prompt.ts）
    channel: 'minimax',
    model: 'MiniMax-M3',
    fallbacks: ['glm-zhipu:glm-5.3-flash'],
  },
  architecture: {
    channel: 'glm-zhipu',
    model: 'GLM-5.3',
    fallbacks: ['deepseek:deepseek-v4-pro'],
    acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
  },
  planning: {
    channel: 'deepseek',
    model: 'deepseek-v4-flash',
    fallbacks: ['glm-zhipu:glm-5.3-flash'],
  },
  coding: {
    channel: 'glm-zhipu',
    model: 'GLM-5.3',
    fallbacks: ['glm-zhipu:glm-5.3-flash', 'deepseek:deepseek-v4-flash'],
    acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
  },
  testing: {
    channel: 'glm-zhipu',
    model: 'glm-5.3-flash',
    fallbacks: ['deepseek:deepseek-v4-flash'],
    acDefender: { channel: 'minimax', model: 'MiniMax-M3' },
  },
}

/** AC 攻防预设兜底（W4 已定，与 nanju-router 的 AC_PRESETS 同值） */
export const FALLBACK_AC_PRESETS: Record<TaskWeight, AcPresetEntry> = {
  light: {
    attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' },
    defender: { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
  },
  medium: {
    attacker: { channel: 'deepseek', model: 'deepseek-v4-pro' },
    defender: { channel: 'glm-zhipu', model: 'GLM-5.3' },
  },
}

// ===== 路径解析 =====

/**
 * 内置参数文件路径（层 2）。候选依次探测（首个存在者胜，同 nanju-engineering-template 惯例）：
 * 1. 打包后 process.resourcesPath（electron-builder extraResources 落点）
 * 2. process.cwd()/apps/electron/resources（仓库根跑测试/脚本）
 * 3. process.cwd()/resources（dev:electron，cwd=apps/electron）
 * 全部不存在时返回候选 1（调用方 existsSync 降级为跳层）。
 */
export function resolveBuiltinNanjuModelConfigPath(explicitBase?: string): string {
  if (explicitBase) return join(explicitBase, 'nanju-model-config.json')
  const bases: string[] = []
  // Electron 主进程检测用 process.versions.electron（无副作用）：
  // bun/node 测试环境下 require('electron') 有包 wrapper 副作用，禁止引入
  if (typeof process.versions.electron === 'string' && (process as { type?: string }).type === 'browser') {
    bases.push(process.resourcesPath as string)
  }
  bases.push(join(process.cwd(), 'apps', 'electron', 'resources'))
  bases.push(join(process.cwd(), 'resources'))
  for (const base of bases) {
    const candidate = join(base, 'nanju-model-config.json')
    if (existsSync(candidate)) return candidate
  }
  return join(bases[0]!, 'nanju-model-config.json')
}

/**
 * 用户覆盖文件路径（层 1）：getConfigDirName 惯例（正式 ~/.proma/，开发 ~/.proma-dev/）。
 * 只拼路径不建目录（getConfigDir 会 mkdir，读路径不需要副作用）。
 */
export function getUserNanjuModelConfigPath(): string {
  const { getConfigDirName } = require('./config-paths') as typeof import('./config-paths')
  return join(homedir(), getConfigDirName(), 'nanju-model-config.json')
}

// ===== 校验容错（非法项跳过用兜底 + warn，不整体拒绝） =====

function warn(message: string): void {
  console.warn(`[nanju-model-config] ${message}`)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 校验单个 AC 角色：合法返回克隆，非法 warn 并返回 undefined（该字段保持低层值） */
function sanitizeActor(value: unknown, context: string): NanjuACActor | undefined {
  if (typeof value !== 'object' || value === null) {
    warn(`${context} 不是对象，忽略该覆盖`)
    return undefined
  }
  const { channel, model } = value as Record<string, unknown>
  if (!isNonEmptyString(channel) || !isNonEmptyString(model)) {
    warn(`${context} 的 channel/model 非空字符串校验失败，忽略该覆盖`)
    return undefined
  }
  return { channel, model }
}

/** 校验单个 fallback 链条目（'channel:model'，按第一个冒号切分，两侧非空） */
function sanitizeFallbackEntry(value: unknown, context: string): string | undefined {
  if (typeof value !== 'string') {
    warn(`${context} 不是字符串，丢弃`)
    return undefined
  }
  const idx = value.indexOf(':')
  if (idx <= 0 || idx >= value.length - 1) {
    warn(`${context}（${value}）不是合法的 channel:model 形态，丢弃`)
    return undefined
  }
  return value
}

/** 深拷贝兜底常量（合并基底；避免调用方修改污染常量） */
function cloneFallback(): LoadedNanjuModelConfig {
  const phases = {} as Record<NanjuModelPhaseId, PhaseModelEntry>
  for (const id of NANJU_MODEL_PHASE_ORDER) {
    const entry = FALLBACK_PHASE_MODELS[id]!
    phases[id] = {
      channel: entry.channel,
      model: entry.model,
      ...(entry.fallbacks ? { fallbacks: [...entry.fallbacks] } : {}),
      ...(entry.acAttacker ? { acAttacker: { ...entry.acAttacker } } : {}),
      ...(entry.acDefender ? { acDefender: { ...entry.acDefender } } : {}),
    }
  }
  return {
    phases,
    acPresets: {
      light: {
        attacker: { ...FALLBACK_AC_PRESETS.light.attacker },
        defender: { ...FALLBACK_AC_PRESETS.light.defender },
      },
      medium: {
        attacker: { ...FALLBACK_AC_PRESETS.medium.attacker },
        defender: { ...FALLBACK_AC_PRESETS.medium.defender },
      },
    },
    sources: {},
  }
}

/** 读取并解析一层文件：不存在/IO 失败/JSON 非法 → warn + null（跳层，不整体拒绝） */
function readConfigFile(path: string): NanjuModelConfigFile | null {
  try {
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warn(`配置文件 ${path} 根结构不是对象，跳过该层`)
      return null
    }
    return parsed as NanjuModelConfigFile
  } catch (err) {
    warn(`配置文件 ${path} 读取/解析失败（${err instanceof Error ? err.message : String(err)}），跳过该层`)
    return null
  }
}

/** 把一层文件的合法字段合并进基底（字段级覆盖；非法字段 warn 后保持低层值） */
function mergeFileLayer(base: LoadedNanjuModelConfig, file: NanjuModelConfigFile, sourcePath: string): void {
  if (file.phases !== undefined) {
    if (typeof file.phases !== 'object' || file.phases === null) {
      warn(`${sourcePath} 的 phases 不是对象，忽略 phases 节`)
    } else {
      for (const key of Object.keys(file.phases)) {
        if (!PHASE_ID_SET.has(key)) {
          warn(`${sourcePath} phases 含未知阶段 ${key}（合法值：${NANJU_MODEL_PHASE_ORDER.join('/')}），忽略`)
          continue
        }
        const phaseId = key as NanjuModelPhaseId
        const entry: unknown = (file.phases as Record<string, unknown>)[key]
        if (typeof entry !== 'object' || entry === null) {
          warn(`${sourcePath} phases.${key} 不是对象，忽略`)
          continue
        }
        const patch = entry as Partial<PhaseModelEntry>
        const target = base.phases[phaseId]
        const ctx = `${sourcePath} phases.${key}`
        if (patch.channel !== undefined) {
          if (isNonEmptyString(patch.channel)) target.channel = patch.channel
          else warn(`${ctx}.channel 非法（非非空字符串），保持原值 ${target.channel}`)
        }
        if (patch.model !== undefined) {
          if (isNonEmptyString(patch.model)) target.model = patch.model
          else warn(`${ctx}.model 非法（非非空字符串），保持原值 ${target.model}`)
        }
        if (patch.fallbacks !== undefined) {
          if (Array.isArray(patch.fallbacks)) {
            const list = patch.fallbacks
              .map((item, i) => sanitizeFallbackEntry(item, `${ctx}.fallbacks[${i}]`))
              .filter((item): item is string => item !== undefined)
            // 非空合法链才覆盖（空数组/全非法 = 视为未声明，继承低层）
            if (list.length > 0) target.fallbacks = list
          } else {
            warn(`${ctx}.fallbacks 不是数组，忽略`)
          }
        }
        if (patch.acAttacker !== undefined) {
          const actor = sanitizeActor(patch.acAttacker, `${ctx}.acAttacker`)
          if (actor) target.acAttacker = actor
        }
        if (patch.acDefender !== undefined) {
          const actor = sanitizeActor(patch.acDefender, `${ctx}.acDefender`)
          if (actor) target.acDefender = actor
        }
      }
    }
  }
  if (file.acPresets !== undefined) {
    if (typeof file.acPresets !== 'object' || file.acPresets === null) {
      warn(`${sourcePath} 的 acPresets 不是对象，忽略 acPresets 节`)
    } else {
      for (const weight of ['light', 'medium'] as const) {
        const entry: unknown = (file.acPresets as Record<string, unknown>)[weight]
        if (entry === undefined) continue
        const ctx = `${sourcePath} acPresets.${weight}`
        if (typeof entry !== 'object' || entry === null) {
          warn(`${ctx} 不是对象，忽略`)
          continue
        }
        const patch = entry as Partial<AcPresetEntry>
        if (patch.attacker !== undefined) {
          const actor = sanitizeActor(patch.attacker, `${ctx}.attacker`)
          if (actor) base.acPresets[weight].attacker = actor
        }
        if (patch.defender !== undefined) {
          const actor = sanitizeActor(patch.defender, `${ctx}.defender`)
          if (actor) base.acPresets[weight].defender = actor
        }
      }
    }
  }
}

// ===== 加载 + 缓存 =====

export interface NanjuModelConfigLoadOpts {
  /** 层 1 用户覆盖文件路径；undefined = 自动探测（~/.proma/）；null = 禁用该层 */
  userConfigPath?: string | null
  /** 层 2 内置文件路径；undefined = 自动探测（resources 候选）；null = 禁用该层 */
  builtinConfigPath?: string | null
}

function computeConfig(opts: NanjuModelConfigLoadOpts): LoadedNanjuModelConfig {
  const result = cloneFallback()
  // 层 2：内置（低 → 高依次覆盖）
  if (opts.builtinConfigPath !== null) {
    const path = opts.builtinConfigPath ?? resolveBuiltinNanjuModelConfigPath()
    const file = readConfigFile(path)
    if (file) {
      mergeFileLayer(result, file, path)
      result.sources.builtin = path
    }
  }
  // 层 1：用户覆盖（最高优先）
  if (opts.userConfigPath !== null) {
    const path = opts.userConfigPath ?? getUserNanjuModelConfigPath()
    const file = readConfigFile(path)
    if (file) {
      mergeFileLayer(result, file, path)
      result.sources.user = path
    }
  }
  return result
}

let _cache: LoadedNanjuModelConfig | undefined

/**
 * 加载有效配置（模块级缓存）：无 opts 且已有缓存时直接返回缓存（进程内一次 IO）；
 * 传 opts 时按显式路径重算并更新缓存（测试注入用）。
 */
export function loadNanjuModelConfig(opts?: NanjuModelConfigLoadOpts): LoadedNanjuModelConfig {
  if (_cache && !opts) return _cache
  _cache = computeConfig(opts ?? {})
  return _cache
}

/** 清缓存重载（总是重算；生产路径对应「重启应用后重新读文件」语义的显式入口） */
export function reloadNanjuModelConfig(opts?: NanjuModelConfigLoadOpts): LoadedNanjuModelConfig {
  _cache = computeConfig(opts ?? {})
  return _cache
}

// ===== 解析函数 =====

/** 解析 'channel:model' 端点字符串（已通过 sanitizeFallbackEntry 校验的输入不会抛错） */
function parseEndpoint(raw: string): NanjuModelEndpoint {
  const idx = raw.indexOf(':')
  return { channelId: raw.slice(0, idx), modelId: raw.slice(idx + 1) }
}

/** resolvePhaseModelConfig 的返回形态（fallbacks 已解析为端点数组） */
export interface ResolvedPhaseModelConfig {
  channel: string
  model: string
  fallbacks: NanjuModelEndpoint[]
  acAttacker?: NanjuACActor
  acDefender?: NanjuACActor
}

/**
 * 解析某阶段的有效模型配置（channel/model/fallbacks + per-phase AC 覆盖位）。
 * nanju-router.makeRoute 在模块加载期逐阶段调用（ROUTES 构建）。
 */
export function resolvePhaseModelConfig(phaseId: NanjuModelPhaseId): ResolvedPhaseModelConfig {
  const entry = loadNanjuModelConfig().phases[phaseId]
  if (!entry) throw new Error(`未知 nanju 阶段: ${phaseId}`)
  return {
    channel: entry.channel,
    model: entry.model,
    fallbacks: (entry.fallbacks ?? []).map(parseEndpoint),
    ...(entry.acAttacker ? { acAttacker: { ...entry.acAttacker } } : {}),
    ...(entry.acDefender ? { acDefender: { ...entry.acDefender } } : {}),
  }
}

/** 解析某档 AC 攻防预设（quick=light / iterative=medium；nanju-router.resolveACActors 消费） */
export function resolveAcPreset(weight: TaskWeight): AcPresetEntry {
  const preset = loadNanjuModelConfig().acPresets[weight]
  return {
    attacker: { ...preset.attacker },
    defender: { ...preset.defender },
  }
}

/**
 * 编译 fallback 链表（key = 'channel:model' → 依次降级端点）：
 * 按六阶段固定序取各阶段 phases[].fallbacks，同 key 多阶段声明按序取并集（去重保序——
 * architecture 与 coding 共用 glm-zhipu:GLM-5.3 时的确定性合并策略）。
 * nanju-model-fallback.getFallbackChain 优先查本表（配置缺项回退代码链 MODEL_FALLBACK_CHAINS）。
 */
export function getConfigFallbackChains(): Record<string, NanjuModelEndpoint[]> {
  const config = loadNanjuModelConfig()
  const chains: Record<string, NanjuModelEndpoint[]> = {}
  for (const phaseId of NANJU_MODEL_PHASE_ORDER) {
    const entry = config.phases[phaseId]
    if (!entry?.fallbacks?.length) continue
    const key = `${entry.channel}:${entry.model}`
    const list = chains[key] ?? (chains[key] = [])
    for (const raw of entry.fallbacks) {
      const endpoint = parseEndpoint(raw)
      if (list.some((e) => e.channelId === endpoint.channelId && e.modelId === endpoint.modelId)) continue
      list.push(endpoint)
    }
  }
  return chains
}
