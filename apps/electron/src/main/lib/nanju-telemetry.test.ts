/**
 * W24-EF F2（v0.17.123）：nanju-telemetry union 追加回归
 *
 * 只测「union 追加不破坏既有读取」：
 * 1. 既有 union 成员字符串仍可赋给 TelemetryEventType（删除既有成员会编译失败）；
 * 2. F2 追加的 5 个 PRD §12.4 成员（#6/#7/#8/#10/#12）为合法成员；
 * 3. readTelemetry 对不存在工作区返回空数组且不抛（追加不破坏读取路径）。
 *
 * Bun 独立运行：`bun test apps/electron/src/main/lib/nanju-telemetry.test.ts`
 */
import { describe, expect, test } from 'bun:test'

import { readTelemetry, type TelemetryEventType } from './nanju-telemetry'

describe('W24-EF F2：nanju-telemetry union 追加回归', () => {
  test('既有 union 成员字符串仍可赋值（不改既有成员，编译期锁定）', () => {
    // 若某字符串被从 union 移除，此数组会因类型不匹配编译失败——即回归被拦截
    const existing: TelemetryEventType[] = [
      'project.created',
      'dialog.submitted',
      'role.switched',
      'prd.confirmed',
      'prototype.confirmed',
      'coding.executed',
      'judge.verdict',
      'project.finished',
      'architecture.confirmed',
      'circuit_break',
      'phase.elapsed',
      'delivery.ack-recorded',
      'delivery.gate.blocked',
    ]
    expect(existing).toHaveLength(13)
  })

  test('F2 追加 5 个 PRD §12.4 成员（#6/#7/#8/#10/#12）为合法成员', () => {
    const added: TelemetryEventType[] = [
      'user.undo',
      'click_to_fix',
      'mode.switched',
      'repair.triggered',
      'satisfaction.marked',
    ]
    expect(added).toEqual([
      'user.undo',
      'click_to_fix',
      'mode.switched',
      'repair.triggered',
      'satisfaction.marked',
    ])
  })

  test('readTelemetry 对不存在工作区返回空数组且不抛（追加不破坏读取路径）', () => {
    // 注：getWorkspaceFilesDir 会惰性 mkdir 工作区目录；断言后清理，避免污染真实工作区列表
    const slug = '__f2_union_nonexistent__'
    try {
      expect(readTelemetry(slug)).toEqual([])
      expect(readTelemetry(slug, 'mode.switched')).toEqual([])
      expect(readTelemetry(slug, 'satisfaction.marked')).toEqual([])
    } finally {
      const { rmSync } = require('node:fs') as typeof import('node:fs')
      const { join } = require('node:path') as typeof import('node:path')
      const { homedir } = require('node:os') as typeof import('node:os')
      try {
        rmSync(join(homedir(), '.proma', 'agent-workspaces', slug), { recursive: true, force: true })
      } catch { /* 清理失败不阻断测试 */ }
    }
  })
})

// ===== L3-7d（2026-09-18）：Spike 三埋点 union 追加 =====
describe('L3-7d：Spike 三埋点枚举在场（spike.created / spike.verdict / spike.timebox_hit）', () => {
  test('三事件均为合法 TelemetryEventType（timebox_hit 无可观测载体仅登记，不接假触发点）', () => {
    // 类型标注为 TelemetryEventType[]：任一成员被从 union 移除会在此编译失败——即枚举在场被编译期锁定
    const spikeEvents: TelemetryEventType[] = ['spike.created', 'spike.verdict', 'spike.timebox_hit']
    expect(spikeEvents).toEqual(['spike.created', 'spike.verdict', 'spike.timebox_hit'])
  })
})
