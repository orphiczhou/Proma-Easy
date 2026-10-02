/**
 * 南大向导·模型配置设置服务（W23 §五/§六，自愈/IPC 域 D2）
 *
 * 设置界面 5 个 IPC 通道（NANJU_MODEL_IPC）的主进程实现：
 * - getNanjuModelState：effective 序列化 + 渠道摘要 + 健康三态 + 多样性警告（两模式合并
 *   去重）+ 层 1 手改文件存在性。**出参绝不包含 apiKey/baseUrl**（验收契约 7）。
 * - saveNanjuModelSettings：schema 白名单校验（未知键拒绝）→ 读-改-写层 1.5 覆盖文件
 *   （~/.proma[-dev]/nanju-model-config-override.json，原子写：临时文件+rename）→
 *   reloadNanjuModelConfig（保存即时生效，§六.1 脏缓存链路）→ 回读比对生成 shadowed
 *   （本次显式设置的字段 effective≠requested 且层 1 存在 → shadowSource:'layer1'）。
 * - resetNanjuModelSettings：删层 1.5 文件 → reload → 返回 state（恢复默认=内置透传）。
 * - testNanjuModelEndpoints：渠道存在校验（**绝不接受 baseUrl 入参**，防 SSRF——baseUrl
 *   一律取自渠道记录）→ decryptApiKey（失败不发网络）→ testChannelDirect，并发 ≤3、
 *   单项 15s 超时（Promise.race + 定时器清理）。
 * - recommendNanjuModelSettings：listChannels → 快照 → recommendNanjuModelMatrix。
 *
 * 拒绝语义边界（设计 §三.3）：save 拒绝「应用无解推荐结果」由 UI 侧保证——「一键应用」
 * 仅 applyable===true 可点；service 不感知 patch 的推荐来源，只对单字段做结构校验
 * （未知顶层键/未知阶段键/未知角色键拒绝、字符串非空、proxyCandidates ≤6 项且元素仅
 * channelId/modelId、fallbacks ≤3 项）。
 *
 * 写点纪律：本文件是全仓库对 nanju-model-config-override.json 的**唯一写者**（验收
 * 契约 1；写点唯一性由 .test.ts 静态扫描锁定）。channel-manager 经 require 惰性加载
 * （它 import electron safeStorage，静态引入会把 electron 拖进 bun 测试环境——先例
 * nanju-router-prompt autofix 钩子）；测试注入走函数 opts（listChannels/decryptApiKey/
 * testDirect/timeoutMs），单测不发真网络。
 *
 * import 方向（无环）：service → {nanju-model-config, nanju-model-health, nanju-router,
 * channel-manager(惰性)}；channelFamily/evaluateModelDiversity 是 nanju-router 的纯函数，
 * 单向引用安全（nanju-model-health 已同向复用 channelFamily）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  Channel,
  ChannelDirectTestInput,
  ChannelTestResult,
  NanjuModelSavePatch,
  NanjuModelSaveResponse,
  NanjuModelSettingsState,
  NanjuModelShadowedField,
  NanjuModelTestResultItem,
} from '@proma/shared'
import {
  NANJU_MODEL_PHASE_ORDER,
  getUserNanjuModelConfigPath,
  getUserNanjuModelOverridePath,
  loadNanjuModelConfig,
  reloadNanjuModelConfig,
  type NanjuModelConfigLoadOpts,
} from './nanju-model-config'
import {
  computeNanjuModelHealth,
  recommendNanjuModelMatrix,
  type NanjuChannelSnapshot,
  type NanjuRecommendResult,
} from './nanju-model-health'
import { channelFamily, evaluateModelDiversity } from './nanju-router'

// ===== 依赖注入点（生产默认绑定 channel-manager；测试经 opts 覆盖，不发真网络） =====

function loadChannelManager(): typeof import('./channel-manager') {
  // electron 可用性探测（先例 nanju-router-prompt.applyConfigAutofix）：bun/node 测试环境
  // require('electron') 解析到 npm 包 wrapper（只导出安装路径字符串）→ 明确报错而非静默降级
  //（channels=[] 会让健康全红、误导修复；测试请经 opts.listChannels 注入）
  const electronModule = require('electron') as unknown
  if (typeof electronModule !== 'object' || electronModule === null) {
    throw new Error('channel-manager 仅在 Electron 主进程可用（测试清经 opts.listChannels 注入渠道数据源）')
  }
  return require('./channel-manager') as typeof import('./channel-manager')
}

const defaultListChannels = (): Channel[] => loadChannelManager().listChannels()
const defaultDecryptApiKey = (channelId: string): string => loadChannelManager().decryptApiKey(channelId)
const defaultTestDirect = (input: ChannelDirectTestInput): Promise<ChannelTestResult> =>
  loadChannelManager().testChannelDirect(input)

/** getState/save/reset/recommend 的注入 opts（层路径透传 nanju-model-config + 渠道数据源） */
export interface NanjuModelServiceOpts {
  /** 层 1 用户手改文件路径；undefined = 自动探测；null = 禁用该层（测试用） */
  userConfigPath?: string | null
  /** 层 1.5 UI 覆盖文件路径；undefined = 自动探测；null = 禁用该层（save 的写目标仍按 undefined 处理=自动探测） */
  overrideConfigPath?: string | null
  /** 层 2 内置文件路径；undefined = 自动探测；null = 禁用该层 */
  builtinConfigPath?: string | null
  /** 渠道数据源注入（测试用；缺省 = channel-manager.listChannels） */
  listChannels?: () => Channel[]
}

/** testEndpoints 的注入 opts（解密/测试函数/超时均可替换，单测不发真网络） */
export interface NanjuModelTestEndpointsOpts {
  listChannels?: () => Channel[]
  decryptApiKey?: (channelId: string) => string
  testDirect?: (input: ChannelDirectTestInput) => Promise<ChannelTestResult>
  /** 单项超时毫秒数；缺省 15000（测试注入缩短避免真等待） */
  timeoutMs?: number
}

function toLoadOpts(opts?: NanjuModelServiceOpts): NanjuModelConfigLoadOpts | undefined {
  if (!opts) return undefined
  return {
    userConfigPath: opts.userConfigPath,
    overrideConfigPath: opts.overrideConfigPath,
    builtinConfigPath: opts.builtinConfigPath,
  }
}

// ===== 渠道快照（先例 nanju-router-prompt.channelSnapshotFamily，非导出——本地复制避免反向依赖） =====

/**
 * 渠道快照家族归并：字面前缀命中用 channelFamily（nanju-router 纯函数）；UUID 渠道
 * 回退 provider 归族（minimax UUID 渠道 → family-minimax，与家族标记 'minimax' 同族
 * 对齐——nanju-model-health 冻结接口的快照构造惯例）。
 */
function channelSnapshotFamily(channel: Channel): string {
  const byPrefix = channelFamily(channel.id)
  if (byPrefix !== channel.id) return byPrefix
  return channel.provider ? `family-${channel.provider}` : channel.id
}

function toChannelSnapshot(channel: Channel): NanjuChannelSnapshot {
  return {
    channelId: channel.id,
    family: channelSnapshotFamily(channel),
    models: channel.models.map((m) => ({ modelId: m.id, enabled: m.enabled })),
  }
}

// ===== getState =====

/** 多样性警告合并去重（quick+iterative 两模式；kind+detail 为键，保序） */
function mergeDiversityWarnings(modes: Array<ReturnType<typeof evaluateModelDiversity>>): Array<{ kind: string; detail: string }> {
  const seen = new Set<string>()
  const out: Array<{ kind: string; detail: string }> = []
  for (const warnings of modes) {
    for (const w of warnings) {
      const key = `${w.kind}|${w.detail}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: w.kind, detail: w.detail })
    }
  }
  return out
}

/**
 * 设置界面初始态：effective 四层合并序列化 + 健康三态 + 多样性警告 + 渠道摘要 +
 * 层 1 存在性。出参无密钥字段（channels 摘要仅 id/name/enabledModelIds）。
 */
export function getNanjuModelState(opts?: NanjuModelServiceOpts): NanjuModelSettingsState {
  const config = loadNanjuModelConfig(toLoadOpts(opts))
  const channels = (opts?.listChannels ?? defaultListChannels)()
  const snapshots = channels.map(toChannelSnapshot)
  const health = computeNanjuModelHealth(config, snapshots)
  const diversityWarnings = mergeDiversityWarnings([
    evaluateModelDiversity('quick'),
    evaluateModelDiversity('iterative'),
  ])
  // 层 1 路径：null = 该层被显式禁用（视为不存在）；undefined = 自动探测
  const layer1Path = opts?.userConfigPath === null ? null : (opts?.userConfigPath ?? getUserNanjuModelConfigPath())

  const phases: NanjuModelSettingsState['effective']['phases'] = {}
  for (const id of NANJU_MODEL_PHASE_ORDER) {
    const entry = config.phases[id]!
    phases[id] = {
      channel: entry.channel,
      model: entry.model,
      ...(entry.fallbacks ? { fallbacks: [...entry.fallbacks] } : {}),
      ...(entry.acAttacker ? { acAttacker: { ...entry.acAttacker } } : {}),
      ...(entry.acDefender ? { acDefender: { ...entry.acDefender } } : {}),
      ...(entry.visualReviewer ? { visualReviewer: { ...entry.visualReviewer } } : {}),
    }
  }

  return {
    effective: {
      phases,
      acPresets: {
        light: {
          attacker: { ...config.acPresets.light.attacker },
          defender: { ...config.acPresets.light.defender },
        },
        medium: {
          attacker: { ...config.acPresets.medium.attacker },
          defender: { ...config.acPresets.medium.defender },
        },
      },
      proxyCandidates: config.proxyCandidates.map((c) => ({ channelId: c.channelId, modelId: c.modelId })),
    },
    sources: { ...config.sources },
    health: health.slots.map((s) => ({ slot: s.slot, channelId: s.channelId, modelId: s.modelId, status: s.status })),
    diversityWarnings,
    channels: channels.map((ch) => ({
      channelId: ch.id,
      name: ch.name,
      enabledModelIds: ch.models.filter((m) => m.enabled).map((m) => m.id),
    })),
    handLayerPresent: layer1Path ? existsSync(layer1Path) : false,
  }
}

// ===== save（白名单校验 + 读-改-写层 1.5 + reload + shadowed 回读比对） =====

const SAVE_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['phases', 'acPresets', 'proxyCandidates'])
const PHASE_FIELD_KEYS: ReadonlySet<string> = new Set(['channel', 'model', 'fallbacks', 'acAttacker', 'acDefender', 'visualReviewer'])
const AC_PRESET_KEYS: ReadonlySet<string> = new Set(['light', 'medium'])
const AC_ROLE_KEYS: ReadonlySet<string> = new Set(['attacker', 'defender'])
const PHASE_ID_SET: ReadonlySet<string> = new Set(NANJU_MODEL_PHASE_ORDER)
/** fallbacks 上限（设计 §四：备选列表可变长 ≥0，上限 3；UI 与写点一致） */
const FALLBACKS_MAX = 3
const PROXY_CANDIDATES_MAX = 6

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 校验 AC 角色对象：仅 {channel, model} 两键、均非空字符串（多余键拒绝） */
function assertActorObject(value: unknown, context: string): void {
  if (!isPlainObject(value)) throw new Error(`${context} 必须是对象`)
  const keys = Object.keys(value)
  if (keys.length !== 2 || !('channel' in value) || !('model' in value)) {
    throw new Error(`${context} 仅允许 channel/model 两键，收到: ${keys.join(',') || '(空)'}`)
  }
  if (!isNonEmptyString(value.channel) || !isNonEmptyString(value.model)) {
    throw new Error(`${context} 的 channel/model 必须是非空字符串`)
  }
}

/** 校验 'channel:model' 端点字符串（第一个冒号切分，两侧非空——同 D1 sanitizeFallbackEntry 口径） */
function isEndpointString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const idx = value.indexOf(':')
  return idx > 0 && idx < value.length - 1
}

/** save patch 的白名单校验：结构非法直接抛错（不静默跳过——与文件加载容错语义相反） */
function validateSavePatch(patch: NanjuModelSavePatch): void {
  if (!isPlainObject(patch)) throw new Error('save patch 必须是对象')
  for (const key of Object.keys(patch)) {
    if (!SAVE_TOP_LEVEL_KEYS.has(key)) throw new Error(`save patch 含未知顶层键「${key}」（合法：phases/acPresets/proxyCandidates）`)
  }
  if (patch.phases !== undefined) {
    if (!isPlainObject(patch.phases)) throw new Error('patch.phases 必须是对象')
    for (const phaseId of Object.keys(patch.phases)) {
      if (!PHASE_ID_SET.has(phaseId)) {
        throw new Error(`patch.phases 含未知阶段「${phaseId}」（合法：${NANJU_MODEL_PHASE_ORDER.join('/')}）`)
      }
      const entry = patch.phases[phaseId]
      if (!isPlainObject(entry)) throw new Error(`patch.phases.${phaseId} 必须是对象`)
      for (const field of Object.keys(entry)) {
        if (!PHASE_FIELD_KEYS.has(field)) {
          throw new Error(`patch.phases.${phaseId} 含未知字段「${field}」（合法：${[...PHASE_FIELD_KEYS].join('/')}）`)
        }
        const value = entry[field]
        if (value === null) continue // null = 删除该键覆盖（行级恢复）
        if (field === 'channel' || field === 'model') {
          if (!isNonEmptyString(value)) throw new Error(`patch.phases.${phaseId}.${field} 必须是非空字符串（或 null 删除覆盖）`)
        } else if (field === 'fallbacks') {
          if (!Array.isArray(value)) throw new Error(`patch.phases.${phaseId}.fallbacks 必须是数组（或 null 删除覆盖）`)
          if (value.length === 0) throw new Error(`patch.phases.${phaseId}.fallbacks 不允许空数组（清空请用 null 删除覆盖，继承低层）`)
          if (value.length > FALLBACKS_MAX) throw new Error(`patch.phases.${phaseId}.fallbacks 超上限（${value.length} > ${FALLBACKS_MAX}）`)
          value.forEach((item, i) => {
            if (!isEndpointString(item)) throw new Error(`patch.phases.${phaseId}.fallbacks[${i}] 必须是 'channel:model' 形态字符串`)
          })
        } else {
          assertActorObject(value, `patch.phases.${phaseId}.${field}`)
        }
      }
    }
  }
  if (patch.acPresets !== undefined) {
    if (!isPlainObject(patch.acPresets)) throw new Error('patch.acPresets 必须是对象')
    for (const weight of Object.keys(patch.acPresets)) {
      if (!AC_PRESET_KEYS.has(weight)) throw new Error(`patch.acPresets 含未知档位「${weight}」（合法：light/medium）`)
      const entry = patch.acPresets[weight]
      if (!isPlainObject(entry)) throw new Error(`patch.acPresets.${weight} 必须是对象`)
      for (const role of Object.keys(entry)) {
        if (!AC_ROLE_KEYS.has(role)) throw new Error(`patch.acPresets.${weight} 含未知角色「${role}」（合法：attacker/defender）`)
        const value = entry[role]
        if (value === null) continue // null = 删除该键覆盖
        assertActorObject(value, `patch.acPresets.${weight}.${role}`)
      }
    }
  }
  if (patch.proxyCandidates !== undefined && patch.proxyCandidates !== null) {
    const list = patch.proxyCandidates
    if (!Array.isArray(list)) throw new Error('patch.proxyCandidates 必须是数组（或 null 删除覆盖）')
    if (list.length === 0) throw new Error('patch.proxyCandidates 不允许空数组（清空请用 null 删除覆盖，继承低层；W23 审查 #4 与 fallbacks 空集合语义对齐）')
    if (list.length > PROXY_CANDIDATES_MAX) throw new Error(`patch.proxyCandidates 超上限（${list.length} > ${PROXY_CANDIDATES_MAX}）`)
    list.forEach((item, i) => {
      if (!isPlainObject(item)) throw new Error(`patch.proxyCandidates[${i}] 必须是对象`)
      const keys = Object.keys(item)
      if (keys.length !== 2 || !('channelId' in item) || !('modelId' in item)) {
        throw new Error(`patch.proxyCandidates[${i}] 仅允许 channelId/modelId 两键，收到: ${keys.join(',') || '(空)'}`)
      }
      if (!isNonEmptyString(item.channelId) || !isNonEmptyString(item.modelId)) {
        throw new Error(`patch.proxyCandidates[${i}] 的 channelId/modelId 必须是非空字符串`)
      }
    })
  }
}

/** 读层 1.5 现有覆盖（读-改-写基底）；文件损坏抛错（写失败/损坏回传不静默——验收契约 1） */
function readOverrideFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!isPlainObject(parsed)) throw new Error('根结构不是对象')
    return parsed
  } catch (err) {
    throw new Error(`层 1.5 覆盖文件损坏（${path}）：${err instanceof Error ? err.message : String(err)}——请先「恢复默认（整体）」重建`)
  }
}

/** 增量合并：patch 字段级写入/删除（null 删除键）；空桶顺手清理 */
function applyPatchToOverride(current: Record<string, unknown>, patch: NanjuModelSavePatch): Record<string, unknown> {
  const next: Record<string, unknown> = JSON.parse(JSON.stringify(current)) as Record<string, unknown>
  const entriesOf = (value: unknown): Array<[string, unknown]> =>
    isPlainObject(value) ? Object.entries(value) : []
  if (patch.phases !== undefined) {
    const phases = isPlainObject(next.phases) ? next.phases : ((next.phases = {}) as Record<string, unknown>)
    for (const [phaseId, entry] of entriesOf(patch.phases)) {
      const bucket = isPlainObject(phases[phaseId]) ? phases[phaseId]! : ((phases[phaseId] = {}) as Record<string, unknown>)
      for (const [field, value] of entriesOf(entry)) {
        if (value === null) delete bucket[field]
        else bucket[field] = value
      }
      if (Object.keys(bucket).length === 0) delete phases[phaseId]
    }
    if (Object.keys(phases).length === 0) delete next.phases
  }
  if (patch.acPresets !== undefined) {
    const presets = isPlainObject(next.acPresets) ? next.acPresets : ((next.acPresets = {}) as Record<string, unknown>)
    for (const [weight, entry] of entriesOf(patch.acPresets)) {
      const bucket = isPlainObject(presets[weight]) ? presets[weight]! : ((presets[weight] = {}) as Record<string, unknown>)
      for (const [role, value] of entriesOf(entry)) {
        if (value === null) delete bucket[role]
        else bucket[role] = value
      }
      if (Object.keys(bucket).length === 0) delete presets[weight]
    }
    if (Object.keys(presets).length === 0) delete next.acPresets
  }
  if (patch.proxyCandidates === null) delete next.proxyCandidates
  else if (patch.proxyCandidates !== undefined) next.proxyCandidates = patch.proxyCandidates
  return next
}

/** 原子写层 1.5（全仓库唯一写点；目录不存在则 mkdir） */
function writeOverrideFile(path: string, data: Record<string, unknown>): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8') // 唯一写点锚点：nanju-model-config-override.json（.test.ts 静态扫描断言写调用行总数=1）
  renameSync(tmpPath, path)
}

/** 简单深比较（patch 载荷均为纯 JSON 结构，序列化比对足够） */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 层 1 手改文件是否声明了该字段（phases.<id>.<field> / acPresets.<weight>.<role> / proxyCandidates） */
function layer1HasField(layer1: Record<string, unknown> | null, field: string): boolean {
  if (!layer1) return false
  const parts = field.split('.')
  let node: unknown = layer1
  for (const part of parts) {
    if (!isPlainObject(node)) return false
    node = node[part]
  }
  return node !== undefined
}

/** 收集 patch 中本次显式设置（非 null）的叶字段，统一槽位命名（同 nanju-model-health 冻结命名） */
function collectSetFields(patch: NanjuModelSavePatch): Array<{ field: string; requested: unknown }> {
  const out: Array<{ field: string; requested: unknown }> = []
  const entriesOf = (value: unknown): Array<[string, unknown]> =>
    isPlainObject(value) ? Object.entries(value) : []
  if (patch.phases !== undefined) {
    for (const [phaseId, entry] of entriesOf(patch.phases)) {
      for (const [field, value] of entriesOf(entry)) {
        if (value !== null) out.push({ field: `phases.${phaseId}.${field}`, requested: value })
      }
    }
  }
  if (patch.acPresets !== undefined) {
    for (const [weight, entry] of entriesOf(patch.acPresets)) {
      for (const [role, value] of entriesOf(entry)) {
        if (value !== null) out.push({ field: `acPresets.${weight}.${role}`, requested: value })
      }
    }
  }
  if (patch.proxyCandidates !== null && patch.proxyCandidates !== undefined) {
    out.push({ field: 'proxyCandidates', requested: patch.proxyCandidates })
  }
  return out
}

/** reload 后的有效值读取（槽位命名 → LoadedNanjuModelConfig 取值） */
function effectiveValueOf(config: ReturnType<typeof loadNanjuModelConfig>, field: string): unknown {
  const m = /^phases\.([^.]+)\.(.+)$/.exec(field)
  if (m) {
    const entry = config.phases[m[1] as keyof typeof config.phases]
    if (!entry) return undefined
    return (entry as unknown as Record<string, unknown>)[m[2]!]
  }
  const p = /^acPresets\.([^.]+)\.(.+)$/.exec(field)
  if (p) {
    const entry = config.acPresets[p[1] as 'light' | 'medium']
    return (entry as unknown as Record<string, unknown>)[p[2]!]
  }
  if (field === 'proxyCandidates') return config.proxyCandidates
  return undefined
}

/**
 * 保存增量 patch：白名单校验 → 读-改-写层 1.5 → reload（即时生效）→ 回读比对
 * shadowed → 返回 {state, shadowed}。写失败抛错（IPC 层转 {error}，不静默）。
 */
export function saveNanjuModelSettings(patch: NanjuModelSavePatch, opts?: NanjuModelServiceOpts): NanjuModelSaveResponse {
  validateSavePatch(patch)
  const overridePath = opts?.overrideConfigPath ?? getUserNanjuModelOverridePath()
  const current = readOverrideFile(overridePath)
  const next = applyPatchToOverride(current, patch)

  if (Object.keys(next).length === 0) {
    // 合并后无任何覆盖：文件存在则删除（语义 = 整体无覆盖，内置/层1 直接透传）
    if (existsSync(overridePath)) {
      try {
        unlinkSync(overridePath)
      } catch (err) {
        throw new Error(`删除层 1.5 覆盖文件失败（${overridePath}）：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } else {
    writeOverrideFile(overridePath, next)
  }

  // 保存即时生效（§六.1）：reload 后下一次 getRoute/resolveProxyChannel 自然用新矩阵
  reloadNanjuModelConfig(toLoadOpts(opts))
  const reloaded = loadNanjuModelConfig()

  // shadowed 回读比对：本次显式设置的字段若 effective≠requested 且层 1 存在该字段
  const layer1Path = opts?.userConfigPath === null ? null : (opts?.userConfigPath ?? getUserNanjuModelConfigPath())
  let layer1: Record<string, unknown> | null = null
  if (layer1Path && existsSync(layer1Path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(layer1Path, 'utf-8'))
      layer1 = isPlainObject(parsed) ? parsed : null
    } catch {
      layer1 = null // 层 1 损坏时加载层已跳过它，遮蔽判定按不存在处理
    }
  }
  const shadowed: NanjuModelShadowedField[] = []
  if (layer1) {
    for (const { field, requested } of collectSetFields(patch)) {
      const effective = effectiveValueOf(reloaded, field)
      if (jsonEqual(requested, effective)) continue
      if (!layer1HasField(layer1, field)) continue
      shadowed.push({ field, requested, effective, shadowSource: 'layer1', path: layer1Path! })
    }
  }

  return { state: getNanjuModelState(opts), shadowed }
}

// ===== reset =====

/** 恢复默认（整体）：删层 1.5 文件 → reload → 返回 state（有效配置回落到层 1/2/3） */
export function resetNanjuModelSettings(opts?: NanjuModelServiceOpts): NanjuModelSettingsState {
  const overridePath = opts?.overrideConfigPath ?? getUserNanjuModelOverridePath()
  if (existsSync(overridePath)) {
    try {
      unlinkSync(overridePath)
    } catch (err) {
      throw new Error(`删除层 1.5 覆盖文件失败（${overridePath}）：${err instanceof Error ? err.message : String(err)}`)
    }
    // 顺手清理崩溃残留的 .tmp（best-effort，不阻断）
    try {
      const tmpPath = `${overridePath}.tmp`
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
  }
  reloadNanjuModelConfig(toLoadOpts(opts))
  return getNanjuModelState(opts)
}

// ===== testEndpoints（渠道存在校验 + 解密 + 直连测试；并发 ≤3、单项超时） =====

const TEST_CONCURRENCY = 3
const TEST_TIMEOUT_MS = 15_000

/**
 * 逐端点连通测试。安全边界：入参仅接受 channelId/modelId——baseUrl/provider/apiKey
 * 一律取自主进程渠道记录（防 SSRF 探测任意 baseUrl，验收契约 8）；渠道不存在/
 * 入参非法的项直接返回 ok:false，不抛错不阻断其余项。
 */
export async function testNanjuModelEndpoints(
  endpoints: Array<{ channelId: string; modelId: string }>,
  opts?: NanjuModelTestEndpointsOpts,
): Promise<NanjuModelTestResultItem[]> {
  if (!Array.isArray(endpoints)) throw new Error('testEndpoints 入参必须是 [{channelId, modelId}] 数组')
  const listChannelsFn = opts?.listChannels ?? defaultListChannels
  const decryptApiKey = opts?.decryptApiKey ?? defaultDecryptApiKey
  const testDirect = opts?.testDirect ?? defaultTestDirect
  const timeoutMs = opts?.timeoutMs ?? TEST_TIMEOUT_MS

  // 入参逐项校验 + 去重（channelId+modelId 保留首个；重复项不出现在结果里）
  const seen = new Set<string>()
  const pending: Array<{ channelId: string; modelId: string }> = []
  const prefiltered: NanjuModelTestResultItem[] = []
  for (const raw of endpoints) {
    const item = (raw ?? {}) as { channelId?: unknown; modelId?: unknown }
    const channelId = typeof item.channelId === 'string' ? item.channelId.trim() : ''
    const modelId = typeof item.modelId === 'string' ? item.modelId.trim() : ''
    if (!channelId || !modelId) {
      prefiltered.push({
        channelId: typeof item.channelId === 'string' ? item.channelId : '',
        modelId: typeof item.modelId === 'string' ? item.modelId : '',
        ok: false,
        message: '入参非法：channelId/modelId 必须是非空字符串',
      })
      continue
    }
    const key = `${channelId}|${modelId}`
    if (seen.has(key)) continue
    seen.add(key)
    pending.push({ channelId, modelId })
  }

  const channels = listChannelsFn()
  const channelById = new Map(channels.map((c) => [c.id, c]))

  // 渠道存在校验（外键约束——baseUrl 绝不接受入参）
  const runnable: Array<{ channelId: string; modelId: string }> = []
  const results: NanjuModelTestResultItem[] = [...prefiltered]
  for (const ep of pending) {
    if (!channelById.has(ep.channelId)) {
      results.push({ ...ep, ok: false, message: '渠道不存在' })
      continue
    }
    runnable.push(ep)
  }

  // 单端点测试（解密失败不发网络；Promise.race 超时 + 定时器清理）
  const testOne = async (ep: { channelId: string; modelId: string }): Promise<NanjuModelTestResultItem> => {
    const channel = channelById.get(ep.channelId)!
    const startedAt = Date.now()
    let apiKey: string
    try {
      apiKey = decryptApiKey(ep.channelId)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { ...ep, ok: false, message: `无法读取渠道「${channel.name}」的 API Key（${reason}），未发起网络请求` }
    }
    if (!apiKey) {
      return { ...ep, ok: false, message: `渠道「${channel.name}」尚未配置 API Key，请先填写后再测试` }
    }
    // provider 直传渠道记录值：testChannelDirect 内部会按 baseUrl 做 inferProviderFromBaseUrl
    // 归一（与 testChannel 惯例等价——该函数未导出，直传 + 内部归一同结果）
    const direct = testDirect({ provider: channel.provider, baseUrl: channel.baseUrl, apiKey, modelId: ep.modelId })
    direct.catch(() => {
      /* 超时后底层 reject 不变成 unhandledRejection（race 已放弃该 promise） */
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`测试超时（${timeoutMs}ms）`)), timeoutMs)
    })
    try {
      const result = await Promise.race([direct, timeoutPromise])
      return {
        ...ep,
        ok: result.success,
        latencyMs: Date.now() - startedAt,
        ...(result.message ? { message: result.message } : {}),
      }
    } catch (err) {
      return {
        ...ep,
        ok: false,
        latencyMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err),
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // 简单并发池（≤3）：多 worker 从共享索引取任务；结果按 runnable 原序落位（确定性输出）
  const runResults: NanjuModelTestResultItem[] = new Array(runnable.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < runnable.length) {
      const index = cursor
      cursor += 1
      runResults[index] = await testOne(runnable[index]!)
    }
  }
  const workers = Array.from({ length: Math.min(TEST_CONCURRENCY, runnable.length) }, () => worker())
  await Promise.all(workers)

  return [...results, ...runResults]
}

// ===== recommend =====

/** 智能配置推荐：渠道现状快照 + 当前有效配置 → 确定性整套矩阵（硬约束两态见 D1） */
export function recommendNanjuModelSettings(opts?: NanjuModelServiceOpts): NanjuRecommendResult {
  const channels = (opts?.listChannels ?? defaultListChannels)()
  const snapshots = channels.map(toChannelSnapshot)
  const config = loadNanjuModelConfig(toLoadOpts(opts))
  return recommendNanjuModelMatrix(config, snapshots)
}
