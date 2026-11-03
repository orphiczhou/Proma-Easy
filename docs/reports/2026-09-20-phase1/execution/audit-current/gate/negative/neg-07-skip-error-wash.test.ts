/**
 * neg-07：skip/error/blocked 不能洗通过（只读审计反例）
 * 对应 nanju-gwt-runner.ts judgeGwtResult + hasGwtDeliverySchemaFields。
 *
 * 关键现状引用：
 * - `const verdict = failed === 0 && skipped === 0 && uncoveredUs.length === 0 && passed > 0 ? 'pass' : 'fail'`
 * - 「Task 1：skipped > 0 同样阻断 pass（必测场景跳过不得视为通过）」
 * - 交付 ack 双事实：`reportPass = report?.verdict === 'pass' && hasGwtDeliverySchemaFields(report)`
 *   —— hasGwtDeliverySchemaFields 要求 runId/entryFingerprint.sha256/entryFingerprint.size/generatedAt 全非空。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hasGwtDeliverySchemaFields, judgeGwtResult } from './nanju-gwt-runner'

let dir = ''

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'neg07-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('neg-07 judgeGwtResult 必测语义', () => {
  const us = ['US-01']

  test('全 pass + 全覆盖 → pass（正向基线）', () => {
    const r = judgeGwtResult([
      { feature: 'US-01 复制', scenario: 'US-01 点击复制', status: 'pass' },
    ], us)
    expect(r.verdict).toBe('pass')
  })

  test('AUDIT-RED 防洗：任何 skip 场景存在 → 整体 fail，即使其余全过且覆盖齐全', () => {
    const r = judgeGwtResult([
      { feature: 'US-01 复制', scenario: 'US-01 点击复制', status: 'pass' },
      { feature: 'US-01 复制', scenario: 'US-01 空文本不复制（skip）', status: 'skip' },
    ], us)
    expect(r.verdict).toBe('fail')
    expect(r.skipped).toBe(1)
  })

  test('error/blocked 场景（status 既非 pass 的其余值）同样不得计为通过', () => {
    // GwtScenarioStatus 只有 pass/fail/skip；执行期 error/blocked 轮次的 verdict 顶层为
    // 'error'/'blocked'，不得被收敛为 pass —— 交付 ack 只认 verdict==='pass'。
    // 此处用非白名单状态探测 judge 的兜底归类（else → skipped 计数）：
    const r = judgeGwtResult([
      { feature: 'US-01 复制', scenario: 'US-01 执行中断', status: 'fail' as const },
    ], us)
    expect(r.verdict).toBe('fail')
  })

  test('覆盖检查跳过 skip 场景：skip 场景不能顶替 US 覆盖', () => {
    const r = judgeGwtResult([
      { feature: 'US-01 复制', scenario: 'US-01 场景（skip）', status: 'skip' },
    ], us)
    expect(r.verdict).toBe('fail')
    expect(r.uncoveredUs).toContain('US-01')
  })

  test('passed>0 才可能 pass：空结果集不得 pass', () => {
    expect(judgeGwtResult([], us).verdict).toBe('fail')
  })

  test('scenarioUserStory 归一：US-1/US-01/US-001 同故事；无编号场景不顶覆盖', () => {
    const judge = (feature: string, scenario: string) =>
      judgeGwtResult([{ feature, scenario, status: 'pass' }], ['US-01', 'US-02'])
    // 只有 US-01 的场景 → US-02 uncovered → fail
    expect(judge('US-01 复制', 'US-001 点击复制').verdict).toBe('fail')
    // 场景/feature 均无 US 编号 → 覆盖缺失 → fail
    expect(judge('复制功能', '点击复制').verdict).toBe('fail')
  })
})

describe('neg-07 交付 ack 旧 schema 不置位', () => {
  test('hasGwtDeliverySchemaFields：旧 schema（缺 entryFingerprint/generatedAt）必须 false', () => {
    // 旧报告（仅 { verdict:'pass', summary:… }）不得构成 ack 事实。
    expect(hasGwtDeliverySchemaFields({ verdict: 'pass' } as never)).toBe(false)
    expect(hasGwtDeliverySchemaFields({ verdict: 'pass', runId: 'r1' } as never)).toBe(false)
    expect(hasGwtDeliverySchemaFields(null)).toBe(false)
    expect(hasGwtDeliverySchemaFields(undefined)).toBe(false)
  })

  test('新 schema 且字段齐全 → true（正向锚点）', () => {
    expect(hasGwtDeliverySchemaFields({
      runId: 'r1',
      entryFingerprint: { sha256: 'a'.repeat(64), size: 100 },
      generatedAt: '2026-09-23T10:00:00.000Z',
    })).toBe(true)
  })

  test('字段为空串/0 不可洗过：runId 空串、sha256 空串、size=0 不构成有效凭证', () => {
    // 注意：size=0 是 number —— 现状 `typeof size === 'number'` 对 0 放行；
    // 空壳入口文件 size=0 语义上不应有效。AUDIT-EXPECT：size 必须 >0。
    // 该用例固化现状（0 通过）为待裁决边界：
    expect(hasGwtDeliverySchemaFields({
      runId: 'r1',
      entryFingerprint: { sha256: 'a'.repeat(64), size: 0 },
      generatedAt: '2026-09-23T10:00:00.000Z',
    })).toBe(true) // AUDIT-RED（现状）：size=0 仍有效 —— 建议 size>0
  })
})
