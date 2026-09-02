/**
 * 向导图 DSL 生成器 + Todo 前缀解析 + 进度派生 快照/行为测试（AC-02/03/04/11/12/13）
 *
 * fixture 与 nanju-router.ts getRoute() 输出字段一致（结构一致性由主进程 getGuideRoute
 * 测试单独保证；本文件聚焦 DSL 生成与派生纯函数）。
 */

import { describe, expect, test } from 'bun:test'
import type { GuideRoutePhase } from '@proma/shared'
import {
  buildGuideDsl,
  computeStageStates,
  computeTodoStats,
  derivePhaseSubNodeStates,
  deriveSubStageStates,
  parseTodoPhase,
  resolveExpandedPhases,
  resolveGuideNodeTarget,
  type GuidePhaseId,
} from './guide-dsl'

// ===== fixture（字段值与 nanju-router.ts makeRoute 一致；acActors = resolveACActors 解析结果） =====

const LIGHT_ACTORS = { attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' }, defender: { channel: 'glm-zhipu', model: 'glm-5-turbo' } }
const MEDIUM_ACTORS = { attacker: { channel: 'deepseek', model: 'deepseek-v4-pro' }, defender: { channel: 'glm-zhipu', model: 'GLM-5.3' } }

function makePhase(overrides: Partial<GuideRoutePhase>): GuideRoutePhase {
  return {
    id: 'requirements',
    role: 'requirement-analyst',
    title: '需求分析师',
    channel: 'deepseek',
    model: 'deepseek-v4-pro',
    task: '',
    outputPath: '01_PRD/prd.md',
    constraints: [],
    requiresUserConfirmation: true,
    requiresAC: false,
    retryLimit: 3,
    next: 'prototype',
    acActors: MEDIUM_ACTORS,
    ...overrides,
  }
}

/** 哨兵节点（id='delivered' 空节点，渲染端应过滤——修订 Y3） */
const SENTINEL: GuideRoutePhase = makePhase({
  id: 'delivered', role: '', title: '', channel: '', model: '', task: '', outputPath: '',
  constraints: [], requiresUserConfirmation: false, requiresAC: false, retryLimit: 0, next: null,
  acActors: MEDIUM_ACTORS,
})

const QUICK_ROUTE: GuideRoutePhase[] = [
  makePhase({ taskWeight: 'light', acActors: LIGHT_ACTORS }),
  makePhase({
    id: 'prototype', role: 'ux-advisor', title: 'UX 顾问', channel: 'minimax', model: 'MiniMax-M3',
    outputPath: '02_UX_DESIGN/prototype.html', retryLimit: 2, next: 'coding', taskWeight: 'light', acActors: LIGHT_ACTORS,
  }),
  makePhase({
    id: 'coding', role: 'fullstack-developer', title: '全栈开发', channel: 'deepseek', model: 'deepseek-v4-pro',
    outputPath: '08_APP/index.html', retryLimit: 2, next: 'testing', taskWeight: 'light', acActors: LIGHT_ACTORS,
  }),
  makePhase({
    id: 'testing', role: 'test-engineer', title: '测试工程师', channel: 'deepseek', model: 'deepseek-v4-pro',
    outputPath: '06_TESTS/features/index.feature', retryLimit: 2, next: 'delivered', taskWeight: 'light', acActors: LIGHT_ACTORS,
  }),
  SENTINEL,
]

const ITERATIVE_ROUTE: GuideRoutePhase[] = [
  makePhase({ taskWeight: 'medium', acActors: MEDIUM_ACTORS }),
  makePhase({
    id: 'prototype', role: 'ux-advisor', title: 'UX 顾问', channel: 'minimax', model: 'MiniMax-M3',
    outputPath: '02_UX_DESIGN/prototype.html', retryLimit: 2, next: 'architecture', taskWeight: 'medium', acActors: MEDIUM_ACTORS,
  }),
  makePhase({
    id: 'architecture', role: 'architect', title: '架构师', channel: 'deepseek', model: 'deepseek-v4-pro',
    outputPath: '03_ARCHITECTURE/architecture.md', requiresAC: true, retryLimit: 2, next: 'planning', taskWeight: 'medium', acActors: MEDIUM_ACTORS,
  }),
  makePhase({
    id: 'planning', role: 'engineering-manager', title: '工程经理', channel: 'deepseek', model: 'deepseek-v4-pro',
    outputPath: '05_PROJECT_PLAN/plan.md', retryLimit: 2, next: 'coding', taskWeight: 'medium', acActors: MEDIUM_ACTORS,
  }),
  makePhase({
    id: 'coding', role: 'fullstack-developer', title: '全栈开发', channel: 'deepseek', model: 'deepseek-v4-pro',
    outputPath: '08_APP/index.html', retryLimit: 2, next: 'testing', taskWeight: 'medium', acActors: MEDIUM_ACTORS,
  }),
  makePhase({
    id: 'testing', role: 'test-engineer', title: '测试工程师', channel: 'deepseek', model: 'deepseek-v4-pro',
    outputPath: '06_TESTS/features/index.feature', retryLimit: 2, next: 'delivered', taskWeight: 'medium', acActors: MEDIUM_ACTORS,
  }),
  SENTINEL,
]

/** 无进度叠加输入（结构快照用） */
const NO_PROGRESS = null

/** 全展开集合（W2 S3：进度模式默认只展开 current 阶段，着色类用例显式全展开保持原测试语义） */
const ALL_QUICK: GuidePhaseId[] = ['requirements', 'prototype', 'coding', 'testing']
const ALL_ITERATIVE: GuidePhaseId[] = ['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing']

// ===== AC-02：DSL 结构正确性 =====

describe('buildGuideDsl 结构（AC-02）', () => {
  test('quick 版：含 REQ/PROTO/CODE/TEST 主阶段与 delivered 终点，不含 ARCH/PLAN', () => {
    const dsl = buildGuideDsl({ mode: 'quick', route: QUICK_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(dsl).toContain('REQ[')
    expect(dsl).toContain('PROTO[')
    expect(dsl).toContain('CODE[')
    expect(dsl).toContain('TEST[')
    expect(dsl).toContain('DONE([\"交付 delivered')
    expect(dsl.includes('ARCH')).toBe(false)
    expect(dsl.includes('PLAN')).toBe(false)
  })

  test('iterative 版：含 REQ/PROTO/ARCH/PLAN/CODE/TEST 六个主阶段', () => {
    const dsl = buildGuideDsl({ mode: 'iterative', route: ITERATIVE_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(dsl).toContain('REQ[')
    expect(dsl).toContain('PROTO[')
    expect(dsl).toContain('ARCH[')
    expect(dsl).toContain('PLAN[')
    expect(dsl).toContain('CODE[')
    expect(dsl).toContain('TEST[')
  })

  test('两版 outputPath 与 nanju-router 一致', () => {
    const quick = buildGuideDsl({ mode: 'quick', route: QUICK_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(quick).toContain('01_PRD/prd.md')
    expect(quick).toContain('02_UX_DESIGN/prototype.html')
    expect(quick).toContain('08_APP/index.html')
    const iterative = buildGuideDsl({ mode: 'iterative', route: ITERATIVE_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(iterative).toContain('01_PRD/prd.md')
    expect(iterative).toContain('02_UX_DESIGN/prototype.html')
    expect(iterative).toContain('03_ARCHITECTURE/architecture.md')
    expect(iterative).toContain('05_PROJECT_PLAN/plan.md')
    expect(iterative).toContain('08_APP/index.html')
  })

  test('quick 边标签含 light、iterative 含 medium（AC 强度按模式整体分级）', () => {
    const quick = buildGuideDsl({ mode: 'quick', route: QUICK_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(quick).toContain('AC light')
    expect(quick).toContain('攻 deepseek-v4-flash / 防 glm-5-turbo')
    const iterative = buildGuideDsl({ mode: 'iterative', route: ITERATIVE_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(iterative).toContain('AC medium')
    expect(iterative).toContain('攻 deepseek-v4-pro / 防 GLM-5.3')
  })

  test('ARCH 子图含「AC 结论硬门禁」独立出口边文案，其余阶段不含（修订 Y2）；CODE 子图走默认分支', () => {
    const dsl = buildGuideDsl({ mode: 'iterative', route: ITERATIVE_ROUTE, progress: NO_PROGRESS, isDark: false })
    const archIndex = dsl.indexOf('subgraph SG_ARCH')
    const planIndex = dsl.indexOf('subgraph SG_PLAN')
    const reqIndex = dsl.indexOf('subgraph SG_REQ')
    const protoIndex = dsl.indexOf('subgraph SG_PROTO')
    const codeIndex = dsl.indexOf('subgraph SG_CODE')
    const archSub = dsl.slice(archIndex, planIndex)
    expect(archSub).toContain('AC 结论硬门禁')
    expect(archSub).toContain('ARCH_GATE')
    expect(dsl.slice(reqIndex, protoIndex)).not.toContain('AC 结论硬门禁')
    expect(dsl.slice(protoIndex, archIndex)).not.toContain('AC 结论硬门禁')
    expect(dsl.slice(planIndex, codeIndex)).not.toContain('AC 结论硬门禁')
    expect(dsl.slice(codeIndex)).not.toContain('AC 结论硬门禁')
    // coding 主节点 label：可运行应用代码 + 08_APP/index.html（走默认分支：产出→攻击者→防御者→用户确认）
    expect(dsl.slice(codeIndex)).toContain('可运行应用代码<br/>08_APP/index.html')
  })

  test('prototype 特有环节 + testing 特有环节（GWT 执行/规则裁判/回炉）+ 哨兵节点被过滤', () => {
    const dsl = buildGuideDsl({ mode: 'iterative', route: ITERATIVE_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(dsl).toContain('PROTO_SS{\"截图渲染自检循环')
    expect(dsl).toContain('PROTO_VIS{\"独立视觉裁决')
    // testing 子图：Harness 执行 GWT + 规则裁判（机器判定收口）+ 回炉 coding 循环
    expect(dsl).toContain('TEST_GWT{\"Harness 执行 GWT')
    expect(dsl).toContain('TEST_JUDGE{\"规则裁判 judge.verdict')
    expect(dsl).toContain('回炉 coding（≤2 次）')
    // 哨兵（id=delivered）不产生第七个 subgraph，只有 REQ/PROTO/ARCH/PLAN/CODE/TEST 六个 subgraph
    expect(dsl.match(/subgraph SG_/g)?.length).toBe(6)
  })

  test('对照模式（progress=null）不注入状态 class，仅注入中性参考样式 st-ref（AC-11 修订）', () => {
    const dsl = buildGuideDsl({ mode: 'quick', route: QUICK_ROUTE, progress: NO_PROGRESS, isDark: false })
    // 不注入任何状态 classDef/class（st-done/st-current/st-pending/st-sub-done）
    expect(dsl.includes('classDef st-done')).toBe(false)
    expect(dsl.includes('classDef st-current')).toBe(false)
    expect(dsl.includes('classDef st-pending')).toBe(false)
    expect(dsl.includes('st-sub-done')).toBe(false)
    expect(dsl.includes('class REQ st-')).toBe(false)
    expect(dsl.includes('linkStyle')).toBe(false)
    // 注入统一中性参考样式（与进度图一致的色块反差，不表状态）
    expect(dsl).toContain('classDef st-ref fill:#FFFFFF,stroke:#9CA3AF')
    expect(dsl).toContain('class USER,MODE,DONE,REQ,REQ_ATK,REQ_DEF,REQ_UC')
    expect(dsl).toContain('st-ref')
  })

  test('同一个输入生成确定性输出（快照稳定性）', () => {
    const a = buildGuideDsl({ mode: 'iterative', route: ITERATIVE_ROUTE, progress: { stageStates: { requirements: 'done' } }, isDark: false })
    const b = buildGuideDsl({ mode: 'iterative', route: ITERATIVE_ROUTE, progress: { stageStates: { requirements: 'done' } }, isDark: false })
    expect(a).toBe(b)
  })
})

// ===== AC-03：进度三态注入 =====

describe('buildGuideDsl 三态注入（AC-03）', () => {
  test('prototype 进行中：REQ=st-done、PROTO=st-current、子节点 st-sub-done、pending 灰态', () => {
    const dsl = buildGuideDsl({
      mode: 'quick',
      route: QUICK_ROUTE,
      progress: { stageStates: { requirements: 'done', prototype: 'current', coding: 'pending', delivered: 'pending' } },
      expandedPhases: ALL_QUICK,
      isDark: false,
    })
    expect(dsl).toContain('class REQ st-done')
    expect(dsl).toContain('class PROTO st-current')
    // REQ 阶段子节点跟随 done（弱一档）
    expect(dsl).toContain('class REQ_ATK,REQ_DEF,REQ_UC st-sub-done')
    // coding 未开始：主节点与子节点 pending 灰态
    expect(dsl).toContain('class CODE st-pending')
    expect(dsl).toContain('class CODE_ATK,CODE_DEF,CODE_UC st-pending')
    // classDef 三态色注入（亮色实色填充，背景/元素反差）
    expect(dsl).toContain('classDef st-done fill:#A7F3D0,stroke:#059669')
    expect(dsl).toContain('classDef st-current fill:#C7D2FE,stroke:#4F46E5')
    expect(dsl).toContain('classDef st-pending fill:#FFFFFF,stroke:#9CA3AF')
    // 已通过的跨阶段边加粗（linkStyle，边索引 7 = REQ_UC→PROTO（coding 加在 PROTO 之后，不影响该索引））
    expect(dsl).toContain('linkStyle 7 stroke:#059669,stroke-width:2.5px')
  })

  test('iterative：REQ done 时 ARCH/PLAN/CODE 子节点 st-pending 灰态', () => {
    const dsl = buildGuideDsl({
      mode: 'iterative',
      route: ITERATIVE_ROUTE,
      progress: { stageStates: { requirements: 'done', prototype: 'current', architecture: 'pending', planning: 'pending', coding: 'pending', delivered: 'pending' } },
      expandedPhases: ALL_ITERATIVE,
      isDark: false,
    })
    expect(dsl).toContain('class ARCH_ATK,ARCH_DEF,ARCH_GATE,ARCH_UC st-pending')
    expect(dsl).toContain('class PLAN_ATK,PLAN_DEF,PLAN_UC st-pending')
    expect(dsl).toContain('class CODE_ATK,CODE_DEF,CODE_UC st-pending')
  })

  test('delivered：全部 done + 终点 done 标记', () => {
    const dsl = buildGuideDsl({
      mode: 'quick',
      route: QUICK_ROUTE,
      progress: { stageStates: { requirements: 'done', prototype: 'done', coding: 'done', delivered: 'done' } },
      expandedPhases: ALL_QUICK,
      isDark: false,
    })
    expect(dsl).toContain('class DONE st-done')
    expect(dsl).toContain('class REQ st-done')
    expect(dsl).toContain('class PROTO st-done')
    expect(dsl).toContain('class CODE st-done')
    expect(dsl).toContain('class PROTO_SS,PROTO_VIS,PROTO_ATK,PROTO_DEF,PROTO_UC st-sub-done')
    expect(dsl).toContain('class CODE_ATK,CODE_DEF,CODE_UC st-sub-done')
  })

  test('暗色主题输出深色 classDef（AC-07 数据面）', () => {
    const dark = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: { stageStates: { requirements: 'done' } },
      expandedPhases: ALL_QUICK,
      isDark: true,
    })
    expect(dark).toContain('classDef st-done fill:#047857,stroke:#34D399')
    expect(dark).toContain('linkStyle 7 stroke:#34D399,stroke-width:2.5px')
  })

  test('abandoned：整图灰态、无 st-current、无动画锚点（修订 Y6）', () => {
    const dsl = buildGuideDsl({
      mode: 'iterative',
      route: ITERATIVE_ROUTE,
      progress: { stageStates: { requirements: 'done', prototype: 'current' }, abandoned: true },
      expandedPhases: ALL_ITERATIVE,
      isDark: false,
    })
    expect(dsl.includes('st-current')).toBe(true) // classDef 定义仍在（静态定义行）
    expect(dsl.includes('class PROTO st-current')).toBe(false) // 但不注入到任何节点
    expect(dsl).toContain('class REQ st-pending')
    expect(dsl).toContain('class PROTO st-pending')
    expect(dsl.includes('linkStyle')).toBe(false) // 无已通过边
  })
})

// ===== AC-04：Todo 徽标 =====

describe('buildGuideDsl Todo 徽标（AC-04）', () => {
  test('阶段主节点 label 追加 Todo 2/3', () => {
    const dsl = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: {
        stageStates: { requirements: 'done', prototype: 'current' },
        todoStats: { prototype: { done: 2, total: 3 } },
      },
      isDark: false,
    })
    expect(dsl).toContain('Todo 2/3')
  })

  test('无匹配 Todo 时不显示徽标且结构稳定', () => {
    const withNone = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: { stageStates: { requirements: 'done' } },
      isDark: false,
    })
    expect(withNone.includes('Todo ')).toBe(false)
  })
})

// ===== Todo 前缀解析（修订 Y5 + PRD §4.2） =====

describe('parseTodoPhase 前缀解析', () => {
  test('强制前缀精确匹配（Y5：调度员 Todo 命名规范）', () => {
    expect(parseTodoPhase('需求阶段：等待子会话产出')).toBe('requirements')
    expect(parseTodoPhase('原型阶段：委派 UX 顾问')).toBe('prototype')
    expect(parseTodoPhase('架构阶段：等待用户确认')).toBe('architecture')
    expect(parseTodoPhase('规划阶段：确认工程计划')).toBe('planning')
    expect(parseTodoPhase('开发阶段：委派全栈开发')).toBe('coding')
  })

  test('宽松关键词匹配（强制前缀启用前的历史 Todo 降级识别）', () => {
    expect(parseTodoPhase('需求收集三件套')).toBe('requirements')
    expect(parseTodoPhase('UX 原型迭代')).toBe('prototype')
    expect(parseTodoPhase('架构文档审查')).toBe('architecture')
    expect(parseTodoPhase('工程计划确认')).toBe('planning')
    expect(parseTodoPhase('计划评审')).toBe('planning')
    expect(parseTodoPhase('开发修复登录页')).toBe('coding')
    expect(parseTodoPhase('编码任务清单')).toBe('coding')
  })

  test('无法归类返回 null（该阶段无徽标，降级不报错）', () => {
    expect(parseTodoPhase('买杯咖啡')).toBeNull()
    expect(parseTodoPhase('')).toBeNull()
  })
})

describe('computeTodoStats 统计', () => {
  test('按前缀归类并统计完成度', () => {
    const { stats, todosByPhase } = computeTodoStats([
      { title: '原型阶段：委派 UX 顾问', status: 'completed' },
      { title: '原型阶段：等待产出', status: 'completed' },
      { title: '原型阶段：请用户确认', status: 'open' },
      { title: '其他杂项', status: 'open' },
    ])
    expect(stats.prototype).toEqual({ done: 2, total: 3 })
    expect(todosByPhase.prototype?.length).toBe(3)
    expect(stats.requirements).toBeUndefined()
  })
})

// ===== AC-12：边界 stage 容错 =====

describe('computeStageStates 边界态（AC-12）', () => {
  const quick = QUICK_ROUTE

  test('正常推进：prototype current', () => {
    const result = computeStageStates({ mode: 'quick', currentStage: 'prototype', status: 'active' }, quick)
    expect(result.stageStates.requirements).toBe('done')
    expect(result.stageStates.prototype).toBe('current')
    expect(result.stageStates.delivered).toBe('pending')
    expect(result.notice).toBeNull()
    expect(result.abandoned).toBe(false)
  })

  test('delivered：全部 done', () => {
    const result = computeStageStates({ mode: 'quick', currentStage: 'delivered', status: 'active' }, quick)
    expect(result.stageStates.requirements).toBe('done')
    expect(result.stageStates.prototype).toBe('done')
    expect(result.stageStates.delivered).toBe('done')
  })

  test('status=completed：全部 done', () => {
    const result = computeStageStates({ mode: 'quick', currentStage: 'requirements', status: 'completed' }, quick)
    expect(result.stageStates.delivered).toBe('done')
  })

  test('abandoned：全 pending + 提示（修订 Y6）', () => {
    const result = computeStageStates({ mode: 'quick', currentStage: 'prototype', status: 'abandoned' }, quick)
    expect(result.abandoned).toBe(true)
    expect(result.stageStates.requirements).toBe('pending')
    expect(result.stageStates.prototype).toBe('pending')
    expect(result.notice).toContain('放弃')
  })

  test('mode-select：全 pending + 引导提示', () => {
    const result = computeStageStates({ mode: 'quick', currentStage: 'mode-select', status: 'active' }, quick)
    expect(result.stageStates.requirements).toBe('pending')
    expect(result.notice).toContain('选择')
  })

  test('coding 是真实路由阶段：按序比较（iterative currentStage=coding → 前四阶段 done、coding current）', () => {
    const result = computeStageStates({ mode: 'iterative', currentStage: 'coding', status: 'active' }, ITERATIVE_ROUTE)
    expect(result.stageStates.requirements).toBe('done')
    expect(result.stageStates.prototype).toBe('done')
    expect(result.stageStates.architecture).toBe('done')
    expect(result.stageStates.planning).toBe('done')
    expect(result.stageStates.coding).toBe('current')
    expect(result.stageStates.delivered).toBe('pending')
    expect(result.notice).toBeNull()
  })

  test('coding 是真实路由阶段：quick currentStage=coding → prototype done、coding current', () => {
    const result = computeStageStates({ mode: 'quick', currentStage: 'coding', status: 'active' }, quick)
    expect(result.stageStates.requirements).toBe('done')
    expect(result.stageStates.prototype).toBe('done')
    expect(result.stageStates.coding).toBe('current')
    expect(result.stageStates.delivered).toBe('pending')
    expect(result.notice).toBeNull()
  })

  test('testing 阶段（Sprint B 入路由）：前序 done + testing current + 后续 pending（正常序比较）', () => {
    const result = computeStageStates({ mode: 'iterative', currentStage: 'testing', status: 'active' }, ITERATIVE_ROUTE)
    expect(result.stageStates.requirements).toBe('done')
    expect(result.stageStates.prototype).toBe('done')
    expect(result.stageStates.coding).toBe('done')
    expect(result.stageStates.testing).toBe('current')
    expect(result.stageStates.delivered).toBe('pending')
    expect(result.notice).toBeNull()
  })

  test('未知 stage：全 pending + 数据异常提示（不崩溃）', () => {
    const result = computeStageStates({ mode: 'quick', currentStage: '???', status: 'active' }, quick)
    expect(result.stageStates.requirements).toBe('pending')
    expect(result.notice).toContain('数据异常')
  })
})

// ===== SVG 节点锚点解析（交互后处理用） =====

describe('resolveGuideNodeTarget 锚点解析（AC-10 数据面）', () => {
  test('主节点 / 子节点 / 官方 mermaid flowchart-XX-n 形式', () => {
    expect(resolveGuideNodeTarget('REQ')).toBe('requirements')
    expect(resolveGuideNodeTarget('PROTO_ATK')).toBe('prototype')
    expect(resolveGuideNodeTarget('ARCH_GATE')).toBe('architecture')
    expect(resolveGuideNodeTarget('flowchart-REQ-0')).toBe('requirements')
    expect(resolveGuideNodeTarget('flowchart-PROTO_UC-12')).toBe('prototype')
    expect(resolveGuideNodeTarget('CODE')).toBe('coding')
    expect(resolveGuideNodeTarget('CODE_DEF')).toBe('coding')
    expect(resolveGuideNodeTarget('flowchart-CODE-4')).toBe('coding')
    expect(resolveGuideNodeTarget('USER')).toBe('user')
    expect(resolveGuideNodeTarget('MODE')).toBe('mode')
    expect(resolveGuideNodeTarget('DONE')).toBe('done')
  })

  test('未知节点返回 null（降级不绑定）', () => {
    expect(resolveGuideNodeTarget('')).toBeNull()
    expect(resolveGuideNodeTarget('OTHER')).toBeNull()
  })
})

// ===== 两版 DSL 完整快照样例（供人工核对 + 防结构回归） =====

describe('DSL 快照样例（两版 × 代表性进度态）', () => {
  test('quick · prototype 进行中', () => {
    const dsl = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: { stageStates: { requirements: 'done', prototype: 'current', delivered: 'pending' } },
      isDark: false,
    })
    expect(dsl).toMatchSnapshot()
  })

  test('iterative · architecture 进行中 + Todo 徽标', () => {
    const dsl = buildGuideDsl({
      mode: 'iterative', route: ITERATIVE_ROUTE,
      progress: {
        stageStates: { requirements: 'done', prototype: 'done', architecture: 'current', planning: 'pending', delivered: 'pending' },
        todoStats: { architecture: { done: 1, total: 3 } },
      },
      isDark: false,
    })
    expect(dsl).toMatchSnapshot()
  })
})

// ===== W2 S2：subStage 细分着色（current 阶段子节点三态） =====

describe('buildGuideDsl subStage 着色（W2 S2）', () => {
  test('current 阶段 subStage=REQ_UC：REQ 主节点 st-done、ATK/DEF pending（A2 修订：未接 AC 数据源不画成已通过）、UC current', () => {
    const dsl = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: {
        stageStates: { requirements: 'current', prototype: 'pending', coding: 'pending', delivered: 'pending' },
        subStage: 'REQ_UC',
      },
      expandedPhases: ALL_QUICK,
      isDark: false,
    })
    expect(dsl).toContain('class REQ st-done') // 产出完成：主节点转 done，脉冲移到 UC
    expect(dsl).toContain('class REQ_ATK,REQ_DEF st-pending') // 中间节点保持未开始（A2 修订）
    expect(dsl).toContain('class REQ_UC st-current')
  })

  test('current 阶段 subStage=REQ（作者产出中）：主节点 current、子节点全 pending', () => {
    const dsl = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: {
        stageStates: { requirements: 'current', prototype: 'pending', coding: 'pending', delivered: 'pending' },
        subStage: 'REQ',
      },
      expandedPhases: ALL_QUICK,
      isDark: false,
    })
    expect(dsl).toContain('class REQ st-current')
    expect(dsl).toContain('class REQ_ATK,REQ_DEF,REQ_UC st-pending')
  })

  test('subStage 缺失/不属于该阶段序列 → 降级为现状（current 阶段子节点无 class 行）', () => {
    const build = (subStage?: string): string => buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: {
        stageStates: { requirements: 'current', prototype: 'pending', coding: 'pending', delivered: 'pending' },
        ...(subStage !== undefined ? { subStage } : {}),
      },
      expandedPhases: ALL_QUICK,
      isDark: false,
    })
    for (const dsl of [build(), build('PROTO'), build('REQ_XX')]) {
      expect(dsl).toContain('class REQ st-current') // 主节点阶段三态不变
      expect(dsl.includes('class REQ_ATK')).toBe(false) // 子节点不注入细分 class（现状降级）
      expect(dsl.includes('class REQ_UC')).toBe(false)
    }
  })

  test('st-blocked classDef 预留（明暗两套；W2 S2 仅类型与样式先行，无数据源不接线）', () => {
    const light = buildGuideDsl({ mode: 'quick', route: QUICK_ROUTE, progress: { stageStates: { requirements: 'current' }, subStage: 'REQ' }, isDark: false })
    const dark = buildGuideDsl({ mode: 'quick', route: QUICK_ROUTE, progress: { stageStates: { requirements: 'current' }, subStage: 'REQ' }, isDark: true })
    expect(light).toContain('classDef st-blocked fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#92400E')
    expect(dark).toContain('classDef st-blocked fill:#78350F,stroke:#F59E0B,stroke-width:2px,color:#FEF3C7')
  })

  test('done/pending 阶段不受 subStage 影响（仅 current 阶段细分）', () => {
    const dsl = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: {
        stageStates: { requirements: 'done', prototype: 'current', coding: 'pending', delivered: 'pending' },
        subStage: 'PROTO_UC',
      },
      expandedPhases: ALL_QUICK,
      isDark: false,
    })
    // done 阶段 REQ 子节点仍全 sub-done；pending 阶段 CODE 子节点仍全 pending
    expect(dsl).toContain('class REQ_ATK,REQ_DEF,REQ_UC st-sub-done')
    expect(dsl).toContain('class CODE_ATK,CODE_DEF,CODE_UC st-pending')
    // current 阶段 PROTO 按 subStage=PROTO_UC 细分：主节点 done + UC current
    expect(dsl).toContain('class PROTO st-done')
    expect(dsl).toContain('class PROTO_UC st-current')
  })
})

// ===== W2 S3：展开/折叠 =====

describe('buildGuideDsl 展开/折叠（W2 S3）', () => {
  test('默认展开 = current 阶段：其余折叠为单代表框（无 subgraph），跨阶段边直连代表框', () => {
    const dsl = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: { stageStates: { requirements: 'done', prototype: 'current', coding: 'pending', delivered: 'pending' } },
      isDark: false,
    })
    // 只有 current 阶段 PROTO 输出 subgraph
    expect(dsl.match(/subgraph SG_/g)?.length).toBe(1)
    expect(dsl).toContain('subgraph SG_PROTO')
    // 折叠框：id=主节点（锚点兼容）+ 标题/产出/状态行摘要
    expect(dsl).toContain('REQ["① 需求分析师 requirement-analyst · deepseek-v4-pro<br/>产出 PRD<br/>✓ 已完成"]')
    expect(dsl).toContain('CODE["③ 全栈开发 fullstack-developer · deepseek-v4-pro<br/>可运行应用代码<br/>未开始"]')
    // 折叠阶段不输出内部边/子节点
    expect(dsl.includes('REQ_ATK')).toBe(false)
    expect(dsl.includes('CODE_UC')).toBe(false)
    // 跨阶段边：REQ 代表框 → PROTO 主节点（前阶段出口=折叠框自身）
    expect(dsl).toContain('REQ -->|"确认"| PROTO')
    expect(dsl).toContain('PROTO_UC -->|"全部用户故事通过"| CODE')
  })

  test('折叠框状态行三态 + Todo 徽标（行内拼接）', () => {
    const dsl = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: {
        stageStates: { requirements: 'done', prototype: 'current', coding: 'pending', delivered: 'pending' },
        todoStats: { requirements: { done: 3, total: 3 }, coding: { done: 0, total: 2 } },
      },
      isDark: false,
    })
    expect(dsl).toContain('✓ 已完成 Todo 3/3')
    expect(dsl).toContain('未开始 Todo 0/2')
    // current 阶段展开：主节点 label 徽标仍为 <br/> 拼接（现状不变）
    expect(dsl.includes('▶ 进行中<br/>')).toBe(false)
  })

  test('显式展开集合可临时多开（expandedPhases 覆盖默认派生）', () => {
    const dsl = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: { stageStates: { requirements: 'done', prototype: 'current', coding: 'pending', delivered: 'pending' } },
      expandedPhases: ['prototype', 'coding'],
      isDark: false,
    })
    expect(dsl.match(/subgraph SG_/g)?.length).toBe(2)
    expect(dsl).toContain('subgraph SG_PROTO')
    expect(dsl).toContain('subgraph SG_CODE')
    expect(dsl.includes('REQ_ATK')).toBe(false)
    // 非法 id 被过滤（不报错）
    const withInvalid = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: { stageStates: { requirements: 'current', delivered: 'pending' } },
      expandedPhases: ['requirements', 'no-such-phase' as GuidePhaseId],
      isDark: false,
    })
    expect(withInvalid).toContain('subgraph SG_REQ')
    expect(withInvalid.match(/subgraph SG_/g)?.length).toBe(1)
  })

  test('对照模式（progress=null）全展开：expandedPhases 不生效，结构快照不变', () => {
    const all = buildGuideDsl({ mode: 'quick', route: QUICK_ROUTE, progress: NO_PROGRESS, isDark: false })
    const withPhases = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE, progress: NO_PROGRESS,
      expandedPhases: ['requirements'], // 对照模式下被忽略
      isDark: false,
    })
    expect(all).toBe(withPhases)
    expect(all.match(/subgraph SG_/g)?.length).toBe(4)
  })

  test('无 current 阶段（已交付）默认全折叠：紧凑摘要视图 + 折叠框可正常着色', () => {
    const dsl = buildGuideDsl({
      mode: 'quick', route: QUICK_ROUTE,
      progress: { stageStates: { requirements: 'done', prototype: 'done', coding: 'done', testing: 'done', delivered: 'done' } },
      isDark: false,
    })
    expect((dsl.match(/subgraph SG_/g) ?? []).length).toBe(0)
    expect(dsl).toContain('class REQ st-done')
    expect(dsl).toContain('class DONE st-done')
    expect(dsl).toContain('✓ 已完成')
  })

  test('resolveExpandedPhases 默认派生规则单元', () => {
    const doneCur = { stageStates: { requirements: 'done', prototype: 'current' } as Partial<Record<GuidePhaseId | 'delivered', 'done' | 'current' | 'pending'>> }
    expect(resolveExpandedPhases(QUICK_ROUTE, doneCur)).toEqual(new Set(['prototype']))
    const noCurrent = { stageStates: { requirements: 'done', delivered: 'done' } as Partial<Record<GuidePhaseId | 'delivered', 'done' | 'current' | 'pending'>> }
    expect(resolveExpandedPhases(QUICK_ROUTE, noCurrent)).toEqual(new Set())
    expect(resolveExpandedPhases(QUICK_ROUTE, null)).toEqual(new Set(['requirements', 'prototype', 'coding', 'testing']))
  })

  test('deriveSubStageStates / derivePhaseSubNodeStates（渲染端纯函数，契约详见 nanju-guide-progress.test.ts 交叉锁定）', () => {
    expect(deriveSubStageStates('requirements', 'REQ_DEF')).toEqual({
      REQ: 'done', REQ_ATK: 'done', REQ_DEF: 'current', REQ_UC: 'pending',
    })
    // 非 UC 中间态维持现规则（前驱 done；S4 事件点接入后的语义）
    expect(derivePhaseSubNodeStates('prototype', 'PROTO_VIS')).toEqual({
      PROTO: 'done', PROTO_SS: 'done', PROTO_ATK: 'done', PROTO_DEF: 'done', PROTO_VIS: 'current', PROTO_UC: 'pending',
    })
    // UC 态（A2 必修-3/4 修订）：中间节点一律 pending，序列外结构节点继承基线 pending
    expect(derivePhaseSubNodeStates('architecture', 'ARCH_UC')).toEqual({
      ARCH: 'done', ARCH_ATK: 'pending', ARCH_DEF: 'pending', ARCH_GATE: 'pending', ARCH_UC: 'current',
    })
    expect(derivePhaseSubNodeStates('coding', 'CODE_UC')).toEqual({
      CODE: 'done', CODE_ATK: 'pending', CODE_DEF: 'pending', CODE_UC: 'current',
    })
  })
})

// ===== W2 S3 快照样例（折叠/展开两态 + 默认展开=currentStage） =====

describe('DSL 快照样例（W2 S3 展开/折叠）', () => {
  test('iterative · architecture 进行中 · 默认折叠（仅 ARCH 展开）', () => {
    const dsl = buildGuideDsl({
      mode: 'iterative', route: ITERATIVE_ROUTE,
      progress: {
        stageStates: { requirements: 'done', prototype: 'done', architecture: 'current', planning: 'pending', coding: 'pending', testing: 'pending', delivered: 'pending' },
        subStage: 'ARCH_UC',
        todoStats: { architecture: { done: 1, total: 3 } },
      },
      isDark: false,
    })
    expect(dsl).toMatchSnapshot()
  })

  test('iterative · 全展开（显式 expandedPhases）· subStage=ARCH_UC 细分着色', () => {
    const dsl = buildGuideDsl({
      mode: 'iterative', route: ITERATIVE_ROUTE,
      progress: {
        stageStates: { requirements: 'done', prototype: 'done', architecture: 'current', planning: 'pending', coding: 'pending', testing: 'pending', delivered: 'pending' },
        subStage: 'ARCH_UC',
        todoStats: { architecture: { done: 1, total: 3 } },
      },
      expandedPhases: ALL_ITERATIVE,
      isDark: false,
    })
    expect(dsl).toMatchSnapshot()
  })
})
