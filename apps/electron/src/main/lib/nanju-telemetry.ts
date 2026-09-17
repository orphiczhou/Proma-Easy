/**
 * 南大项目埋点采集层
 *
 * JSONL 追加写入，按月分片。复用 Proma 的 safe-file.ts 原子写。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getWorkspaceFilesDir } from './config-paths'

// ===== 类型 =====

export type TelemetryEventType =
  | 'project.created' | 'dialog.submitted' | 'role.switched'
  | 'prd.confirmed' | 'prototype.confirmed' | 'coding.executed'
  | 'judge.verdict' | 'project.finished' | 'architecture.confirmed'
  // v0.17.64 Sprint C1：熔断与阶段时长护栏埋点
  | 'circuit_break' | 'phase.elapsed'
  // v0.17.69 W2c/W7：回归流 + 架构师环节 + 环境配置
  | 'regression.detected' | 'arch.executed'
  | 'env.check.executed' | 'env.setup.verified' | 'env.setup.failed'
  // W8 流程程序化强制：委派守卫（阶段拒绝 / 误拦观察 / AC 模型覆写）
  | 'delegate.guard.stage-deny' | 'delegate.guard.pass-unmatched' | 'delegate.guard.ac-override'
  // W10 推进闭环强化：unmatched 强动词拒绝 + 确认待推进提示
  | 'delegate.guard.unmatched-action-deny' | 'confirm.advance-hint'
  // W13 模型 fallback 让步链：委派降级可观测（原值→新值→原因）
  | 'model.fallback.used'
  // W17-AC-S1（A3 锚定收集）：未锚定命中丢弃观测——收集正则收紧为注释/行首形态后，
  // 句中引用（正文/代码块复述协议字面串）不再误收集，丢弃事件供一迭代周期观察后定稿
  | 'phase.advance.discarded-unanchored'
  // W18 Wave2 交付双事实门禁：确认登记（ask-answer 精确等值置位）/ 门禁拦截现测（四道校验
  // 归因）/ 自由文本拒绝观测（message 来源命中交付词但不置位）
  | 'delivery.ack-recorded' | 'delivery.gate.blocked' | 'delivery.ack-rejected-freetext'
  // W19 缺陷A（v0.17.87）：未绑定会话直写项目目录拦截（E2E 6039a6af 续接直写事 Replay）
  | 'router.gate.unbound-write-deny'
  // v2.4 自动补完需求（D7 §8）：clarify 代理链路五事件——代理委派/代答完成/转述真人/
  // 类别门拒绝（含入参校验拒）/预算耗尽；payload 摘要 ≤80 字符，附 diversityDegraded
  // 与确认词命中布尔（代答永不构成 I1 授权，命中仅作标记与取证）
  | 'clarify.proxy-delegate' | 'clarify.proxy-answer' | 'clarify.relay-human'
  | 'clarify.guard-deny' | 'clarify.budget-exhausted'
  // v2.4（D7 §8 审查返工 F2-9）：守卫/门禁域（A）四事件 + 渲染程序化重放观测——
  // union 收口后 A 域去除 recordTelemetry 调用点的 `as never`（类型安全收口）。
  // confirm.replay-origin 当前无消费点（Defender #2 可选埋点），预置入表供 A/C 接线。
  | 'advance.gate-deny' | 'confirm.scatter-no-auth' | 'router.gate.ask-deny'
  | 'clarify.suspect-fake-confirm' | 'confirm.replay-origin'
  // v2.4.1（D8 §九 B′/R7-14）：auto 审核三事件——A 域 autoConfirm 推进/门拒（c5244262 已用，
  // 现以 as Parameters 绕类型，本表收口后可去）+ B 域确定性降级出口（R7-01 四条路径）
  | 'confirm.auto-confirm' | 'advance.auto-gate' | 'clarify.auto-degrade'
  // W22（G 域 F5/D8-1）：W11 目标校验拒绝遥测补齐 + 拒收防环转人工/续接放弃归因
  //（payload.kind 区分 loop-limit / continuation-giveup）
  | 'advance.target-deny' | 'advance.reject-escalate'
  // W22（M 域 M#8 预留入表）：开发↔测试跨族断言告警（不阻断，配置层可观测）
  | 'model.diversity-warn'
  // W23（§六.3）：配置级 autofix——委派指令构建前预检失效端点并临时替换（区别于
  // 请求级 model.fallback.used：本事件在构建期触发，不落盘，仅本次指令生效）
  | 'model.config-autofix'
  // W24-EF F2（v0.17.123）：PRD §12.4 事件表补齐——只追加 union 成员；既有发射点不动。
  // #6 user.undo：用户主动撤销（区分系统侧 undo 与用户意图）；#7 click_to_fix：点选纠错单点
  // 上报（按 nanju-quick-events.ts.buildClickToFixPayload 输出，privacy 最小 payload 仅含
  // 元素类型/是否含 id/是否成功/阶段，绝不含原文/坐标）；#8 mode.switched：模式转换（快消→
  // 长期）——独立事件，与 #3 role.switched（向导角色切换）语义不同，不得复用；#10
  // repair.triggered：自动修复触发（按 E2 RepairAttempt[] 派生 payload，含
  // attempts/strategies/outcome，attempt 数始终来自 E2 真实状态，禁止 I 端硬编码伪造）；
  // #12 satisfaction.marked：用户主动标记满意交付（仅 AskUserQuestion 精确等值置位，
  // message 来源不置位——W18 已固化）。
  | 'user.undo' | 'click_to_fix' | 'mode.switched' | 'repair.triggered' | 'satisfaction.marked'

export interface TelemetryEvent {
  eventId: string
  projectId?: string
  eventType: TelemetryEventType
  timestamp: string
  payload: Record<string, unknown>
}

// ===== 路径 =====

function getTelemetryPath(workspaceSlug: string): string {
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  return join(getWorkspaceFilesDir(workspaceSlug), '_telemetry', `events-${month}.jsonl`)
}

// ===== 公开接口 =====

/** 记录埋点事件（R3/AC 裁决 A5：内部 try-catch——写失败只告警不上抛，门禁热路径不因埋点盘中断） */
export function recordTelemetry(
  workspaceSlug: string,
  eventType: TelemetryEventType,
  payload: Record<string, unknown> = {},
  projectId?: string,
): TelemetryEvent {
  const event: TelemetryEvent = {
    eventId: randomUUID(),
    projectId,
    eventType,
    timestamp: new Date().toISOString(),
    payload,
  }

  try {
    const dir = join(getWorkspaceFilesDir(workspaceSlug), '_telemetry')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const filePath = getTelemetryPath(workspaceSlug)
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8')
  } catch (err) {
    console.warn('[南大埋点] 写入失败（不阻断主流程）:', err instanceof Error ? err.message : err)
  }

  return event
}

/** 读取埋点事件 */
export function readTelemetry(
  workspaceSlug: string,
  eventType?: TelemetryEventType,
): TelemetryEvent[] {
  const dir = join(getWorkspaceFilesDir(workspaceSlug), '_telemetry')
  if (!existsSync(dir)) return []

  const { readdirSync, readFileSync } = require('node:fs')  // eslint-disable-line @typescript-eslint/no-require-imports
  const files = readdirSync(dir).filter((f: string) => f.endsWith('.jsonl'))
  const events: TelemetryEvent[] = []

  for (const file of files) {
    const lines = readFileSync(join(dir, file), 'utf-8').trim().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as TelemetryEvent
        if (!eventType || event.eventType === eventType) {
          events.push(event)
        }
      } catch {
        /* skip malformed lines */
      }
    }
  }

  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}
