/**
 * 南大向导·模型健康与智能推荐（W23 §三，配置解析域 D1）
 *
 * 纯函数模块（无 electron 依赖；渠道现状由调用方以 NanjuChannelSnapshot 快照注入——
 * 快照构造先例：listChannels + provider 感知的家族归并，见 nanju-router-prompt autofix 钩子
 * 与 D2 nanju-model-settings-service）。消费方：设置界面 IPC（getState/recommend/
 * testEndpoints 行级标红）+ 运行时 autofix（getNanjuRouterPrompt 单槽替换）。
 *
 * 核心语义（设计 §三，冻结接口——D2/D3 依赖，签名不可改）：
 * - computeNanjuModelHealth：逐端点三态红灯（ok / model-disabled 黄 / channel-missing、
 *   model-missing 红）。家族标记（如 'minimax'，真渠道是 UUID）按快照 family 归族解析。
 * - recommendNanjuModelMatrix：确定性推荐——有效即保留，失效按序找替换：
 *   ①同渠道同档位（版本段归一改名检测优先）②同族他渠道同档位 ③规格兜底家族 ④任意
 *   enabled（附降级说明）；tie-break 字母序。硬约束两态：defender≠作者族、
 *   attacker≠defender 族、coding↔testing 主选跨族——有解才返回 matrix；无解
 *   matrix=null + applyable=false + diversityViolations（save 拒绝应用）。
 * - 分配序：作者 → AC → 代理（AC 替换在作者定局后带族排除求解）。
 *
 * 家族判定：快照 family 优先，缺省回退 nanju-router.channelFamily（前缀规则）——
 * 本模块不 import clarify-proxy/router-prompt（无环；channelFamily 是 router 的纯函数，
 * 单向引用安全）。
 */

import { channelFamily } from './nanju-router'
import {
  NANJU_MODEL_PHASE_ORDER,
  type LoadedNanjuModelConfig,
  type NanjuModelConfigFile,
  type NanjuModelPhaseId,
} from './nanju-model-config'

// ===== 冻结接口（设计 §三；D2/D3 依赖，签名一字不改） =====

export interface NanjuChannelSnapshot {
  channelId: string
  family: string
  models: Array<{ modelId: string; enabled: boolean }>
}

export type NanjuEndpointHealthStatus = 'ok' | 'model-disabled' | 'model-missing' | 'channel-missing'

export interface NanjuSlotHealth {
  slot: string
  channelId: string
  modelId: string
  status: NanjuEndpointHealthStatus
}

export interface NanjuHealthReport {
  slots: NanjuSlotHealth[]
  invalidCount: number
}

export interface NanjuRecommendChange {
  /** 槽位名（冻结命名：phases.<id>.primary / phases.<id>.fallbacks[<i>] / phases.<id>.acAttacker / phases.<id>.acDefender / acPresets.<weight>.attacker / acPresets.<weight>.defender / proxyCandidates[<i>]） */
  slot: string
  /** 'channel:model' */
  from: string
  /** 'channel:model' */
  to: string
  reason: string
}

export interface NanjuRecommendResult {
  matrix: Partial<NanjuModelConfigFile> | null
  applyable: boolean
  changes: NanjuRecommendChange[]
  notes: string[]
  diversityViolations?: Array<{ slot: string; violation: string }>
}

// ===== 模型档位与改名归一（§三.2） =====

type ModelTier = 'fast' | 'flagship' | 'vision' | 'unknown'

/**
 * 档位判定（快类优先，§三.2）：id 含 flash/turbo/air/lite 即判快——避免 glm-5.3-flash
 * 同时含 5.3 被误判旗舰；vision 次之；pro / 5.3 / m3 = 旗舰；其余 unknown。
 */
export function classifyModelTier(modelId: string): 'fast' | 'flagship' | 'vision' | 'unknown' {
  const id = modelId.toLowerCase()
  if (id.includes('flash') || id.includes('turbo') || id.includes('air') || id.includes('lite')) return 'fast'
  if (id.includes('vision')) return 'vision'
  if (id.includes('pro') || id.includes('m3') || id.includes('5.3')) return 'flagship'
  return 'unknown'
}

/** 版本段归一（改名检测）：去除 `-v\d+` 段——deepseek-v4-flash → deepseek-flash */
export function normalizeModelIdForRename(modelId: string): string {
  return modelId.replace(/-v\d+(?=-|$)/g, '')
}

// ===== 槽位枚举（冻结命名） =====

interface SlotEntry {
  slot: string
  channelId: string
  modelId: string
}

function parseEndpointString(raw: string): { channelId: string; modelId: string } {
  const idx = raw.indexOf(':')
  return { channelId: raw.slice(0, idx), modelId: raw.slice(idx + 1) }
}

function endpointKey(channelId: string, modelId: string): string {
  return `${channelId}:${modelId}`
}

/** 枚举配置内全部端点槽位（顺序：各阶段 primary → fallbacks → AC 覆盖 → 预设 → 代理） */
export function enumerateNanjuModelSlots(config: LoadedNanjuModelConfig): SlotEntry[] {
  const out: SlotEntry[] = []
  for (const id of NANJU_MODEL_PHASE_ORDER) {
    const entry = config.phases[id]!
    out.push({ slot: `phases.${id}.primary`, channelId: entry.channel, modelId: entry.model })
    const fallbacks = entry.fallbacks ?? []
    for (let i = 0; i < fallbacks.length; i++) {
      const ep = parseEndpointString(fallbacks[i]!)
      out.push({ slot: `phases.${id}.fallbacks[${i}]`, channelId: ep.channelId, modelId: ep.modelId })
    }
    if (entry.acAttacker) out.push({ slot: `phases.${id}.acAttacker`, channelId: entry.acAttacker.channel, modelId: entry.acAttacker.model })
    if (entry.acDefender) out.push({ slot: `phases.${id}.acDefender`, channelId: entry.acDefender.channel, modelId: entry.acDefender.model })
  }
  for (const weight of ['light', 'medium'] as const) {
    const preset = config.acPresets[weight]
    out.push({ slot: `acPresets.${weight}.attacker`, channelId: preset.attacker.channel, modelId: preset.attacker.model })
    out.push({ slot: `acPresets.${weight}.defender`, channelId: preset.defender.channel, modelId: preset.defender.model })
  }
  for (let i = 0; i < config.proxyCandidates.length; i++) {
    const c = config.proxyCandidates[i]!
    out.push({ slot: `proxyCandidates[${i}]`, channelId: c.channelId, modelId: c.modelId })
  }
  return out
}

// ===== 端点有效性（三态红灯） =====

/**
 * 渠道家族解析：快照 family 优先（快照由调用方用 provider 感知逻辑构造——UUID 渠道
 * 按其 provider 归族，与家族标记 'minimax' → family-minimax 对齐）；快照无该渠道时
 * 回退 channelFamily 前缀规则。
 */
function familyOfChannel(channelId: string, channels: NanjuChannelSnapshot[]): string {
  return channels.find((c) => c.channelId === channelId)?.family ?? channelFamily(channelId)
}

/** 逐端点状态：渠道存在 ∧ 模型存在 ∧ enabled = ok；家族标记按快照 family 归族解析 */
function endpointStatus(channelId: string, modelId: string, channels: NanjuChannelSnapshot[]): NanjuEndpointHealthStatus {
  const exact = channels.find((c) => c.channelId === channelId)
  if (exact) {
    const model = exact.models.find((m) => m.modelId === modelId)
    if (!model) return 'model-missing'
    return model.enabled ? 'ok' : 'model-disabled'
  }
  // 家族标记（'minimax' 等字面 ID，真渠道是 UUID）：按快照 family 归族匹配
  const family = channelFamily(channelId)
  const familyChannels = channels.filter((c) => c.family === family)
  if (familyChannels.length === 0) return 'channel-missing'
  if (familyChannels.some((c) => c.models.some((m) => m.modelId === modelId && m.enabled))) return 'ok'
  if (familyChannels.some((c) => c.models.some((m) => m.modelId === modelId))) return 'model-disabled'
  return 'model-missing'
}

/** 健康报告：全部槽位逐端点状态 + 失效计数（非 ok 即失效） */
export function computeNanjuModelHealth(config: LoadedNanjuModelConfig, channels: NanjuChannelSnapshot[]): NanjuHealthReport {
  const slots = enumerateNanjuModelSlots(config).map((s) => ({
    slot: s.slot,
    channelId: s.channelId,
    modelId: s.modelId,
    status: endpointStatus(s.channelId, s.modelId, channels),
  }))
  return { slots, invalidCount: slots.filter((s) => s.status !== 'ok').length }
}

// ===== 角色规格表（§三.1：家族 + 档位表达，替换阶梯第 ③ 步的兜底家族） =====

/** 规格家族用 channelFamily 的家族字面量（family-deepseek / family-glm / family-minimax） */
const SLOT_SPECS: Record<string, { family: string; tier: ModelTier }> = {
  'phases.requirements.primary': { family: 'family-deepseek', tier: 'flagship' },
  'phases.prototype.primary': { family: 'family-minimax', tier: 'flagship' },
  'phases.architecture.primary': { family: 'family-glm', tier: 'flagship' },
  'phases.planning.primary': { family: 'family-deepseek', tier: 'fast' },
  'phases.coding.primary': { family: 'family-glm', tier: 'flagship' },
  'phases.testing.primary': { family: 'family-deepseek', tier: 'fast' },
  // per-phase AC 覆盖规格（设计 §三.1：architecture/coding/testing defender=minimax；testing attacker=glm:快）
  'phases.architecture.acDefender': { family: 'family-minimax', tier: 'flagship' },
  'phases.coding.acDefender': { family: 'family-minimax', tier: 'flagship' },
  'phases.testing.acDefender': { family: 'family-minimax', tier: 'flagship' },
  'phases.testing.acAttacker': { family: 'family-glm', tier: 'fast' },
  // AC 预设：light=(ds:快, glm:快)、medium=(ds:旗舰, glm:旗舰)
  'acPresets.light.attacker': { family: 'family-deepseek', tier: 'fast' },
  'acPresets.light.defender': { family: 'family-glm', tier: 'fast' },
  'acPresets.medium.attacker': { family: 'family-deepseek', tier: 'flagship' },
  'acPresets.medium.defender': { family: 'family-glm', tier: 'flagship' },
}

/** 代理候选偏好序（§三.1）：[glm:快, ds:快, ds:旗舰, glm:旗舰, minimax:M3(旗舰)] */
const PROXY_SPEC_ORDER: ReadonlyArray<{ family: string; tier: ModelTier }> = [
  { family: 'family-glm', tier: 'fast' },
  { family: 'family-deepseek', tier: 'fast' },
  { family: 'family-deepseek', tier: 'flagship' },
  { family: 'family-glm', tier: 'flagship' },
  { family: 'family-minimax', tier: 'flagship' },
]

// ===== 替换阶梯（①同渠道同档位→②同族他渠道同档位→③规格兜底家族→④任意 enabled） =====

interface Candidate {
  channelId: string
  modelId: string
  family: string
}

/** 全量候选（enabled 模型平铺；确定性排序：channelId → modelId 字母序） */
function allCandidates(channels: NanjuChannelSnapshot[]): Candidate[] {
  const out: Candidate[] = []
  for (const channel of channels) {
    for (const model of channel.models) {
      if (!model.enabled) continue
      out.push({ channelId: channel.channelId, modelId: model.modelId, family: channel.family })
    }
  }
  return out.sort((a, b) => (a.channelId === b.channelId ? (a.modelId < b.modelId ? -1 : 1) : a.channelId < b.channelId ? -1 : 1))
}

interface ReplacementOpts {
  /** 硬约束排除族（AC 替换时排除作者族/攻防对端族） */
  excludeFamilies?: ReadonlySet<string>
  /** 强制替换：有效但违约的端点（defender 同作者族等）也走阶梯重选（约束回填用） */
  force?: boolean
}

function findReplacement(
  slot: string,
  channelId: string,
  modelId: string,
  channels: NanjuChannelSnapshot[],
  opts: ReplacementOpts = {},
): { channelId: string; modelId: string; reason: string } | null {
  const status = endpointStatus(channelId, modelId, channels)
  if (status === 'ok' && !opts.force) return null // 有效即保留（约束回填场景例外）

  const pass = (c: Candidate) => !opts.excludeFamilies?.has(c.family)
  const targetTier = classifyModelTier(modelId)
  const normalizedTarget = normalizeModelIdForRename(modelId)
  const family = familyOfChannel(channelId, channels)

  // ① 同渠道（或家族标记归族渠道）同档位：版本段归一改名命中优先，其余字母序
  const tierMatches = allCandidates(channels).filter(
    (c) => c.family === family && classifyModelTier(c.modelId) === targetTier && pass(c),
  )
  const renameHit = tierMatches.find((c) => normalizeModelIdForRename(c.modelId) === normalizedTarget)
  if (renameHit) return { channelId: renameHit.channelId, modelId: renameHit.modelId, reason: 'same-channel-rename' }
  if (tierMatches[0]) return { channelId: tierMatches[0].channelId, modelId: tierMatches[0].modelId, reason: 'same-family-same-tier' }

  // ③ 规格兜底家族（② 已并入 ① 的族内全渠道扫描；规格覆盖主选/AC/代理槽位）
  const specOrder: ReadonlyArray<{ family: string; tier: ModelTier }> = slot.startsWith('proxyCandidates[')
    ? PROXY_SPEC_ORDER
    : SLOT_SPECS[slot]
      ? [SLOT_SPECS[slot]!]
      : [] // fallbacks 槽位无独立规格（沿用原端点家族+档位，即 ① 的范围）
  for (const spec of specOrder) {
    const hit = allCandidates(channels).find(
      (c) => c.family === spec.family && classifyModelTier(c.modelId) === spec.tier && pass(c),
    )
    if (hit) return { channelId: hit.channelId, modelId: hit.modelId, reason: `spec-family-tier(${spec.family.split('family-')[1]}:${spec.tier})` }
  }

  // ④ 任意 enabled（附降级说明）
  const any = allCandidates(channels).find(pass)
  if (any) return { channelId: any.channelId, modelId: any.modelId, reason: 'any-enabled-downgrade' }
  return null
}

/**
 * 单槽推荐替换（autofix 钩子与行级修复共用）：端点有效返回 null；失效按
 * ①②③④ 阶梯找确定性替换（不含硬约束排除——需要族排除的场景由
 * recommendNanjuModelMatrix 内部带 excludeFamilies 调用）。
 */
export function recommendEndpointReplacement(
  slot: string,
  channelId: string,
  modelId: string,
  config: LoadedNanjuModelConfig,
  channels: NanjuChannelSnapshot[],
): { channelId: string; modelId: string; reason: string } | null {
  void config // 槽位规格走 SLOT_SPECS 静态表（config 参数保留在冻结签名内，供未来按配置扩展）
  return findReplacement(slot, channelId, modelId, channels)
}

// ===== 整套矩阵推荐（§三：确定性 + 硬约束两态） =====

interface EffectiveSlot {
  channelId: string
  modelId: string
  reason?: string
}

/** 阶段的攻/防有效角色来源：per-phase 覆盖优先（两档共用），缺省按指定档预设（W23 审查 #5：quick=light / iterative=medium 双档校验） */
function effectiveAcActors(
  config: LoadedNanjuModelConfig,
  effective: Map<string, EffectiveSlot>,
  phaseId: NanjuModelPhaseId,
  weight: 'light' | 'medium',
): { attacker: EffectiveSlot & { slot: string }; defender: EffectiveSlot & { slot: string }; perPhaseCovered: boolean } {
  const entry = config.phases[phaseId]!
  const attackerSlot = entry.acAttacker
    ? `phases.${phaseId}.acAttacker`
    : `acPresets.${weight}.attacker`
  const defenderSlot = entry.acDefender
    ? `phases.${phaseId}.acDefender`
    : `acPresets.${weight}.defender`
  const attacker = effective.get(attackerSlot)!
  const defender = effective.get(defenderSlot)!
  const perPhaseCovered = Boolean(entry.acAttacker) || Boolean(entry.acDefender)
  return {
    attacker: { ...attacker, slot: attackerSlot },
    defender: { ...defender, slot: defenderSlot },
    /** true = 攻/防任一为 per-phase 覆盖（两档共用同一槽，双档循环只需跑一轮） */
    perPhaseCovered,
  }
}

/** 智能配置推荐：确定性整套矩阵（有效即保留 + 失效阶梯替换 + 硬约束两态回填校验） */
export function recommendNanjuModelMatrix(
  config: LoadedNanjuModelConfig,
  channels: NanjuChannelSnapshot[],
): NanjuRecommendResult {
  const changes: NanjuRecommendChange[] = []
  const notes: string[] = []
  const violations: Array<{ slot: string; violation: string }> = []
  // W23 审查 #3：存在无法替换的失效端点时，「无需变更」分支不得宣称「全部端点有效」
  let hasUnreplaced = false
  // 槽位 → 有效端点（工作副本；替换写回此处）
  const effective = new Map<string, EffectiveSlot>()
  for (const s of enumerateNanjuModelSlots(config)) {
    effective.set(s.slot, { channelId: s.channelId, modelId: s.modelId })
  }
  const record = (slot: string, from: SlotEntry | { channelId: string; modelId: string }, replacement: { channelId: string; modelId: string; reason: string }) => {
    if (replacement.channelId === from.channelId && replacement.modelId === from.modelId) return // no-op 替换不记录
    effective.set(slot, { channelId: replacement.channelId, modelId: replacement.modelId, reason: replacement.reason })
    changes.push({
      slot,
      from: endpointKey(from.channelId, from.modelId),
      to: endpointKey(replacement.channelId, replacement.modelId),
      reason: replacement.reason,
    })
    if (replacement.reason === 'any-enabled-downgrade') {
      notes.push(`${slot}: 仅剩任意可用端点兜底（${endpointKey(replacement.channelId, replacement.modelId)}），规格/族多样性已降级，建议尽快补配`)
    }
  }

  // ---- 分配序 1：作者（各阶段 primary + fallbacks，按固定阶段序） ----
  for (const phaseId of NANJU_MODEL_PHASE_ORDER) {
    const entry = config.phases[phaseId]!
    const primarySlot = `phases.${phaseId}.primary`
    if (endpointStatus(entry.channel, entry.model, channels) !== 'ok') {
      const r = findReplacement(primarySlot, entry.channel, entry.model, channels)
      if (r) record(primarySlot, { channelId: entry.channel, modelId: entry.model }, r)
      else {
        notes.push(`${primarySlot}: 无任何可用替换候选（渠道全空？），保持原值`)
        hasUnreplaced = true
      }
    }
    const fallbacks = entry.fallbacks ?? []
    for (let i = 0; i < fallbacks.length; i++) {
      const slot = `phases.${phaseId}.fallbacks[${i}]`
      const ep = parseEndpointString(fallbacks[i]!)
      if (endpointStatus(ep.channelId, ep.modelId, channels) !== 'ok') {
        const r = findReplacement(slot, ep.channelId, ep.modelId, channels)
        if (r) record(slot, ep, r)
        else {
          notes.push(`${slot}: 无任何可用替换候选（渠道全空？），保持原值`)
          hasUnreplaced = true
        }
      }
    }
  }

  // ---- 分配序 2：AC（先防御者【排除作者族】，后攻击者【排除防御者族】；含有效但违约的重选） ----
  // W23 审查 #5：无 per-phase 覆盖的阶段 light/medium 两档都校验（quick 用 light，iterative 用 medium）
  for (const phaseId of NANJU_MODEL_PHASE_ORDER) {
    const authorSlot = `phases.${phaseId}.primary`
    const author = effective.get(authorSlot)!
    const authorFamily = familyOfChannel(author.channelId, channels)
    const hasPerPhaseCover = Boolean(config.phases[phaseId]!.acAttacker) || Boolean(config.phases[phaseId]!.acDefender)
    for (const weight of hasPerPhaseCover ? ['medium'] as const : ['light', 'medium'] as const) {
      const { defender, attacker } = effectiveAcActors(config, effective, phaseId, weight)
      const defenderFamily = familyOfChannel(defender.channelId, channels)

      if (defenderFamily === authorFamily) {
        // 防御者失效或与作者同族 → 重选：排除作者族（攻击者族此时未定，先不排除；终检兜底）
        const r = findReplacement(defender.slot, defender.channelId, defender.modelId, channels, {
          excludeFamilies: new Set([authorFamily]),
          force: true,
        })
        if (r) record(defender.slot, defender, r)
      }
      const defenderAfter = effective.get(defender.slot)!
      const defenderFamilyAfter = familyOfChannel(defenderAfter.channelId, channels)
      const attackerFamily = familyOfChannel(attacker.channelId, channels)
      if (attackerFamily === defenderFamilyAfter) {
        const r = findReplacement(attacker.slot, attacker.channelId, attacker.modelId, channels, {
          excludeFamilies: new Set([defenderFamilyAfter]),
          force: true,
        })
        if (r) record(attacker.slot, attacker, r)
      }
    }
  }

  // ---- 分配序 3：代理候选（偏好序保持多样性铺开，无硬排除） ----
  for (let i = 0; i < config.proxyCandidates.length; i++) {
    const slot = `proxyCandidates[${i}]`
    const c = config.proxyCandidates[i]!
    if (endpointStatus(c.channelId, c.modelId, channels) !== 'ok') {
      const r = findReplacement(slot, c.channelId, c.modelId, channels)
      if (r) record(slot, c, r)
    }
  }

  // ---- 硬约束回填校验（两态语义；双档：无覆盖阶段 light/medium 都终检） ----
  for (const phaseId of NANJU_MODEL_PHASE_ORDER) {
    const authorSlot = `phases.${phaseId}.primary`
    const author = effective.get(authorSlot)!
    const authorFamily = familyOfChannel(author.channelId, channels)
    const hasPerPhaseCoverFinal = Boolean(config.phases[phaseId]!.acAttacker) || Boolean(config.phases[phaseId]!.acDefender)
    for (const weight of hasPerPhaseCoverFinal ? ['medium'] as const : ['light', 'medium'] as const) {
      const { attacker, defender } = effectiveAcActors(config, effective, phaseId, weight)
      const defenderFamily = familyOfChannel(defender.channelId, channels)
      const attackerFamily = familyOfChannel(attacker.channelId, channels)
      if (defenderFamily === authorFamily) {
        violations.push({
          slot: defender.slot,
          violation: `[${weight}] 防御者（${endpointKey(defender.channelId, defender.modelId)}）与作者（${endpointKey(author.channelId, author.modelId)}）同家族（${authorFamily}），无满足异族约束的可用替换`,
        })
      }
      if (attackerFamily === defenderFamily) {
        violations.push({
          slot: attacker.slot,
          violation: `[${weight}] 攻击者（${endpointKey(attacker.channelId, attacker.modelId)}）与防御者（${endpointKey(defender.channelId, defender.modelId)}）同家族（${defenderFamily}），攻防可能串通`,
        })
      }
    }
  }
  // coding ↔ testing 主选跨族（开发/测试独立性）
  const codingPrimary = effective.get('phases.coding.primary')!
  const testingPrimary = effective.get('phases.testing.primary')!
  const codingFamily = familyOfChannel(codingPrimary.channelId, channels)
  const testingFamily = familyOfChannel(testingPrimary.channelId, channels)
  if (codingFamily === testingFamily) {
    // 两态红测语义：先试重选 testing（规格 ds:快，排除 coding 族），再试 coding（排除 testing 族）
    const testingRetry = findReplacement('phases.testing.primary', testingPrimary.channelId, testingPrimary.modelId, channels, {
      excludeFamilies: new Set([codingFamily]),
      force: true,
    })
    if (testingRetry) record('phases.testing.primary', testingPrimary, testingRetry)
    else {
      const codingRetry = findReplacement('phases.coding.primary', codingPrimary.channelId, codingPrimary.modelId, channels, {
        excludeFamilies: new Set([testingFamily]),
        force: true,
      })
      if (codingRetry) record('phases.coding.primary', codingPrimary, codingRetry)
      else {
        violations.push({
          slot: 'phases.testing.primary',
          violation: `coding↔testing 主选同族（${codingFamily}：${endpointKey(codingPrimary.channelId, codingPrimary.modelId)} vs ${endpointKey(testingPrimary.channelId, testingPrimary.modelId)}），且无跨族替换可用——开发/测试独立性无法满足`,
        })
      }
    }
  }

  if (changes.length === 0) {
    return {
      matrix: null,
      applyable: true,
      changes: [],
      notes: hasUnreplaced
        ? ['存在无法自动替换的失效端点（下列槽位保持原值），请手动调整渠道或改选模型', ...notes]
        : ['无需变更：全部端点有效且满足硬约束'],
    }
  }
  if (violations.length > 0) {
    // 无解：不返回 matrix（save 拒绝应用）；changes 保留供诊断
    return { matrix: null, applyable: false, changes, notes, diversityViolations: violations }
  }
  return { matrix: buildMatrixPatch(config, effective, changes), applyable: true, changes, notes }
}

/** 从有效端点表编译增量 matrix patch（只含发生变更的字段；字符串端点形态随文件 schema） */
function buildMatrixPatch(
  config: LoadedNanjuModelConfig,
  effective: Map<string, EffectiveSlot>,
  changes: NanjuRecommendChange[],
): Partial<NanjuModelConfigFile> {
  const patch: Partial<NanjuModelConfigFile> = {}
  const phases: Partial<Record<NanjuModelPhaseId, Record<string, unknown>>> = {}
  const acPresets: Partial<Record<'light' | 'medium', Record<string, unknown>>> = {}
  const changedSlots = new Set(changes.map((c) => c.slot))

  for (const phaseId of NANJU_MODEL_PHASE_ORDER) {
    const entry = config.phases[phaseId]!
    const bucket: Record<string, unknown> = {}
    if (changedSlots.has(`phases.${phaseId}.primary`)) {
      const p = effective.get(`phases.${phaseId}.primary`)!
      bucket.channel = p.channelId
      bucket.model = p.modelId
    }
    const fallbackSlots = (entry.fallbacks ?? []).map((_, i) => `phases.${phaseId}.fallbacks[${i}]`)
    if (fallbackSlots.some((s) => changedSlots.has(s))) {
      bucket.fallbacks = fallbackSlots.map((s) => {
        const ep = effective.get(s)!
        return endpointKey(ep.channelId, ep.modelId)
      })
    }
    if (entry.acAttacker && changedSlots.has(`phases.${phaseId}.acAttacker`)) {
      const a = effective.get(`phases.${phaseId}.acAttacker`)!
      bucket.acAttacker = { channel: a.channelId, model: a.modelId }
    }
    if (entry.acDefender && changedSlots.has(`phases.${phaseId}.acDefender`)) {
      const d = effective.get(`phases.${phaseId}.acDefender`)!
      bucket.acDefender = { channel: d.channelId, model: d.modelId }
    }
    if (Object.keys(bucket).length > 0) phases[phaseId] = bucket
  }
  for (const weight of ['light', 'medium'] as const) {
    const bucket: Record<string, unknown> = {}
    if (changedSlots.has(`acPresets.${weight}.attacker`)) {
      const a = effective.get(`acPresets.${weight}.attacker`)!
      bucket.attacker = { channel: a.channelId, model: a.modelId }
    }
    if (changedSlots.has(`acPresets.${weight}.defender`)) {
      const d = effective.get(`acPresets.${weight}.defender`)!
      bucket.defender = { channel: d.channelId, model: d.modelId }
    }
    if (Object.keys(bucket).length > 0) acPresets[weight] = bucket
  }
  if (Object.keys(phases).length > 0) patch.phases = phases as Partial<Record<NanjuModelPhaseId, Partial<typeof config.phases.requirements>>>
  if (Object.keys(acPresets).length > 0) patch.acPresets = acPresets as Partial<Record<'light' | 'medium', never>>
  if (config.proxyCandidates.some((_, i) => changedSlots.has(`proxyCandidates[${i}]`))) {
    patch.proxyCandidates = config.proxyCandidates.map((_, i) => {
      const ep = effective.get(`proxyCandidates[${i}]`)!
      return { channelId: ep.channelId, modelId: ep.modelId }
    })
  }
  return patch
}
