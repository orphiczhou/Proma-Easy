/**
 * L3-7d（2026-09-18）：Spike 埋点观察器单测
 *
 * 覆盖面：
 * - detectSpikePendingMarks：宽松匹配（空格/全角括号/带短名）+ 按序去重 + 解析客错（无标记/空串→[]）；
 * - recordSpikeTelemetryFromDoc：首见 PENDING→spike.created（基线视为空集）、
 *   消失→spike.verdict（resolved+pending-removed 诚实降级）、无变化不埋、快照按 workspace/project 隔离；
 * - recordSpikeTelemetryFromContract：登记变化→spike.verdict（verdict 取登记值）、
 *   重复读不埋、verdict 变化重埋、无 spikes 字段不埋；
 * - 三埋点枚举在场断言（timebox_hit 无假触发点，仅登记）；
 * - 源码接线断言（nanju-router-gate 挂点防静默脱钩）。
 *
 * verifyPhaseOutput 端到端接线测试见 nanju-router-gate.test.ts（L3-7d describe）。
 * 依赖 config-paths.getWorkspaceFilesDir 定位埋点目录——按 nanju-router-gate.test.ts
 * 模式先 mock.module 指向 tmpdir 再动态导入被测模块。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TelemetryEventType } from './nanju-telemetry'

/** 当前 fixture 根目录（mock 的 getWorkspaceFilesDir 每次调用时读取） */
let fixtureRoot = ''

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
}))

const { detectSpikePendingMarks, recordSpikeTelemetryFromDoc, recordSpikeTelemetryFromContract, resetSpikeTelemetryState } = await import('./nanju-spike-telemetry')

const WS = 'spike-ws'
const PID = 'spike-p1'

function newFixture(): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-spike-telemetry-'))
}

/** 读取 fixture 下 _telemetry 全部事件（含 payload） */
function readEvents(): Array<{ eventType: string; payload: Record<string, unknown> }> {
  const dir = join(fixtureRoot, '_telemetry')
  if (!existsSync(dir)) return []
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, file), 'utf-8').trim().split('\n').filter(Boolean)) {
      events.push(JSON.parse(line) as { eventType: string; payload: Record<string, unknown> })
    }
  }
  return events
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
  resetSpikeTelemetryState()
})

describe('Given 架构文档 PENDING 标记，When detectSpikePendingMarks，Then 宽松匹配且容错', () => {
  test('Then 匹配紧凑/带空格/全角括号/带短名形态并按首次出现去重', () => {
    const doc = [
      '决策A：PENDING(SPIKE-001) 待 Spike 验证',
      '决策B：PENDING (SPIKE-002-wayland-ime) 待验证',
      '决策C：PENDING（SPIKE-003.dbus）待验证',
      '重复引用：PENDING(SPIKE-001)',
    ].join('\n')
    expect(detectSpikePendingMarks(doc)).toEqual(['SPIKE-001', 'SPIKE-002-wayland-ime', 'SPIKE-003.dbus'])
  })
  test('Then 解析客错：无 PENDING 前缀/无括号/纯 PENDING/空文档均返回空数组', () => {
    expect(detectSpikePendingMarks('SPIKE-001 已验证并替换为结论')).toEqual([])
    expect(detectSpikePendingMarks('(SPIKE-001)')).toEqual([])
    expect(detectSpikePendingMarks('PENDING 待定（无编号）')).toEqual([])
    expect(detectSpikePendingMarks('')).toEqual([])
    expect(detectSpikePendingMarks('普通架构文档，无 Spike 标记。')).toEqual([])
  })

  // 审计 AC-5：占位符 SPIKE-NNN 回抄过滤（任务书条文含字面 PENDING(SPIKE-NNN)，回抄不产生伪事件）
  test('Then 占位符 SPIKE-NNN（大小写不敏感全等）被过滤，真实编号不受影响', () => {
    const doc = [
      '条文：Spike 未决前架构文档该决策点标 PENDING(SPIKE-NNN)，不得写成确定性结论',
      '决策点A：PENDING(SPIKE-001-xkb)',
      '决策点B：PENDING(spike-nnn)（占位符变体）',
      '决策点C：PENDING(SPIKE-002-atspi)',
    ].join('\n')
    expect(detectSpikePendingMarks(doc)).toEqual(['SPIKE-001-xkb', 'SPIKE-002-atspi'])
  })
})

describe('Given 文档侧快照对比，When recordSpikeTelemetryFromDoc，Then 事件按变化派生', () => {
  test('Then 首见 PENDING 埋 spike.created（基线视为空集，payload 带 slug）', () => {
    newFixture()
    recordSpikeTelemetryFromDoc(WS, PID, '# 架构\n- 决策A：PENDING(SPIKE-001)\n- 决策B：PENDING(SPIKE-002)')
    const created = readEvents().filter((e) => e.eventType === 'spike.created')
    expect(created.map((e) => e.payload.slug)).toEqual(['SPIKE-001', 'SPIKE-002'])
    expect(created[0]?.payload.source).toBe('pending-mark')
  })
  test('Then 无变化不重复埋（同文档多次观察只埋一次）', () => {
    newFixture()
    const doc = '# 架构\n- PENDING(SPIKE-001)'
    recordSpikeTelemetryFromDoc(WS, PID, doc)
    recordSpikeTelemetryFromDoc(WS, PID, doc)
    recordSpikeTelemetryFromDoc(WS, PID, doc)
    expect(readEvents().filter((e) => e.eventType === 'spike.created')).toHaveLength(1)
    expect(readEvents().filter((e) => e.eventType === 'spike.verdict')).toHaveLength(0)
  })
  test('Then PENDING 消失埋 spike.verdict（resolved + pending-removed 诚实降级，方向不可知）', () => {
    newFixture()
    recordSpikeTelemetryFromDoc(WS, PID, '# 架构\n- 决策A：PENDING(SPIKE-001)')
    recordSpikeTelemetryFromDoc(WS, PID, '# 架构\n- 决策A：SPIKE-001 结论——GTK 注入生效 [实证]')
    const verdicts = readEvents().filter((e) => e.eventType === 'spike.verdict')
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]?.payload).toMatchObject({ slug: 'SPIKE-001', verdict: 'resolved', source: 'pending-removed' })
  })
  test('Then 快照按 workspace/project 隔离（同名 slug 各自埋 created）', () => {
    newFixture()
    recordSpikeTelemetryFromDoc(WS, 'pid-a', '# PENDING(SPIKE-001)')
    recordSpikeTelemetryFromDoc(WS, 'pid-b', '# PENDING(SPIKE-001)')
    recordSpikeTelemetryFromDoc('other-ws', 'pid-a', '# PENDING(SPIKE-001)')
    expect(readEvents().filter((e) => e.eventType === 'spike.created')).toHaveLength(3)
  })
})

describe('Given 契约 spikes[] 登记，When recordSpikeTelemetryFromContract，Then verdict 取登记值', () => {
  test('Then 首见登记埋 spike.verdict（含 decided_by/ts）；重复读不埋；verdict 变化重埋', () => {
    newFixture()
    const registered = { spikes: [{ slug: 'SPIKE-001-ime-injection', verdict: 'confirmed' as const, decided_by: 'architect-a', ts: '2026-09-18' }] }
    recordSpikeTelemetryFromContract(WS, PID, registered)
    recordSpikeTelemetryFromContract(WS, PID, registered) // 重复读相同登记：不埋
    let verdicts = readEvents().filter((e) => e.eventType === 'spike.verdict')
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]?.payload).toMatchObject({ slug: 'SPIKE-001-ime-injection', verdict: 'confirmed', source: 'contract-registration', decided_by: 'architect-a', ts: '2026-09-18' })
    // verdict 变化（confirmed → partial）视为新登记，重埋一次
    recordSpikeTelemetryFromContract(WS, PID, { spikes: [{ slug: 'SPIKE-001-ime-injection', verdict: 'partial' }] })
    verdicts = readEvents().filter((e) => e.eventType === 'spike.verdict')
    expect(verdicts).toHaveLength(2)
    expect(verdicts[1]?.payload.verdict).toBe('partial')
  })
  test('Then 契约无 spikes 字段不埋任何事件', () => {
    newFixture()
    recordSpikeTelemetryFromContract(WS, PID, {})
    expect(readEvents()).toHaveLength(0)
  })
})

describe('Given L3-7d 三埋点枚举与接线，When 接入平台，Then 事件已登记且挂点在场', () => {
  test('Then spike.created/spike.verdict/spike.timebox_hit 均为合法事件成员（timebox_hit 仅登记无假触发点）', () => {
    // 类型标注为 TelemetryEventType[]：任一成员被从 union 移除会在此编译失败——即枚举在场被编译期锁定
    const spikeEvents: TelemetryEventType[] = ['spike.created', 'spike.verdict', 'spike.timebox_hit']
    expect(spikeEvents).toEqual(['spike.created', 'spike.verdict', 'spike.timebox_hit'])
  })
  test('Then nanju-router-gate 源码接线在场（文档侧与契约侧挂点防静默脱钩）', () => {
    const source = readFileSync(join(import.meta.dir, 'nanju-router-gate.ts'), 'utf-8')
    expect(source).toContain('recordSpikeTelemetryFromDoc')
    expect(source).toContain('recordSpikeTelemetryFromContract')
  })
})
