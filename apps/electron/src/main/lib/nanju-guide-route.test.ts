/**
 * getGuideRoute 测试（nanju:get-route IPC 的数据面，修订 R2）
 *
 * 保证：透传 getRoute(mode) 全部阶段字段 + 每 phase 附加 resolveACActors 解析结果；
 * quick/iterative 两版的 outputPath/next/AC 强度与 nanju-router.ts 单一真相源一致。
 */

import { describe, expect, test } from 'bun:test'
import { getGuideRoute, getRoute, AC_PRESETS } from './nanju-router'

describe('getGuideRoute（nanju:get-route 数据面）', () => {
  test('quick：6 个阶段（含 delivered 哨兵；W7 v0.17.69 起必经 architecture 轻量变体），taskWeight=light，acActors=light 预设（例外：architecture/coding 防御者=minimax 覆盖；testing 攻+防双覆盖，W22 M#7）', () => {
    const route = getGuideRoute('quick')
    expect(route.length).toBe(6)
    expect(route.map((p) => p.id)).toEqual(['requirements', 'prototype', 'architecture', 'coding', 'testing', 'delivered'])
    for (const phase of route) {
      if (phase.id === 'delivered') continue
      expect(phase.taskWeight).toBe('light')
      // W22 M#7：testing 双覆盖（攻 glm / 防 minimax）；architecture/coding 仅防御者覆盖
      //（作者 glm 系阶段防御者必须异族）；其余阶段 = light 预设
      const expected = phase.id === 'architecture' || phase.id === 'coding'
        ? { attacker: AC_PRESETS.light.attacker, defender: { channel: 'minimax', model: 'MiniMax-M3' } }
        : phase.id === 'testing'
          ? {
              attacker: { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
              defender: { channel: 'minimax', model: 'MiniMax-M3' },
            }
          : AC_PRESETS.light
      expect(phase.acActors).toEqual(expected)
    }
    // 哨兵节点字段为空（渲染端按 id==='delivered' 过滤，修订 Y3）
    const sentinel = route.find((p) => p.id === 'delivered')
    expect(sentinel?.role).toBe('')
    expect(sentinel?.outputPath).toBe('')
  })

  test('iterative：7 个阶段（含 delivered 哨兵；Sprint B 起 testing 入路由），taskWeight=medium，acActors=medium 预设（例外：architecture/coding 防御者=minimax 覆盖；testing 攻+防双覆盖，W22 M#7）', () => {
    const route = getGuideRoute('iterative')
    expect(route.map((p) => p.id)).toEqual(['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing', 'delivered'])
    for (const phase of route) {
      if (phase.id === 'delivered') continue
      expect(phase.taskWeight).toBe('medium')
      const expected = phase.id === 'architecture' || phase.id === 'coding'
        ? { attacker: AC_PRESETS.medium.attacker, defender: { channel: 'minimax', model: 'MiniMax-M3' } }
        : phase.id === 'testing'
          ? {
              attacker: { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
              defender: { channel: 'minimax', model: 'MiniMax-M3' },
            }
          : AC_PRESETS.medium
      expect(phase.acActors).toEqual(expected)
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

  test('阶段角色与模型（v0.16.87 基准：UX 顾问为 MiniMax-M3 家族标记；W13b：coding/architecture 换 glm-zhipu:GLM-5.3）', () => {
    const iterative = getGuideRoute('iterative')
    const byTitle = (phase: string) => iterative.find((p) => p.id === phase)
    expect(byTitle('requirements')?.title).toBe('需求分析师')
    expect(byTitle('prototype')?.model).toBe('MiniMax-M3')
    expect(byTitle('architecture')?.title).toBe('架构师')
    // W13b：架构师 GLM 化（用户 09-04 07:25 核心裁定，经参数文件下发）
    expect(byTitle('architecture')?.model).toBe('GLM-5.3')
    expect(byTitle('architecture')?.channel).toBe('glm-zhipu')
    expect(byTitle('planning')?.title).toBe('工程经理')
    expect(byTitle('coding')?.title).toBe('全栈开发')
    expect(byTitle('coding')?.role).toBe('fullstack-developer')
    // W13b：coding GLM 化（原 deepseek-v4-pro）
    expect(byTitle('coding')?.model).toBe('GLM-5.3')
    expect(byTitle('coding')?.channel).toBe('glm-zhipu')
    // W22 M#6：测试工程师换 deepseek-v4-flash（跨族：与 coding 的 glm 系异族，恢复开发/测试独立性）
    expect(byTitle('testing')?.model).toBe('deepseek-v4-flash')
    expect(byTitle('testing')?.channel).toBe('deepseek')
    // W13：planning 降档 deepseek-v4-flash（模板化拆分）
    expect(byTitle('planning')?.model).toBe('deepseek-v4-flash')
  })
})
