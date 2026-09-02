/**
 * 南大向导「跨大环节回归流」（W2c 判定协议 v1，v0.17.69）
 *
 * 三件事：
 * 1. detectRegressionSignal —— 硬规则纯函数（无 IO）：意见文本 vs PRD 内容的 US-xx 编号比对。
 * 2. recordRegressionEvent —— 回归事件唯一写入点（AC plan-audit A11 防越权对称）：
 *    a. _project-info.json 的 regressionEvents（同 from→to 5 分钟窗口内去重合并 count++）；
 *    b. 审计日志 _regression-audit.jsonl 逐条追加（L1 语义判定必附 judgment 理由，可回放）；
 *    c. 埋点 regression.detected + emitGuideProgress 广播（载荷带 regressions 投影）。
 * 3. getRegressionEvents / projectRegressions —— 读函数与渲染端投影（按边聚合 + active 判定）。
 *
 * 判定协议五变量（AC plan-audit A4 终裁）：
 * - 判定主体 = 主进程（点选批量提交处硬规则；意见收集轮的 L1 语义标记由 agent-orchestrator
 *   检测后仍走本文件写入——L1 只标建议，写入走唯一写入点）；
 * - 硬规则优先于语义；语义判定（NANJU_REGRESSION 标记）必须带 judgment 落审计日志；
 * - 边界 default 非回归（低敏感度，宁漏判不过度触发）；
 * - 去重：同 from→to 5 分钟窗口内合并为 1 条（count++）。
 *
 * 纪律：文件 IO 全部惰性 require（nanju-project / nanju-guide-progress 同型惯例），
 * 保证可被任何测试环境直接 import（顶部仅纯常量/纯函数与类型）。
 */

import type { ProjectStage, RegressionEvent } from './nanju-project'

// ===== 硬规则判定（纯函数，无 IO） =====

/** 意见文本中 US-xx 编号提取（大小写不敏感；US-01 / us-1 / US-12 均识别） */
const US_ID_RE = /us-(\d+)/gi

/** 需求撤回关键词（命中则该条意见跳过新需求判定——撤回不是新需求） */
const WITHDRAW_KEYWORDS = ['删掉', '不要', '取消']

/** US 编号数值规范化键（US-01 与 US-1 视为同一条，PRD 编号位数不稳定时的容错） */
function usKey(numStr: string): string {
  return String(Number.parseInt(numStr, 10))
}

/** 从文本提取 US 编号规范化键集合 */
function extractUsKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const m of text.matchAll(US_ID_RE)) {
    const n = Number.parseInt(m[1] ?? '', 10)
    if (Number.isFinite(n)) keys.add(String(n))
  }
  return keys
}

/** 硬规则信号（regress=true 时 rule 说明触发规则；matched 为首个命中编号） */
export interface RegressionSignal {
  regress: boolean
  rule: string
  /** 触发新需求判定的 US 编号原文（如 US-05） */
  matched?: string
}

/**
 * 回归硬规则判定（判定协议 v1 第 2 条，纯函数）：
 *
 * 逐条意见判定，任一条命中即返回 regress（返回首个命中）：
 * 1. 意见含「删掉/不要/取消」→ 需求撤回，跳过该条的新编号判定（null 语义）；
 * 2. 意见引入 US-xx 编号且 PRD 无对应条目 → 新需求回归（rule='new-us-id'）；
 * 3. 意见只指向 PRD 已有 US-xx → 修改非新需求，不触发；
 * 4. 无编号 → 硬规则不覆盖（由 L1 语义判定通道 NANJU_REGRESSION 标记承接）。
 *
 * 边界 default 非回归：prdContent 为空时所有编号都算「新增」——但调用方负责只在
 * PRD 存在的场景下调用（PRD 都不存在则项目异常，回归语义不成立）。
 */
export function detectRegressionSignal(
  opinions: string[],
  prdContent: string,
): RegressionSignal | null {
  const prdKeys = extractUsKeys(prdContent)
  for (const opinion of opinions) {
    if (!opinion) continue
    // 规则 3（撤回优先于新编号：「删掉 US-05」不是新增 US-05）
    if (WITHDRAW_KEYWORDS.some((kw) => opinion.includes(kw))) continue
    // 规则 1/2：编号比对
    const matches = [...opinion.matchAll(US_ID_RE)]
    for (const m of matches) {
      const raw = m[0] ?? ''
      const key = usKey(m[1] ?? '')
      if (key && !prdKeys.has(key)) {
        return { regress: true, rule: 'new-us-id', matched: raw }
      }
    }
  }
  return null
}

// ===== 回归事件唯一写入点 =====

/** 同边去重窗口（毫秒）：判定协议 v1 第 5 条——同 from→to 5 分钟内合并为 1 条 */
export const REGRESSION_DEDUP_WINDOW_MS = 5 * 60 * 1000

/** recordRegressionEvent 附加载荷（审计与广播用） */
export interface RecordRegressionOptions {
  /** 触发意见原文（审计日志回放用；L1 语义判定/点选批量提交时传入） */
  opinion?: string
  /** L1 语义判定理由（NANJU_REGRESSION 标记通道必传——A11：语义判定必附 judgment） */
  judgment?: string
  /** 关联会话（用于 emitGuideProgress 广播；缺省则跳过广播，只落盘+埋点） */
  sessionId?: string
}

/** 审计日志行（_regression-audit.jsonl，JSONL 追加；judgment 仅语义判定带） */
interface RegressionAuditLine {
  at: string
  from: string
  to: string
  reason: string
  opinion?: string
  judgment?: string
}

/**
 * 记录一次跨大环节回归（唯一写入点——所有触发路径都必须经此函数，不得直写
 * _project-info.json 的 regressionEvents 字段）：
 *
 * 1. 状态文件：从尾向前找最后一条同 from→to 事件（M6：不再只比数组末条——末条是
 *    其他边时同边新触发会被误开新条，与「同 from→to 5 分钟窗口」语义不符），
 *    距其首次触发 <5 分钟 → 合并（count++，不追加；at 保留首次触发时间）；
 * 2. 审计日志：项目目录 _regression-audit.jsonl 逐条追加（审计要可回放，不做合并）；
 * 3. 埋点 regression.detected + emitGuideProgress（opts.sessionId 存在时）广播
 *    regressions 投影（渲染端画回归边）。
 *
 * 返回写入后的事件（合并时返回合并态），失败不抛（回归记录是观测面，不阻断主流程）。
 */
export function recordRegressionEvent(
  workspaceSlug: string,
  projectId: string,
  from: ProjectStage,
  to: ProjectStage,
  reason: string,
  opts?: RecordRegressionOptions,
): RegressionEvent | null {
  try {
    const { readProjectInfo, writeProjectInfo, getNanjuProjectDir } =
      require('./nanju-project') as typeof import('./nanju-project')
    const { appendFileSync, existsSync, mkdirSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')

    const now = new Date().toISOString()
    const info = readProjectInfo(workspaceSlug, projectId)
    const base = info ?? {
      projectId,
      name: projectId,
      mode: 'quick' as const,
      createdAt: now,
      workspaceSlug,
      projectDir: `project-${projectId}`,
      docDirs: [],
    }
    const events = [...(base.regressionEvents ?? [])]

    // 5 分钟窗口去重（M6）：从尾向前扫描找最后一条同 from→to 事件（只比数组末条会
    // 在末条是其他边时误开新条）；窗口内 → count++（at 保留首次触发时间）
    let lastIdx = -1
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev && ev.from === from && ev.to === to) { lastIdx = i; break }
    }
    const last = lastIdx >= 0 ? events[lastIdx] : null
    let event: RegressionEvent
    if (
      last
      && Number.isFinite(Date.parse(last.at))
      && (Date.now() - Date.parse(last.at)) < REGRESSION_DEDUP_WINDOW_MS
    ) {
      event = { ...last, count: last.count + 1 }
      events[lastIdx] = event
    } else {
      event = { from, to, at: now, reason, count: 1 }
      events.push(event)
    }

    base.regressionEvents = events
    writeProjectInfo(workspaceSlug, projectId, base)

    // 审计日志（逐条追加，不合并——AC 可回放；A11：L1 语义判定必附 judgment）
    const auditLine: RegressionAuditLine = { at: now, from, to, reason }
    if (opts?.opinion !== undefined) auditLine.opinion = opts.opinion
    if (opts?.judgment !== undefined) auditLine.judgment = opts.judgment
    const projectDir = getNanjuProjectDir(workspaceSlug, projectId)
    if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })
    appendFileSync(join(projectDir, '_regression-audit.jsonl'), JSON.stringify(auditLine) + '\n', 'utf-8')

    // 埋点（失败不影响事件写入）
    try {
      const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
      recordTelemetry(workspaceSlug, 'regression.detected', {
        project_id: projectId, from, to, reason, count: event.count,
      }, projectId)
    } catch { /* 埋点失败不影响回归记录 */ }

    // 进度广播（write-then-emit：状态已落盘；sessionId 缺省时跳过）
    if (opts?.sessionId) {
      try {
        const { emitGuideProgress } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
        const { listNanjuProjects } = require('./nanju-project') as typeof import('./nanju-project')
        const project = listNanjuProjects(workspaceSlug).find((p) => p.projectId === projectId)
        if (project) {
          emitGuideProgress(opts.sessionId, projectId, project.currentStage, base.subStage ?? '', {
            regressions: projectRegressions(events, project.currentStage),
          })
        }
      } catch { /* 广播失败不影响回归记录（渲染端 10s 轮询快照兑底） */ }
    }

    return event
  } catch (e) {
    console.warn('[南大回归] 事件写入失败（不阻断主流程）:', e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * GWT 失败分流回归记录（A2 触发点 3，v0.17.63 失败分流的观测补全）：
 * behavior → 回炉 coding（TEST_GWT -.-> CODE）；mapping → 回 testing 重写映射（TEST_GWT -.-> TEST）。
 * agent-orchestrator 的两个分流分支各调一次。
 */
export function recordGwtFailureRegression(
  workspaceSlug: string,
  projectId: string,
  kind: 'behavior' | 'mapping',
  opts?: RecordRegressionOptions,
): void {
  const to = kind === 'behavior' ? 'coding' : 'testing'
  const reason = kind === 'behavior'
    ? 'GWT 行为类失败（断言不满足）：回炉 coding 修复缺陷'
    : 'GWT 映射类失败（selector 等待超时/未映射）：回 testing 重写 steps.json 映射'
  recordRegressionEvent(workspaceSlug, projectId, 'testing', to, reason, opts)
}

// ===== 读函数与渲染端投影 =====

/** 读取回归事件（原始数组，按写入顺序；无文件/无字段返回空数组） */
export function getRegressionEvents(
  workspaceSlug: string,
  projectId: string,
): RegressionEvent[] {
  const { readProjectInfo } = require('./nanju-project') as typeof import('./nanju-project')
  return readProjectInfo(workspaceSlug, projectId)?.regressionEvents ?? []
}

/** 渲染端回归边投影（guide-dsl regressions 入参同构） */
export interface RegressionEdge {
  from: string
  to: string
  count: number
  /** 回归进行中（active = 项目当前处于 to 阶段：回改/回炉尚未收口）；收敛后 false = 浅色留痕 */
  active: boolean
}

/**
 * 事件 → 边投影（纯函数）：按 from→to 聚合（count 累加，reason 取最新），
 * active = currentStage === to（项目正在被回归的目标阶段内）。
 * lastAt 用于「新近回归」的动画判定交由渲染端 active 处理。
 */
export function projectRegressions(
  events: RegressionEvent[],
  currentStage: string,
): RegressionEdge[] {
  const byEdge = new Map<string, RegressionEdge>()
  for (const ev of events) {
    const key = `${ev.from}->${ev.to}`
    const existing = byEdge.get(key)
    if (existing) {
      existing.count += ev.count
      existing.active = currentStage === ev.to || existing.active
    } else {
      byEdge.set(key, {
        from: ev.from,
        to: ev.to,
        count: ev.count,
        active: currentStage === ev.to,
      })
    }
  }
  return Array.from(byEdge.values())
}
