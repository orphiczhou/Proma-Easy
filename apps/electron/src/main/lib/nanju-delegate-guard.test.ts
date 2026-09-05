/**
 * W8 委派守卫测试（三层程序化强制，v0.17.71）
 *
 * 覆盖面（工单 §5）：
 * - 匹配矩阵：6 阶段 × {本阶段词 / 他阶段词 / AC 词 / 无关词} 全组合
 * - 词边界：'ac' 不误命中 'trace'、'test' 词边界行为、中文 includes、大小写不敏感
 * - delegate_agents 批量：任一不匹配 → 整批拒绝（文案列出不匹配项）
 * - AC 攻防识别与覆写：quick→light（glm-5.3-flash）/ iterative→medium（GLM-5.3）、
 *   L1 自选已下线 glm-5-turbo 被覆写、攻/防区分、仅审计词（无攻防）不覆写
 * - 路径注入：stage/unmatched 注入、ac 不注入、幂等（已含标记不重复追加）
 * - checkNanjuRouterGate 集成：非项目会话放行、mode-select 不做参数校验（白名单语义）、
 *   requirements 委派全栈被拒、本阶段委派放行并注入、telemetry 事件落盘
 *
 * 依赖 config-paths.getWorkspaceFilesDir 定位项目/埋点目录——沿用仓库既有
 * mock.module 指向 tmpdir 模式（见 nanju-router-gate.test.ts）。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fixtureRoot = ''

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))
// R3 失败注入不用 mock.module('node:fs')（bun 下 appendFileSync 透传会自引用递归挂死）；
// 改用纯文件系统注入：fixtureRoot 下预置同名文件占用 _telemetry 目录路径 →
// recordTelemetry 内 mkdirSync 抛 EEXIST/ENOTDIR → 同一 try-catch 命中，等价覆盖写盘失败

const {
  STAGE_ROLE_KEYWORDS,
  AC_AUDIT_VERBS,
  STAGE_WRITE_DIR,
  PATH_CONSTRAINT_MARKER,
  STRONG_ACTION_VERBS,
  STAGE_OUTPUT_KEYWORDS,
  checkDelegationAgainstStage,
  detectACRole,
  matchACKeyword,
  resolveACOverride,
  injectStagePathConstraint,
  isDelegationTool,
  extractDelegationSources,
} = await import('./nanju-delegate-guard')
const { checkNanjuRouterGate } = await import('./nanju-router-gate')
const { recordTelemetry } = await import('./nanju-telemetry')

const STAGES = ['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing'] as const
type Stage = (typeof STAGES)[number]

/**
 * 各阶段典型「本阶段委派」样例（title + task）。
 * W18 严格序基线：样例文本不得含他阶段角色词子串（如 architecture 样例不可含 planning
 * 的「工程」、coding 样例不可含 requirements 的「PRD」、testing 样例 title 不可含
 * 「测试工程师」——「工程」子串会先被 planning 扫描命中而 deny，属已接受的误拦成本，
 * 见 __tests__/w18-delegate-intent.test.ts 基线翻转固化）。
 */
const STAGE_SELF_EXAMPLES: Record<Stage, { title: string; task: string }> = {
  requirements: { title: '需求分析师', task: '梳理工具类应用的核心需求，产出 PRD 初稿' },
  prototype: { title: 'UX 顾问', task: '设计首屏界面原型与视觉风格基调' },
  architecture: { title: '架构师', task: '完成技术选型与环境探测，产出架构文档' },
  planning: { title: '工程经理', task: '制定迭代规划与工程计划，拆分里程碑' },
  coding: { title: '全栈开发', task: '按既定方案实现应用全部页面与交互逻辑' },
  testing: { title: 'GWT 验收测试', task: '编写 GWT 验收测试场景与步骤映射' },
}

/** 各阶段典型「他阶段委派」样例（应被拒绝） */
const STAGE_FOREIGN_EXAMPLES: Record<Stage, { title: string; task: string }> = {
  requirements: { title: '全栈开发工程师', task: '直接编写应用代码并跑通主流程' },
  prototype: { title: '测试工程师', task: '为原型页面编写验收测试用例' },
  architecture: { title: 'UX 视觉设计师', task: '绘制高保真界面原型与配色方案' },
  planning: { title: '全栈开发', task: '实现数据库 schema 与后端接口' },
  coding: { title: '需求分析师', task: '补写 PRD 文档并重新确认需求范围' },
  testing: { title: '全栈开发工程师', task: '修复测试发现的缺陷并重构实现' },
}

/** 构造 fixture：_nanju-projects.json 元数据（指定 stage/mode/sessionId） */
function setupProject(opts: {
  stage: Stage | 'mode-select' | 'delivered'
  mode?: 'quick' | 'iterative'
  sessionId?: string
}): void {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-delegate-guard-'))
  fixtureRoot = dir
  mkdirSync(join(dir, '_telemetry'), { recursive: true })
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
    projectId: 'p1',
    name: '委派守卫测试项目',
    mode: opts.mode ?? 'quick',
    status: 'active',
    currentStage: opts.stage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: opts.sessionId ?? 'session-1',
    workspaceSlug: 'test-ws',
  }]))
}

/** 读取 fixture 埋点事件 */
function readTelemetryEvents(): Array<{ eventType: string; payload: Record<string, unknown> }> {
  const telemetryDir = join(fixtureRoot, '_telemetry')
  if (!existsSync(telemetryDir)) return []
  const files = require('node:fs').readdirSync(telemetryDir) as string[]
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = []
  for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(telemetryDir, file), 'utf-8').trim().split('\n').filter(Boolean)) {
      events.push(JSON.parse(line))
    }
  }
  return events
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

// ═══════════════ 纯函数：匹配矩阵 ═══════════════

describe('W8 层一：checkDelegationAgainstStage 匹配矩阵（6 阶段全组合）', () => {
  describe.each([...STAGES] as Stage[])('阶段 %s', (stage: Stage) => {
    test('本阶段词命中 → 放行（stage）', () => {
      for (const kw of STAGE_ROLE_KEYWORDS[stage]) {
        const result = checkDelegationAgainstStage(stage, { title: '', task: `委派任务：${kw} 相关工作` })
        expect(result.allowed).toBe(true)
        expect(result.matchKind).toBe('stage')
        expect(result.matchedKeyword).toBe(kw)
      }
    })

    test('本阶段典型样例 → 放行（stage）', () => {
      const result = checkDelegationAgainstStage(stage, STAGE_SELF_EXAMPLES[stage])
      expect(result.allowed).toBe(true)
      expect(result.matchKind).toBe('stage')
    })

    test('他阶段专属词 → 拒绝并标注所属阶段', () => {
      // 依次用其他五个阶段的词表词构造 task，全部应拒绝
      for (const other of STAGES.filter((s) => s !== stage)) {
        // 用「纯净」词构造（避免本阶段词同时出现干扰判定顺序）
        const foreignWord = STAGE_ROLE_KEYWORDS[other][0]
        const result = checkDelegationAgainstStage(stage, { title: '', task: `做一个 ${foreignWord} 的活` })
        expect(result.allowed).toBe(false)
        expect(result.violatedStage).toBe(other)
        expect(result.violatedKeyword).toBe(foreignWord)
      }
    })

    test('AC 审计动词（W18：裸 AC 已移出词表）→ 放行（ac）', () => {
      for (const kw of AC_AUDIT_VERBS) {
        const result = checkDelegationAgainstStage(stage, { title: '', task: `独立段落 ${kw} 检查任务` })
        expect(result.allowed).toBe(true)
        expect(result.matchKind).toBe('ac')
      }
    })

    test('裸 AC（W18 翻转：不再构成审计意图）→ 非 ac，按普通判定流分流', () => {
      // 「独立段落 AC 检查任务」无阶段词/无强动词 → unmatched 放行（宽匹配兑底不推翻）；
      // 裸 AC 掩护混合任务的拒例见 __tests__/w18-delegate-intent.test.ts 例 3
      const result = checkDelegationAgainstStage(stage, { title: '', task: '独立段落 AC 检查任务' })
      expect(result.allowed).toBe(true)
      expect(result.matchKind).toBe('unmatched')
    })

    test('无关词（查资料/分析类）→ 放行（unmatched）', () => {
      const result = checkDelegationAgainstStage(stage, { title: '资料调研', task: '搜集同类产品的定价策略并汇总分析' })
      expect(result.allowed).toBe(true)
      expect(result.matchKind).toBe('unmatched')
    })

    test('空文本 → 放行（交给 validateToolInput 必填校验）', () => {
      const result = checkDelegationAgainstStage(stage, {})
      expect(result.allowed).toBe(true)
      expect(result.matchKind).toBe('unmatched')
    })
  })

  test('W18 严格序翻转：他阶段词先于本阶段词（多词并存改拒）', () => {
    // planning 阶段委派含「规划」（本阶段）与「实现」（coding 词）→ W8 旧序 stage 放行；
    // W18 他阶段扫描前置 → deny(other-stage, coding)。翻转固化，详见 w18-delegate-intent.test.ts
    const result = checkDelegationAgainstStage('planning', { task: '规划工程实现步骤与里程碑计划' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('coding')
    expect(result.violatedKeyword).toBe('实现')
  })

  test('大小写不敏感：PrD / ANALYST / Requirements 均命中', () => {
    expect(checkDelegationAgainstStage('requirements', { task: 'update the PRD' }).matchKind).toBe('stage')
    expect(checkDelegationAgainstStage('requirements', { task: 'act as ANALYST' }).matchKind).toBe('stage')
    expect(checkDelegationAgainstStage('requirements', { task: 'Requirements gathering' }).matchKind).toBe('stage')
  })

  test('词边界：ac 不误命中 trace/space；裸 AC 不再判 ac（W18 翻转）', () => {
    expect(checkDelegationAgainstStage('coding', { task: 'trace the space flow' }).matchKind).toBe('unmatched')
    // W8 旧序：独立词 'AC' 在 AC_KEYWORDS 内 → ac；W18 裸 AC 移出词表，无阶段词/强动词 → unmatched
    expect(checkDelegationAgainstStage('coding', { task: 'run AC audit on app' }).matchKind).toBe('unmatched')
  })

  test('词边界：test 不命中 latest；testing 单独成词命中 testing 阶段', () => {
    expect(checkDelegationAgainstStage('coding', { task: 'fix the latest regression' }).matchKind).toBe('unmatched')
    expect(checkDelegationAgainstStage('testing', { task: 'testing scenarios for login' }).matchKind).toBe('stage')
  })

  test('中文词 includes：需求命中需求调研', () => {
    const result = checkDelegationAgainstStage('requirements', { task: '做一轮需求调研' })
    expect(result.matchKind).toBe('stage')
    expect(result.matchedKeyword).toBe('需求')
  })
})

// ═══════════════ 纯函数：AC 攻防识别与覆写 ═══════════════

describe('W8 层二：AC 攻防识别与模型覆写', () => {
  test('攻方词（攻击/attack）→ attacker', () => {
    expect(detectACRole({ task: '攻击者攻击登录场景' })).toBe('attacker')
    expect(detectACRole({ task: 'run attack scenarios' })).toBe('attacker')
  })

  test('防方词（防御/defense/裁决）→ defender', () => {
    expect(detectACRole({ task: '防御者裁决该 finding' })).toBe('defender')
    expect(detectACRole({ task: 'defense verdict pass' })).toBe('defender')
  })

  test('攻防词并存 → attacker（攻方优先，报告注明口径）', () => {
    expect(detectACRole({ task: '攻击与防御对抗审计' })).toBe('attacker')
  })

  test('仅审计/复审词（无攻防）→ null 不覆写', () => {
    expect(detectACRole({ task: '复审 06_TESTS 产出并出审计报告' })).toBeNull()
  })

  test('quick 模式 → light 预设（attacker=deepseek-v4-flash / defender=glm-5.3-flash）', () => {
    expect(resolveACOverride('attacker', 'quick')).toEqual({ channel: 'deepseek', model: 'deepseek-v4-flash' })
    expect(resolveACOverride('defender', 'quick')).toEqual({ channel: 'glm-zhipu', model: 'glm-5.3-flash' })
  })

  test('iterative 模式 → medium 预设（attacker=deepseek-v4-pro / defender=GLM-5.3）', () => {
    expect(resolveACOverride('attacker', 'iterative')).toEqual({ channel: 'deepseek', model: 'deepseek-v4-pro' })
    expect(resolveACOverride('defender', 'iterative')).toEqual({ channel: 'glm-zhipu', model: 'GLM-5.3' })
  })
})

// ═══════════════ 纯函数：路径注入 ═══════════════

describe('W8 层三：injectStagePathConstraint', () => {
  const stageCases = [...STAGES]
  test.each(stageCases)('阶段 %s 注入对应目录约束', (stage: Stage) => {
    const result = injectStagePathConstraint(stage, '完成任务')
    expect(result).toContain(PATH_CONSTRAINT_MARKER)
    expect(result).toContain(STAGE_WRITE_DIR[stage])
    expect(result.startsWith('完成任务\n')).toBe(true)
  })

  test('幂等：已含标记不重复追加', () => {
    const once = injectStagePathConstraint('coding', '做开发')
    const twice = injectStagePathConstraint('coding', once)
    expect(twice).toBe(once)
  })
})

// ═══════════════ 纯函数：工具名识别与参数提取 ═══════════════

describe('工具名识别与委派参数提取', () => {
  test('delegate_agent / delegate_agents 及 MCP 前缀变体均识别', () => {
    expect(isDelegationTool('delegate_agent')).toBe(true)
    expect(isDelegationTool('delegate_agents')).toBe(true)
    expect(isDelegationTool('mcp__collaboration__delegate_agent')).toBe(true)
    expect(isDelegationTool('mcp__collaboration__delegate_agents')).toBe(true)
    expect(isDelegationTool('wait_for_delegations')).toBe(false)
    expect(isDelegationTool('Read')).toBe(false)
  })

  test('单个委派：从 input 顶层提取 title/task', () => {
    expect(extractDelegationSources({ title: 'T', task: 'K', modelId: 'x' })).toEqual([{ title: 'T', task: 'K' }])
  })

  test('批量委派：按 items 索引对齐提取（非对象项占位）', () => {
    const sources = extractDelegationSources({ items: [{ title: 'A', task: 'a' }, null, { task: 'c' }] })
    expect(sources).toHaveLength(3)
    expect(sources[0]).toEqual({ title: 'A', task: 'a' })
    expect(sources[1]).toEqual({})
    expect(sources[2]).toEqual({ title: undefined, task: 'c' })
  })

  test('非字符串字段忽略', () => {
    expect(extractDelegationSources({ title: 123, task: { deep: true } })).toEqual([{}])
  })
})

// ═══════════════ 集成：checkNanjuRouterGate ═══════════════

describe('W8 集成：checkNanjuRouterGate 参数级三层强制', () => {
  test('无项目会话：delegate 放行且零副作用', () => {
    setupProject({ stage: 'requirements', sessionId: 'session-other' })
    const input: Record<string, unknown> = { title: '全栈开发', task: '直接实现全部代码' }
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)
    expect(result).toBeNull()
    expect(input.modelId).toBeUndefined()
    expect(readTelemetryEvents()).toHaveLength(0)
  })

  test('mode-select 阶段：delegate 不在白名单，走既有 deny（不做 W8 参数校验）', () => {
    setupProject({ stage: 'mode-select' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', { title: '全栈开发', task: '写代码' })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).not.toContain('委派门禁') // 是白名单 deny 文案，非 W8 文案
  })

  test('层一拦截：requirements 阶段委派「全栈开发」→ deny 且文案教育（P1-C 场景）', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '全栈开发工程师',
      task: '直接编写应用代码并跑通主流程',
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('全栈开发')
    expect(result?.message).toContain('PHASE_ADVANCE')
    expect(result?.message).toContain('阶段序列不可跳过')
    const events = readTelemetryEvents()
    expect(events.filter((e) => e.eventType === 'delegate.guard.stage-deny')).toHaveLength(1)
  })

  test('层一放行+层三注入：requirements 阶段委派需求分析 → task 追加 01_PRD 约束', () => {
    setupProject({ stage: 'requirements' })
    const input: Record<string, unknown> = { title: '需求分析师', task: '梳理核心需求产出 PRD' }
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)
    expect(result).toBeNull()
    expect(input.task).toContain(PATH_CONSTRAINT_MARKER)
    expect(input.task).toContain('01_PRD')
    expect(String(input.task).startsWith('梳理核心需求产出 PRD\n')).toBe(true)
  })

  test('unmatched 放行 + telemetry 观察（查资料类）', () => {
    setupProject({ stage: 'requirements' })
    const input: Record<string, unknown> = { task: '搜集同类产品定价策略' }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)).toBeNull()
    expect(input.task).toContain(PATH_CONSTRAINT_MARKER) // unmatched 也注入（宁多勿少）
    const events = readTelemetryEvents()
    expect(events.filter((e) => e.eventType === 'delegate.guard.pass-unmatched')).toHaveLength(1)
  })

  test('层二覆写：L1 自选已下线 glm-5-turbo 委派攻击者 → quick 项目覆写为 light attacker', () => {
    setupProject({ stage: 'testing', mode: 'quick' })
    const input: Record<string, unknown> = {
      title: 'AC 攻击者',
      task: '攻击登录与支付场景，尝试构造可利用缺口',
      channelId: 'glm-zhipu',
      modelId: 'glm-5-turbo',
    }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'mcp__collaboration__delegate_agent', input)).toBeNull()
    expect(input.channelId).toBe('deepseek')
    expect(input.modelId).toBe('deepseek-v4-flash')
    // AC 类不注入路径约束（审计只读）
    expect(String(input.task)).not.toContain(PATH_CONSTRAINT_MARKER)
    const events = readTelemetryEvents()
    const override = events.find((e) => e.eventType === 'delegate.guard.ac-override')
    expect(override?.payload.originalModelId).toBe('glm-5-turbo')
    expect(override?.payload.modelId).toBe('deepseek-v4-flash')
    expect(override?.payload.acRole).toBe('attacker')
  })

  test('层二覆写：iterative 项目防御者 → medium defender（GLM-5.3）', () => {
    setupProject({ stage: 'coding', mode: 'iterative' })
    const input: Record<string, unknown> = { title: '防御者', task: '裁决攻方提交的 finding 是否成立' }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)).toBeNull()
    expect(input.channelId).toBe('glm-zhipu')
    expect(input.modelId).toBe('GLM-5.3')
    expect(readTelemetryEvents().some((e) => e.eventType === 'delegate.guard.ac-override')).toBe(true)
  })

  test('层二边界：命中 AC 词但无攻防区分（仅复审）→ 放行不覆写不注入', () => {
    setupProject({ stage: 'requirements' })
    const input: Record<string, unknown> = { title: '复审员', task: '复审 PRD 初稿' }
    // 「PRD」本阶段词优先命中 → stage 类；复审词不触发覆写（无攻防）
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)).toBeNull()
    expect(input.modelId).toBeUndefined()
    expect(input.channelId).toBeUndefined()
    expect(readTelemetryEvents().some((e) => e.eventType === 'delegate.guard.ac-override')).toBe(false)
  })

  test('批量 delegate_agents：任一不匹配 → 整批拒绝并列出不匹配项', () => {
    setupProject({ stage: 'requirements' })
    const input: Record<string, unknown> = {
      items: [
        { title: '需求分析师', task: '需求调研' },
        { title: '全栈开发', task: '直接实现代码' },
        { title: '测试工程师', task: '写验收测试' },
      ],
    }
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'mcp__collaboration__delegate_agents', input)
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('全栈开发')
    expect(result?.message).toContain('测试工程师')
    expect(result?.message).toContain('#2')
    expect(result?.message).toContain('#3')
    // 整批拒绝：不放行任何一项的副作用（无覆写/无注入）
    const items = input.items as Array<Record<string, unknown>>
    expect(items[0]?.task).toBe('需求调研')
  })

  test('批量 delegate_agents：全部匹配 → 放行并逐项注入约束', () => {
    setupProject({ stage: 'testing' })
    // W18 严格序：title 不可含他阶段角色词子串（「测试工程师」含 planning「工程」会先被扫中），
    // 改用「测试专员」保持本测试对批量注入路径的覆盖焦点
    const input: Record<string, unknown> = {
      items: [
        { title: '测试专员 A', task: '编写登录验收测试' },
        { title: '测试专员 B', task: '编写支付 GWT 场景' },
      ],
    }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agents', input)).toBeNull()
    const items = input.items as Array<Record<string, unknown>>
    expect(String(items[0]?.task)).toContain('06_TESTS')
    expect(String(items[1]?.task)).toContain('06_TESTS')
  })

  test('非委派白名单工具（Read）零变化放行', () => {
    setupProject({ stage: 'requirements' })
    const input: Record<string, unknown> = { file_path: '/tmp/x' }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'Read', input)).toBeNull()
    expect(input.file_path).toBe('/tmp/x')
  })
})

// ═══════════════ 修订轮 R1-R3（AC 裁决 20260903 CONVERGED_CERTIFIED 随批） ═══════════════

describe('R1：层三注入与层二识别同源（matchACKeyword 替代 matchKind）', () => {
  test('混合文本 1：本阶段词+攻击词并存（testing「测试攻击审计」）→ 不注入但覆写', () => {
    setupProject({ stage: 'testing', mode: 'quick' })
    const input: Record<string, unknown> = {
      title: '测试攻击审计',
      task: '对 06_TESTS 产出做攻击审计',
    }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)).toBeNull()
    // R1 修复前：matchKind='stage'（「测试」本阶段词先命中）→ 误注入；修复后：AC 词在场 → 同源不注入
    expect(String(input.task)).not.toContain(PATH_CONSTRAINT_MARKER)
    // 层二独立性保持：攻方覆写 quick→light attacker
    expect(input.modelId).toBe('deepseek-v4-flash')
    expect(input.channelId).toBe('deepseek')
  })

  test('混合文本 2：review/复审词无攻防（testing「测试审计复审」）→ 不注入且不覆写', () => {
    setupProject({ stage: 'testing', mode: 'quick' })
    const input: Record<string, unknown> = {
      title: '测试审计复审',
      task: '验收 PRD',
    }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)).toBeNull()
    // 「复审」AC 词命中 → 层三同源条件 false → 不注入
    expect(String(input.task)).not.toContain(PATH_CONSTRAINT_MARKER)
    // detectACRole=null（无攻/防词）→ 层二不覆写（detectACRole 独立于 matchACKeyword 判定）
    expect(input.modelId).toBeUndefined()
    expect(input.channelId).toBeUndefined()
  })

  test('混合文本 3：本阶段词+英文 attack 并存（coding）→ 不注入但覆写', () => {
    setupProject({ stage: 'coding', mode: 'iterative' })
    const input: Record<string, unknown> = { task: '实现登录页，完成后 attack 场景复审' }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)).toBeNull()
    expect(String(input.task)).not.toContain(PATH_CONSTRAINT_MARKER)
    expect(input.modelId).toBe('deepseek-v4-pro') // iterative→medium attacker
  })
})

describe('R2：expectedOutput 纳入匹配文本（堵藏词绕过）', () => {
  test('藏词 deny：title/task 无阶段词，expectedOutput 藏「全栈」→ 拒绝', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '辅助分析',
      task: '帮我看看这个想法',
      expectedOutput: '全栈应用代码',
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('全栈')
    expect(result?.message).toContain('与当前阶段')
  })

  test('纯函数：expectedOutput 命中本阶段词 → 放行（stage）', () => {
    const result = checkDelegationAgainstStage('requirements', {
      title: '辅助',
      task: '帮我整理',
      expectedOutput: 'PRD 初稿',
    })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
    expect(result.matchedKeyword).toBe('PRD')
  })

  test('纯函数：expectedOutput 藏 AC 攻击词 → matchACKeyword 命中 + detectACRole=attacker', () => {
    const source = { title: '', task: '无词描述', expectedOutput: 'attack 场景清单' }
    expect(matchACKeyword(source)).toBe('attack')
    expect(detectACRole(source)).toBe('attacker')
  })
})

describe('R3：recordTelemetry 失败注入（fail-closed：埋点盘中断不阻断门禁）', () => {
  test('写盘失败（_telemetry 路径被同名文件占用，mkdirSync 抛错）→ 不向上抛，返回 event 正常', () => {
    setupProject({ stage: 'requirements' })
    // setupProject 预建了 _telemetry 目录：删掉后用同名文件占用路径 →
    // existsSync 为 false（是文件非目录）→ recordTelemetry 内 mkdirSync 抛错（EEXIST/ENOTDIR）
    rmSync(join(fixtureRoot, '_telemetry'), { recursive: true, force: true })
    writeFileSync(join(fixtureRoot, '_telemetry'), '占位文件（非目录）')
    const event = recordTelemetry('test-ws', 'project.created', { k: 1 })
    expect(event.eventType).toBe('project.created')
    expect(event.payload).toEqual({ k: 1 })
  })

  test('写盘失败 → 门禁 deny/pass 流程仍正常（fail-closed：异常不产生权限旁路）', () => {
    setupProject({ stage: 'requirements' })
    rmSync(join(fixtureRoot, '_telemetry'), { recursive: true, force: true })
    writeFileSync(join(fixtureRoot, '_telemetry'), '占位文件（非目录）')
    // 层一 deny 路径的 stage-deny 埋点写盘失败，但 deny 判定与文案不受影响
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '全栈开发工程师',
      task: '直接写代码',
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('PHASE_ADVANCE')
    // 放行路径的 pass-unmatched 埋点失败同样不阻断
    const pass = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '资料调研',
      task: '搜集同类产品定价策略',
    })
    expect(pass).toBeNull()
  })
})

describe('R5：deny 文案弱化（不断言归属阶段）', () => {
  test('「测试工程师」在 requirements 阶段被拒 → 文案只说与当前阶段不符，不断言属于哪一阶段', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '测试工程师',
      task: '写验收测试',
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('与当前阶段「需求分析师」不符')
    expect(result?.message).not.toContain('属于「工程经理」阶段职责')
  })
})

// ═══════════════ W10-V2.1：unmatched 强动作动词兜底 ═══════════════

describe('W10-V2.1：unmatched 强动作动词 deny 矩阵（动词 × 无阶段词文本）', () => {
  // 「实现/开发」同时是 coding 角色词（STAGE_ROLE_KEYWORDS.coding）：在 requirements 阶段
  // 会被第 3 步他阶段扫描先命中（denialKind='other-stage'，W8 既有行为，deny 结果等价）；
  // 其余动词（不属任何阶段词表）走第 4a 条 strong-verb。矩阵固化两者的完整分流。
  test('全部强动词在 requirements 阶段（无阶段词文本）→ denied；动词属 coding 词表的走 other-stage，其余走 strong-verb', () => {
    const codingVerbs = new Set(['实现', '开发'])
    for (const verb of STRONG_ACTION_VERBS) {
      const result = checkDelegationAgainstStage('requirements', { title: '助手', task: `把这个小工具${verb}，交付可用结果` })
      expect(result.allowed).toBe(false)
      if (codingVerbs.has(verb)) {
        expect(result.denialKind).toBe('other-stage')
        expect(result.violatedStage).toBe('coding')
      } else {
        expect(result.denialKind).toBe('strong-verb')
        expect(result.matchedVerb).toBe(verb)
      }
    }
  })

  test('E2E 复现场景（dev-test-report §六）：requirements 阶段委派「把这个倒计时小工具做出来」→ strong-verb deny', () => {
    const result = checkDelegationAgainstStage('requirements', {
      title: '助手',
      task: '把这个倒计时小工具做出来，能跑就行',
    })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('strong-verb')
    expect(result.matchedVerb).toBe('做出来')
  })

  test('coding 阶段反例：「实现登录功能」→ 本阶段词放行（实现 ∈ coding 角色词，防 coding 自身误拦）', () => {
    const result = checkDelegationAgainstStage('coding', { title: '开发任务', task: '实现登录功能与表单校验' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
  })

  test('W18 翻转：AC 动词与强动词并存不判 ac——「review 后 build the feature」→ strong-verb deny', () => {
    // W18：审计词不掩护产出动作（「审计+产出」不是同一意图）→ ① 不裁决，掉入后续判定；
    // 无阶段词 → 第 4 条强动词 deny（W8 旧序 ac 放行，基线翻转固化）
    const result = checkDelegationAgainstStage('requirements', { title: '审计', task: 'review the draft then build the feature list' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('strong-verb')
    expect(result.matchedVerb).toBe('build')
  })

  test('无强动词 unmatched（查询/分析/总结类）→ 维持放行（宽匹配原则不推翻）', () => {
    for (const stage of STAGES) {
      const result = checkDelegationAgainstStage(stage, { title: '调研', task: '搜集同类产品的定价策略并汇总对比' })
      expect(result.allowed).toBe(true)
      expect(result.matchKind).toBe('unmatched')
      expect(result.denialKind).toBeUndefined()
    }
  })
})

describe('W10-V2.1：产出物词优先缓解误拦（本阶段目录词 > 强动词判定）', () => {
  test('工单案例：requirements「调研并编写 PRD 草稿要点」→ stage 放行（「编写」是强动词但「PRD」命中产出物词）', () => {
    const result = checkDelegationAgainstStage('requirements', { title: '调研助手', task: '调研并编写 PRD 草稿要点' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
    expect(result.matchedKeyword).toBe('PRD')
  })

  test('各阶段产出物词 × 同文本强动词 → 全部 stage 放行（全词表矩阵）', () => {
    const pairs: Array<[Stage, string]> = [
      ['requirements', '调研并编写 PRD 草稿要点'],
      ['requirements', '整理用户故事供确认'],
      ['prototype', '生成原型交互稿初版'],
      ['prototype', '绘制界面稿与线框'],
      ['architecture', '构建技术选型清单'],
      ['architecture', '梳理组件清单与风险'],
      ['planning', '编写计划与里程碑拆分'],
      ['coding', 'write the code for timer'],
      ['coding', '生成应用入口 index.html'],
      ['testing', '编写 steps.json 步骤映射'],
      ['testing', '整理场景覆盖情况'],
    ]
    for (const [stage, task] of pairs) {
      const result = checkDelegationAgainstStage(stage, { title: '助手', task })
      expect(result.allowed).toBe(true)
      expect(result.matchKind).toBe('stage')
    }
  })

  test('产出物词不参与他阶段扫描：requirements 阶段「构建代码评审清单」不被 coding 产出物词误放（仍按 unmatched+强动词 deny）', () => {
    // 「代码」是 coding 产出物词但不在任何角色词表——第 3 步他阶段扫描不扫产出物词表，
    // requirements 下此文本不中任何阶段词 → unmatched + 「构建」强动词 → strong-verb deny
    // （交叉表述靠 AC 词表兜底，产出物词只用于本阶段放行补充，防推翻宽匹配原则）
    const result = checkDelegationAgainstStage('requirements', { title: '评审', task: '构建代码评审清单' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('strong-verb')
    expect(result.matchedVerb).toBe('构建')
  })
})

describe('W10-V2.1：误拦残留场景（设计权衡固化，报告记录）', () => {
  test('requirements「编写调研纪要」→ strong-verb deny（产出物词表不含「纪要」——deny 文案引导补角色声明后可重试）', () => {
    const result = checkDelegationAgainstStage('requirements', { title: '助手', task: '编写调研纪要一份' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('strong-verb')
    expect(result.matchedVerb).toBe('编写')
  })

  test('coding「build the app」→ strong-verb deny（app 已从产出物词表移除——保护 W8 的 ac 归类断言；残余误拦面记录）', () => {
    const result = checkDelegationAgainstStage('coding', { title: 'helper', task: 'build the app for timer' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('strong-verb')
    expect(result.matchedVerb).toBe('build')
  })
})

describe('W10-V2.1：router-gate 集成（deny 文案与 telemetry）', () => {
  test('requirements 委派「把这个工具做出来」→ deny 文案含产出类动作引导 + unmatched-action-deny 事件（含动词与文本摘要）', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '助手',
      task: '把这个工具做出来，交付能跑的版本',
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('含产出类动作词「做出来」')
    expect(result?.message).toContain('委派内容含产出类动作但未声明阶段角色。请在 title/task 明确角色')
    expect(result?.message).toContain('当前requirements阶段，允许的角色关键词见上')
    expect(result?.message).toContain('需求分析师')
    const events = readTelemetryEvents()
    const denyEvents = events.filter((e) => e.eventType === 'delegate.guard.unmatched-action-deny')
    expect(denyEvents).toHaveLength(1)
    expect(denyEvents[0]?.payload.stage).toBe('requirements')
    expect(denyEvents[0]?.payload.denies).toEqual([
      expect.objectContaining({ verb: '做出来', title: '助手' }),
    ])
  })

  test('批量混合（他阶段词 + 强动词）→ 整批拒绝，两类违规行都在文案，两个 telemetry 事件各 1', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agents', {
      items: [
        { title: '测试工程师', task: '写验收用例' },
        { title: '助手', task: '把这个工具做出来' },
      ],
    })
    expect(result?.behavior).toBe('deny')
    // 键序首命中（W8 报告已知特性）：「测试工程师」先撞 planning 的「工程」而非 testing 的「测试」
    expect(result?.message).toContain('命中「工程」')
    expect(result?.message).toContain('含产出类动作词「做出来」') // 强动词行
    const events = readTelemetryEvents()
    expect(events.filter((e) => e.eventType === 'delegate.guard.stage-deny')).toHaveLength(1)
    const verbEvents = events.filter((e) => e.eventType === 'delegate.guard.unmatched-action-deny')
    expect(verbEvents).toHaveLength(1)
    expect(verbEvents[0]?.payload.count).toBe(1)
  })

  test('纯他阶段词 deny（无强动词）→ 文案不含产出类动作段、只记 stage-deny 事件（W8 行为不变）', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '测试工程师',
      task: '写验收用例',
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).not.toContain('产出类动作')
    const events = readTelemetryEvents()
    expect(events.filter((e) => e.eventType === 'delegate.guard.unmatched-action-deny')).toHaveLength(0)
    expect(events.filter((e) => e.eventType === 'delegate.guard.stage-deny')).toHaveLength(1)
  })
})

// ═══════════════ W10 修订轮 A1（随批）：动词表补词与表外边界（裁决 20260903） ═══════════════

describe('W10 修订轮 A1：动词表补 7 词 + 表外放行边界', () => {
  test('新补 7 词（完善/优化/调整/fix/ship/refine/polish）在 requirements 无阶段词文本 → strong-verb deny', () => {
    for (const verb of ['完善', '优化', '调整', 'fix', 'ship', 'refine', 'polish']) {
      const result = checkDelegationAgainstStage('requirements', { title: '助手', task: `把这个小工具${verb}一下再交付` })
      expect(result.allowed).toBe(false)
      expect(result.denialKind).toBe('strong-verb')
      expect(result.matchedVerb).toBe(verb)
    }
  })

  test('暂缓词（修复/调一下/改一下——裁决 A1 明确暂缓入表）表外 → requirements/prototype/architecture 全阶段 unmatched 放行（设计内行为固化）', () => {
    for (const stage of STAGES.filter((s) => s === 'requirements' || s === 'prototype' || s === 'architecture')) {
      for (const task of ['修复已知问题清单', '把这个页面调一下', '改一下文案措辞']) {
        const result = checkDelegationAgainstStage(stage, { title: '助手', task })
        expect(result.allowed).toBe(true)
        expect(result.matchKind).toBe('unmatched')
      }
    }
  })

  test('coding 阶段 fix 边界：无 coding 阶段词 → strong-verb deny（引导补角色词）；含产出物词 → 放行', () => {
    // fix 补入（修订轮 A1）后 coding 纯英文 fix 委派若无阶段词会被拦一次——deny 文案引导
    // 补角色词后可重试（残余误拦面，报告 §1.3 记录）；同文本带 'code' 产出物词即放行
    const denied = checkDelegationAgainstStage('coding', { title: 'helper', task: 'fix the latest regression' })
    expect(denied.allowed).toBe(false)
    expect(denied.denialKind).toBe('strong-verb')
    expect(denied.matchedVerb).toBe('fix')
    const allowed = checkDelegationAgainstStage('coding', { title: 'helper', task: 'fix the code for timer' })
    expect(allowed.allowed).toBe(true)
    expect(allowed.matchKind).toBe('stage')
  })
})
