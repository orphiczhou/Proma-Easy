import { describe, expect, test } from 'bun:test'
import {
  AC_PRESETS,
  assertACFamilyDiversity,
  channelFamily,
  checkOutputFormat,
  getPhaseNode,
  getRoute,
  resolveACActors,
  type PhaseNode,
} from './nanju-router'

/** 构造最小可用的 PhaseNode（测试辅助） */
function makeNode(overrides: Partial<PhaseNode> = {}): PhaseNode {
  return {
    id: 'requirements',
    role: 'test',
    title: '测试阶段',
    channel: 'deepseek',
    model: 'deepseek-v4-pro',
    task: '测试任务',
    outputPath: '01_PRD/prd.md',
    constraints: [],
    requiresUserConfirmation: false,
    requiresAC: false,
    retryLimit: 1,
    next: null,
    ...overrides,
  }
}

describe('AC 审计分级预设', () => {
  test('light 预设：攻击 deepseek-v4-flash，防御 glm-5-turbo', () => {
    expect(AC_PRESETS.light.attacker).toEqual({ channel: 'deepseek', model: 'deepseek-v4-flash' })
    expect(AC_PRESETS.light.defender).toEqual({ channel: 'glm-zhipu', model: 'glm-5-turbo' })
  })

  test('medium 预设：攻击 deepseek-v4-pro，防御 GLM-5.3', () => {
    expect(AC_PRESETS.medium.attacker).toEqual({ channel: 'deepseek', model: 'deepseek-v4-pro' })
    expect(AC_PRESETS.medium.defender).toEqual({ channel: 'glm-zhipu', model: 'GLM-5.3' })
  })

  test('resolveACActors 按 taskWeight 选择预设', () => {
    const light = resolveACActors(makeNode({ taskWeight: 'light' }))
    expect(light.attacker.model).toBe('deepseek-v4-flash')
    expect(light.defender.model).toBe('glm-5-turbo')

    const medium = resolveACActors(makeNode({ taskWeight: 'medium' }))
    expect(medium.attacker.model).toBe('deepseek-v4-pro')
    expect(medium.defender.model).toBe('GLM-5.3')
  })

  test('未标注 taskWeight 时默认按 medium 处理', () => {
    const actors = resolveACActors(makeNode())
    expect(actors.attacker).toEqual(AC_PRESETS.medium.attacker)
    expect(actors.defender).toEqual(AC_PRESETS.medium.defender)
  })

  test('显式 acAttacker/acDefender 字段覆盖预设（优先级：显式 > 预设）', () => {
    const actors = resolveACActors(makeNode({
      taskWeight: 'light',
      acAttackerChannel: 'glm-zhipu',
      acAttackerModel: 'glm-5.2',
    }))
    // 显式攻击者生效
    expect(actors.attacker).toEqual({ channel: 'glm-zhipu', model: 'glm-5.2' })
    // 未显式指定的防御者仍取 light 预设
    expect(actors.defender).toEqual({ channel: 'glm-zhipu', model: 'glm-5-turbo' })
  })

  test('防御者显式覆盖 + 攻击者走预设', () => {
    const actors = resolveACActors(makeNode({
      taskWeight: 'medium',
      acDefenderChannel: 'kimi',
      acDefenderModel: 'k3',
    }))
    expect(actors.attacker).toEqual(AC_PRESETS.medium.attacker)
    expect(actors.defender).toEqual({ channel: 'kimi', model: 'k3' })
  })
})

describe('quick/iterative 默认分级映射', () => {
  test('quick 模式所有活跃阶段为 light，SENTINEL 不参与', () => {
    const nodes = getRoute('quick')
    for (const node of nodes) {
      if (node.id === 'delivered') {
        expect(node.taskWeight).toBeUndefined()
      } else {
        expect(node.taskWeight).toBe('light')
      }
    }
  })

  test('iterative 模式所有活跃阶段为 medium', () => {
    const nodes = getRoute('iterative')
    for (const node of nodes) {
      if (node.id === 'delivered') {
        expect(node.taskWeight).toBeUndefined()
      } else {
        expect(node.taskWeight).toBe('medium')
      }
    }
  })

  test('quick 路由：requirements → prototype → coding → testing → delivered；iterative 路由完整六阶段（Sprint B 起 testing 入路由）', () => {
    expect(getRoute('quick').map((n) => n.id)).toEqual(['requirements', 'prototype', 'coding', 'testing', 'delivered'])
    expect(getRoute('iterative').map((n) => n.id)).toEqual([
      'requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing', 'delivered',
    ])
  })

  test('两种模式的各阶段 AC 配置均满足家族多样性断言（作者按节点渠道）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      for (const node of getRoute(mode)) {
        if (node.id === 'delivered') continue
        const actors = resolveACActors(node)
        expect(() => assertACFamilyDiversity({
          authorChannel: node.channel,
          attackerChannel: actors.attacker.channel,
          defenderChannel: actors.defender.channel,
        })).not.toThrow()
      }
    }
  })

  test('prototype 作者为 MiniMax-M3（视觉模型），渠道为运行时解析标记', () => {
    const quickPrototype = getPhaseNode('quick', 'prototype')
    const iterativePrototype = getPhaseNode('iterative', 'prototype')
    expect(quickPrototype?.model).toBe('MiniMax-M3')
    expect(iterativePrototype?.model).toBe('MiniMax-M3')
    // 'minimax' 仅是家族标记，实际渠道 ID 在构建委派指令时运行时解析
    expect(quickPrototype?.channel).toBe('minimax')
  })
})

describe('coding 阶段（P1 Sprint A：向导域→编程域贯通）', () => {
  test('coding 节点定义：全栈开发 / deepseek-v4-pro / 08_APP/index.html / next=testing（Sprint B 改向）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const coding = getPhaseNode(mode, 'coding')
      expect(coding?.role).toBe('fullstack-developer')
      expect(coding?.title).toBe('全栈开发')
      expect(coding?.channel).toBe('deepseek')
      expect(coding?.model).toBe('deepseek-v4-pro')
      expect(coding?.outputPath).toBe('08_APP/index.html')
      expect(coding?.next).toBe('testing')
      expect(coding?.requiresUserConfirmation).toBe(true)
      expect(coding?.requiresAC).toBe(false)
      expect(coding?.retryLimit).toBe(2)
      expect(coding?.taskWeight).toBe(mode === 'quick' ? 'light' : 'medium')
    }
  })

  test('路由改向：quick prototype.next=coding；iterative planning.next=coding（两条链均贯通到代码交付）', () => {
    expect(getPhaseNode('quick', 'prototype')?.next).toBe('coding')
    expect(getPhaseNode('iterative', 'planning')?.next).toBe('coding')
    expect(getPhaseNode('iterative', 'prototype')?.next).toBe('architecture')
  })

  test('FORMAT_CHECKS：coding 接受 <html / <!DOCTYPE / <script（入口可运行）', () => {
    expect(checkOutputFormat('coding', '<html><body>x</body></html>')).toBe(true)
    expect(checkOutputFormat('coding', '<!DOCTYPE html>')).toBe(true)
    expect(checkOutputFormat('coding', '<script src="app.js"></script>')).toBe(true)
    expect(checkOutputFormat('coding', '这不是 HTML，没有脚本')).toBe(false)
  })

  test('coding 作者 deepseek 系与两套 AC 预设防御者（glm 系）均满足家族多样性断言', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const coding = getPhaseNode(mode, 'coding')!
      const actors = resolveACActors(coding)
      expect(actors.defender.channel).not.toBe(coding.channel)
      expect(() => assertACFamilyDiversity({
        authorChannel: coding.channel,
        attackerChannel: actors.attacker.channel,
        defenderChannel: actors.defender.channel,
      })).not.toThrow()
    }
  })
})

describe('渠道家族判定', () => {
  test('按前缀归类：deepseek=ds系、glm-zhipu=智谱系、minimax=M3系', () => {
    expect(channelFamily('deepseek')).toBe('family-deepseek')
    expect(channelFamily('deepseek-backup')).toBe('family-deepseek')
    expect(channelFamily('glm-zhipu')).toBe('family-glm')
    expect(channelFamily('glm-zhipu-2')).toBe('family-glm')
    expect(channelFamily('minimax')).toBe('family-minimax')
    expect(channelFamily('minimax-channel')).toBe('family-minimax')
  })

  test('无法识别前缀的渠道（如 minimax UUID 渠道 ID）视为独立家族', () => {
    const uuid = 'ad74ac74-1111-2222-3333-444455556666'
    expect(channelFamily(uuid)).toBe(uuid)
    expect(channelFamily(uuid)).not.toBe(channelFamily('deepseek'))
  })
})

describe('AC 家族多样性断言', () => {
  test('防御者与作者同家族时抛错（修复「防御者=作者同家族」缺陷）', () => {
    expect(() => assertACFamilyDiversity({
      authorChannel: 'deepseek',
      attackerChannel: 'glm-zhipu',
      defenderChannel: 'deepseek',
    })).toThrow('防御者渠道')
  })

  test('防御者与作者同前缀家族（不同渠道 ID）时抛错', () => {
    expect(() => assertACFamilyDiversity({
      authorChannel: 'deepseek',
      attackerChannel: 'glm-zhipu',
      defenderChannel: 'deepseek-backup',
    })).toThrow('同一家族')
  })

  test('攻击者与防御者同家族时抛错', () => {
    expect(() => assertACFamilyDiversity({
      authorChannel: 'deepseek',
      attackerChannel: 'glm-zhipu',
      defenderChannel: 'glm-zhipu-pro',
    })).toThrow('攻击者渠道')
  })

  test('作者/攻/防分属不同家族时通过', () => {
    expect(() => assertACFamilyDiversity({
      authorChannel: 'deepseek',
      attackerChannel: 'deepseek',
      defenderChannel: 'glm-zhipu',
    })).not.toThrow()
  })

  test('minimax UUID 作者渠道与字面攻防渠道天然不同家族，通过', () => {
    expect(() => assertACFamilyDiversity({
      authorChannel: 'ad74ac74-1111-2222-3333-444455556666',
      attackerChannel: 'deepseek',
      defenderChannel: 'glm-zhipu',
    })).not.toThrow()
  })
})

describe('testing 阶段（P1 Sprint B：GWT 验收 + 裁判判定闭环）', () => {
  test('testing 节点定义：测试工程师 / deepseek-v4-pro（v0.17.63 回退，仲裁 selection_ruling）/ 06_TESTS/features/index.feature / next=delivered', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const testing = getPhaseNode(mode, 'testing')
      expect(testing?.role).toBe('test-engineer')
      expect(testing?.title).toBe('测试工程师')
      expect(testing?.channel).toBe('deepseek') // 纯文本 spec 生成任务，不绑视觉模型（AC F-001）
      expect(testing?.model).toBe('deepseek-v4-pro')
      expect(testing?.outputPath).toBe('06_TESTS/features/index.feature')
      expect(testing?.next).toBe('delivered')
      expect(testing?.requiresUserConfirmation).toBe(false) // 机器判定收口（裁判规则），不做人肉确认
      expect(testing?.requiresAC).toBe(false)
      expect(testing?.retryLimit).toBe(2) // PRD §9.3：测试回炉上限 2 次
      expect(testing?.taskWeight).toBe(mode === 'quick' ? 'light' : 'medium')
    }
  })

  test('testing 作者与 AC 攻防满足家族多样性断言（defender≠author / attacker≠defender；不再自设 testing≠coding 家族约束）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const testing = getPhaseNode(mode, 'testing')!
      const actors = resolveACActors(testing)
      expect(() => assertACFamilyDiversity({
        authorChannel: testing.channel,
        attackerChannel: actors.attacker.channel,
        defenderChannel: actors.defender.channel,
      })).not.toThrow()
    }
  })

  test('testing 约束含映射前提（先读 08_APP 实码提 data-ai-id）与透明 skip 语义；不含自由 JS op（v0.17.63）', () => {
    const constraints = getPhaseNode('quick', 'testing')!.constraints.join('\n')
    expect(constraints).toContain('先 Read 08_APP/index.html')
    expect(constraints).toContain('禁止臆造 selector')
    expect(constraints).toContain('unmapped')
    expect(constraints).toContain('禁止严格时刻断言')
    expect(constraints.includes('eval')).toBe(false) // 自由 JS op 已移除（AC G-001/G-002）
  })

  test('FORMAT_CHECKS：testing 接受 Feature: + Scenario:（中文 Gherkin 最低结构）', () => {
    expect(checkOutputFormat('testing', 'Feature: 读书笔记\nScenario: US-01 添加笔记\n  Given 用户在列表页')).toBe(true)
    expect(checkOutputFormat('testing', '# 这只是 markdown，没有 Gherkin 结构')).toBe(false)
  })

  test('requirements 上游软门禁：PRD 应含 US-xx 编号用户故事清单提示（AC F-002）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const constraints = getPhaseNode(mode, 'requirements')!.constraints.join('\n')
      expect(constraints).toContain('US-xx')
      expect(constraints).toContain('覆盖性')
    }
  })
})

describe('工程品类上游标注门禁（W3，v0.17.66）', () => {
  test('requirements 约束含品类初判要求（PRD 标注格式 + 六品类枚举说明）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const constraints = getPhaseNode(mode, 'requirements')!.constraints.join('\n')
      expect(constraints).toContain('工程品类初判')
      expect(constraints).toContain('projectCategory')
      expect(constraints).toContain('desktop-app')
      expect(constraints).toContain('web-fullstack')
    }
  })

  test('architecture 约束含品类终判要求（可修正 PRD 初判）', () => {
    const constraints = getPhaseNode('iterative', 'architecture')!.constraints.join('\n')
    expect(constraints).toContain('工程品类终判')
    expect(constraints).toContain('可修正 PRD 初判')
    // quick 模式无 architecture 阶段
    expect(getPhaseNode('quick', 'architecture')).toBeUndefined()
  })
})
