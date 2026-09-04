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
  test('light 预设：攻击 deepseek-v4-flash，防御 glm-5.3-flash', () => {
    expect(AC_PRESETS.light.attacker).toEqual({ channel: 'deepseek', model: 'deepseek-v4-flash' })
    expect(AC_PRESETS.light.defender).toEqual({ channel: 'glm-zhipu', model: 'glm-5.3-flash' })
  })

  test('medium 预设：攻击 deepseek-v4-pro，防御 GLM-5.3', () => {
    expect(AC_PRESETS.medium.attacker).toEqual({ channel: 'deepseek', model: 'deepseek-v4-pro' })
    expect(AC_PRESETS.medium.defender).toEqual({ channel: 'glm-zhipu', model: 'GLM-5.3' })
  })

  test('resolveACActors 按 taskWeight 选择预设', () => {
    const light = resolveACActors(makeNode({ taskWeight: 'light' }))
    expect(light.attacker.model).toBe('deepseek-v4-flash')
    expect(light.defender.model).toBe('glm-5.3-flash')

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
    expect(actors.defender).toEqual({ channel: 'glm-zhipu', model: 'glm-5.3-flash' })
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

  test('quick 路由：requirements → prototype → architecture → coding → testing → delivered（W7 v0.17.69 两模式必经架构师）；iterative 路由完整七阶段', () => {
    expect(getRoute('quick').map((n) => n.id)).toEqual(['requirements', 'prototype', 'architecture', 'coding', 'testing', 'delivered'])
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
  test('coding 节点定义：全栈开发 / glm-zhipu:GLM-5.3（W13b 用户 09-04 07:25 核心裁定，经参数文件下发）/ 08_APP/index.html / next=testing（Sprint B 改向）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const coding = getPhaseNode(mode, 'coding')
      expect(coding?.role).toBe('fullstack-developer')
      expect(coding?.title).toBe('全栈开发')
      expect(coding?.channel).toBe('glm-zhipu') // W13b：GLM 化（原 deepseek-v4-pro），值随 nanju-model-config 下发
      expect(coding?.model).toBe('GLM-5.3')
      expect(coding?.outputPath).toBe('08_APP/index.html')
      expect(coding?.next).toBe('testing')
      expect(coding?.requiresUserConfirmation).toBe(true)
      expect(coding?.requiresAC).toBe(false)
      expect(coding?.retryLimit).toBe(2)
      expect(coding?.taskWeight).toBe(mode === 'quick' ? 'light' : 'medium')
    }
  })

  test('路由统一：两模式 prototype.next=architecture（W7 v0.17.69，删除分叉）；iterative planning.next=coding；quick architecture.next=coding', () => {
    expect(getPhaseNode('quick', 'prototype')?.next).toBe('architecture')
    expect(getPhaseNode('iterative', 'prototype')?.next).toBe('architecture')
    expect(getPhaseNode('iterative', 'planning')?.next).toBe('coding')
    expect(getPhaseNode('quick', 'architecture')?.next).toBe('coding')
  })

  test('FORMAT_CHECKS：coding 接受 <html / <!DOCTYPE / <script（入口可运行）', () => {
    expect(checkOutputFormat('coding', '<html><body>x</body></html>')).toBe(true)
    expect(checkOutputFormat('coding', '<!DOCTYPE html>')).toBe(true)
    expect(checkOutputFormat('coding', '<script src="app.js"></script>')).toBe(true)
    expect(checkOutputFormat('coding', '这不是 HTML，没有脚本')).toBe(false)
  })

  test('W13b：coding 作者换 glm 系后显式覆盖 acDefender=minimax 系（两档预设防御者均 glm 系会同族抛错；攻者两档均 deepseek 系 → 唯一异族备援，W13 testing 先例）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const coding = getPhaseNode(mode, 'coding')!
      expect(coding.acDefenderChannel).toBe('minimax')
      expect(coding.acDefenderModel).toBe('MiniMax-M3')
      // 覆盖优先于预设（resolveACActors 显式字段优先）
      const actors = resolveACActors(coding)
      expect(actors.defender.channel).toBe('minimax')
      expect(actors.defender.model).toBe('MiniMax-M3')
      // 攻者仍为预设 deepseek 系（quick=light flash / iterative=medium pro）
      expect(actors.attacker.channel).toBe('deepseek')
      expect(actors.attacker.model).toBe(mode === 'quick' ? 'deepseek-v4-flash' : 'deepseek-v4-pro')
    }
  })

  test('W13b 反例锁定：若不覆盖 acDefender，glm 作者与两档预设防御者必抛错（覆盖位的必要性回归钉）', () => {
    for (const weight of ['light', 'medium'] as const) {
      const coding = getPhaseNode('quick', 'coding')!
      const presetDefender = AC_PRESETS[weight].defender.channel
      expect(() => assertACFamilyDiversity({
        authorChannel: coding.channel,
        attackerChannel: 'deepseek',
        defenderChannel: presetDefender,
      })).toThrow('防御者渠道')
    }
  })

  test('coding 作者与覆盖后的 AC 攻防满足家族多样性断言（defender=minimax ≠ author=glm；attacker=deepseek ≠ defender）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const coding = getPhaseNode(mode, 'coding')!
      const actors = resolveACActors(coding)
      expect(() => assertACFamilyDiversity({
        authorChannel: coding.channel,
        attackerChannel: actors.attacker.channel,
        defenderChannel: actors.defender.channel,
      })).not.toThrow()
    }
  })
})

describe('planning 阶段（W13：v4-pro → v4-flash 降档）', () => {
  test('planning 节点定义：工程经理 / deepseek-v4-flash（模板化拆分，技术决策已由 architecture 终判）/ 05_PROJECT_PLAN/plan.md / next=coding', () => {
    const planning = getPhaseNode('iterative', 'planning')
    expect(planning?.role).toBe('engineering-manager')
    expect(planning?.title).toBe('工程经理')
    expect(planning?.channel).toBe('deepseek')
    expect(planning?.model).toBe('deepseek-v4-flash') // W13 降档：无独立技术决策耦合，成本敏感
    expect(planning?.outputPath).toBe('05_PROJECT_PLAN/plan.md')
    expect(planning?.next).toBe('coding')
    expect(planning?.requiresUserConfirmation).toBe(true)
    expect(planning?.requiresAC).toBe(false)
    expect(planning?.retryLimit).toBe(2)
    expect(planning?.taskWeight).toBe('medium')
    // quick 模式无 planning 节点（架构后直入 coding）
    expect(getPhaseNode('quick', 'planning')).toBeUndefined()
  })

  test('planning 作者 deepseek-flash 与两档预设防御者（glm 系）均满足家族多样性断言（降档不影响断言）', () => {
    const planning = getPhaseNode('iterative', 'planning')!
    const actors = resolveACActors(planning)
    expect(() => assertACFamilyDiversity({
      authorChannel: planning.channel,
      attackerChannel: actors.attacker.channel,
      defenderChannel: actors.defender.channel,
    })).not.toThrow()
  })
})

describe('architecture 阶段（W13b：deepseek-v4-pro → glm-zhipu:GLM-5.3，用户 09-04 07:25 核心裁定）', () => {
  test('两模式变体均换 GLM-5.3 + acDefender=minimax 覆盖（经参数文件下发；quick 变体同样需要——家族断言先于 skipInlineAC 执行）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const arch = getPhaseNode(mode, 'architecture')!
      expect(arch.channel).toBe('glm-zhipu')
      expect(arch.model).toBe('GLM-5.3')
      expect(arch.acDefenderChannel).toBe('minimax')
      expect(arch.acDefenderModel).toBe('MiniMax-M3')
      const actors = resolveACActors(arch)
      expect(actors.defender).toEqual({ channel: 'minimax', model: 'MiniMax-M3' })
      expect(actors.attacker.model).toBe(mode === 'quick' ? 'deepseek-v4-flash' : 'deepseek-v4-pro')
      expect(() => assertACFamilyDiversity({
        authorChannel: arch.channel,
        attackerChannel: actors.attacker.channel,
        defenderChannel: actors.defender.channel,
      })).not.toThrow()
    }
  })

  test('W13b 反例锁定：不覆盖 acDefender 时 glm 作者与两档预设防御者必抛错（与 W13 testing 反例同型）', () => {
    for (const weight of ['light', 'medium'] as const) {
      const arch = getPhaseNode('iterative', 'architecture')!
      expect(() => assertACFamilyDiversity({
        authorChannel: arch.channel,
        attackerChannel: 'deepseek',
        defenderChannel: AC_PRESETS[weight].defender.channel,
      })).toThrow('防御者渠道')
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
  test('testing 节点定义：测试工程师 / glm-5.3-flash（W13 用户裁定：机械任务+视觉+成本）/ 06_TESTS/features/index.feature / next=delivered', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const testing = getPhaseNode(mode, 'testing')
      expect(testing?.role).toBe('test-engineer')
      expect(testing?.title).toBe('测试工程师')
      expect(testing?.channel).toBe('glm-zhipu') // W13：机械任务+视觉能力+成本（替代 v4-pro 的贵+无视觉双重错配）
      expect(testing?.model).toBe('glm-5.3-flash')
      expect(testing?.outputPath).toBe('06_TESTS/features/index.feature')
      expect(testing?.next).toBe('delivered')
      expect(testing?.requiresUserConfirmation).toBe(false) // 机器判定收口（裁判规则），不做人肉确认
      expect(testing?.requiresAC).toBe(false)
      expect(testing?.retryLimit).toBe(2) // PRD §9.3：测试回炉上限 2 次
      expect(testing?.taskWeight).toBe(mode === 'quick' ? 'light' : 'medium')
    }
  })

  test('W13：testing 作者换 glm 系后显式覆盖 acDefender=minimax 系（两档预设防御者均 glm 系会同族抛错；攻者均 deepseek 系 → 唯一异族备援）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const testing = getPhaseNode(mode, 'testing')!
      expect(testing.acDefenderChannel).toBe('minimax')
      expect(testing.acDefenderModel).toBe('MiniMax-M3')
      // 覆盖优先于预设（resolveACActors 显式字段优先）
      const actors = resolveACActors(testing)
      expect(actors.defender.channel).toBe('minimax')
      expect(actors.defender.model).toBe('MiniMax-M3')
      // 攻者仍为预设 deepseek 系（quick=light flash / iterative=medium pro）
      expect(actors.attacker.channel).toBe('deepseek')
      expect(actors.attacker.model).toBe(mode === 'quick' ? 'deepseek-v4-flash' : 'deepseek-v4-pro')
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

  test('W13 反例锁定：若不覆盖 acDefender，glm 作者与预设防御者同族必抛错（覆盖位的必要性回归锥）', () => {
    for (const weight of ['light', 'medium'] as const) {
      const testing = getPhaseNode('quick', 'testing')!
      const presetDefender = AC_PRESETS[weight].defender.channel
      expect(() => assertACFamilyDiversity({
        authorChannel: testing.channel,
        attackerChannel: 'deepseek',
        defenderChannel: presetDefender,
      })).toThrow('防御者渠道')
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

  test('architecture 约束含品类终判要求（可修正 PRD 初判）；W7 v0.17.69 quick 变体不再 undefined', () => {
    const constraints = getPhaseNode('iterative', 'architecture')!.constraints.join('\n')
    expect(constraints).toContain('工程品类终判')
    expect(constraints).toContain('可修正 PRD 初判')
    // W7 断言反转（R7）：quick 必经架构师环节（轻量变体）
    const quickArch = getPhaseNode('quick', 'architecture')
    expect(quickArch).toBeDefined()
    expect(quickArch?.requiresAC).toBe(false)
    expect(quickArch?.requiresUserConfirmation).toBe(true)
    expect(quickArch?.taskWeight).toBe('light')
    expect(quickArch?.outputPath).toBe('03_ARCHITECTURE/architecture.md')
    // 两变体均含环境探测与缺失报告指令（W7 v3 §六）
    for (const mode of ['quick', 'iterative'] as const) {
      const c = getPhaseNode(mode, 'architecture')!.constraints.join('\n')
      expect(c).toContain('工程环境探测')
      expect(c).toContain('projectEnv: ready')
      expect(c).toContain('不擅自安装')
    }
    // iterative 变体专属：模板必读 + 环境配置清单节（W7 v3 §五）
    const iterC = getPhaseNode('iterative', 'architecture')!.constraints.join('\n')
    expect(iterC).toContain('必读工程模板')
    expect(iterC).toContain('## 环境配置')
  })
})
