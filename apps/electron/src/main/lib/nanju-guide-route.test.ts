/**
 * getGuideRoute 测试（nanju:get-route IPC 的数据面，修订 R2）
 *
 * 保证：透传 getRoute(mode) 全部阶段字段 + 每 phase 附加 resolveACActors 解析结果；
 * quick/iterative 两版的 outputPath/next/AC 强度与 nanju-router.ts 单一真相源一致。
 */

import { describe, expect, test } from 'bun:test'
import { getGuideRoute, getRoute, AC_PRESETS } from './nanju-router'

describe('getGuideRoute（nanju:get-route 数据面）', () => {
  test('quick：6 个阶段（含 delivered 哨兵；W7 v0.17.69 起必经 architecture 轻量变体），taskWeight=light，acActors=light 预设', () => {
    const route = getGuideRoute('quick')
    expect(route.length).toBe(6)
    expect(route.map((p) => p.id)).toEqual(['requirements', 'prototype', 'architecture', 'coding', 'testing', 'delivered'])
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

  test('iterative：7 个阶段（含 delivered 哨兵；Sprint B 起 testing 入路由），taskWeight=medium，acActors=medium 预设', () => {
    const route = getGuideRoute('iterative')
    expect(route.map((p) => p.id)).toEqual(['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing', 'delivered'])
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
    expect(quick.find((p) => p.id === 'coding')?.outputPath).toBe('08_APP/index.html')
    expect(iterative.find((p) => p.id === 'architecture')?.outputPath).toBe('03_ARCHITECTURE/architecture.md')
    expect(iterative.find((p) => p.id === 'planning')?.outputPath).toBe('05_PROJECT_PLAN/plan.md')
    expect(iterative.find((p) => p.id === 'coding')?.outputPath).toBe('08_APP/index.html')
  })

  test('prototype next 指向：两模式统一→architecture（W7 v0.17.69 断言反转）；quick architecture→coding / iterative planning→coding；coding next=testing；testing next=delivered', () => {
    expect(getGuideRoute('quick').find((p) => p.id === 'prototype')?.next).toBe('architecture')
    expect(getGuideRoute('iterative').find((p) => p.id === 'prototype')?.next).toBe('architecture')
    expect(getGuideRoute('quick').find((p) => p.id === 'architecture')?.next).toBe('coding')
    expect(getGuideRoute('iterative').find((p) => p.id === 'planning')?.next).toBe('coding')
    expect(getGuideRoute('quick').find((p) => p.id === 'coding')?.next).toBe('testing')
    expect(getGuideRoute('iterative').find((p) => p.id === 'coding')?.next).toBe('testing')
    expect(getGuideRoute('quick').find((p) => p.id === 'testing')?.next).toBe('delivered')
    expect(getGuideRoute('iterative').find((p) => p.id === 'testing')?.next).toBe('delivered')
  })

  test('requiresAC 硬门禁仅 iterative architecture 为 true（W7：quick architecture 免 AC，U1）', () => {
    const iterative = getGuideRoute('iterative')
    expect(iterative.find((p) => p.id === 'architecture')?.requiresAC).toBe(true)
    expect(iterative.filter((p) => p.id !== 'architecture').every((p) => !p.requiresAC)).toBe(true)
    // quick 全阶段免 red 硬门禁（architecture 轻量变体同样免）
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

  test('阶段角色与模型（v0.16.87 基准：UX 顾问为 MiniMax-M3 家族标记；v0.17.60：coding 为全栈开发）', () => {
    const iterative = getGuideRoute('iterative')
    const byTitle = (phase: string) => iterative.find((p) => p.id === phase)
    expect(byTitle('requirements')?.title).toBe('需求分析师')
    expect(byTitle('prototype')?.model).toBe('MiniMax-M3')
    expect(byTitle('architecture')?.title).toBe('架构师')
    expect(byTitle('planning')?.title).toBe('工程经理')
    expect(byTitle('coding')?.title).toBe('全栈开发')
    expect(byTitle('coding')?.role).toBe('fullstack-developer')
    expect(byTitle('coding')?.model).toBe('deepseek-v4-pro')
    // v0.17.63：测试工程师回 deepseek-v4-pro（纯文本 spec 任务，不绑视觉模型）
    expect(byTitle('testing')?.model).toBe('deepseek-v4-pro')
    expect(byTitle('testing')?.channel).toBe('deepseek')
  })
})
