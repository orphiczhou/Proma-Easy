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
