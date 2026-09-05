/**
 * W18 Wave1（v0.17.81）：委派意图语义升级——层一判定顺序重排红测试
 *
 * 背景（w18-wave-plan §1 + 对抗审查 MUST-6 裁定收窄）：
 * - AC 放行条件收窄为「纯审计意图」：命中 AC 审计动词（AC_AUDIT_VERBS = AC_KEYWORDS
 *   去裸 'AC'）**且无 STRONG_ACTION_VERBS 命中**→pass(ac)；强动词在场则不裁决，
 *   落入后续判定（「审计+产出」不是同一意图）；
 * - 他阶段角色词扫描提前到本阶段词之前（严格序，用户裁决接受合法交叉表述误拦成本，
 *   误拦面经 router-gate stage-deny 埋点 coPresentStageKeyword 观察统计）；
 * - 裸 'AC' 不再放行 ac 类（不再触发层二覆写候选/层三注入豁免）；
 * - F6：injectStagePathConstraint 文案诚实化——不再声称「将被记录」（无对应强制机制）。
 *
 * 断言口径：allowed / matchKind / violatedStage / denialKind（deny 时 matchKind 维持
 * 'unmatched' 既有约定）。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fixtureRoot = ''

const actualConfigPaths = await import('../config-paths')
mock.module('../config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const {
  AC_AUDIT_VERBS,
  PATH_CONSTRAINT_MARKER,
  checkDelegationAgainstStage,
  injectStagePathConstraint,
  matchACKeyword,
} = await import('../nanju-delegate-guard')
const { checkNanjuRouterGate } = await import('../nanju-router-gate')

// ═══════════════ 工单例 1-8：判定矩阵 ═══════════════

describe('W18 例1：requirements 阶段「基于 PRD 直接开发完整应用」→ deny coding（严格序翻转）', () => {
  test('含本阶段词 PRD 与他阶段词「开发」→ 他阶段扫描先于本阶段词，deny(other-stage, coding)', () => {
    const result = checkDelegationAgainstStage('requirements', {
      title: '快速交付',
      task: '基于 PRD 直接开发完整应用，交付可运行版本',
    })
    expect(result.allowed).toBe(false)
    expect(result.matchKind).toBe('unmatched')
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('coding')
    expect(result.violatedKeyword).toBe('开发')
  })
})

describe('W18 例2：planning 阶段「委派测试工程师跑 GWT」→ deny testing（严格序翻转）', () => {
  test('含本阶段词「计划」与他阶段词「测试」→ deny(other-stage, testing)', () => {
    const result = checkDelegationAgainstStage('planning', {
      task: '完成本阶段计划拆分后，委派测试工程师跑 GWT',
    })
    expect(result.allowed).toBe(false)
    expect(result.matchKind).toBe('unmatched')
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('testing')
  })
})

describe('W18 例3：requirements 阶段「对照 AC-05 编写测试场景」→ deny testing（裸 AC 不放行）', () => {
  test('裸 AC 不构成审计意图 → 掉入他阶段扫描 → deny(other-stage, testing)', () => {
    const result = checkDelegationAgainstStage('requirements', {
      task: '对照 AC-05 编写测试场景',
    })
    expect(result.allowed).toBe(false)
    expect(result.matchKind).toBe('unmatched')
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('testing')
    // 裸 AC 也不构成层二识别（AC_AUDIT_VERBS 去除独立词 'AC'）
    expect(matchACKeyword({ task: '对照 AC-05 编写测试场景' })).toBeUndefined()
  })
})

describe('W18 例4：requirements 阶段「调研并编写 PRD 草稿要点」→ pass stage（W10 基线保持）', () => {
  test('无 AC 审计动词、无他阶段词 → 本阶段词优先于强动词 → pass(stage)', () => {
    const result = checkDelegationAgainstStage('requirements', {
      title: '调研助手',
      task: '调研并编写 PRD 草稿要点',
    })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
    expect(result.matchedKeyword).toBe('PRD')
  })
})

describe('W18 例5：requirements 阶段「攻击 02_UX_DESIGN 原型找可用性问题」→ pass ac（审计宾语跨阶段）', () => {
  test('AC 审计动词命中且无强动词 → ① 先于他阶段扫描，prototype 词「原型/UX」不触发 deny', () => {
    const result = checkDelegationAgainstStage('requirements', {
      title: 'AC 攻击者',
      task: '攻击 02_UX_DESIGN 原型找可用性问题',
    })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('ac')
    expect(result.matchedKeyword).toBe('攻击')
  })
})

describe('W18 例6：requirements 阶段「review 架构并实现应用」→ deny（审计词不掩护混合产出）', () => {
  test('AC 动词与强动词并存 → ① 不裁决 → 他阶段扫描 → deny(other-stage, architecture)', () => {
    const result = checkDelegationAgainstStage('requirements', {
      task: 'review 架构并实现应用',
    })
    expect(result.allowed).toBe(false)
    expect(result.matchKind).toBe('unmatched')
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('architecture')
  })
})

describe('W18 例7：requirements 阶段「审计后顺便编写测试」→ deny（审计词不掩护混合产出）', () => {
  test('AC 动词与强动词并存 → 掉入他阶段扫描 → deny(other-stage, testing)', () => {
    const result = checkDelegationAgainstStage('requirements', {
      task: '审计后顺便编写测试',
    })
    expect(result.allowed).toBe(false)
    expect(result.matchKind).toBe('unmatched')
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('testing')
  })
})

describe('W18 例8：F6 层三文案诚实化（不再声称「将被记录」）', () => {
  test('注入文案不含「将被记录」，含「提示性软约束」与「不强制拦截」', () => {
    const out = injectStagePathConstraint('coding', '做开发')
    expect(out).toContain(PATH_CONSTRAINT_MARKER)
    expect(out).not.toContain('将被记录')
    expect(out).toContain('提示性软约束')
    expect(out).toContain('不强制拦截')
  })
})

// ═══════════════ 既有基线翻转固化 ═══════════════

describe("W18 基线翻转：裸 AC 放行例（W8 「run AC audit on app」原判 ac）", () => {
  test('裸 AC 不触发 ac 类 → coding 阶段无阶段词 → unmatched 放行（宽匹配兜底不推翻）', () => {
    const result = checkDelegationAgainstStage('coding', { task: 'run AC audit on app' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('unmatched')
  })
})

describe('W18 基线翻转：「本阶段词优先于他阶段词」例（W8 planning 规划实现步骤原判 stage 放行）', () => {
  test('planning 阶段「规划工程实现步骤与里程碑计划」→ 他阶段扫描先命中 coding「实现」→ deny', () => {
    const result = checkDelegationAgainstStage('planning', { task: '规划工程实现步骤与里程碑计划' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('coding')
    expect(result.violatedKeyword).toBe('实现')
  })
})

describe('W18 层三注入口径同步：裸 AC 文本不再豁免注入（matchACKeyword 用 AC_AUDIT_VERBS）', () => {
  test('requirements「按 AC 清单更新 PRD 要点」→ 层一 pass(stage)、层三注入路径约束（原裸 AC 豁免）', () => {
    const result = checkDelegationAgainstStage('requirements', { task: '按 AC 清单更新 PRD 要点' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
    expect(matchACKeyword({ task: '按 AC 清单更新 PRD 要点' })).toBeUndefined()
  })
})

describe('W18 AC_AUDIT_VERBS 词表口径', () => {
  test('等于原 AC_KEYWORDS 去裸 AC（七个审计动词，含词边界英文词）', () => {
    expect(AC_AUDIT_VERBS).toEqual(['攻击', '防御', '审计', '复审', 'attack', 'defense', 'review'])
    // 裸 AC 明确不在表内
    expect(AC_AUDIT_VERBS.includes('AC')).toBe(false)
  })
})

// ═══════════════ router-gate 集成：coPresentStageKeyword 埋点 ═══════════════

/** 构造 fixture：_nanju-projects.json 元数据（指定 stage/mode/sessionId） */
function setupProject(opts: { stage: string; mode?: 'quick' | 'iterative' }): void {
  const dir = mkdtempSync(join(tmpdir(), 'w18-delegate-intent-'))
  fixtureRoot = dir
  mkdirSync(join(dir, '_telemetry'), { recursive: true })
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
    projectId: 'p1',
    name: 'W18 委派意图测试项目',
    mode: opts.mode ?? 'quick',
    status: 'active',
    currentStage: opts.stage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: 'session-1',
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

describe('W18 router-gate：stage-deny 埋点 coPresentStageKeyword（严格序误拦观察口径）', () => {
  test('拒绝文本同时命中本阶段词（PRD/需求）→ violations[].coPresentStageKeyword 记录共现词', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '快速交付',
      task: '基于 PRD 需求直接开发完整应用',
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'delegate.guard.stage-deny')
    expect(events).toHaveLength(1)
    const violations = events[0]?.payload.violations as Array<Record<string, unknown>>
    expect(violations).toHaveLength(1)
    expect(violations[0]?.coPresentStageKeyword).toBe('需求')
  })

  test('纯他阶段文本（无本阶段词共现）→ coPresentStageKeyword 为 undefined', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '全栈开发工程师',
      task: '直接编写应用代码并跑通主流程',
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'delegate.guard.stage-deny')
    expect(events).toHaveLength(1)
    const violations = events[0]?.payload.violations as Array<Record<string, unknown>>
    expect(violations).toHaveLength(1)
    expect(violations[0]?.coPresentStageKeyword).toBeUndefined()
  })

  test('混合任务 deny 文案教育引导拆分（审计词+强动词场景，含产出动作段）', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '助手',
      task: 'review 架构并实现应用',
    })
    expect(result?.behavior).toBe('deny')
    // other-stage 拒绝文案既有形态保持（与当前阶段不符 + PHASE_ADVANCE 引导）
    expect(result?.message).toContain('与当前阶段「需求分析师」不符')
    expect(result?.message).toContain('PHASE_ADVANCE')
  })
})

describe('W18 router-gate：纯审计意图放行端到端（① 先于他阶段扫描 + 层三不注入）', () => {
  test('requirements「攻击 02_UX_DESIGN 原型找可用性问题」→ 放行、不注入路径约束', () => {
    setupProject({ stage: 'requirements' })
    const input: Record<string, unknown> = {
      title: 'AC 攻击者',
      task: '攻击 02_UX_DESIGN 原型找可用性问题',
    }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)).toBeNull()
    expect(String(input.task)).not.toContain(PATH_CONSTRAINT_MARKER)
  })
})
