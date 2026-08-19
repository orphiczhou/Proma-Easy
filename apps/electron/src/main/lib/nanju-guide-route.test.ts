/**
 * getGuideRoute 测试（nanju:get-route IPC 的数据面，修订 R2）
 *
 * 保证：透传 getRoute(mode) 全部阶段字段 + 每 phase 附加 resolveACActors 解析结果；
 * quick/iterative 两版的 outputPath/next/AC 强度与 nanju-router.ts 单一真相源一致。
 */

import { describe, expect, test } from 'bun:test'
import { getGuideRoute, getRoute, AC_PRESETS } from './nanju-router'

describe('getGuideRoute（nanju:get-route 数据面）', () => {
  test('quick：3 个阶段（含 delivered 哨兵），taskWeight=light，acActors=light 预设', () => {
    const route = getGuideRoute('quick')
    expect(route.length).toBe(3)
    expect(route.map((p) => p.id)).toEqual(['requirements', 'prototype', 'delivered'])
    for (const phase of route) {
      if (phase.id === 'delivered') continue
      expect(phase.taskWeight).toBe('light')
      expect(phase.acActors).toEqual(AC_PRESETS.light)
    }
    // 哨兵节点字段为空（渲染端按 id==='delivered' 过滤，修订 Y3）
    const sentinel = route.find((p) => p.id === 'delivered')
    expect(sentinel?.role).toBe('')
    expect(sentinel?.outputPath).toBe('')
  })

  test('iterative：5 个阶段（含 delivered 哨兵），taskWeight=medium，acActors=medium 预设', () => {
    const route = getGuideRoute('iterative')
    expect(route.map((p) => p.id)).toEqual(['requirements', 'prototype', 'architecture', 'planning', 'delivered'])
    for (const phase of route) {
      if (phase.id === 'delivered') continue
      expect(phase.taskWeight).toBe('medium')
      expect(phase.acActors).toEqual(AC_PRESETS.medium)
    }
  })

  test('两版 outputPath 与 getRoute 一致（AC-02 契约）', () => {
    const quick = getGuideRoute('quick')
    const iterative = getGuideRoute('iterative')
    expect(quick.find((p) => p.id === 'requirements')?.outputPath).toBe('01_PRD/prd.md')
    expect(quick.find((p) => p.id === 'prototype')?.outputPath).toBe('02_UX_DESIGN/prototype.html')
    expect(iterative.find((p) => p.id === 'architecture')?.outputPath).toBe('03_ARCHITECTURE/architecture.md')
    expect(iterative.find((p) => p.id === 'planning')?.outputPath).toBe('05_PROJECT_PLAN/plan.md')
  })

  test('prototype next 指向：quick→delivered，iterative→architecture（路由分叉点）', () => {
    expect(getGuideRoute('quick').find((p) => p.id === 'prototype')?.next).toBe('delivered')
    expect(getGuideRoute('iterative').find((p) => p.id === 'prototype')?.next).toBe('architecture')
  })

  test('requiresAC 硬门禁仅 architecture 为 true', () => {
    const iterative = getGuideRoute('iterative')
    expect(iterative.find((p) => p.id === 'architecture')?.requiresAC).toBe(true)
    expect(iterative.filter((p) => p.id !== 'architecture').every((p) => !p.requiresAC)).toBe(true)
    expect(getGuideRoute('quick').every((p) => !p.requiresAC)).toBe(true)
  })

  test('透传性：除 acActors 外字段与 getRoute 输出逐一相等', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const plain = getRoute(mode)
      const guide = getGuideRoute(mode)
      expect(guide.length).toBe(plain.length)
      plain.forEach((phase, i) => {
        const guidePhase = guide[i]
        if (!guidePhase) throw new Error(`getGuideRoute(${mode}) 缺少第 ${i} 个阶段`)
        const { acActors: _extra, ...rest } = guidePhase
        // JSON 序列化后逐字段深度相等（避免交叉类型断言）
        expect(JSON.parse(JSON.stringify(rest))).toEqual(JSON.parse(JSON.stringify(phase)))
      })
    }
  })

  test('阶段角色与模型（v0.16.87 基准：UX 顾问为 MiniMax-M3 家族标记）', () => {
    const iterative = getGuideRoute('iterative')
    const byTitle = (phase: string) => iterative.find((p) => p.id === phase)
    expect(byTitle('requirements')?.title).toBe('需求分析师')
    expect(byTitle('prototype')?.model).toBe('MiniMax-M3')
    expect(byTitle('architecture')?.title).toBe('架构师')
    expect(byTitle('planning')?.title).toBe('工程经理')
  })
})
