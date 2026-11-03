/**
 * L3-7d（2026-09-18）：Spike 效果度量埋点观察器——spike.created / spike.verdict /
 * spike.timebox_hit 三事件的可观测触发实现（03 §6 定义，PRD §12.7 归档对照承接）。
 *
 * 诚实边界（设计裁决，方案 v1 §四 L3-7）：
 * - spike.created / spike.verdict 的可观测载体 = architecture.md 的 PENDING(SPIKE-NNN)
 *   标记（CP-B 条文：Spike 未决前该决策点标 PENDING，不得写成确定性结论——L1 已注入
 *   架构师任务书）。本模块按「内存 per workspace/project 快照对比」派生事件，不解析
 *   00_SPIKES markdown（中文断句不稳定，消费方为 LLM/人工——与 L3-7c 契约登记同裁决）。
 * - spike.verdict 有两个来源，payload.source 区分：
 *   ① source:'pending-removed'——文档侧 PENDING 标记消失。结论方向（confirmed/refuted/
 *   partial）文档侧不可知，只有契约 spikes[] 登记才知方向，故 payload 以
 *   verdict:'resolved' 诚实登记（「已决」而非「方向」）。
 *   ② source:'contract-registration'——契约 spikes[] 登记变化（verifyPhaseOutput 读
 *   契约成功后观察，契约校验通过才可信为登记），verdict 取登记值。
 * - spike.timebox_hit 无可观测载体：时间盒命中发生在 Spike 子会话内部，文档 PENDING
 *   标记无创建时间戳、契约登记无创建 ts，差值不可算——仅登记枚举（nanju-telemetry.ts），
 *   不接假触发点。真实触发依赖：未来 Spike 子会话自报通道，或 spikes[] 登记扩展
 *   创建时间字段后由登记差值比对（届时不改枚举只补触发点）。
 * - 全部观察不阻断门禁：recordTelemetry 写失败只告警（nanju-telemetry.ts 内部
 *   try-catch）；调用方（verifyPhaseOutput）另以 try/catch 兜底。
 * - 快照为进程内存态（不落盘）：宿主重启后首见即重建基线；同进程内按
 *   workspace/project 隔离，埋点幂等由快照对比保证。
 */
import { recordTelemetry } from './nanju-telemetry'
import type { EngineeringSpikeRecord } from './nanju-engineering-contract'

/**
 * CP-B 标记宽松匹配：PENDING(SPIKE-xxx)，容忍标记与括号间空格、全角括号；
 * slug 取 SPIKE- 起头的字母数字/._/- 串（SPIKE-NNN 与 SPIKE-NNN-短名均收）。
 * 大小写不敏感（PENDING/spike 混写宽容），按首次出现顺序去重。
 */
const PENDING_SPIKE_MARK_RE = /PENDING\s*[（(]\s*(SPIKE-[A-Za-z0-9][A-Za-z0-9._-]*)\s*[)）]/gi

/** 从架构文档提取 PENDING(SPIKE-NNN) 标记（按出现顺序去重；空串/无标记返回 []）。
 * 审计 AC-5：过滤精确占位符 slug「SPIKE-NNN」——任务书/guide 注入条文含字面
 * PENDING(SPIKE-NNN)，架构师若原样回抄进架构文档会产生伪 spike.created 事件
 * （指标噪声；门禁零影响）。占位符非真实编号，全等过滤。 */
export function detectSpikePendingMarks(content: string): string[] {
  const seen: string[] = []
  for (const match of content.matchAll(PENDING_SPIKE_MARK_RE)) {
    const slug = match[1]!
    if (slug.toUpperCase() === 'SPIKE-NNN') continue // 任务书注入条文占位符回抄，非真实标记
    if (!seen.includes(slug)) seen.push(slug)
  }
  return seen
}

/** 内存快照（per workspace/project）：文档侧 PENDING 标记集合。 */
const pendingSnapshots = new Map<string, Set<string>>()
/** 内存快照（per workspace/project）：契约侧已埋过 spike.verdict 的 (slug,verdict) 对。 */
const registeredVerdictSnapshots = new Map<string, Set<string>>()

function snapshotKey(workspaceSlug: string, projectId: string): string {
  return workspaceSlug + '/' + projectId
}

/** 测试隔离用：清空内存快照（生产代码不得调用；快照不落盘，重启即天然重置）。 */
export function resetSpikeTelemetryState(): void {
  pendingSnapshots.clear()
  registeredVerdictSnapshots.clear()
}

/**
 * 文档侧观察：与上次快照对比派生事件——
 * - 新增 PENDING → spike.created（首见基线视为空集：架构文档在架构阶段才产出，
 *   门禁首次读到时在册的 PENDING 必为本轮架构期新增，计为 created）；
 * - PENDING 消失 → spike.verdict（verdict:'resolved' + source:'pending-removed'，
 *   方向不可知——见头注诚实边界①）。
 * 同一文档重复观察（无变化）不产生事件。
 */
export function recordSpikeTelemetryFromDoc(workspaceSlug: string, projectId: string, content: string): void {
  const key = snapshotKey(workspaceSlug, projectId)
  const current = new Set(detectSpikePendingMarks(content))
  const previous = pendingSnapshots.get(key) ?? new Set<string>()
  for (const slug of current) {
    if (!previous.has(slug)) {
      recordTelemetry(workspaceSlug, 'spike.created', { slug, source: 'pending-mark' }, projectId)
    }
  }
  for (const slug of previous) {
    if (!current.has(slug)) {
      recordTelemetry(workspaceSlug, 'spike.verdict', { slug, verdict: 'resolved', source: 'pending-removed' }, projectId)
    }
  }
  pendingSnapshots.set(key, current)
}

/**
 * 契约侧观察：spikes[] 登记变化 → spike.verdict（verdict 取登记值，见头注诚实边界②）。
 * 挂在契约校验通过后（verifyPhaseOutput architecture 分支读契约成功处）——契约合法
 * 才可信为登记。首见或 verdict 变化的 (slug,verdict) 埋一次；重复读相同登记不重复埋。
 * decided_by/ts 透传进 payload，供后续效果度量做登记主体与时间分布分析
 * （timebox 差值分析仍不可算——缺创建时间戳，见头注诚实边界③）。
 */
export function recordSpikeTelemetryFromContract(
  workspaceSlug: string,
  projectId: string,
  contract: { spikes?: EngineeringSpikeRecord[] },
): void {
  const key = snapshotKey(workspaceSlug, projectId)
  const seen = registeredVerdictSnapshots.get(key) ?? new Set<string>()
  const rows = Array.isArray(contract.spikes) ? contract.spikes : []
  for (const row of rows) {
    const pair = row.slug + ' :: ' + row.verdict
    if (seen.has(pair)) continue
    seen.add(pair)
    recordTelemetry(workspaceSlug, 'spike.verdict', {
      slug: row.slug,
      verdict: row.verdict,
      source: 'contract-registration',
      ...(row.decided_by !== undefined ? { decided_by: row.decided_by } : {}),
      ...(row.ts !== undefined ? { ts: row.ts } : {}),
    }, projectId)
  }
  registeredVerdictSnapshots.set(key, seen)
}
