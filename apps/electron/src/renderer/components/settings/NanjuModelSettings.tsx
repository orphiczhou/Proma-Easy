/**
 * NanjuModelSettings - 南大向导·模型配置
 *
 * 设计真相源：nanju-w23-model-settings-design.md §四（设置 UI）。
 * 三组矩阵：阶段模型（六阶段主选+可变长备选）、AC 攻防（两档预设 + per-phase 覆盖）、代理候选。
 * 操作条：智能配置（diff 预览→应用）、测试全部、一键应用推荐修复、恢复默认（整体）、保存并生效。
 *
 * IPC 契约类型在本文件本地声明（共享类型归 D2 的 packages/shared）；主进程 API 可能尚未
 * 注册（D2 并行施工），因此一律经 getNanjuModelApi() 防御性访问，缺失时渲染空态不崩组件。
 */

import * as React from 'react'
import {
  Activity,
  AlertTriangle,
  Info,
  Plus,
  RotateCcw,
  Trash2,
  Wand2,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { SettingsCard, SettingsSection } from './primitives'

// ===== IPC 契约类型（本地声明；权威定义在 D2 的 packages/shared）=====

/** 端点对（渠道 id + 模型 id） */
export interface NanjuEndpointPair {
  channel: string
  model: string
}

interface NanjuPhaseConfigLike {
  channel: string
  model: string
  fallbacks?: string[]
  acAttacker?: NanjuEndpointPair
  acDefender?: NanjuEndpointPair
}

export interface NanjuModelSettingsStateLike {
  effective: {
    phases: Record<string, NanjuPhaseConfigLike>
    acPresets: Record<'light' | 'medium', { attacker: NanjuEndpointPair; defender: NanjuEndpointPair }>
    proxyCandidates: Array<{ channelId: string; modelId: string }>
  }
  sources: { builtin?: string; override?: string; user?: string }
  health: Array<{
    slot: string
    channelId: string
    modelId: string
    status: 'ok' | 'model-disabled' | 'model-missing' | 'channel-missing'
  }>
  diversityWarnings: Array<{ kind: string; detail: string }>
  channels: Array<{ channelId: string; name: string; enabledModelIds: string[] }>
  handLayerPresent: boolean
}

interface NanjuTestResult {
  channelId: string
  modelId: string
  ok: boolean
  latencyMs?: number
  message?: string
}

interface NanjuRecommendResult {
  matrix: unknown | null
  applyable: boolean
  changes: Array<{ slot: string; from: string; to: string; reason: string }>
  notes: string[]
  diversityViolations?: Array<{ slot: string; violation: string }>
}

interface NanjuShadowedEntry {
  field: string
  requested: unknown
  effective: unknown
  shadowSource: string
  path: string
}

/** save patch：只含改动字段；字段值 null = 删除该键覆盖；fallbacks/proxyCandidates 数组整体替换 */
interface NanjuModelSavePatchLike {
  phases?: Record<string, {
    channel?: string | null
    model?: string | null
    fallbacks?: string[] | null
    acAttacker?: NanjuEndpointPair | null
    acDefender?: NanjuEndpointPair | null
  }>
  acPresets?: Record<string, {
    attacker?: NanjuEndpointPair | null
    defender?: NanjuEndpointPair | null
  }>
  proxyCandidates?: Array<{ channelId: string; modelId: string }> | null
}

interface NanjuModelApi {
  // W23 审查 #2：主进程 handler 统一 try/catch 返回 { error } 联合形态——渲染端必须消费
  nanjuModelGetState: () => Promise<NanjuModelSettingsStateLike | { error: string }>
  nanjuModelTestEndpoints: (eps: Array<{ channelId: string; modelId: string }>) => Promise<NanjuTestResult[] | { error: string }>
  nanjuModelRecommend: () => Promise<NanjuRecommendResult | { error: string }>
  nanjuModelSave: (patch: NanjuModelSavePatchLike) => Promise<{ state: NanjuModelSettingsStateLike; shadowed: NanjuShadowedEntry[] } | { error: string }>
  nanjuModelReset: () => Promise<NanjuModelSettingsStateLike | { error: string }>
}

/** IPC 联合形态的错误提取（{ error } → message；非错误形态返回 null） */
export function ipcErrorOf(res: unknown): string | null {
  if (res && typeof res === 'object' && 'error' in res) {
    const msg = (res as { error?: unknown }).error
    if (typeof msg === 'string' && msg.length > 0) return msg
  }
  return null
}

/** 防御性获取主进程 API（D2 并行施工，可能尚未注册） */
function getNanjuModelApi(): NanjuModelApi | null {
  const electronAPI = (window as unknown as { electronAPI?: Partial<NanjuModelApi> }).electronAPI
  if (!electronAPI || typeof electronAPI.nanjuModelGetState !== 'function') return null
  return electronAPI as NanjuModelApi
}

/**
 * 模块级 dirty 标志（不新增 atom；SettingsPanel 读取用于离开拦截）。
 * 组件挂载期间由 effect 同步；卸载时由 cleanup 复位。
 */
export const nanjuModelFormDirty = { dirty: false }

// ===== 常量 =====

const PHASE_IDS = ['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing'] as const
type PhaseId = (typeof PHASE_IDS)[number]

const PHASE_LABELS: Record<PhaseId, string> = {
  requirements: '需求分析',
  prototype: '原型设计',
  architecture: '架构设计',
  planning: '工程规划',
  coding: '编码',
  testing: '测试',
}

/** per-phase AC 覆盖四行（设计 §四：architecture defender、coding defender、testing attacker、testing defender） */
const PHASE_AC_ROWS: Array<{ phase: PhaseId; role: 'acAttacker' | 'acDefender' }> = [
  { phase: 'architecture', role: 'acDefender' },
  { phase: 'coding', role: 'acDefender' },
  { phase: 'testing', role: 'acAttacker' },
  { phase: 'testing', role: 'acDefender' },
]

const AC_TIERS: Array<'light' | 'medium'> = ['light', 'medium']
const AC_TIER_LABELS: Record<'light' | 'medium', string> = { light: '轻量档', medium: '标准档' }

const FALLBACK_MAX = 3
const PROXY_MAX = 6
/** minimax 家族标记（非真实渠道 id，运行时解析） */
const FAMILY_MARKER_CHANNEL = 'minimax'

// ===== 草稿模型（本地 state）=====

interface EndpointDraft {
  channel: string
  model: string
}

interface PhaseDraft {
  main: EndpointDraft
  fallbacks: EndpointDraft[]
  acAttacker: EndpointDraft | null
  acDefender: EndpointDraft | null
}

export interface Draft {
  phases: Record<PhaseId, PhaseDraft>
  presets: Record<'light' | 'medium', { attacker: EndpointDraft; defender: EndpointDraft }>
  proxy: EndpointDraft[]
}

// ===== 纯函数（导出供逻辑测试）=====

/** "channel:model" → 端点对；按第一个冒号切分，非法输入返回 null */
export function parseEndpointString(s: string): EndpointDraft | null {
  if (!s) return null
  const idx = s.indexOf(':')
  if (idx <= 0 || idx >= s.length - 1) return null
  return { channel: s.slice(0, idx), model: s.slice(idx + 1) }
}

/** 端点对 → "channel:model"；空槽返回 null（空槽不落盘） */
export function endpointToString(p: EndpointDraft): string | null {
  if (!p.channel || !p.model) return null
  return `${p.channel}:${p.model}`
}

function draftFromState(state: NanjuModelSettingsStateLike): Draft {
  const phases = {} as Record<PhaseId, PhaseDraft>
  for (const id of PHASE_IDS) {
    const p = state.effective.phases[id]
    phases[id] = {
      main: { channel: p?.channel ?? '', model: p?.model ?? '' },
      fallbacks: (p?.fallbacks ?? []).map((s) => parseEndpointString(s) ?? { channel: '', model: '' }),
      acAttacker: p?.acAttacker ? { channel: p.acAttacker.channel, model: p.acAttacker.model } : null,
      acDefender: p?.acDefender ? { channel: p.acDefender.channel, model: p.acDefender.model } : null,
    }
  }
  const presets = {} as Draft['presets']
  for (const tier of AC_TIERS) {
    const preset = state.effective.acPresets?.[tier]
    presets[tier] = {
      attacker: { channel: preset?.attacker?.channel ?? '', model: preset?.attacker?.model ?? '' },
      defender: { channel: preset?.defender?.channel ?? '', model: preset?.defender?.model ?? '' },
    }
  }
  const proxy = (state.effective.proxyCandidates ?? []).map((c) => ({ channel: c.channelId, model: c.modelId }))
  return { phases, presets, proxy }
}

function pairsEqual(
  a: { channel: string; model: string } | null | undefined,
  b: { channel: string; model: string } | null | undefined,
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.channel === b.channel && a.model === b.model
}

/** 与生效值比较（undefined/空串视为相等，避免误判 dirty） */
function endpointPairEquals(
  a: { channel?: string; model?: string } | null | undefined,
  b: { channel: string; model: string },
): boolean {
  return (a?.channel ?? '') === b.channel && (a?.model ?? '') === b.model
}

/** diff 草稿 vs 生效配置 → 增量 save patch（只含显式改动字段） */
export function computeSavePatch(state: NanjuModelSettingsStateLike, draft: Draft): NanjuModelSavePatchLike {
  const patch: NanjuModelSavePatchLike = {}
  let dirty = false

  for (const id of PHASE_IDS) {
    const base = state.effective.phases[id]
    const d = draft.phases[id]
    const phasePatch: NonNullable<NonNullable<NanjuModelSavePatchLike['phases']>[string]> = {}

    if (!endpointPairEquals(base, d.main) && d.main.channel && d.main.model) {
      phasePatch.channel = d.main.channel
      phasePatch.model = d.main.model
    }

    const baseFallbacks = base?.fallbacks ?? []
    const draftFallbacks = d.fallbacks.map(endpointToString).filter((s): s is string => s !== null)
    const fallbacksChanged =
      baseFallbacks.length !== draftFallbacks.length ||
      baseFallbacks.some((s, i) => s !== draftFallbacks[i])
    // W23 审查 #1：删空备选发 null（删除覆盖、继承低层）——空数组会被 save 白名单拒绝，
    // 且合并层语义「空=未声明」无法表达零备选；继承低层是唯一一致的收口
    if (fallbacksChanged) phasePatch.fallbacks = draftFallbacks.length > 0 ? draftFallbacks : null

    if (!pairsEqual(base?.acAttacker ?? null, d.acAttacker)) {
      phasePatch.acAttacker =
        d.acAttacker && d.acAttacker.channel && d.acAttacker.model
          ? { channel: d.acAttacker.channel, model: d.acAttacker.model }
          : null
    }
    if (!pairsEqual(base?.acDefender ?? null, d.acDefender)) {
      phasePatch.acDefender =
        d.acDefender && d.acDefender.channel && d.acDefender.model
          ? { channel: d.acDefender.channel, model: d.acDefender.model }
          : null
    }

    if (Object.keys(phasePatch).length > 0) {
      patch.phases ??= {}
      patch.phases[id] = phasePatch
      dirty = true
    }
  }

  for (const tier of AC_TIERS) {
    const base = state.effective.acPresets?.[tier]
    const d = draft.presets[tier]
    if (!endpointPairEquals(base?.attacker, d.attacker) || !endpointPairEquals(base?.defender, d.defender)) {
      patch.acPresets ??= {}
      patch.acPresets[tier] = {
        ...(d.attacker.channel && d.attacker.model ? { attacker: { ...d.attacker } } : {}),
        ...(d.defender.channel && d.defender.model ? { defender: { ...d.defender } } : {}),
      }
      dirty = true
    }
  }

  const baseProxy = state.effective.proxyCandidates ?? []
  const draftProxy = draft.proxy
    .map((p): { channelId: string; modelId: string } | null =>
      p.channel && p.model ? { channelId: p.channel, modelId: p.model } : null)
    .filter((p): p is { channelId: string; modelId: string } => p !== null)
  const proxyChanged =
    baseProxy.length !== draftProxy.length ||
    baseProxy.some((p, i) => p.channelId !== draftProxy[i]?.channelId || p.modelId !== draftProxy[i]?.modelId)
  if (proxyChanged) {
    // W23 审查 #4：删空代理候选发 null（与 fallbacks 空集合语义对齐：空数组=拒绝）
    patch.proxyCandidates = draftProxy.length > 0 ? draftProxy : null
    dirty = true
  }

  return dirty ? patch : {}
}

// ===== 槽位解析（health slot / shadowed field / recommend slot 三处共用）=====

export type ParsedSlot =
  | { kind: 'phase-main'; phase: PhaseId }
  | { kind: 'phase-fallback'; phase: PhaseId; index: number }
  | { kind: 'phase-ac'; phase: PhaseId; role: 'acAttacker' | 'acDefender' }
  | { kind: 'ac-preset'; tier: 'light' | 'medium'; role: 'attacker' | 'defender' }
  | { kind: 'proxy'; index: number }

const PHASE_ALT = PHASE_IDS.join('|')

/** 解析 slot 字符串为结构化槽位；兼容 `.0` 与 `[0]` 两种下标写法；
 * W23 接缝对齐：主选槽同时接受 `.primary`（D1 冻结命名/health/changes）与 `.main`/裸形态 */
export function parseHealthSlot(slot: string): ParsedSlot | null {
  if (!slot) return null
  let m = new RegExp(`^phases\\.(${PHASE_ALT})(?:\\.(?:main|primary))?$`).exec(slot)
  if (m) return { kind: 'phase-main', phase: m[1] as PhaseId }
  m = new RegExp(`^phases\\.(${PHASE_ALT})\\.fallbacks(?:\\.(\\d+)|\\[(\\d+)\\])$`).exec(slot)
  if (m) return { kind: 'phase-fallback', phase: m[1] as PhaseId, index: Number(m[2] ?? m[3]) }
  m = new RegExp(`^phases\\.(${PHASE_ALT})\\.(acAttacker|acDefender)$`).exec(slot)
  if (m) return { kind: 'phase-ac', phase: m[1] as PhaseId, role: m[2] as 'acAttacker' | 'acDefender' }
  m = /^acPresets\.(light|medium)\.(attacker|defender)$/.exec(slot)
  if (m) return { kind: 'ac-preset', tier: m[1] as 'light' | 'medium', role: m[2] as 'attacker' | 'defender' }
  m = /^proxyCandidates(?:\.(\d+)|\[(\d+)\])$/.exec(slot)
  if (m) return { kind: 'proxy', index: Number(m[1] ?? m[2]) }
  return null
}

/** 槽位 → 行 key（状态灯/提示挂载点） */
function slotRowKey(slot: ParsedSlot): string {
  switch (slot.kind) {
    case 'phase-main': return `p:${slot.phase}`
    case 'phase-fallback': return `p:${slot.phase}:f:${slot.index}`
    case 'phase-ac': return `p:${slot.phase}:ac:${slot.role}`
    case 'ac-preset': return `ac:${slot.tier}:${slot.role}`
    case 'proxy': return `proxy:${slot.index}`
  }
}

/** 槽位 → 展示名（diff 预览等） */
function slotDisplayName(slotRaw: string): string {
  const slot = parseHealthSlot(slotRaw)
  if (!slot) return slotRaw
  switch (slot.kind) {
    case 'phase-main': return `${PHASE_LABELS[slot.phase]}·主选`
    case 'phase-fallback': return `${PHASE_LABELS[slot.phase]}·备选${slot.index + 1}`
    case 'phase-ac': return `${PHASE_LABELS[slot.phase]}·AC${slot.role === 'acAttacker' ? '攻击' : '防守'}覆盖`
    case 'ac-preset': return `AC 预设·${AC_TIER_LABELS[slot.tier]}${slot.role === 'attacker' ? '攻击' : '防守'}`
    case 'proxy': return `代理候选 ${slot.index + 1}`
  }
}

/** 行 key → 该行当前端点（用于 health 端点兜底匹配） */
function rowEndpointsOf(state: NanjuModelSettingsStateLike): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const push = (key: string, pair: { channel: string; model: string } | null | undefined): void => {
    if (!pair?.channel || !pair.model) return
    const endpoint = `${pair.channel}:${pair.model}`
    map.set(endpoint, [...(map.get(endpoint) ?? []), key])
  }
  for (const id of PHASE_IDS) {
    const p = state.effective.phases[id]
    push(`p:${id}`, p)
    ;(p?.fallbacks ?? []).forEach((s, i) => {
      const pair = parseEndpointString(s)
      if (pair) push(`p:${id}:f:${i}`, pair)
    })
    push(`p:${id}:ac:acAttacker`, p?.acAttacker)
    push(`p:${id}:ac:acDefender`, p?.acDefender)
  }
  for (const tier of AC_TIERS) {
    const preset = state.effective.acPresets?.[tier]
    push(`ac:${tier}:attacker`, preset?.attacker)
    push(`ac:${tier}:defender`, preset?.defender)
  }
  ;(state.effective.proxyCandidates ?? []).forEach((c, i) => {
    push(`proxy:${i}`, { channel: c.channelId, model: c.modelId })
  })
  return map
}

/**
 * health 列表 → 行 key 索引。
 * 主路径按 slot 解析；slot 无法解析时退化为端点唯一匹配（端点在全矩阵只出现一次才归因）。
 */
export function buildHealthByRow(
  state: NanjuModelSettingsStateLike,
): Map<string, NanjuModelSettingsStateLike['health'][number]> {
  const byRow = new Map<string, NanjuModelSettingsStateLike['health'][number]>()
  const endpoints = rowEndpointsOf(state)
  for (const entry of state.health) {
    const slot = parseHealthSlot(entry.slot)
    if (slot) {
      byRow.set(slotRowKey(slot), entry)
      continue
    }
    const rows = endpoints.get(`${entry.channelId}:${entry.modelId}`)
    const uniqueRow = rows?.length === 1 ? rows[0] : undefined
    if (uniqueRow) byRow.set(uniqueRow, entry)
  }
  return byRow
}

/** recommend changes → save patch（fallbacks/proxyCandidates 以当前生效值为基数整体替换） */
export function changesToPatch(
  changes: NanjuRecommendResult['changes'],
  state: NanjuModelSettingsStateLike,
): NanjuModelSavePatchLike {
  const patch: NanjuModelSavePatchLike = {}
  const phaseOf = (id: string): NonNullable<NonNullable<NanjuModelSavePatchLike['phases']>[string]> => {
    patch.phases ??= {}
    patch.phases[id] ??= {}
    return patch.phases[id]
  }

  for (const change of changes) {
    const to = parseEndpointString(change.to)
    if (!to) continue
    const slot = parseHealthSlot(change.slot)
    if (!slot) continue

    if (slot.kind === 'phase-main') {
      const phase = phaseOf(slot.phase)
      phase.channel = to.channel
      phase.model = to.model
    } else if (slot.kind === 'phase-fallback') {
      const phase = phaseOf(slot.phase)
      const strings = [...(phase.fallbacks ?? state.effective.phases[slot.phase]?.fallbacks ?? [])]
      strings[slot.index] = change.to
      phase.fallbacks = strings
    } else if (slot.kind === 'phase-ac') {
      const phase = phaseOf(slot.phase)
      if (slot.role === 'acAttacker') phase.acAttacker = { channel: to.channel, model: to.model }
      else phase.acDefender = { channel: to.channel, model: to.model }
    } else if (slot.kind === 'ac-preset') {
      patch.acPresets ??= {}
      const presetPatch = (patch.acPresets[slot.tier] ??= {})
      presetPatch[slot.role] = { channel: to.channel, model: to.model }
    } else if (slot.kind === 'proxy') {
      const arr = [...(patch.proxyCandidates ?? state.effective.proxyCandidates ?? [])]
      arr[slot.index] = { channelId: to.channel, modelId: to.model }
      patch.proxyCandidates = arr
    }
  }
  return patch
}

/** shadowed 字段列表 → 行 key → 覆盖文件路径。
 * D2 save 的 shadowed.field 是字段级路径（phases.<id>.channel|model|fallbacks、acPresets.<w>.<role>、proxyCandidates 裸键），
 * 不是槽位命名——先试槽位解析（兼容 acPresets.*），再用字段级正则把 channel/model/fallbacks 归到对应阶段行 */
export function buildShadowedByRow(shadowed: NanjuShadowedEntry[]): Map<string, string> {
  const byRow = new Map<string, string>()
  for (const entry of shadowed) {
    const slot = parseHealthSlot(entry.field)
    if (slot && slot.kind !== 'proxy') {
      byRow.set(slotRowKey(slot), entry.path)
      continue
    }
    if (slot?.kind === 'proxy') {
      byRow.set(slotRowKey(slot), entry.path)
      continue
    }
    // 字段级路径：phases.<id>.<field>（field 任意，含 channel/model/fallbacks/acAttacker/acDefender）
    const fm = new RegExp(`^phases\\.(${PHASE_ALT})\\.(channel|model|fallbacks|acAttacker|acDefender)(?:[.\\[].*)?$`).exec(entry.field)
    if (fm) {
      const roleKey = fm[2] === 'acAttacker' || fm[2] === 'acDefender' ? `:ac:${fm[2]}` : ''
      byRow.set(`p:${fm[1]}${roleKey}`, entry.path)
      continue
    }
    // 裸 proxyCandidates：标到每个代理候选行（保守：全部标记）
    if (entry.field === 'proxyCandidates') {
      byRow.set('proxy:*', entry.path)
    }
  }
  return byRow
}

/** 收集草稿中全部可测端点（跳过空槽与 minimax 家族标记；去重） */
export function collectTestEndpoints(draft: Draft): Array<{ channelId: string; modelId: string }> {
  const seen = new Set<string>()
  const out: Array<{ channelId: string; modelId: string }> = []
  const push = (p: EndpointDraft | null): void => {
    if (!p?.channel || !p.model) return
    if (p.channel === FAMILY_MARKER_CHANNEL) return
    const key = `${p.channel}:${p.model}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ channelId: p.channel, modelId: p.model })
  }
  for (const id of PHASE_IDS) {
    const d = draft.phases[id]
    push(d.main)
    d.fallbacks.forEach((f) => push(f))
    push(d.acAttacker)
    push(d.acDefender)
  }
  for (const tier of AC_TIERS) {
    push(draft.presets[tier].attacker)
    push(draft.presets[tier].defender)
  }
  draft.proxy.forEach((p) => push(p))
  return out
}

/** change 是否命中 health 红/黄项（一键修复过滤） */
export function changeHitsUnhealthySlot(
  change: NanjuRecommendResult['changes'][number],
  state: NanjuModelSettingsStateLike,
): boolean {
  const slot = parseHealthSlot(change.slot)
  if (!slot) return false
  const rowKey = slotRowKey(slot)
  return state.health.some((h) => {
    if (h.status === 'ok') return false
    const hSlot = parseHealthSlot(h.slot)
    return hSlot !== null && slotRowKey(hSlot) === rowKey
  })
}

function hasPatchFields(patch: NanjuModelSavePatchLike): boolean {
  return Object.keys(patch).length > 0
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ===== 状态灯 =====

type StatusLevel = 'ok' | 'yellow' | 'red' | 'shadowed' | 'neutral'

const STATUS_DOT_CLASS: Record<StatusLevel, string> = {
  ok: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
  shadowed: 'bg-slate-400',
  neutral: 'bg-muted-foreground/40',
}

const STATUS_LABEL: Record<StatusLevel, string> = {
  ok: '正常',
  yellow: '警告',
  red: '失效',
  shadowed: '被覆盖',
  neutral: '—',
}

function StatusDot({ level, label }: { level: StatusLevel; label?: string }): React.ReactElement {
  return (
    <span
      className={cn('inline-block size-2.5 flex-shrink-0 rounded-full', STATUS_DOT_CLASS[level])}
      title={label ?? STATUS_LABEL[level]}
      aria-label={label ?? STATUS_LABEL[level]}
    />
  )
}

// ===== 行内提示 =====

function InlineHint({ tone, children }: { tone: 'info' | 'warn' | 'error' | 'shadow'; children: React.ReactNode }): React.ReactElement {
  const toneClass = {
    info: 'text-muted-foreground',
    warn: 'text-amber-600 dark:text-amber-400',
    error: 'text-red-600 dark:text-red-400',
    shadow: 'text-slate-500 dark:text-slate-400',
  }[tone]
  return <div className={cn('flex items-start gap-1 text-xs leading-relaxed', toneClass)}>{children}</div>
}

// ===== 端点选择器（渠道 → 模型级联）=====

interface EndpointSelectsProps {
  value: EndpointDraft
  channels: NanjuModelSettingsStateLike['channels']
  onChange: (next: EndpointDraft) => void
}

function EndpointSelects({ value, channels, onChange }: EndpointSelectsProps): React.ReactElement {
  const models = channels.find((c) => c.channelId === value.channel)?.enabledModelIds ?? []
  const modelMissingFromList = Boolean(value.model) && !models.includes(value.model)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Select
        value={value.channel || undefined}
        onValueChange={(channel) => onChange({ channel, model: '' })}
      >
        <SelectTrigger className="h-8 w-[160px] flex-shrink-0 text-xs">
          <SelectValue placeholder="选择渠道" />
        </SelectTrigger>
        <SelectContent>
          {channels.map((c) => (
            <SelectItem key={c.channelId} value={c.channelId} className="text-xs">
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={value.model || undefined}
        onValueChange={(model) => onChange({ channel: value.channel, model })}
        disabled={!value.channel}
      >
        <SelectTrigger className="h-8 min-w-0 flex-1 text-xs">
          <SelectValue placeholder="选择模型" />
        </SelectTrigger>
        <SelectContent>
          {modelMissingFromList && (
            <SelectItem value={value.model} className="text-xs text-amber-600 dark:text-amber-400">
              {value.model}（不在启用列表）
            </SelectItem>
          )}
          {models.map((m) => (
            <SelectItem key={m} value={m} className="text-xs">
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** minimax 家族标记：不可编辑、状态灯中性 */
function FamilyMarkerView({ model }: { model: string }): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate rounded-md border border-dashed border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
        家族标记（运行时解析）：{FAMILY_MARKER_CHANNEL}:{model}
      </span>
    </div>
  )
}

// ===== 主组件 =====

export function NanjuModelSettings(): React.ReactElement {
  const api = React.useMemo(getNanjuModelApi, [])
  const [state, setState] = React.useState<NanjuModelSettingsStateLike | null>(null)
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [busy, setBusy] = React.useState<'test' | 'recommend' | 'repair' | null>(null)
  const [note, setNote] = React.useState<string | null>(null)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [testResults, setTestResults] = React.useState<Map<string, NanjuTestResult>>(new Map())
  const [shadowed, setShadowed] = React.useState<NanjuShadowedEntry[]>([])
  const [recommendPreview, setRecommendPreview] = React.useState<NanjuRecommendResult | null>(null)
  const [resetConfirmOpen, setResetConfirmOpen] = React.useState(false)

  const load = React.useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      const next = await api.nanjuModelGetState()
      const err = ipcErrorOf(next)
      if (err !== null) {
        setLoadError(`主进程返回错误：${err}`)
        return
      }
      setState(next as NanjuModelSettingsStateLike)
      setDraft(draftFromState(next as NanjuModelSettingsStateLike))
      setLoadError(null)
    } catch (error) {
      console.error('[南大向导·模型配置] 加载失败:', error)
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [api])

  React.useEffect(() => {
    if (api) void load()
  }, [api, load])

  const patch = React.useMemo(
    () => (state && draft ? computeSavePatch(state, draft) : {}),
    [state, draft],
  )
  const dirty = React.useMemo(() => hasPatchFields(patch), [patch])

  // 同步模块级 dirty 标志（SettingsPanel 离开拦截读取；不新增 atom）
  React.useEffect(() => {
    nanjuModelFormDirty.dirty = dirty
    return () => {
      nanjuModelFormDirty.dirty = false
    }
  }, [dirty])

  const healthByRow = React.useMemo(
    () => (state ? buildHealthByRow(state) : new Map<string, NanjuModelSettingsStateLike['health'][number]>()),
    [state],
  )
  const shadowedByRow = React.useMemo(() => buildShadowedByRow(shadowed), [shadowed])

  /** 行级状态与提示汇总（状态灯优先级：家族标记/空 > shadowed > 未保存 > health > 多样性） */
  const resolveRow = React.useCallback(
    (
      rowKey: string,
      value: EndpointDraft,
      baseline: EndpointDraft | null,
      phaseLabelForWarning: string,
    ): {
      level: StatusLevel
      dotLabel: string
      hints: Array<{ tone: 'info' | 'warn' | 'error' | 'shadow'; text: string; title?: string }>
    } => {
      const hints: Array<{ tone: 'info' | 'warn' | 'error' | 'shadow'; text: string; title?: string }> = []

      if (!value.channel || !value.model) {
        return { level: 'neutral', dotLabel: baseline ? '已清空' : '未配置', hints }
      }
      if (value.channel === FAMILY_MARKER_CHANNEL) {
        return { level: 'neutral', dotLabel: '家族标记（运行时解析）', hints }
      }

      const shadowPath = shadowedByRow.get(rowKey)
        ?? (rowKey.startsWith('proxy:') ? shadowedByRow.get('proxy:*') : undefined)
      if (shadowPath) {
        hints.push({ tone: 'shadow', text: `该字段由 ${shadowPath} 覆盖，设置界面修改不生效` })
        return { level: 'shadowed', dotLabel: '被覆盖', hints }
      }

      const edited = baseline !== null && (baseline.channel !== value.channel || baseline.model !== value.model)
      if (edited) {
        hints.push({ tone: 'info', text: '已编辑，保存后刷新状态' })
        return { level: 'neutral', dotLabel: '未保存', hints }
      }

      const health = healthByRow.get(rowKey)
      if (health) {
        if (health.status === 'model-missing') {
          hints.push({ tone: 'error', text: '模型不存在于该渠道（可能已改名/下线）' })
          return { level: 'red', dotLabel: '失效', hints }
        }
        if (health.status === 'channel-missing') {
          hints.push({ tone: 'error', text: '渠道不存在' })
          return { level: 'red', dotLabel: '失效', hints }
        }
        if (health.status === 'model-disabled') {
          hints.push({ tone: 'warn', text: '模型已在渠道中禁用' })
        }
      }

      const test = testResults.get(`${value.channel}:${value.model}`)
      if (test) {
        hints.push(
          test.ok
            ? { tone: 'info', text: `测试通过${test.latencyMs != null ? ` ${test.latencyMs}ms` : ''}` }
            : { tone: 'error', text: `测试失败${test.message ? `：${truncate(test.message, 60)}` : ''}`, title: test.message },
        )
      }

      let level: StatusLevel = health
        ? health.status === 'ok'
          ? 'ok'
          : health.status === 'model-disabled'
            ? 'yellow'
            : 'red'
        : 'neutral'

      // 多样性提示按端点/渠道/模型名/阶段名关联到行（kind+detail 截断展示）
      for (const w of state?.diversityWarnings ?? []) {
        const endpoint = `${value.channel}:${value.model}`
        if (
          w.detail.includes(endpoint) ||
          w.detail.includes(value.channel) ||
          w.detail.includes(value.model) ||
          w.detail.includes(phaseLabelForWarning)
        ) {
          const full = `${w.kind}: ${w.detail}`
          hints.push({ tone: 'warn', text: truncate(full), title: full })
          if (level === 'ok' || level === 'neutral') level = 'yellow'
        }
      }

      return { level, dotLabel: STATUS_LABEL[level], hints }
    },
    [healthByRow, shadowedByRow, state, testResults],
  )

  /** 统一提交：apply patch → 刷新状态/草稿 → 记录 shadowed */
  const applyPatch = React.useCallback(
    async (nextPatch: NanjuModelSavePatchLike): Promise<boolean> => {
      if (!api) return false
      setSaving(true)
      setSaveError(null)
      try {
        const res = await api.nanjuModelSave(nextPatch)
        const saveErr = ipcErrorOf(res)
        if (saveErr !== null) {
          setSaveError(`保存失败：${saveErr}`)
          return false
        }
        const ok = res as { state: NanjuModelSettingsStateLike; shadowed: NanjuShadowedEntry[] }
        setState(ok.state)
        setDraft(draftFromState(ok.state))
        setShadowed(ok.shadowed ?? [])
        setTestResults(new Map())
        setRecommendPreview(null)
        return true
      } catch (error) {
        console.error('[南大向导·模型配置] 保存失败:', error)
        setSaveError(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setSaving(false)
      }
    },
    [api],
  )

  const handleSave = async (): Promise<void> => {
    if (!dirty || !api) return
    await applyPatch(patch)
  }

  const handleTestAll = async (): Promise<void> => {
    if (!api || !draft) return
    const eps = collectTestEndpoints(draft)
    if (eps.length === 0) {
      setNote('没有可测试的端点（空槽与家族标记已跳过）')
      return
    }
    setBusy('test')
    setNote(null)
    try {
      const resultsRaw = await api.nanjuModelTestEndpoints(eps)
      const testErr = ipcErrorOf(resultsRaw)
      if (testErr !== null) {
        setNote(`测试请求失败：${testErr}`)
        return
      }
      const results = resultsRaw as NanjuTestResult[]
      const map = new Map<string, NanjuTestResult>()
      for (const r of results) map.set(`${r.channelId}:${r.modelId}`, r)
      setTestResults(map)
      const failed = results.filter((r) => !r.ok).length
      setNote(
        failed > 0
          ? `测试完成：${results.length - failed}/${results.length} 通过，${failed} 个失败`
          : `测试完成：全部 ${results.length} 个端点通过`,
      )
    } catch (error) {
      console.error('[南大向导·模型配置] 测试失败:', error)
      setNote(`测试请求失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const handleRecommend = async (): Promise<void> => {
    if (!api) return
    setBusy('recommend')
    setNote(null)
    try {
      const recRaw = await api.nanjuModelRecommend()
      const recErr = ipcErrorOf(recRaw)
      if (recErr !== null) {
        setNote(`智能配置请求失败：${recErr}`)
        return
      }
      setRecommendPreview(recRaw as NanjuRecommendResult)
    } catch (error) {
      console.error('[南大向导·模型配置] 智能配置失败:', error)
      setNote(`智能配置请求失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const applyChanges = async (changes: NanjuRecommendResult['changes']): Promise<void> => {
    if (!state) return
    const nextPatch = changesToPatch(changes, state)
    if (!hasPatchFields(nextPatch)) {
      setNote('推荐结果没有可应用的字段变更')
      setRecommendPreview(null)
      return
    }
    const ok = await applyPatch(nextPatch)
    if (ok) setNote(`已应用 ${changes.length} 项推荐变更并保存`)
  }

  const handleRepair = async (): Promise<void> => {
    if (!api || !state) return
    setBusy('repair')
    setNote(null)
    try {
      const recRaw = await api.nanjuModelRecommend()
      const recErr = ipcErrorOf(recRaw)
      if (recErr !== null) {
        setNote(`一键修复请求失败：${recErr}`)
        return
      }
      const rec = recRaw as NanjuRecommendResult
      if (!rec.applyable) {
        setNote('当前渠道无法满足家族多样性硬约束，暂无法自动修复（详见「智能配置」预览）')
        setRecommendPreview(rec)
        return
      }
      const selected = rec.changes.filter((c) => changeHitsUnhealthySlot(c, state))
      if (selected.length === 0) {
        setNote('没有检测到需要修复的失效端点')
        return
      }
      await applyChanges(selected)
    } catch (error) {
      console.error('[南大向导·模型配置] 一键修复失败:', error)
      setNote(`一键修复请求失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const handleReset = async (): Promise<void> => {
    if (!api) return
    setResetConfirmOpen(false)
    setSaving(true)
    try {
      const nextRaw = await api.nanjuModelReset()
      const resetErr = ipcErrorOf(nextRaw)
      if (resetErr !== null) {
        setSaveError(`恢复默认失败：${resetErr}`)
        return
      }
      const next = nextRaw as NanjuModelSettingsStateLike
      setState(next)
      setDraft(draftFromState(next))
      setShadowed([])
      setTestResults(new Map())
      setRecommendPreview(null)
      setNote('已恢复默认：设置界面覆盖文件已删除，生效配置回到内置默认')
    } catch (error) {
      console.error('[南大向导·模型配置] 恢复默认失败:', error)
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  // ===== 渲染：空态 / 加载 / 错误 =====

  if (!api) {
    return (
      <SettingsSection title="南大向导·模型配置" description="六阶段模型矩阵、AC 攻防与代理候选的集中配置入口。">
        <SettingsCard divided={false}>
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Info className="size-5 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">
              需要新版本主进程支持：当前主进程未提供南大向导模型配置接口，请更新应用后再使用。
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    )
  }

  if (loadError && !state) {
    return (
      <SettingsSection title="南大向导·模型配置">
        <SettingsCard divided={false}>
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <AlertTriangle className="size-5 text-red-500" />
            <div className="text-sm text-muted-foreground">配置加载失败：{truncate(loadError, 120)}</div>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              <RotateCcw size={14} />
              <span>重试</span>
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>
    )
  }

  if (!state || !draft) {
    return (
      <SettingsSection title="南大向导·模型配置">
        <SettingsCard divided={false}>
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">加载中…</div>
        </SettingsCard>
      </SettingsSection>
    )
  }

  const channels = state.channels
  const recApplyable = recommendPreview === null || recommendPreview.applyable

  const renderHints = (
    hints: Array<{ tone: 'info' | 'warn' | 'error' | 'shadow'; text: string; title?: string }>,
  ): React.ReactNode =>
    hints.length > 0 ? (
      <div className="space-y-0.5 pl-10">
        {hints.map((h, i) => (
          <InlineHint key={i} tone={h.tone}>
            <span className="truncate" title={h.title ?? h.text}>{h.text}</span>
          </InlineHint>
        ))}
      </div>
    ) : null

  return (
    <div className="space-y-8">
      {/* 顶部：操作条 */}
      <SettingsSection
        title="南大向导·模型配置"
        description="六阶段主选+备选、AC 攻防与代理候选矩阵。保存后立即生效，无需重启。"
        action={
          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">有未保存的更改</span>}
            <Button size="sm" disabled={!dirty || saving} onClick={() => void handleSave()}>
              保存并生效
            </Button>
          </div>
        }
      >
        <SettingsCard divided={false} className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null || saving} onClick={() => void handleRecommend()}>
              <Wand2 size={14} />
              <span>{busy === 'recommend' ? '生成中…' : '智能配置'}</span>
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null || saving} onClick={() => void handleTestAll()}>
              <Activity size={14} />
              <span>{busy === 'test' ? '测试中…' : '测试全部'}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || saving || !recApplyable}
              title={recApplyable ? '只修复失效（红/黄）端点' : '当前渠道无法满足多样性硬约束，不可自动修复'}
              onClick={() => void handleRepair()}
            >
              <Zap size={14} />
              <span>{busy === 'repair' ? '修复中…' : '一键应用推荐修复'}</span>
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setResetConfirmOpen(true)}>
              <RotateCcw size={14} />
              <span>恢复默认（整体）</span>
            </Button>
          </div>
          {note && <div className="mt-2 text-xs text-muted-foreground">{note}</div>}
          {saveError && <div className="mt-2 text-xs text-red-600 dark:text-red-400">保存失败：{truncate(saveError, 120)}</div>}
        </SettingsCard>

        {/* 层 1 手改覆盖横幅 */}
        {state.handLayerPresent && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 flex-shrink-0" />
            <span>检测到手改覆盖文件（层1），优先级高于设置界面——被遮蔽字段修改不生效。</span>
          </div>
        )}
        {shadowed.length > 0 && (
          <div className="mt-3 space-y-1 rounded-lg border border-slate-500/40 bg-slate-500/10 px-3 py-2 text-xs text-slate-600 dark:text-slate-300">
            <div className="flex items-center gap-1.5 font-medium">
              <Info className="size-3.5 flex-shrink-0" />
              <span>{shadowed.length} 个字段被更高层覆盖，本次修改未生效：</span>
            </div>
            {shadowed.map((s) => (
              <div key={s.field} className="truncate pl-5" title={`${s.field} → ${s.path}`}>
                {s.field}（由 {s.path} 覆盖）
              </div>
            ))}
          </div>
        )}
        {/* 多样性提示全局汇总（行级关联为子串匹配，未命中行的警告在此兜底展示） */}
        {state.diversityWarnings.length > 0 && (
          <div className="mt-3 space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-3.5 flex-shrink-0" />
              <span>家族多样性提示（{state.diversityWarnings.length}）：</span>
            </div>
            {state.diversityWarnings.map((w, i) => (
              <div key={i} className="truncate pl-5" title={`${w.kind}: ${w.detail}`}>
                {truncate(`${w.kind}: ${w.detail}`)}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {/* 组一：阶段模型 */}
      <SettingsSection
        title="阶段模型"
        description="六个阶段的主选与备选链（备选 ≤3，空槽不保存）。备选链只影响请求级降级顺序。"
      >
        <SettingsCard>
          {PHASE_IDS.map((id) => {
            const d = draft.phases[id]
            const baseline = state.effective.phases[id]
            const main = resolveRow(
              `p:${id}`,
              d.main,
              { channel: baseline?.channel ?? '', model: baseline?.model ?? '' },
              PHASE_LABELS[id],
            )
            const updatePhase = (updater: (phase: PhaseDraft) => PhaseDraft): void => {
              setDraft((prev) => (prev ? { ...prev, phases: { ...prev.phases, [id]: updater(prev.phases[id]) } } : prev))
            }
            return (
              <div key={id} className="space-y-1.5 px-4 py-3">
                <div className="flex items-center gap-3">
                  <StatusDot level={main.level} label={main.dotLabel} />
                  <div className="w-24 flex-shrink-0">
                    <span className="text-sm font-medium">{PHASE_LABELS[id]}</span>
                    <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]">作者</Badge>
                  </div>
                  {d.main.channel === FAMILY_MARKER_CHANNEL ? (
                    <FamilyMarkerView model={d.main.model} />
                  ) : (
                    <EndpointSelects
                      value={d.main}
                      channels={channels}
                      onChange={(next) => updatePhase((p) => ({ ...p, main: next }))}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 flex-shrink-0 px-2 text-xs text-muted-foreground"
                    disabled={saving}
                    title="从设置界面覆盖中删除该阶段主选，回到内置/手改值"
                    onClick={() =>
                      void applyPatch({ phases: { [id]: { channel: null, model: null } } })
                    }
                  >
                    恢复内置值
                  </Button>
                </div>

                {d.fallbacks.map((fb, i) => {
                  const rowKey = `p:${id}:f:${i}`
                  const fbBaseline = baseline?.fallbacks?.[i] ? parseEndpointString(baseline.fallbacks[i]) : null
                  const resolved = resolveRow(rowKey, fb, fbBaseline ?? { channel: '', model: '' }, PHASE_LABELS[id])
                  return (
                    <div key={rowKey} className="flex items-center gap-3 pl-10">
                      <StatusDot level={resolved.level} label={resolved.dotLabel} />
                      <span className="w-16 flex-shrink-0 text-xs text-muted-foreground">备选 {i + 1}</span>
                      {fb.channel === FAMILY_MARKER_CHANNEL ? (
                        <FamilyMarkerView model={fb.model} />
                      ) : (
                        <EndpointSelects
                          value={fb}
                          channels={channels}
                          onChange={(next) =>
                            updatePhase((p) => ({
                              ...p,
                              fallbacks: p.fallbacks.map((f, idx) => (idx === i ? next : f)),
                            }))
                          }
                        />
                      )}
                      <button
                        type="button"
                        className="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        title="删除该备选"
                        disabled={saving}
                        onClick={() =>
                          updatePhase((p) => ({ ...p, fallbacks: p.fallbacks.filter((_, idx) => idx !== i) }))
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  )
                })}
                {d.fallbacks.length < FALLBACK_MAX && (
                  <button
                    type="button"
                    className="ml-10 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    disabled={saving}
                    onClick={() => updatePhase((p) => ({ ...p, fallbacks: [...p.fallbacks, { channel: '', model: '' }] }))}
                  >
                    <Plus className="size-3.5" />
                    <span>备选</span>
                  </button>
                )}

                {renderHints(main.hints)}
              </div>
            )
          })}
        </SettingsCard>
      </SettingsSection>

      {/* 组二：AC 攻防 */}
      <SettingsSection
        title="AC 攻防"
        description="两档预设（轻量/标准）+ 指定阶段的角色覆盖。防守方须与作者异族，攻击方须与防守方异族。"
      >
        <SettingsCard>
          {AC_TIERS.map((tier) =>
            (['attacker', 'defender'] as const).map((role) => {
              const rowKey = `ac:${tier}:${role}`
              const value = draft.presets[tier][role]
              const baselinePair = state.effective.acPresets?.[tier]?.[role]
              const resolved = resolveRow(
                rowKey,
                value,
                { channel: baselinePair?.channel ?? '', model: baselinePair?.model ?? '' },
                `${AC_TIER_LABELS[tier]}${role === 'attacker' ? '攻击' : '防守'}`,
              )
              return (
                <div key={rowKey} className="space-y-1.5 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <StatusDot level={resolved.level} label={resolved.dotLabel} />
                    <div className="w-24 flex-shrink-0">
                      <span className="text-sm font-medium">{AC_TIER_LABELS[tier]}</span>
                      <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px]">
                        {role === 'attacker' ? '攻击方' : '防守方'}
                      </Badge>
                    </div>
                    {value.channel === FAMILY_MARKER_CHANNEL ? (
                      <FamilyMarkerView model={value.model} />
                    ) : (
                      <EndpointSelects
                        value={value}
                        channels={channels}
                        onChange={(next) =>
                          setDraft((prev) =>
                            prev
                              ? { ...prev, presets: { ...prev.presets, [tier]: { ...prev.presets[tier], [role]: next } } }
                              : prev,
                          )
                        }
                      />
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 flex-shrink-0 px-2 text-xs text-muted-foreground"
                      disabled={saving}
                      title="从设置界面覆盖中删除该预设角色，回到内置/手改值"
                      onClick={() =>
                        void applyPatch({ acPresets: { [tier]: { [role]: null } } })
                      }
                    >
                      恢复内置值
                    </Button>
                  </div>
                  {renderHints(resolved.hints)}
                </div>
              )
            }),
          )}

          {PHASE_AC_ROWS.map(({ phase, role }) => {
            const rowKey = `p:${phase}:ac:${role}`
            const value = draft.phases[phase][role]
            const baselinePair = state.effective.phases[phase]?.[role]
            const roleLabel = role === 'acAttacker' ? '攻击方' : '防守方'
            const resolved = value
              ? resolveRow(
                  rowKey,
                  value,
                  baselinePair ? { channel: baselinePair.channel, model: baselinePair.model } : null,
                  `${PHASE_LABELS[phase]}${roleLabel}`,
                )
              : null
            return (
              <div key={rowKey} className="space-y-1.5 px-4 py-3">
                <div className="flex items-center gap-3">
                  <StatusDot level={resolved?.level ?? 'neutral'} label={resolved?.dotLabel ?? '未配置'} />
                  <div className="w-24 flex-shrink-0">
                    <span className="text-sm font-medium">{PHASE_LABELS[phase]}</span>
                    <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px]">{roleLabel}</Badge>
                  </div>
                  {value && value.channel === FAMILY_MARKER_CHANNEL ? (
                    <FamilyMarkerView model={value.model} />
                  ) : (
                    <EndpointSelects
                      value={value ?? { channel: '', model: '' }}
                      channels={channels}
                      onChange={(next) =>
                        setDraft((prev) =>
                          prev
                            ? {
                                ...prev,
                                phases: {
                                  ...prev.phases,
                                  [phase]: {
                                    ...prev.phases[phase],
                                    [role]: next.channel && next.model ? next : null,
                                  },
                                },
                              }
                            : prev,
                        )
                      }
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 flex-shrink-0 px-2 text-xs text-muted-foreground"
                    disabled={saving || !baselinePair}
                    title={baselinePair ? '从设置界面覆盖中删除该阶段角色覆盖' : '当前生效配置没有该覆盖'}
                    onClick={() =>
                      void applyPatch({ phases: { [phase]: { [role]: null } } })
                    }
                  >
                    恢复内置值
                  </Button>
                </div>
                {!value && (
                  <InlineHint tone="info">
                    <span className="pl-10">未配置阶段覆盖，沿用 AC 预设。</span>
                  </InlineHint>
                )}
                {resolved && renderHints(resolved.hints)}
              </div>
            )
          })}
        </SettingsCard>
      </SettingsSection>

      {/* 组三：代理候选 */}
      <SettingsSection
        title="代理候选"
        description="代理解析的有序偏好列表（≤6），按序校验取第一个可用项。"
      >
        <SettingsCard>
          {draft.proxy.map((p, i) => {
            const rowKey = `proxy:${i}`
            const baselineCand = state.effective.proxyCandidates?.[i]
            const resolved = resolveRow(
              rowKey,
              p,
              baselineCand ? { channel: baselineCand.channelId, model: baselineCand.modelId } : null,
              `代理候选${i + 1}`,
            )
            return (
              <div key={rowKey} className="space-y-1.5 px-4 py-3">
                <div className="flex items-center gap-3">
                  <StatusDot level={resolved.level} label={resolved.dotLabel} />
                  <span className="w-16 flex-shrink-0 text-sm font-medium">候选 {i + 1}</span>
                  {p.channel === FAMILY_MARKER_CHANNEL ? (
                    <FamilyMarkerView model={p.model} />
                  ) : (
                    <EndpointSelects
                      value={p}
                      channels={channels}
                      onChange={(next) =>
                        setDraft((prev) =>
                          prev ? { ...prev, proxy: prev.proxy.map((x, idx) => (idx === i ? next : x)) } : prev,
                        )
                      }
                    />
                  )}
                  <button
                    type="button"
                    className="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title="删除该候选"
                    disabled={saving}
                    onClick={() => setDraft((prev) => (prev ? { ...prev, proxy: prev.proxy.filter((_, idx) => idx !== i) } : prev))}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                {renderHints(resolved.hints)}
              </div>
            )
          })}
          {draft.proxy.length < PROXY_MAX && (
            <div className="px-4 py-3">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                disabled={saving}
                onClick={() => setDraft((prev) => (prev ? { ...prev, proxy: [...prev.proxy, { channel: '', model: '' }] } : prev))}
              >
                <Plus className="size-3.5" />
                <span>添加候选</span>
              </button>
            </div>
          )}
          <div className="px-4 py-2 text-xs text-muted-foreground">提示：候选应覆盖 ≥2 家族，避免单点失效。</div>
        </SettingsCard>
      </SettingsSection>

      {/* 来源展示 */}
      <SettingsSection
        title="配置来源"
        description="优先级：手改覆盖（层1） > 设置界面（层1.5） > 内置默认（层2） > 代码兜底（层3）。"
      >
        <SettingsCard divided={false}>
          <div className="space-y-1.5 px-4 py-3 text-xs text-muted-foreground">
            <div>手改覆盖（层1）：{state.sources.user ?? '—（未使用）'}</div>
            <div>设置界面覆盖（层1.5）：{state.sources.override ?? '—（未使用，保存后将创建）'}</div>
            <div>内置默认（层2）：{state.sources.builtin ?? '—'}</div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 智能配置 diff 预览 */}
      <Dialog open={recommendPreview !== null} onOpenChange={(open) => { if (!open) setRecommendPreview(null) }}>
        <DialogContent className="max-w-lg" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>智能配置预览</DialogTitle>
          </DialogHeader>
          <div className="max-h-[420px] space-y-3 overflow-y-auto scrollbar-thin">
            {recommendPreview === null ? null : recommendPreview.applyable ? (
              <>
                <div className="text-sm text-muted-foreground">
                  将应用 {recommendPreview.changes.length} 项变更{recommendPreview.changes.length === 0 ? '（当前矩阵已是最优，无需变更）' : '：'}
                </div>
                {recommendPreview.changes.map((c) => (
                  <div key={c.slot} className="rounded-md border border-border/60 px-3 py-2 text-xs">
                    <div className="font-medium text-foreground">{slotDisplayName(c.slot)}</div>
                    <div className="mt-1 text-muted-foreground">
                      <span className="text-red-600 dark:text-red-400 line-through">{c.from || '（空）'}</span>
                      <span className="mx-1.5">→</span>
                      <span className="text-emerald-600 dark:text-emerald-400">{c.to}</span>
                    </div>
                    <div className="mt-1 text-muted-foreground/80">{c.reason}</div>
                  </div>
                ))}
                {recommendPreview.notes.length > 0 && (
                  <div className="space-y-1 text-xs text-muted-foreground">
                    {recommendPreview.notes.map((n, i) => (
                      <div key={i}>· {n}</div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  <AlertTriangle className="mt-0.5 size-3.5 flex-shrink-0" />
                  <span>当前渠道现状无法满足家族多样性硬约束，无法生成可应用的完整矩阵。</span>
                </div>
                {(recommendPreview.diversityViolations ?? []).map((v, i) => (
                  <div key={i} className="rounded-md border border-border/60 px-3 py-2 text-xs">
                    <div className="font-medium text-foreground">{slotDisplayName(v.slot)}</div>
                    <div className="mt-1 text-muted-foreground">{v.violation}</div>
                  </div>
                ))}
                {recommendPreview.notes.length > 0 && (
                  <div className="space-y-1 text-xs text-muted-foreground">
                    {recommendPreview.notes.map((n, i) => (
                      <div key={i}>· {n}</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setRecommendPreview(null)}>取消</Button>
            <Button
              size="sm"
              disabled={recommendPreview === null || !recommendPreview.applyable || recommendPreview.changes.length === 0 || saving}
              onClick={() => {
                if (recommendPreview) void applyChanges(recommendPreview.changes)
              }}
            >
              应用全部
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 恢复默认确认 */}
      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>恢复默认配置？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除设置界面覆盖文件（层1.5）中的全部字段，生效配置回到内置默认。手改覆盖文件（层1）不受影响。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleReset()}>确认恢复默认</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
