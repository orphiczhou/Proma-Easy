/**
 * W24-EF F2（v0.17.123）：南大项目 quick UX 视图模型测试
 *
 * 测试范围（与 EF.md §3.2 BDD 对齐）：
 * 1. 模式卡片文案常量（标题/副标题/场景举例）+ ITERATIVE 标题为「做一个长期维护的项目」；
 * 2. GWT 报告逐场景通俗行（不含 Given/When/Then 术语）；
 * 3. 部分未通过标题「通过了 X 项，还有 Y 项需要修复」；
 * 4. 熔断安抚文案按 quick/iterative × 1..2/≥3 次特化；
 * 5. GWT 汇总行兼容既有 nanju-gwt-runner.ts:758 标题口径。
 *
 * Bun 独立运行：`bun test apps/electron/src/renderer/components/nanju/quick-ux-model.test.ts`
 */
import { describe, expect, test } from 'bun:test'

import {
  CIRCUIT_BREAK_FIRST_OR_SECOND_MESSAGE,
  CIRCUIT_BREAK_OVER_TRIED_MESSAGE,
  ITERATIVE_MODE_CARD,
  QUICK_MODE_CARD,
  buildCircuitBreakMessage,
  buildGwtSummaryLine,
  buildPartialFailureHeadline,
  buildScenarioRows,
  describeScenarioRow,
} from './quick-ux-model'

describe('W24-EF F2：US-U01 模式卡片文案', () => {
  test('Given 模式卡片常量 When 读取 Then 标题/副标题/场景举例齐全', () => {
    expect(QUICK_MODE_CARD.title).toBe('快速做一个工具')
    expect(QUICK_MODE_CARD.subtitle).toContain('验证')
    expect(QUICK_MODE_CARD.examples.length).toBeGreaterThanOrEqual(3)
    expect(QUICK_MODE_CARD.examples.some((e) => e.includes('读书笔记'))).toBe(true)
    expect(QUICK_MODE_CARD.accentToken).toBe('blue')

    expect(ITERATIVE_MODE_CARD.title).toBe('做一个长期维护的项目')
    expect(ITERATIVE_MODE_CARD.subtitle).toContain('适合想持续更新、不断完善')
    expect(ITERATIVE_MODE_CARD.examples.length).toBeGreaterThanOrEqual(3)
    expect(ITERATIVE_MODE_CARD.examples.some((e) => e.includes('社区网站'))).toBe(true)
    expect(ITERATIVE_MODE_CARD.accentToken).toBe('purple')
  })

  test('Given 副标题 When 校验 Then 至少含一个具体场景关键词（「工具/想法/笔记/项目/维护」）', () => {
    expect(QUICK_MODE_CARD.subtitle).toMatch(/(工具|想法|笔记|验证|点子)/)
    expect(ITERATIVE_MODE_CARD.subtitle).toMatch(/(项目|维护|长期|更新)/)
  })
})

describe('W24-EF F2：US-U08 GWT 报告逐场景通俗行', () => {
  test('Given GWT 报告含 2 场景 When 构建行 Then 有 plainText 用原文，缺 plainText 显示「暂无描述」', () => {
    const rows = buildScenarioRows({
      scenarios: [
        // US-01 无 plainText（只有技术 steps）
        { usId: 'US-01', verdict: 'pass', steps: ['打开添加页面', '填写标题', '点保存'] },
        // US-02 有可信 plainText
        { usId: 'US-02', verdict: 'fail', steps: ['打开笔记列表', '点删除按钮'], plainText: '能删除已添加的笔记' },
      ],
    })
    expect(rows).toHaveLength(2)
    // US-01 无 plainText → 不伪造「能正常打开添加页面」，显式标注「暂无描述」
    expect(rows[0]!.plainText).toBe('US-01（暂无描述）')
    expect(rows[0]!.plainText).not.toContain('打开')
    // US-02 有可信 plainText → 保留原文
    expect(rows[1]!.plainText).toBe('能删除已添加的笔记')
    expect(rows[0]!.status).toBe('pass')
    expect(rows[1]!.status).toBe('fail')
  })

  test('Given 技术 steps（Given/When/Then） When 构建 Then 不冒充用户叙述（narration 仅基于 plainText）', () => {
    const rows = buildScenarioRows({
      scenarios: [
        {
          usId: 'US-03',
          verdict: 'pass',
          plainText: '能正常添加笔记',
          steps: ['Given 用户在首页', 'When 点击「新建」按钮', 'Then 进入创建页'],
        },
      ],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.plainText).toBe('能正常添加笔记')
    // narration 基于 plainText，不含技术步骤 / GWT 术语
    expect(rows[0]!.narration).toContain('能正常添加笔记')
    expect(rows[0]!.narration).not.toMatch(/\b(Given|When|Then|And|But)\b/)
    expect(rows[0]!.narration).not.toContain('用户在首页')
  })

  test('Given usId/verdict 缺省或异常 When 构建 Then 兜底', () => {
    const rows = buildScenarioRows({
      scenarios: [
        // usId 缺省 + 有 plainText
        { plainText: '能搜索笔记', verdict: 'pass', steps: ['打开搜索页'] },
        // verdict 异常 + 无 plainText
        {
          usId: 'US-04',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          verdict: 'mystery' as any,
          steps: ['打开搜索页', '输入关键词'],
        },
      ],
    })
    expect(rows[0]!.usId).toBe('US-?')
    expect(rows[0]!.plainText).toBe('能搜索笔记')
    expect(rows[1]!.plainText).toBe('US-04（暂无描述）')
    expect(rows[1]!.status).toBe('fail')
  })

  test('Given 无 plainText 且有步骤 When 构建 Then 不派生「能正常 X」，显示「暂无描述」', () => {
    const rows = buildScenarioRows({
      scenarios: [{ usId: 'US-05', verdict: 'pass', steps: ['打开设置页', '切换语言'] }],
    })
    expect(rows[0]!.plainText).toBe('US-05（暂无描述）')
    expect(rows[0]!.plainText).not.toContain('打开设置页')
  })

  test('describeScenarioRow 与 buildScenarioRows.narration 同语义', () => {
    const rows = buildScenarioRows({
      scenarios: [{ usId: 'US-06', verdict: 'pass', plainText: '能开始使用' }],
    })
    expect(describeScenarioRow(rows[0]!)).toBe(rows[0]!.narration)
  })
})

describe('W24-EF F2：US-U08 部分未通过标题', () => {
  test('Given 报告 1 通过 1 未通过 When 生成标题 Then 含「通过了 1 项，还有 1 项需要修复」', () => {
    expect(buildPartialFailureHeadline(1, 1)).toBe('通过了 1 项，还有 1 项需要修复')
    expect(buildPartialFailureHeadline(2, 3)).toBe('通过了 2 项，还有 3 项需要修复')
  })

  test('Given 全通过 When 生成标题 Then 含「全部 N 项通过」', () => {
    expect(buildPartialFailureHeadline(5, 0)).toBe('全部 5 项通过')
  })

  test('Given 全失败 When 生成标题 Then 含「N 项未通过，已自动进入修复」', () => {
    expect(buildPartialFailureHeadline(0, 3)).toBe('3 项未通过，已自动进入修复')
  })

  test('Given 异常输入（NaN/负数）When 生成标题 Then 截断到合法范围', () => {
    expect(buildPartialFailureHeadline(Number.NaN, Number.NaN)).toBe('本次验收没有场景可执行')
    expect(buildPartialFailureHeadline(-1, -2)).toBe('本次验收没有场景可执行')
    expect(buildPartialFailureHeadline(2.7, 1.4)).toBe('通过了 2 项，还有 1 项需要修复')
  })
})

describe('W24-EF F2：US-U07 熔断安抚文案', () => {
  test('Given quick 第 1 次熔断 When 构建 Then 文案为第 1/2 次特化', () => {
    const msg = buildCircuitBreakMessage({ mode: 'quick', consecutiveCircuitCount: 1, rolledBack: false })
    expect(msg).toBe(CIRCUIT_BREAK_FIRST_OR_SECOND_MESSAGE)
    expect(msg).toMatch(/稍等|正在/)
  })

  test('Given quick 第 3 次熔断 When 构建 Then 文案为 ≥3 次特化', () => {
    const msg = buildCircuitBreakMessage({ mode: 'quick', consecutiveCircuitCount: 3, rolledBack: false })
    expect(msg).toBe(CIRCUIT_BREAK_OVER_TRIED_MESSAGE)
    expect(msg).toContain('困难')
  })

  test('Given iterative 第 2 次熔断 When 构建 Then 用 iterative 文案（与 quick 区分）', () => {
    const msg = buildCircuitBreakMessage({ mode: 'iterative', consecutiveCircuitCount: 2, rolledBack: false })
    expect(msg).not.toBe(CIRCUIT_BREAK_FIRST_OR_SECOND_MESSAGE) // quick 文案
    expect(msg).toContain('技术细节')
  })

  test('Given 任意模式第 3 次熔断且已回滚 When 构建 Then 末句追加「已回到上一个正常版本」', () => {
    const msg = buildCircuitBreakMessage({ mode: 'quick', consecutiveCircuitCount: 3, rolledBack: true })
    expect(msg).toContain('已回到上一个正常版本')
    expect(msg).toContain('困难')
  })

  test('Given 文案常量 Then 字面值稳定不变', () => {
    expect(CIRCUIT_BREAK_FIRST_OR_SECOND_MESSAGE).toContain('稍等')
    expect(CIRCUIT_BREAK_OVER_TRIED_MESSAGE).toContain('困难')
  })
})

describe('W24-EF F2：US-U08 GWT 汇总行', () => {
  test('Given 全通过 5 项 When 汇总 Then 「全部 5 项通过」', () => {
    expect(buildGwtSummaryLine({ passed: 5, failed: 0, skipped: 0 })).toBe('我们测试了 5 个场景，全部通过 ✓')
  })

  test('Given 3 通过 + 1 跳过 When 汇总 Then 「3 项通过，1 项跳过」', () => {
    expect(buildGwtSummaryLine({ passed: 3, failed: 0, skipped: 1 })).toBe(
      '我们测试了 4 个场景，3 项通过，1 项跳过',
    )
  })

  test('Given 2 通过 + 1 失败 When 汇总 Then 部分未通过标题', () => {
    expect(buildGwtSummaryLine({ passed: 2, failed: 1, skipped: 0 })).toBe(
      '通过了 2 项，还有 1 项需要修复',
    )
  })

  test('Given 空数据 When 汇总 Then 「本次没有运行任何场景」', () => {
    expect(buildGwtSummaryLine({ passed: 0, failed: 0, skipped: 0 })).toBe('本次没有运行任何场景')
  })
})