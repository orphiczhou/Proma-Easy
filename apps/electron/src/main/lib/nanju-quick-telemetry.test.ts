/**
 * W-I B-e（v0.17.124）：quick UX 埋点接线层测试（I 自有新模块）。
 *
 * 测试范围：
 * 1. #2 dialog.submitted 轮次自增/门禁/隐私收敛（不存原文）；
 * 2. #10 repair.triggered attempt 数取自 E 修复日志（禁止伪造），首产即过不发射；
 * 3. #1 project.created 只记名称长度；
 * 4. #8 mode.switched 只认 quick→iterative 且字段封闭；
 * 5. #6 user.undo 只记来源。
 *
 * 隐私红线（本文件显式断言）：任何 payload 都不得出现用户原文/项目名称原文/id 原文。
 *
 * Bun 独立运行：`bun test apps/electron/src/main/lib/nanju-quick-telemetry.test.ts`
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

interface CapturedEvent {
  workspaceSlug: string
  eventType: string
  payload: Record<string, unknown>
  projectId?: string
}

const events: CapturedEvent[] = []
let sessionProject: { projectId: string; mode: 'quick' | 'iterative'; status: string } | null = null
let repairAttempts: Array<{ strategy: string }> = []

mock.module('./nanju-telemetry', () => ({
  recordTelemetry: (
    workspaceSlug: string,
    eventType: string,
    payload: Record<string, unknown>,
    projectId?: string,
  ) => {
    events.push({ workspaceSlug, eventType, payload, projectId })
    return { ok: true }
  },
}))

mock.module('./nanju-phase-gate', () => ({
  findNanjuProjectBySession: () => sessionProject,
}))

mock.module('./nanju-repair-loop', () => ({
  readRepairLogState: () => ({ attempts: repairAttempts, logStatus: 'ok' }),
}))

const {
  emitDialogSubmitted,
  emitRepairTriggered,
  emitProjectCreated,
  emitModeSwitched,
  emitUserUndo,
  __resetQuickTelemetryForTests,
} = await import('./nanju-quick-telemetry')
const { AUTO_DECIDE_LABEL, isVagueInput } = await import('./nanju-quick-dialog')

function lastEvent(): CapturedEvent {
  const event = events[events.length - 1]
  if (!event) throw new Error('没有任何埋点事件被发射')
  return event
}

beforeEach(() => {
  events.length = 0
  repairAttempts = []
  sessionProject = { projectId: 'p1', mode: 'quick', status: 'active' }
  __resetQuickTelemetryForTests()
})

describe('W-I B-e：#2 dialog.submitted 接线（轮次/门禁/隐私）', () => {
  test('Given 同一会话连续两次提交 When 发射 Then turn 单调自增 1→2 且归属项目正确', () => {
    emitDialogSubmitted('ws', 's1', '我想做一个记账工具')
    emitDialogSubmitted('ws', 's1', '再加个导出功能')
    expect(events).toHaveLength(2)
    expect(events[0]?.payload.turn).toBe(1)
    expect(events[1]?.payload.turn).toBe(2)
    expect(events[0]?.projectId).toBe('p1')
    expect(events[0]?.eventType).toBe('dialog.submitted')
  })

  test('Given 无归属项目的会话 When 提交 Then 不发射且不消耗轮次（后续绑定后仍从 1 起）', () => {
    sessionProject = null
    emitDialogSubmitted('ws', 's1', '随便说点什么内容')
    expect(events).toHaveLength(0)
    sessionProject = { projectId: 'p1', mode: 'quick', status: 'active' }
    emitDialogSubmitted('ws', 's1', '随便说点什么内容')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.turn).toBe(1)
  })

  test('Given 会话绑定的项目非 active（已交付/归档）When 提交 Then 不发射', () => {
    sessionProject = { projectId: 'p1', mode: 'quick', status: 'delivered' }
    emitDialogSubmitted('ws', 's1', '还能再改点东西吗')
    expect(events).toHaveLength(0)
  })

  test('Given 用户提交消息 When 发射 Then payload 字段封闭为 5 项且不含原文', () => {
    const text = '帮我做一个宠物喂食提醒的小工具，要能设置时间'
    emitDialogSubmitted('ws', 's1', text)
    const payload = lastEvent().payload
    expect(Object.keys(payload).sort()).toEqual(
      ['autoFilledCount', 'inputLength', 'mode', 'turn', 'vague'].sort(),
    )
    expect(payload.inputLength).toBe(text.length)
    expect(payload.mode).toBe('quick')
    // 隐私红线：原文任何片段都不得出现在序列化结果里
    expect(JSON.stringify(payload)).not.toContain('宠物')
    expect(JSON.stringify(payload)).not.toContain(text)
  })

  test('Given 模糊输入 When 发射 Then vague 与 quick-dialog 同一判定（不另立口径）', () => {
    emitDialogSubmitted('ws', 's1', '做')
    expect(lastEvent().payload.vague).toBe(isVagueInput('做'))
    emitDialogSubmitted('ws', 's1', '我要做一个支持多人协作的看板，带权限和导出')
    expect(lastEvent().payload.vague).toBe(isVagueInput('我要做一个支持多人协作的看板，带权限和导出'))
  })

  test('Given 消息里出现两次「你帮我决定」When 发射 Then autoFilledCount=2（真实计数非推断）', () => {
    emitDialogSubmitted('ws', 's1', `${AUTO_DECIDE_LABEL}，颜色${AUTO_DECIDE_LABEL}`)
    expect(lastEvent().payload.autoFilledCount).toBe(2)
    emitDialogSubmitted('ws', 's1', '这次我自己选')
    expect(lastEvent().payload.autoFilledCount).toBe(0)
  })
})

describe('W-I B-e：#10 repair.triggered 接线（attempt 真源）', () => {
  test('Given 首产即过（修复日志 0 条）When 发射 success Then 不发射（无修复事实=无噪音）', () => {
    repairAttempts = []
    emitRepairTriggered('ws', 'p1', 'success')
    expect(events).toHaveLength(0)
  })

  test('Given 修复日志 2 条 When 发射 success Then attempts=2 且 strategies 取日志原序', () => {
    repairAttempts = [{ strategy: 'direct-fix' }, { strategy: 're-read-design' }]
    emitRepairTriggered('ws', 'p1', 'success')
    const payload = lastEvent().payload
    expect(payload.attempts).toBe(2)
    expect(payload.outcome).toBe('success')
    // F2 builder 的字段口径：strategiesCsv（保序去重后的 CSV）+ strategyVariants（去重计数）
    expect(payload.strategiesCsv).toBe('direct-fix,re-read-design')
    expect(payload.strategyVariants).toBe(2)
  })

  test('Given 三次修复后熔断 When 发射 circuit-break Then attempts=3（不信任何外部传入）', () => {
    repairAttempts = [
      { strategy: 'direct-fix' },
      { strategy: 're-read-design' },
      { strategy: 'alternate-approach' },
    ]
    emitRepairTriggered('ws', 'p1', 'circuit-break')
    expect(lastEvent().payload.attempts).toBe(3)
    expect(lastEvent().payload.outcome).toBe('circuit-break')
  })

  test('Given 环境类阻塞（0 attempt 预算未消耗）When 发射 environment-notify Then 仍作为收尾事实发射', () => {
    repairAttempts = []
    emitRepairTriggered('ws', 'p1', 'environment-notify')
    expect(events).toHaveLength(1)
    expect(lastEvent().payload.attempts).toBe(0)
    expect(lastEvent().payload.outcome).toBe('environment-notify')
  })

  test('Given 事件类型固定 When 发射 Then 走 click_to_fix 之外的 repair.triggered 单点（不串事件）', () => {
    repairAttempts = [{ strategy: 'direct-fix' }]
    emitRepairTriggered('ws', 'p1', 'success')
    expect(lastEvent().eventType).toBe('repair.triggered')
    expect(lastEvent().workspaceSlug).toBe('ws')
  })
})

describe('W-I B-e：#1 project.created 接线（名称只记长度）', () => {
  test('Given 建项目成功 When 发射 Then mode/name_length/auto_clarify 三字段且无名称原文', () => {
    const name = '李雷的记账本'
    emitProjectCreated('ws', {
      projectId: 'p9',
      name,
      mode: 'quick',
      autoClarify: { enabled: true },
    })
    const payload = lastEvent().payload
    expect(payload.project_id).toBe('p9')
    expect(payload.mode).toBe('quick')
    expect(payload.name_length).toBe(name.length)
    expect(payload.auto_clarify).toBe(true)
    expect(JSON.stringify(payload)).not.toContain('李雷')
    expect(JSON.stringify(payload)).not.toContain(name)
  })

  test('Given 未开启自动补完 When 发射 Then auto_clarify=false（无该字段也视为 false）', () => {
    emitProjectCreated('ws', { projectId: 'p9', name: 'x', mode: 'iterative' })
    expect(lastEvent().payload.auto_clarify).toBe(false)
    expect(lastEvent().payload.mode).toBe('iterative')
  })
})

describe('W-I B-e：#8 mode.switched 接线', () => {
  test('Given 真实升级快速消型→长期迭代 When 发射 Then 四字段封闭且含升级前阶段', () => {
    emitModeSwitched('ws', 'p1', {
      from: 'quick',
      to: 'iterative',
      reason: 'user-upgrade',
      quickStageState: 'prototype',
    })
    const payload = lastEvent().payload
    expect(Object.keys(payload).sort()).toEqual(
      ['from_mode', 'project_id', 'quick_stage_state', 'reason', 'to_mode'].sort(),
    )
    expect(payload.from_mode).toBe('quick')
    expect(payload.to_mode).toBe('iterative')
    expect(payload.reason).toBe('user-upgrade')
    expect(payload.quick_stage_state).toBe('prototype')
    expect(lastEvent().eventType).toBe('mode.switched')
  })
})

describe('W-I B-e：#6 user.undo 接线', () => {
  test('Given 单条撤销与全部放弃 When 发射 Then 只记来源（不含被撤销内容/元素 id）', () => {
    emitUserUndo('ws', 'p1', 'single')
    emitUserUndo('ws', 'p1', 'all')
    expect(events.map((e) => e.payload)).toEqual([{ source: 'single' }, { source: 'all' }])
    expect(events.every((e) => e.eventType === 'user.undo')).toBe(true)
  })
})
