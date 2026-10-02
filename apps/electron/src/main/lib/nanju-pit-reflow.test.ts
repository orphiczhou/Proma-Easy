/**
 * L2-6（L2 批，2026-09-18）坑库回填机制单测——触发判定 + 指令段文本结构。
 * 规格：模版体系改进方案 v1 §四 L2-6（ATK-L-001/L-006 裁决）、
 * 03-架构阶段流程增强建议 §4 R1-R3、01-模版结构规范-v2 §6 Minor Bump。
 */
import { describe, expect, test } from 'bun:test'
import {
  buildPitReflowDirective,
  shouldTriggerPitReflow,
  PIT_REFLOW_RETRY_COUNT_THRESHOLD,
  PIT_REFLOW_FALLBACK_CATEGORY,
} from './nanju-pit-reflow'

describe('Given GWT 结果轮次事实，When 判定强制复盘触发，Then 按规格「验收收敛 >3 轮」口径（总轮次≥4 = retryCount≥3；审计 RED-1 修正：pass 轮也触发，随交付验收消息注入）', () => {
  test('Then retryCount=2（3 轮收敛健康带）不触发', () => {
    expect(shouldTriggerPitReflow('fail', 2, false)).toBe(false)
    expect(shouldTriggerPitReflow('pass', 2, false)).toBe(false)
  })
  test('Then retryCount=3（总轮次 4，含 pass 轮）触发——4/5 轮收敛项目不再漏触发（RED-1 修正语义）', () => {
    expect(shouldTriggerPitReflow('fail', 3, false)).toBe(true)
    expect(shouldTriggerPitReflow('error', 3, false)).toBe(true)
    expect(shouldTriggerPitReflow('pass', 3, false)).toBe(true) // pass 轮随交付验收消息触发终局复盘
    expect(shouldTriggerPitReflow('fail', 4, false)).toBe(true)
  })
  test('Then blocked 轮不触发（与本轮不计入修复次数的声明自洽）', () => {
    expect(shouldTriggerPitReflow('blocked', 5, true)).toBe(false)
  })
})

describe('Given 品类标记与回填规格，When 构建指令段，Then R1/R2/R3 与效果度量五字段齐备', () => {
  const text = buildPitReflowDirective('desktop-app', { retryCount: 6, errorCount: 2 })

  test('Then R1：含强制复盘声明与「当时模版里没有的知识」清单三问', () => {
    expect(text).toContain('强制复盘')
    expect(text).toContain('当时模版里没有的知识')
    expect(text).toContain('哪个坑')
    expect(text).toContain('为什么当时品类模版没覆盖')
    expect(text).toContain('证据')
  })
  test('Then R2：回填格式含现象/根因/绕行/证据等级三档/来源编号示例', () => {
    expect(text).toContain('现象')
    expect(text).toContain('根因')
    expect(text).toContain('绕行')
    expect(text).toContain('[实证]')
    expect(text).toContain('[文证]')
    expect(text).toContain('[推断]')
    expect(text).toContain('来源：G3b复盘 2026-09-18')
    expect(text).toContain('来源：SPIKE-001，2026-09-17')
  })
  test('Then 写入目标：品类模版 §2/§5/§7 对应节 + CHANGELOG 带来源编号 + Bump Minor', () => {
    expect(text).toContain('§2 组件环境清单')
    expect(text).toContain('§5 测试闭环样例')
    expect(text).toContain('§7 坑库')
    expect(text).toContain('CHANGELOG')
    expect(text).toContain('Bump Minor')
    expect(text).toContain('01-模版结构规范-v2 §6')
  })
  test('Then R3：双位置同步（模版源头 + 运行时快照）、同版本号、运行时不单写快照', () => {
    expect(text).toContain('~/projects/nanju-guide/09_工程模板/')
    expect(text).toContain('nanju-engineering-templates/')
    expect(text).toContain('同版本号同步更新')
    expect(text).toContain('不得只写快照')
  })
  test('Then 效果度量五字段固定小节与 owner=本复盘会话', () => {
    expect(text).toContain('效果度量记录')
    expect(text).toContain('品类 / 收敛轮次 / error 轮数 / 透传命中轮数 / 备注')
    expect(text).toContain('owner=本复盘会话')
  })
  test('Then 品类参数传递：desktop-app 入文', () => {
    expect(text).toContain('品类：desktop-app')
    expect(text).not.toContain('web-fullstack')
  })
  test('Then 触发事实（retryCount/errorCount）入指令段头部', () => {
    expect(text).toContain('fail 回炉 6 轮')
    expect(text).toContain('error 异常 2 轮')
  })

  test('Then 无品类标记：兜底 web-fullstack 并提示补标（含六品类枚举与补标位置）', () => {
    const fallback = buildPitReflowDirective(null)
    expect(PIT_REFLOW_FALLBACK_CATEGORY).toBe('web-fullstack')
    expect(fallback).toContain('品类：web-fullstack')
    expect(fallback).toContain('projectCategory')
    expect(fallback).toContain('architecture.md')
    expect(fallback).toContain('desktop-app / cli-tool / ai-application')
    // 有标记时不带补标提示
    expect(buildPitReflowDirective('cli-tool')).not.toContain('projectCategory')
  })
  test('Then facts 缺省时头部仍成立（不带具体轮次）', () => {
    const noFacts = buildPitReflowDirective('api-backend')
    expect(noFacts).toContain('已超 3 轮')
    expect(noFacts).not.toContain('fail 回炉')
  })
})
