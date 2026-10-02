/**
 * W-I B-e（I-P6）：GWT 逐场景通俗行累积器测试。
 *
 * 锁定三件事：
 * 1. 只把 `scenario-end` 的终态事件当事实（其它 phase / 非法状态不猜、不兜底成 pass）；
 * 2. plainText 只取场景描述（可信来源），去前缀后为空则交给 builder 走「暂无描述」；
 * 3. 去重=同场景覆盖最新（重跑不叠行）、上限裁剪、展示裁剪失败行优先。
 *
 * Bun 独立运行：`bun test apps/electron/src/renderer/components/nanju/gwt-scenario-rows.test.ts`
 */
import { describe, expect, test } from 'bun:test'

import { buildScenarioRows, describeScenarioRow } from './quick-ux-model'
import {
  SCENARIO_ROWS_CAP,
  appendScenarioRow,
  extractUserStoryId,
  pickVisibleScenarioRows,
  scenarioRowSeedFromEvent,
  type ScenarioRowSeed,
} from './gwt-scenario-rows'

describe('W-I B-e：#I-P6 场景种子派生（只认终态事实）', () => {
  test('Given scenario-end 带 US 编号与通过 When 派生 Then id/描述/状态齐备', () => {
    const seed = scenarioRowSeedFromEvent({
      phase: 'scenario-end',
      scenario: 'US-01 添加笔记后列表可见',
      scenarioStatus: 'pass',
    })
    expect(seed).toEqual({ usId: 'US-01', plainText: '添加笔记后列表可见', verdict: 'pass' })
  })

  test('Given 非结算 phase（start/scenario-start/done）When 派生 Then 返回 null（不提前记行）', () => {
    expect(scenarioRowSeedFromEvent({ phase: 'start', scenario: 'US-01 x', scenarioStatus: 'pass' })).toBeNull()
    expect(scenarioRowSeedFromEvent({ phase: 'scenario-start', scenario: 'US-01 x' })).toBeNull()
    expect(scenarioRowSeedFromEvent({ phase: 'done', scenarioStatus: 'pass' })).toBeNull()
  })

  test('Given 状态非法或缺失 When 派生 Then 返回 null（绝不兜底成 pass）', () => {
    expect(scenarioRowSeedFromEvent({ phase: 'scenario-end', scenario: 'US-01 x', scenarioStatus: 'error' })).toBeNull()
    expect(scenarioRowSeedFromEvent({ phase: 'scenario-end', scenario: 'US-01 x' })).toBeNull()
    expect(scenarioRowSeedFromEvent({ phase: 'scenario-end', scenarioStatus: 'pass' })).toBeNull()
  })

  test('Given 描述不含 US 编号 When 派生 Then usId=US-? 且保留原描述（不编造编号）', () => {
    const seed = scenarioRowSeedFromEvent({ phase: 'scenario-end', scenario: '首页能打开', scenarioStatus: 'fail' })
    expect(seed).toEqual({ usId: 'US-?', plainText: '首页能打开', verdict: 'fail' })
    expect(extractUserStoryId('us-7 大小写混排')).toBe('US-07')
  })

  test('Given 描述只有编号 When 派生 Then plainText 为空 → builder 显示「暂无描述」而非 steps', () => {
    const seed = scenarioRowSeedFromEvent({ phase: 'scenario-end', scenario: 'US-03', scenarioStatus: 'skip' })
    expect(seed).toEqual({ usId: 'US-03', plainText: '', verdict: 'skip' })
    const rows = buildScenarioRows({ scenarios: [seed!] })
    expect(rows[0]?.plainText).toBe('US-03（暂无描述）')
    expect(rows[0]?.narration).toContain('跳过')
  })
})

describe('W-I B-e：#I-P6 累积与展示裁剪', () => {
  const seedOf = (usId: string, plainText: string, verdict: string): ScenarioRowSeed => ({ usId, plainText, verdict })

  test('Given 同场景重跑（同 id 同描述）When 追加 Then 覆盖为最新状态且不叠行', () => {
    let rows: ScenarioRowSeed[] = []
    rows = appendScenarioRow(rows, seedOf('US-01', '能加笔记', 'fail'))
    rows = appendScenarioRow(rows, seedOf('US-01', '能加笔记', 'pass'))
    expect(rows).toEqual([seedOf('US-01', '能加笔记', 'pass')])
  })

  test('Given 不同场景 When 追加 Then 保序累积（先失败后通过都在）', () => {
    let rows: ScenarioRowSeed[] = []
    rows = appendScenarioRow(rows, seedOf('US-01', '能加笔记', 'pass'))
    rows = appendScenarioRow(rows, seedOf('US-02', '能删笔记', 'fail'))
    expect(rows.map((r) => r.usId)).toEqual(['US-01', 'US-02'])
  })

  test('Given 超过上限 When 追加 Then 丢最早的行（保留最近 SCENARIO_ROWS_CAP 条）', () => {
    let rows: ScenarioRowSeed[] = []
    for (let i = 0; i < SCENARIO_ROWS_CAP + 5; i += 1) {
      rows = appendScenarioRow(rows, seedOf(`US-${String(i).padStart(2, '0')}`, `场景 ${i}`, 'pass'))
    }
    expect(rows).toHaveLength(SCENARIO_ROWS_CAP)
    expect(rows[0]?.plainText).toBe('场景 5')
    expect(rows[rows.length - 1]?.plainText).toBe(`场景 ${SCENARIO_ROWS_CAP + 4}`)
  })

  test('Given 行数不超限 When 裁剪 Then 全量可见且 hiddenCount=0', () => {
    const rows = buildScenarioRows({
      scenarios: [seedOf('US-01', '能加笔记', 'pass'), seedOf('US-02', '能删笔记', 'fail')],
    })
    const { visible, hiddenCount } = pickVisibleScenarioRows(rows, 6)
    expect(visible).toHaveLength(2)
    expect(hiddenCount).toBe(0)
  })

  test('Given 行数超限且有失败行 When 裁剪 Then 失败行优先可见且计数正确', () => {
    const scenarios = [
      seedOf('US-01', '能加笔记', 'pass'),
      seedOf('US-02', '能删笔记', 'fail'),
      seedOf('US-03', '能改笔记', 'pass'),
      seedOf('US-04', '能导出', 'pass'),
      seedOf('US-05', '能分享', 'fail'),
      seedOf('US-06', '能搜索', 'pass'),
      seedOf('US-07', '能排序', 'pass'),
      seedOf('US-08', '能打印', 'skip'),
    ]
    const rows = buildScenarioRows({ scenarios })
    const { visible, hiddenCount } = pickVisibleScenarioRows(rows, 4)
    expect(visible).toHaveLength(4)
    expect(hiddenCount).toBe(4)
    // 两条失败行必在可见集里（用户最需要看到的）
    expect(visible.some((r) => r.usId === 'US-02' && r.status === 'fail')).toBe(true)
    expect(visible.some((r) => r.usId === 'US-05' && r.status === 'fail')).toBe(true)
  })

  test('Given 累积后的行 When 渲染叙述 Then 叙述只来自可信 plainText（无技术 steps）', () => {
    let rows: ScenarioRowSeed[] = []
    rows = appendScenarioRow(rows, seedOf('US-09', '登录后能看到首页', 'pass'))
    const narration = describeScenarioRow(buildScenarioRows({ scenarios: rows })[0]!)
    expect(narration).toContain('登录后能看到首页')
    expect(narration).toContain('成功')
  })
})
