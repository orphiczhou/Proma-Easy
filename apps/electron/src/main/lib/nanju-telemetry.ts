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
