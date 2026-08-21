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
  parseTodoPhase,
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
    outputPath: '08_APP/index.html', retryLimit: 2, next: 'delivered', taskWeight: 'light', acActors: LIGHT_ACTORS,
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
    outputPath: '08_APP/index.html', retryLimit: 2, next: 'delivered', taskWeight: 'medium', acActors: MEDIUM_ACTORS,
  }),
  SENTINEL,
]

/** 无进度叠加输入（结构快照用） */
const NO_PROGRESS = null

// ===== AC-02：DSL 结构正确性 =====

describe('buildGuideDsl 结构（AC-02）', () => {
  test('quick 版：含 REQ/PROTO/CODE 主阶段与 delivered 终点，不含 ARCH/PLAN', () => {
    const dsl = buildGuideDsl({ mode: 'quick', route: QUICK_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(dsl).toContain('REQ[')
    expect(dsl).toContain('PROTO[')
    expect(dsl).toContain('CODE[')
    expect(dsl).toContain('DONE([\"交付 delivered')
    expect(dsl.includes('ARCH')).toBe(false)
    expect(dsl.includes('PLAN')).toBe(false)
  })

  test('iterative 版：含 REQ/PROTO/ARCH/PLAN/CODE 五个主阶段', () => {
    const dsl = buildGuideDsl({ mode: 'iterative', route: ITERATIVE_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(dsl).toContain('REQ[')
    expect(dsl).toContain('PROTO[')
    expect(dsl).toContain('ARCH[')
    expect(dsl).toContain('PLAN[')
    expect(dsl).toContain('CODE[')
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

  test('prototype 特有环节：截图自检循环 + 独立视觉裁决；哨兵节点被过滤', () => {
    const dsl = buildGuideDsl({ mode: 'iterative', route: ITERATIVE_ROUTE, progress: NO_PROGRESS, isDark: false })
    expect(dsl).toContain('PROTO_SS{\"截图渲染自检循环')
    expect(dsl).toContain('PROTO_VIS{\"独立视觉裁决')
    // 哨兵（id=delivered）不产生第六个 subgraph，只有 REQ/PROTO/ARCH/PLAN/CODE 五个 subgraph
    expect(dsl.match(/subgraph SG_/g)?.length).toBe(5)
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

  test('testing 遗留值：全 pending 无高亮 + 收口提示（不崩溃）', () => {
    const result = computeStageStates({ mode: 'iterative', currentStage: 'testing', status: 'active' }, ITERATIVE_ROUTE)
    expect(result.stageStates.coding).toBe('pending')
    expect(result.stageStates.delivered).toBe('pending')
    expect(result.notice).toContain('测试')
    expect(result.notice).toContain('向导流程已交付')
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
