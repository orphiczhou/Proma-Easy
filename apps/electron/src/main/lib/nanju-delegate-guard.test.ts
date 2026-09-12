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
  stripPathTokens,
  isMinimaxEndpoint,
  R2_CODING_STAGE_KEYWORDS,
  MINIMAX_REPAIR_GUIDANCE,
} = await import('./nanju-delegate-guard')
const { checkNanjuRouterGate } = await import('./nanju-router-gate')
const { recordTelemetry } = await import('./nanju-telemetry')

const STAGES = ['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing'] as const
type Stage = (typeof STAGES)[number]

/**
 * 各阶段典型「本阶段委派」样例（title + task）。
 * W18.1（Wave1.1）修复后：planning 已移除裸「工程」（「工程师」职称后缀不再误撞），
 * testing 样例 title 可含本阶段规范角色名「测试工程师」；样例文本仍避免含
 * 他阶段角色词子串（如 coding 样例不含「PRD」——严格序下他阶段词仍先拦，
 * 见 __tests__/w18-delegate-intent.test.ts 基线翻转固化）。
 */
const STAGE_SELF_EXAMPLES: Record<Stage, { title: string; task: string }> = {
  requirements: { title: '需求分析师', task: '梳理工具类应用的核心需求，产出 PRD 初稿' },
  prototype: { title: 'UX 顾问', task: '设计首屏界面原型与视觉风格基调' },
  architecture: { title: '架构师', task: '完成技术选型与环境探测，产出架构文档' },
  planning: { title: '工程经理', task: '制定迭代规划与工程计划，拆分里程碑' },
  coding: { title: '全栈开发', task: '按既定方案实现应用全部页面与交互逻辑' },
  testing: { title: '测试工程师', task: '编写 GWT 验收测试场景与步骤映射' },
}

/** 各阶段典型「他阶段委派」样例（应被拒绝） */
const STAGE_FOREIGN_EXAMPLES: Record<Stage, { title: string; task: string }> = {
  requirements: { title: '全栈开发工程师', task: '直接编写应用代码并跑通主流程' },
  prototype: { title: '测试工程师', task: '为原型页面编写验收测试用例' },
  architecture: { title: 'UX 视觉设计师', task: '绘制高保真界面原型与配色方案' },
  planning: { title: '全栈开发', task: '实现数据库 schema 与后端接口' },
  // W19-C：裸「需求」「PRD」已移出 requirements ROLE，改用角色复合词样例
  coding: { title: '需求调研员', task: '补做需求调研并更新 PRD 范围' },
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
        // W19-C：词表引入复合词后（如 验收测试 ⊃ 测试），matchedKeyword 可能是表中
        // 更早命中的短词（子串先行）——只断言命中了某个本阶段词，不再断言等值
        expect(result.matchedKeyword).toBeDefined()
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

  test('中文词 includes：W19-C 复合词直接命中（需求调研 → stage，裸「需求」已移出 ROLE 表）', () => {
    const result = checkDelegationAgainstStage('requirements', { task: '做一轮需求调研' })
    expect(result.matchKind).toBe('stage')
    expect(result.matchedKeyword).toBe('需求调研')
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

// ═══════════════ W22 M#7：resolveACOverride per-stage 优先（防 preset 静默覆写） ═══════════════

describe('W22 M#7：resolveACOverride 第三参 stage（per-phase 覆盖优先于 preset）', () => {
  test('红测：testing attacker 最终 target.channelId=glm-zhipu（per-phase 覆盖生效，不被 preset 覆写回 deepseek 系）——两模式同源', () => {
    // 论证 P0#5 场景：若 resolveACOverride 不接 stage，per-phase acAttacker 会被
    // AC_PRESETS 静默覆写 → attacker 与新作者（deepseek-v4-flash）同族，三族矩阵失效
    expect(resolveACOverride('attacker', 'quick', 'testing')).toEqual({ channel: 'glm-zhipu', model: 'glm-5.3-flash' })
    expect(resolveACOverride('attacker', 'iterative', 'testing')).toEqual({ channel: 'glm-zhipu', model: 'glm-5.3-flash' })
  })

  test('testing defender：per-phase 覆盖 minimax:MiniMax-M3 优先（W13 起 acDefender 同样不再被 preset 覆写回 glm 系）', () => {
    expect(resolveACOverride('defender', 'quick', 'testing')).toEqual({ channel: 'minimax', model: 'MiniMax-M3' })
    expect(resolveACOverride('defender', 'iterative', 'testing')).toEqual({ channel: 'minimax', model: 'MiniMax-M3' })
  })

  test('无 attacker 覆盖的阶段（coding/architecture/requirements）→ 节点 taskWeight 对应预设，行为与两参一致', () => {
    expect(resolveACOverride('attacker', 'quick', 'coding')).toEqual({ channel: 'deepseek', model: 'deepseek-v4-flash' })
    expect(resolveACOverride('attacker', 'iterative', 'coding')).toEqual({ channel: 'deepseek', model: 'deepseek-v4-pro' })
    expect(resolveACOverride('attacker', 'quick', 'requirements')).toEqual({ channel: 'deepseek', model: 'deepseek-v4-flash' })
    expect(resolveACOverride('defender', 'quick', 'prototype')).toEqual({ channel: 'glm-zhipu', model: 'glm-5.3-flash' })
  })

  test('节点缺失（quick 无 planning）→ 回退全局 preset；不传 stage（两参旧签名）→ 向后兼容不变', () => {
    expect(resolveACOverride('attacker', 'quick', 'planning')).toEqual({ channel: 'deepseek', model: 'deepseek-v4-flash' })
    expect(resolveACOverride('defender', 'iterative', 'planning')).toEqual({ channel: 'glm-zhipu', model: 'GLM-5.3' })
    expect(resolveACOverride('attacker', 'quick')).toEqual({ channel: 'deepseek', model: 'deepseek-v4-flash' })
    expect(resolveACOverride('defender', 'iterative')).toEqual({ channel: 'glm-zhipu', model: 'GLM-5.3' })
  })

  test('gate 流模拟：testing 阶段 L1 委派 AC 攻击者，层二覆写后 target 端点 = 三族矩阵攻击位（glm 系），与作者（deepseek 系）异族', () => {
    const target: { channelId?: string; modelId?: string } = { channelId: 'deepseek', modelId: 'deepseek-v4-pro' } // L1 自选旧值
    const override = resolveACOverride('attacker', 'quick', 'testing')
    target.channelId = override.channel
    target.modelId = override.model
    expect(target.channelId).toBe('glm-zhipu')
    expect(target.modelId).toBe('glm-5.3-flash')
  })
})

// ═══════════════ W22 M#9/R2：修复路由守卫（testing ∧ minimax 家族端点 ∧ coding 阶段词） ═══════════════

describe('W22 M#9/R2：修复路由守卫（MiniMax-M3 不干代码修复；deny + continue_delegation 教育）', () => {
  test('isMinimaxEndpoint：字面前缀 / MiniMax-M3 模型名（UUID 渠道实测形态）/ 两者皆无', () => {
    expect(isMinimaxEndpoint('minimax')).toBe(true)
    expect(isMinimaxEndpoint('minimax-channel')).toBe(true)
    expect(isMinimaxEndpoint(undefined, 'MiniMax-M3')).toBe(true)
    expect(isMinimaxEndpoint(undefined, 'minimax_m3')).toBe(true)
    // E2E 实测形态：minimax 渠道 ID 是 UUID，渠道前缀判不到家族 → 模型名兜住
    expect(isMinimaxEndpoint('ad74ac74-aaaa-bbbb-cccc-dddddddddddd', 'MiniMax-M3')).toBe(true)
    expect(isMinimaxEndpoint('deepseek', 'deepseek-v4-flash')).toBe(false)
    expect(isMinimaxEndpoint(undefined, undefined)).toBe(false)
    expect(isMinimaxEndpoint('  ')).toBe(false) // 空白串不算显式指定
  })

  test('红测·E2E 实测形态：testing 阶段 + 显式 minimax UUID 渠道/MiniMax-M3 + 修复代码描述 → deny（denialKind=minimax-repair-misuse，violatedStage=coding）', () => {
    // D8 实测（06:47/06:53）：L1→deepseek 协调→MiniMax-M3 干代码修复——三条件恰合取
    const result = checkDelegationAgainstStage('testing', {
      title: '修复提交按钮缺陷',
      task: '修复测试发现的代码缺陷：08_APP/index.html 提交按钮点击无反应，请修改代码逻辑并验证',
      channelId: 'ad74ac74-aaaa-bbbb-cccc-dddddddddddd',
      modelId: 'MiniMax-M3',
    })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('minimax-repair-misuse')
    expect(result.violatedStage).toBe('coding')
    expect(result.violatedKeyword).toBeDefined()
    expect(['代码', 'index.html', '开发']).toContain(result.violatedKeyword!)
  })

  test('字面 minimax 渠道标记同样命中；index.html 纯 ASCII 相对路径保留参与匹配', () => {
    const result = checkDelegationAgainstStage('testing', {
      title: '修 index.html',
      task: '把首页提交按钮的开发问题修好',
      channelId: 'minimax',
    })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('minimax-repair-misuse')
  })

  test('合法面①：prototype 阶段 minimax 原型修复 → 放行（R2 只管 testing；本阶段词命中 stage 放行）', () => {
    const result = checkDelegationAgainstStage('prototype', {
      title: '原型修复',
      task: '修复原型中按钮不可点的问题',
      channelId: 'minimax',
      modelId: 'MiniMax-M3',
    })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
  })

  test('合法面②：testing 阶段 minimax 截图比对标注（无 coding 阶段词、无 AC 动词）→ R2 不触发，unmatched 放行', () => {
    // 措辞避开既有层一词表（「视觉/原型」是 prototype ROLE 词、「实现」是 coding ROLE 词，
    // 会被既有层一拒——那是 W8 既有行为，非 R2 引入；报告已注明该边界）
    const result = checkDelegationAgainstStage('testing', {
      title: '截图一致性标注',
      task: '对比设计稿截图与实际渲染截图，逐条标注差异（只读核对，不修改任何文件）',
      channelId: 'minimax',
      modelId: 'MiniMax-M3',
    })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('unmatched')
    expect(result.denialKind).toBeUndefined()
  })

  test('合法面③：testing + minimax + coding 词但 AC 审计意图（防御复审缺陷清单，只读）→ 放行（攻防类不经 R2，1 号判定优先）', () => {
    const result = checkDelegationAgainstStage('testing', {
      title: 'AC 防御',
      task: '防御：复审代码缺陷清单的真实性（只读审计，不修复代码）',
      channelId: 'minimax',
      modelId: 'MiniMax-M3',
    })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('ac')
  })

  test('合法面④：testing + 非 minimax 渠道 + 修复类描述 → 不属 R2（端点证据不成立，走既有判定流；无任何阶段词+无强动词 → unmatched 放行）', () => {
    const result = checkDelegationAgainstStage('testing', {
      title: '修复代码缺陷',
      task: '修复代码缺陷',
      channelId: 'deepseek',
    })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('unmatched')
    expect(result.denialKind).toBeUndefined()
  })

  test('端点未显式指定（继承父渠道，无 channelId/modelId 字段）→ R2 不触发（无端点证据不判 misuse）', () => {
    const result = checkDelegationAgainstStage('testing', {
      title: '修复提交按钮',
      task: '修复代码缺陷',
    })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('unmatched')
  })

  test('边界锁定：R2 词表不动 STRONG_ACTION_VERBS（修复不在强动词表）；教育文案含 continue_delegation 与原委派查找指引', () => {
    // 论证 P0#7：「修复」入 STRONG_ACTION_VERBS 血溅面是全阶段；W10 注释明确暂缓——本测试锁住该约束
    expect(STRONG_ACTION_VERBS).not.toContain('修复')
    expect(R2_CODING_STAGE_KEYWORDS).toEqual(['全栈', '开发', '代码', 'coding', 'code', 'index.html'])
    expect(MINIMAX_REPAIR_GUIDANCE).toContain('continue_delegation')
    expect(MINIMAX_REPAIR_GUIDANCE).toContain('全栈开发')
    expect(MINIMAX_REPAIR_GUIDANCE).toContain('list_delegations')
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

  test('单个委派：从 input 顶层提取 title/task + W22 M#9/R2 端点字段（channelId/modelId）', () => {
    expect(extractDelegationSources({ title: 'T', task: 'K', modelId: 'x' })).toEqual([{ title: 'T', task: 'K', channelId: undefined, modelId: 'x' }])
    expect(extractDelegationSources({ title: 'T', task: 'K', channelId: 'minimax', modelId: 'MiniMax-M3' }))
      .toEqual([{ title: 'T', task: 'K', channelId: 'minimax', modelId: 'MiniMax-M3' }])
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

  test('层二覆写：L1 自选已下线 glm-5-turbo 委派攻击者 → quick 项目覆写（W22 起 testing=per-phase glm 攻击者，与新作者 deepseek 跨族）', () => {
    setupProject({ stage: 'testing', mode: 'quick' })
    const input: Record<string, unknown> = {
      title: 'AC 攻击者',
      task: '攻击登录与支付场景，尝试构造可利用缺口',
      channelId: 'glm-zhipu',
      modelId: 'glm-5-turbo',
    }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'mcp__collaboration__delegate_agent', input)).toBeNull()
    expect(input.channelId).toBe('glm-zhipu')
    expect(input.modelId).toBe('glm-5.3-flash')
    // AC 类不注入路径约束（审计只读）
    expect(String(input.task)).not.toContain(PATH_CONSTRAINT_MARKER)
    const events = readTelemetryEvents()
    const override = events.find((e) => e.eventType === 'delegate.guard.ac-override')
    expect(override?.payload.originalModelId).toBe('glm-5-turbo')
    expect(override?.payload.modelId).toBe('glm-5.3-flash')
    expect(override?.payload.acRole).toBe('attacker')
  })

  test('层二覆写：iterative 项目防御者 → coding per-phase defender=minimax 家族标记 → 跳过覆写（W22 O1：门禁无法解析 UUID 渠道，保留原值+埋点）', () => {
    setupProject({ stage: 'coding', mode: 'iterative' })
    const input: Record<string, unknown> = { title: '防御者', task: '裁决攻方提交的 finding 是否成立' }
    expect(checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', input)).toBeNull()
    expect(input.channelId).toBeUndefined()
    expect(input.modelId).toBeUndefined()
    const ev = readTelemetryEvents().find((e) => e.eventType === 'delegate.guard.ac-override')
    expect(ev?.payload.skipped).toBe('family-marker')
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
    // W18.1 修复：title 还原为真实职称「测试工程师」（曾因 planning 裸「工程」子串被净化为
    // 「测试专员」规避——A2 修复后不再需要，回归固化真实职称不再被拒）
    const input: Record<string, unknown> = {
      items: [
        { title: '测试工程师 A', task: '编写登录验收测试' },
        { title: '测试工程师 B', task: '编写支付 GWT 场景' },
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
    // 层二独立性保持：攻方覆写（W22 起 testing per-phase 攻击者=glm，与新作者 deepseek 跨族）
    expect(input.modelId).toBe('glm-5.3-flash')
    expect(input.channelId).toBe('glm-zhipu')
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
    // W18.1：文本避开下游（testing）产出物词「场景」——coding 强动词在场 + 下游 OUTPUT 词
    // 并存会被 A3 守卫 deny（见 w18-delegate-intent.test.ts）；本测试焦点是层二覆写/层三注入
    const input: Record<string, unknown> = { task: '实现登录页，完成后 attack 认证链路复审' }
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
  // 被第 2 步他阶段扫描先命中（denialKind='other-stage'，W8 既有行为，deny 结果等价）；
  // W18.1 后「写代码」（含产出物词「代码」）与「code」（同词）再被 2.5 步下游 OUTPUT 守卫
  // 先拦（violatedStage 同为 coding，denialKind='other-stage'）；其余动词走第 4 条 strong-verb。
  // 矩阵固化三路分流。
  test('全部强动词在 requirements 阶段（无阶段词文本）→ denied；动词属 coding 阶段词的走 other-stage，其余走 strong-verb', () => {
    const codingVerbs = new Set(['实现', '开发', '写代码', 'code'])
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
      // W19-C：「场景」已从 testing OUTPUT 移除（UX 正常词汇，实测 deny#8）——
      // 本对改用保留产出物词 report.json 承接同一测试意图
      ['testing', '整理 report.json 覆盖情况'],
    ]
    for (const [stage, task] of pairs) {
      const result = checkDelegationAgainstStage(stage, { title: '助手', task })
      expect(result.allowed).toBe(true)
      expect(result.matchKind).toBe('stage')
    }
  })

  test('W18.1 分流迁移：requirements 阶段「构建代码评审清单」含强动词「构建」+下游产出词「代码」→ deny(other-stage, coding)（原 strong-verb）', () => {
    // W10 原断言：产出物词不参与他阶段扫描 → unmatched+「构建」强动词 strong-verb deny；
    // W18.1 A3 守卫有条件纳入下游产出物词（强动词在场时）——本文本从 strong-verb 迁移到
    // other-stage（deny 语义等价，且归因到 coding 更准）；无强动词的交叉表述仍不扫产出词（宽匹配原则不推翻）
    const result = checkDelegationAgainstStage('requirements', { title: '评审', task: '构建代码评审清单' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('coding')
    expect(result.violatedKeyword).toBe('代码')
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
    // W18.1（A2 修复后）：「测试工程师」首命中 testing 的「测试」（原裸「工程」已从 planning
    // 词表移除——归因更贴切，不再自相矛盾地归 planning）
    expect(result?.message).toContain('命中「测试」')
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

// ═══════════════ W19-C（v0.17.88）：路径豁免 + 词表复核 + 邻近语境判定 ═══════════════

/**
 * E2E 实测 9 连拒样本重放（R 级探针）：L1-0a37a8ee-sdk-01a07147.jsonl 中的全部
 * delegate_agent 参数原文（title/task/expectedOutput 未截断）。
 * - line 8：requirements 首委派（对照，原本就放行）
 * - line 20-34：8 次被拒委派（telemetry 逐条 stage-deny：需求/PRD/fullstack/验收×2/
 *   代码/应用/场景）——修复后重放应全部放行
 * - line 36：L1 同义改写后放行的最终委派（对照）
 * 提取脚本见 reports/w19-guard-impl.md §0；字符内容为 R 级证据逐字复制。
 */
interface W19ReplaySample {
  line: number
  stage: 'requirements' | 'prototype'
  title: string
  task: string
  expectedOutput: string
}

const W19_E2E_REPLAY_SAMPLES: W19ReplaySample[] = [
  {
    line: 8,
    stage: 'requirements',
    title: "需求分析师：番茄钟工具 PRD",
    task: "你是需求分析师。与用户对话收集需求，产出 PRD。\n\n用户初始需求（已向调度员表达）：「做一个倒计时番茄钟工具：25分钟专注+5分钟休息循环，可暂停/重置，显示剩余时间」。你仍可按流程向用户追问引导性问题（通过 blocked 事件，由调度员转述），但应基于此初始需求，避免重复询问已明确的内容。\n\n## 约束\n用生活化语言提问；3-5 个引导性问题；提供选项而非填空；PRD 应含「US-xx」编号的用户故事清单（如「## US-01 添加笔记」），每条故事一段含验收标准；后续验收测试按 US-xx 编号判定覆盖性，无编号清单会导致验收无法收口；工程品类初判（强烈建议）：工程品类标注（后续 coding 按品类加载工程模板）：文档中包含一行 `projectCategory: <品类>`，品类限 web-fullstack / api-backend / mobile-app / desktop-app / cli-tool / ai-application 六选一（本地桌面程序=desktop-app，纯后端服务=api-backend，命令行工具=cli-tool，移动应用=mobile-app，以 LLM 为核心=ai-application，浏览器访问的网站/Web 应用=web-fullstack）；放在 PRD 靠前位置（如「## 工程品类」一节）\n\n## 产出文件\n请将产出写入：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/01_PRD/prd.md\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 审计通过后，返回产出文件路径和 AC 审计结论摘要。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件 /home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/01_PRD/prd.md（含 projectCategory、US-xx 编号用户故事清单与验收标准），并返回产出文件路径和 AC 审计结论摘要（攻防轮次、red 清零情况或已知问题清单）。",
  },
  {
    line: 20,
    stage: 'prototype',
    title: "UX 顾问：番茄钟交互原型",
    task: "你是UX 顾问。你是 UX 顾问。根据 PRD 生成可交互 HTML 原型。\n\n## 前序 PRD 摘要\n# 番茄钟（倒计时番茄钟工具）产品需求文档（PRD）\n\n- 文档版本：v1.1（修复 AC 对抗审计 RED-1/RED-2 与 YELLOW-1~4 后）\n- 日期：2026-09-05\n- 作者：Proma 需求分析师（子会话 59ce67aa-0635-419f-951f-7d38b6848eda）\n- 状态：待评审（AC 对抗审计中）\n\n## 工程品类\n\nprojectCategory: web-fullstack\n\n> 说明：按浏览器访问的 Web 应用（单页应用，无需安装、打开即用）设计，符合「工具」的轻量定位，也便于后续端到端验收用浏览器自动化执行。若用户希望改为本地桌面程序，请明确告知后再整体调整品类与后续模板（改动影响 UX/架构/测试全链路）。\n\n## 一、产品概述\n\n### 1.1 一句话定位\n一个帮人「专心干 25 分钟、歇 5 分钟」的倒计时番茄钟：你点开始，它替你数时间；时间到了，它自动提醒你切换专注/休息。\n\n### 1.2 目标\n- 让用户在电脑浏览器里随时打开就能用，无需注册登录、无需安装。\n- 用清晰的剩余时间倒计时 + 专注/休息阶段切换，帮助用户...(截断)\n\n## 前序产出文件（请先 Read 后再工作）\n/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/01_PRD/prd.md\n\n## 前序必读：PRD 用户故事清单\n01_PRD/prd.md 包含用户故事与验收标准（AC）清单，是你的必读输入。\n你必须先完整 Read 该文件，把每条用户故事列成对照清单；\n后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。\n\n## 约束\n单文件 HTML，内联 CSS；简洁现代风格；覆盖 PRD 核心功能；可交互演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态/数据用演示数据+JS 状态机模拟（参照闪念Tips 原型的做法：六态状态机、串行队列模拟、故障注入演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）；点选纠错标记（硬性标准）：所有可交互/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会注入点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名；多场景导航规范：场景索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个场景全部展示，>6 横向滚动不换行；核心场景在 1280x720 首屏不滚动即可见\n\n## 产出文件\n请将产出写入：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html\n\n## 补充说明（用户裁决的遗留问题，请顺带处理）\n上一阶段 AC 审计遗留已知问题 F1（red）：PRD §八示例参数 `?focusSec=2&breakSec=1` 与 AC9-1「提示至少持续显示 3 秒」数学冲突。用户已裁决按建议①修复：请把 prd.md §八中该示例参数最小改动为 `?focusSec=3&breakSec=3`（只改这一处示例参数，不动其他内容），并在你的原型中相应保证短时长演示模式下完成提示可见性不被立即覆盖。\n\n## 截图渲染自检循环（必须执行，先于 AC 审计）\n⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；\n   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。\n每次生成或修改原型 HTML 后，你必须：\n1. 用 chrome-devtools MCP 的 new_page 打开 file:///home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（原型绝对路径）。\n2. 用 take_screenshot 获取渲染截图。\n3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看代码推断）。\n4. 对照 PRD 用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击验证：点按钮看反馈、填输入看结果——不允许只看代码就判可交互，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（场景索引为顶部横向分页窄条且 sticky，核心场景 1280x720 首屏可见，无纵向全屏索引页）、可交互演示达标（原型可真实操作而非静态展示，状态机/演示数据完整，参照闪念Tips 原型标准）。\n5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，\n   用 delegate_agent(inline:true, channel=ad74ac74-64a1-4dbb-80c5-4f5d9916bace, model=MiniMax-M3) 创建视觉验证者。\n   只给它两样输入：PRD 用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。\n   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。\n   审查项必含「导航布局合规」：场景索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心场景是否首屏可见。\n5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。\n   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。\n6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 视觉验证者是独立裁决者，只看 PRD 用户故事与最新截图，防止你自证通过。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件 /home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（单文件 HTML，可交互演示原型，含 data-ai-id/data-ai-id 标记与顶部横向场景导航窄条），并返回产出文件路径、AC 审计结论摘要（攻防轮次与 red 清零情况）与视觉裁决结论。",
  },
  {
    line: 22,
    stage: 'prototype',
    title: "UX 顾问：番茄钟交互原型",
    task: "你是UX 顾问。你是 UX 顾问。根据 PRD 生成可交互 HTML 原型。\n\n## 前序输入（必读，先 Read 再工作）\n番茄钟（倒计时番茄钟工具）的产品文档 v1.1 已完成评审与 AC 对抗审计，全文位于：\n/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/01_PRD/prd.md\n文档要点：projectCategory: web-fullstack（浏览器 Web 单页应用，免安装）；一句话定位——「专心干 25 分钟、歇 5 分钟」的倒计时番茄钟，点开始自动数时间，到点自动提醒切换专注/休息。\n\n## 前序必读：PRD 用户故事清单\n01_PRD/prd.md 包含用户故事与验收标准（AC）清单，是你的必读输入。\n你必须先完整 Read 该文件，把每条用户故事列成对照清单；\n后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。\n\n## 约束\n单文件 HTML，内联 CSS；简洁现代风格；覆盖 PRD 核心功能；可交互演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态/数据用演示数据+JS 状态机模拟（参照闪念Tips 原型的做法：六态状态机、串行队列模拟、故障注入演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）；点选纠错标记（硬性标准）：所有可交互/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会注入点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名；多场景导航规范：场景索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个场景全部展示，>6 横向滚动不换行；核心场景在 1280x720 首屏不滚动即可见\n\n## 产出文件\n请将产出写入：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html\n\n## 补充说明（用户裁决的遗留问题，请顺带处理）\n上一阶段 AC 审计遗留已知问题 F1（red）：PRD §八示例参数 `?focusSec=2&breakSec=1` 与 AC9-1「提示至少持续显示 3 秒」数学冲突。用户已裁决按建议①修复：请把 prd.md §八中该示例参数最小改动为 `?focusSec=3&breakSec=3`（只改这一处示例参数，不动其他内容），并在你的原型中相应保证短时长演示模式下完成提示可见性不被立即覆盖。\n\n## 截图渲染自检循环（必须执行，先于 AC 审计）\n⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；\n   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。\n每次生成或修改原型 HTML 后，你必须：\n1. 用 chrome-devtools MCP 的 new_page 打开 file:///home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（原型绝对路径）。\n2. 用 take_screenshot 获取渲染截图。\n3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看代码推断）。\n4. 对照 PRD 用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击验证：点按钮看反馈、填输入看结果——不允许只看代码就判可交互，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（场景索引为顶部横向分页窄条且 sticky，核心场景 1280x720 首屏可见，无纵向全屏索引页）、可交互演示达标（原型可真实操作而非静态展示，状态机/演示数据完整，参照闪念Tips 原型标准）。\n5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，\n   用 delegate_agent(inline:true, channel=ad74ac74-64a1-4dbb-80c5-4f5d9916bace, model=MiniMax-M3) 创建视觉验证者。\n   只给它两样输入：PRD 用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。\n   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。\n   审查项必含「导航布局合规」：场景索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心场景是否首屏可见。\n5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。\n   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。\n6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 视觉验证者是独立裁决者，只看 PRD 用户故事与最新截图，防止你自证通过。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件 /home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（单文件 HTML，可交互演示原型，含 data-ai-id/data-ai-type 标记与顶部横向场景导航窄条），并返回产出文件路径、AC 审计结论摘要（攻防轮次与 red 清零情况）与视觉裁决结论。",
  },
  {
    line: 24,
    stage: 'prototype',
    title: "UX 顾问：番茄钟交互原型",
    task: "你是UX 顾问。你是 UX 顾问。根据产品文档生成可交互 HTML 原型。\n\n## 前序输入（必读，先 Read 再工作）\n番茄钟（倒计时番茄钟工具）的产品文档 v1.1（已完成评审与 AC 对抗审计）位于项目目录：\n/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2\n请先用 LS 列出该目录，进入 01_ 开头的子目录，Read 其中的 .md 文档。\n文档要点：projectCategory: web-fullstack（浏览器 Web 单页应用，免安装）；一句话定位——「专心干 25 分钟、歇 5 分钟」的倒计时番茄钟，点开始自动数时间，到点自动提醒切换专注/休息。\n\n## 前序必读：用户故事清单\n该文档包含用户故事与验收标准（AC）清单，是你的必读输入。\n你必须先完整 Read 该文件，把每条用户故事列成对照清单；\n后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。\n\n## 约束\n单文件 HTML，内联 CSS；简洁现代风格；覆盖产品文档核心功能；可交互演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态/数据用演示数据+JS 状态机模拟（参照闪念Tips 原型的做法：六态状态机、串行队列模拟、故障注入演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）；点选纠错标记（硬性标准）：所有可交互/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会注入点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名；多场景导航规范：场景索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个场景全部展示，>6 横向滚动不换行；核心场景在 1280x720 首屏不滚动即可见\n\n## 产出文件\n请将产出写入：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html\n\n## 补充说明（用户裁决的遗留问题，请顺带处理）\n上一阶段 AC 审计遗留已知问题 F1（red）：产品文档 §八示例参数 `?focusSec=2&breakSec=1` 与 AC9-1「提示至少持续显示 3 秒」数学冲突。用户已裁决按建议①修复：请把该文档 §八中此示例参数最小改动为 `?focusSec=3&breakSec=3`（只改这一处示例参数，不动其他内容），并在你的原型中相应保证短时长演示模式下完成提示可见性不被立即覆盖。\n\n## 截图渲染自检循环（必须执行，先于 AC 审计）\n⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；\n   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。\n每次生成或修改原型 HTML 后，你必须：\n1. 用 chrome-devtools MCP 的 new_page 打开 file:///home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（原型绝对路径）。\n2. 用 take_screenshot 获取渲染截图。\n3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看代码推断）。\n4. 对照用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击验证：点按钮看反馈、填输入看结果——不允许只看代码就判可交互，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（场景索引为顶部横向分页窄条且 sticky，核心场景 1280x720 首屏可见，无纵向全屏索引页）、可交互演示达标（原型可真实操作而非静态展示，状态机/演示数据完整，参照闪念Tips 原型标准）。\n5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，\n   用 delegate_agent(inline:true, channel=ad74ac74-64a1-4dbb-80c5-4f5d9916bace, model=MiniMax-M3) 创建视觉验证者。\n   只给它两样输入：用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。\n   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。\n   审查项必含「导航布局合规」：场景索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心场景是否首屏可见。\n5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。\n   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。\n6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 视觉验证者是独立裁决者，只看用户故事清单与最新截图，防止你自证通过。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件 /home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（单文件 HTML，可交互演示原型，含 data-ai-id/data-ai-type 标记与顶部横向场景导航窄条），并返回产出文件路径、AC 审计结论摘要（攻防轮次与 red 清零情况）与视觉裁决结论。",
  },
  {
    line: 26,
    stage: 'prototype',
    title: "UX 顾问：番茄钟交互原型",
    task: "你是UX 顾问。你是 UX 顾问。根据产品文档生成可交互 HTML 原型。\n\n## 前序输入（必读，先 Read 再工作）\n番茄钟（倒计时番茄钟工具）的产品文档 v1.1（已完成评审与 AC 对抗审计）位于项目目录：\n/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2\n请先用 LS 列出该目录，进入 01_ 开头的子目录，Read 其中的 .md 文档。\n文档要点：品类为浏览器 Web 单页应用（免安装、打开即用）；一句话定位——「专心干 25 分钟、歇 5 分钟」的倒计时番茄钟，点开始自动数时间，到点自动提醒切换专注/休息。\n\n## 前序必读：用户故事清单\n该文档包含用户故事与验收标准（AC）清单，是你的必读输入。\n你必须先完整 Read 该文件，把每条用户故事列成对照清单；\n后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。\n\n## 约束\n单文件 HTML，内联 CSS；简洁现代风格；覆盖产品文档核心功能；可交互演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态/数据用演示数据+JS 状态机模拟（参照闪念Tips 原型的做法：六态状态机、串行队列模拟、故障注入演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）；点选纠错标记（硬性标准）：所有可交互/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会注入点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名；多场景导航规范：场景索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个场景全部展示，>6 横向滚动不换行；核心场景在 1280x720 首屏不滚动即可见\n\n## 产出文件\n请将产出写入：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html\n\n## 补充说明（用户裁决的遗留问题，请顺带处理）\n上一阶段 AC 审计遗留已知问题 F1（red）：产品文档 §八示例参数 `?focusSec=2&breakSec=1` 与 AC9-1「提示至少持续显示 3 秒」数学冲突。用户已裁决按建议①修复：请把该文档 §八中此示例参数最小改动为 `?focusSec=3&breakSec=3`（只改这一处示例参数，不动其他内容），并在你的原型中相应保证短时长演示模式下完成提示可见性不被立即覆盖。\n\n## 截图渲染自检循环（必须执行，先于 AC 审计）\n⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；\n   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。\n每次生成或修改原型 HTML 后，你必须：\n1. 用 chrome-devtools MCP 的 new_page 打开 file:///home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（原型绝对路径）。\n2. 用 take_screenshot 获取渲染截图。\n3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看代码推断）。\n4. 对照用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击验证：点按钮看反馈、填输入看结果——不允许只看代码就判可交互，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（场景索引为顶部横向分页窄条且 sticky，核心场景 1280x720 首屏可见，无纵向全屏索引页）、可交互演示达标（原型可真实操作而非静态展示，状态机/演示数据完整，参照闪念Tips 原型标准）。\n5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，\n   用 delegate_agent(inline:true, channel=ad74ac74-64a1-4dbb-80c5-4f5d9916bace, model=MiniMax-M3) 创建视觉验证者。\n   只给它两样输入：用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。\n   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。\n   审查项必含「导航布局合规」：场景索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心场景是否首屏可见。\n5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。\n   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。\n6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 视觉验证者是独立裁决者，只看用户故事清单与最新截图，防止你自证通过。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件 /home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（单文件 HTML，可交互演示原型，含 data-ai-id/data-ai-type 标记与顶部横向场景导航窄条），并返回产出文件路径、AC 审计结论摘要（攻防轮次与 red 清零情况）与视觉裁决结论。",
  },
  {
    line: 28,
    stage: 'prototype',
    title: "UX 顾问：番茄钟交互原型",
    task: "你是UX 顾问。你是 UX 顾问。根据产品文档生成可交互 HTML 原型。\n\n## 前序输入（必读，先 Read 再工作）\n番茄钟（倒计时番茄钟工具）的产品文档 v1.1（已完成 AC 对抗审计收敛）位于项目目录：\n/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2\n请先用 LS 列出该目录，进入 01_ 开头的子目录，Read 其中的 .md 文档。\n文档要点：形态为浏览器 Web 单页应用（免安装、打开即用）；一句话定位——「专心干 25 分钟、歇 5 分钟」的倒计时番茄钟，点开始自动数时间，到点自动提醒切换专注/休息。\n\n## 前序必读：用户故事清单\n该文档包含用户故事与 AC 判定标准清单，是你的必读输入。\n你必须先完整 Read 该文件，把每条用户故事列成对照清单；\n后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。\n\n## 约束\n单文件 HTML，内联 CSS；简洁现代风格；覆盖产品文档核心功能；可交互演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态/数据用演示数据+JS 状态机模拟（参照闪念Tips 原型的做法：六态状态机、串行队列模拟、故障注入演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）；点选纠错标记（硬性标准）：所有可交互/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会注入点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名；多场景导航规范：场景索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个场景全部展示，>6 横向滚动不换行；核心场景在 1280x720 首屏不滚动即可见\n\n## 产出文件\n请将产出写入：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html\n\n## 补充说明（用户裁决的遗留问题，请顺带处理）\n上一阶段 AC 审计遗留已知问题 F1（red）：产品文档 §八示例参数 `?focusSec=2&breakSec=1` 与 AC9-1「提示至少持续显示 3 秒」数学冲突。用户已裁决按建议①修复：请把该文档 §八中此示例参数最小改动为 `?focusSec=3&breakSec=3`（只改这一处示例参数，不动其他内容），并在你的原型中相应保证短时长演示模式下完成提示可见性不被立即覆盖。\n\n## 截图渲染自检循环（必须执行，先于 AC 审计）\n⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；\n   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。\n每次生成或修改原型 HTML 后，你必须：\n1. 用 chrome-devtools MCP 的 new_page 打开 file:///home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（原型绝对路径）。\n2. 用 take_screenshot 获取渲染截图。\n3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看代码推断）。\n4. 对照用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击验证：点按钮看反馈、填输入看结果——不允许只看代码就判可交互，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（场景索引为顶部横向分页窄条且 sticky，核心场景 1280x720 首屏可见，无纵向全屏索引页）、可交互演示达标（原型可真实操作而非静态展示，状态机/演示数据完整，参照闪念Tips 原型标准）。\n5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，\n   用 delegate_agent(inline:true, channel=ad74ac74-64a1-4dbb-80c5-4f5d9916bace, model=MiniMax-M3) 创建视觉验证者。\n   只给它两样输入：用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。\n   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。\n   审查项必含「导航布局合规」：场景索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心场景是否首屏可见。\n5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。\n   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。\n6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 视觉验证者是独立裁决者，只看用户故事清单与最新截图，防止你自证通过。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件 /home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html（单文件 HTML，可交互演示原型，含 data-ai-id/data-ai-type 标记与顶部横向场景导航窄条），并返回产出文件路径、AC 审计结论摘要（攻防轮次与 red 清零情况）与视觉裁决结论。",
  },
  {
    line: 30,
    stage: 'prototype',
    title: "UX 顾问：番茄钟交互原型",
    task: "你是UX 顾问。你是 UX 顾问。根据产品文档生成可交互 HTML 原型。\n\n## 项目目录定位（第一步先做）\n项目根：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files\n用 LS 列出项目根，找到名称以 project-e2e-w18- 开头、以数字 2 结尾的唯一目录（下称「项目目录」，真实名称以 LS 结果为准）。后续所有读写都基于项目目录拼接：\n- 输入文档 = 项目目录下 01_ 开头子目录内的 .md 文档（产品文档 v1.1，已完成 AC 对抗审计收敛，先 Read 全文）\n- 产出文件 = 项目目录/02_UX_DESIGN/prototype.html\n- 截图打开地址 = file:// + 项目目录绝对路径 + /02_UX_DESIGN/prototype.html\n\n## 文档要点\n番茄钟（倒计时番茄钟工具）：形态为浏览器 Web 单页应用（免安装、打开即用）；一句话定位——「专心干 25 分钟、歇 5 分钟」的倒计时番茄钟，点开始自动数时间，到点自动提醒切换专注/休息。\n\n## 前序必读：用户故事清单\n该文档包含用户故事与 AC 判定标准清单，是你的必读输入。\n你必须先完整 Read 该文件，把每条用户故事列成对照清单；\n后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。\n\n## 约束\n单文件 HTML，内联 CSS；简洁现代风格；覆盖产品文档核心功能；可交互演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态/数据用演示数据+JS 状态机模拟（参照闪念Tips 原型的做法：六态状态机、串行队列模拟、故障注入演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）；点选纠错标记（硬性标准）：所有可交互/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会注入点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名；多场景导航规范：场景索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个场景全部展示，>6 横向滚动不换行；核心场景在 1280x720 首屏不滚动即可见\n\n## 补充说明（用户裁决的遗留问题，请顺带处理）\n上一阶段 AC 审计遗留已知问题 F1（red）：产品文档 §八示例参数 `?focusSec=2&breakSec=1` 与 AC9-1「提示至少持续显示 3 秒」数学冲突。用户已裁决按建议①修复：请把该文档 §八中此示例参数最小改动为 `?focusSec=3&breakSec=3`（只改这一处示例参数，不动其他内容），并在你的原型中相应保证短时长演示模式下完成提示可见性不被立即覆盖。\n\n## 截图渲染自检循环（必须执行，先于 AC 审计）\n⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；\n   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。\n每次生成或修改原型 HTML 后，你必须：\n1. 用 chrome-devtools MCP 的 new_page 打开 file:// + 项目目录绝对路径 + /02_UX_DESIGN/prototype.html（原型绝对路径，先 LS 确认）。\n2. 用 take_screenshot 获取渲染截图。\n3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看代码推断）。\n4. 对照用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击验证：点按钮看反馈、填输入看结果——不允许只看代码就判可交互，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（场景索引为顶部横向分页窄条且 sticky，核心场景 1280x720 首屏可见，无纵向全屏索引页）、可交互演示达标（原型可真实操作而非静态展示，状态机/演示数据完整，参照闪念Tips 原型标准）。\n5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，\n   用 delegate_agent(inline:true, channel=ad74ac74-64a1-4dbb-80c5-4f5d9916bace, model=MiniMax-M3) 创建视觉验证者。\n   只给它两样输入：用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。\n   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。\n   审查项必含「导航布局合规」：场景索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心场景是否首屏可见。\n5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。\n   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。\n6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 视觉验证者是独立裁决者，只看用户故事清单与最新截图，防止你自证通过。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件：项目目录/02_UX_DESIGN/prototype.html（单文件 HTML，可交互演示原型，含 data-ai-id/data-ai-type 标记与顶部横向场景导航窄条），并返回产出文件路径、AC 审计结论摘要（攻防轮次与 red 清零情况）与视觉裁决结论。",
  },
  {
    line: 32,
    stage: 'prototype',
    title: "UX 顾问：番茄钟交互原型",
    task: "你是UX 顾问。你是 UX 顾问。根据产品文档生成可交互 HTML 原型。\n\n## 项目目录定位（第一步先做）\n项目根：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files\n用 LS 列出项目根，找到名称以 project-e2e-w18- 开头、以数字 2 结尾的唯一目录（下称「项目目录」，真实名称以 LS 结果为准）。后续所有读写都基于项目目录拼接：\n- 输入文档 = 项目目录下 01_ 开头子目录内的 .md 文档（产品文档 v1.1，已完成 AC 对抗审计收敛，先 Read 全文）\n- 产出文件 = 项目目录/02_UX_DESIGN/prototype.html\n- 截图打开地址 = file:// + 项目目录绝对路径 + /02_UX_DESIGN/prototype.html\n\n## 文档要点\n番茄钟（倒计时番茄钟工具）：形态为浏览器 Web 单页应用（免安装、打开即用）；一句话定位——「专心干 25 分钟、歇 5 分钟」的倒计时番茄钟，点开始自动数时间，到点自动提醒切换专注/休息。\n\n## 前序必读：用户故事清单\n该文档包含用户故事与 AC 判定标准清单，是你的必读输入。\n你必须先完整 Read 该文件，把每条用户故事列成对照清单；\n后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。\n\n## 约束\n单文件 HTML，内联 CSS；简洁现代风格；覆盖产品文档核心功能；可交互演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态/数据用演示数据+JS 状态机模拟（参照闪念Tips 原型的做法：六态状态机、串行队列模拟、故障注入演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）；点选纠错标记（硬性标准）：所有可交互/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会注入点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名；多场景导航规范：场景索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个场景全部展示，>6 横向滚动不换行；核心场景在 1280x720 首屏不滚动即可见\n\n## 补充说明（用户裁决的遗留问题，请顺带处理）\n上一阶段 AC 审计遗留已知问题 F1（red）：产品文档 §八示例参数 `?focusSec=2&breakSec=1` 与 AC9-1「提示至少持续显示 3 秒」数学冲突。用户已裁决按建议①修复：请把该文档 §八中此示例参数最小改动为 `?focusSec=3&breakSec=3`（只改这一处示例参数，不动其他内容），并在你的原型中相应保证短时长演示模式下完成提示可见性不被立即覆盖。\n\n## 截图渲染自检循环（必须执行，先于 AC 审计）\n⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；\n   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。\n每次生成或修改原型 HTML 后，你必须：\n1. 用 chrome-devtools MCP 的 new_page 打开 file:// + 项目目录绝对路径 + /02_UX_DESIGN/prototype.html（原型绝对路径，先 LS 确认）。\n2. 用 take_screenshot 获取渲染截图。\n3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看 HTML 源文推断）。\n4. 对照用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击验证：点按钮看反馈、填输入看结果——不允许只看 HTML 源文就判可交互，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（场景索引为顶部横向分页窄条且 sticky，核心场景 1280x720 首屏可见，无纵向全屏索引页）、可交互演示达标（原型可真实操作而非静态展示，状态机/演示数据完整，参照闪念Tips 原型标准）。\n5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，\n   用 delegate_agent(inline:true, channel=ad74ac74-64a1-4dbb-80c5-4f5d9916bace, model=MiniMax-M3) 创建视觉验证者。\n   只给它两样输入：用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。\n   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。\n   审查项必含「导航布局合规」：场景索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心场景是否首屏可见。\n5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。\n   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。\n6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 视觉验证者是独立裁决者，只看用户故事清单与最新截图，防止你自证通过。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件：项目目录/02_UX_DESIGN/prototype.html（单文件 HTML，可交互演示原型，含 data-ai-id/data-ai-type 标记与顶部横向场景导航窄条），并返回产出文件路径、AC 审计结论摘要（攻防轮次与 red 清零情况）与视觉裁决结论。",
  },
  {
    line: 34,
    stage: 'prototype',
    title: "UX 顾问：番茄钟交互原型",
    task: "你是UX 顾问。你是 UX 顾问。根据产品文档生成可交互 HTML 原型。\n\n## 项目目录定位（第一步先做）\n项目根：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files\n用 LS 列出项目根，找到名称以 project-e2e-w18- 开头、以数字 2 结尾的唯一目录（下称「项目目录」，真实名称以 LS 结果为准）。后续所有读写都基于项目目录拼接：\n- 输入文档 = 项目目录下 01_ 开头子目录内的 .md 文档（产品文档 v1.1，已完成 AC 对抗审计收敛，先 Read 全文）\n- 产出文件 = 项目目录/02_UX_DESIGN/prototype.html\n- 截图打开地址 = file:// + 项目目录绝对路径 + /02_UX_DESIGN/prototype.html\n\n## 文档要点\n番茄钟（倒计时番茄钟工具）：形态为浏览器网页（免安装、打开即用，单页面）；一句话定位——「专心干 25 分钟、歇 5 分钟」的倒计时番茄钟，点开始自动数时间，到点自动提醒切换专注/休息。\n\n## 前序必读：用户故事清单\n该文档包含用户故事与 AC 判定标准清单，是你的必读输入。\n你必须先完整 Read 该文件，把每条用户故事列成对照清单；\n后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。\n\n## 约束\n单文件 HTML，内联 CSS；简洁现代风格；覆盖产品文档核心功能；可交互演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态/数据用演示数据+JS 状态机模拟（参照闪念Tips 原型的做法：六态状态机、串行队列模拟、故障模拟演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）；点选纠错标记（硬性标准）：所有可交互/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会加载点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名；多场景导航规范：场景索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个场景全部展示，>6 横向滚动不换行；核心场景在 1280x720 首屏不滚动即可见\n\n## 补充说明（用户裁决的遗留问题，请顺带处理）\n上一阶段 AC 审计遗留已知问题 F1（red）：产品文档 §八示例参数 `?focusSec=2&breakSec=1` 与 AC9-1「提示至少持续显示 3 秒」数学冲突。用户已裁决按建议①修复：请把该文档 §八中此示例参数最小改动为 `?focusSec=3&breakSec=3`（只改这一处示例参数，不动其他内容），并在你的原型中相应保证短时长演示模式下完成提示可见性不被立即覆盖。\n\n## 截图渲染自检循环（必须执行，先于 AC 审计）\n⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；\n   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。\n每次生成或修改原型 HTML 后，你必须：\n1. 用 chrome-devtools MCP 的 new_page 打开 file:// + 项目目录绝对路径 + /02_UX_DESIGN/prototype.html（原型绝对路径，先 LS 确认）。\n2. 用 take_screenshot 获取渲染截图。\n3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看 HTML 源文推断）。\n4. 对照用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击验证：点按钮看反馈、填输入看结果——不允许只看 HTML 源文就判可交互，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（场景索引为顶部横向分页窄条且 sticky，核心场景 1280x720 首屏可见，无纵向全屏索引页）、可交互演示达标（原型可真实操作而非静态展示，状态机/演示数据完整，参照闪念Tips 原型标准）。\n5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，\n   用 delegate_agent(inline:true, channel=ad74ac74-64a1-4dbb-80c5-4f5d9916bace, model=MiniMax-M3) 创建视觉验证者。\n   只给它两样输入：用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。\n   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。\n   审查项必含「导航布局合规」：场景索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心场景是否首屏可见。\n5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。\n   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。\n6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 视觉验证者是独立裁决者，只看用户故事清单与最新截图，防止你自证通过。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件：项目目录/02_UX_DESIGN/prototype.html（单文件 HTML，可交互演示原型，含 data-ai-id/data-ai-type 标记与顶部横向场景导航窄条），并返回产出文件路径、AC 审计结论摘要（攻防轮次与 red 清零情况）与视觉裁决结论。",
  },
  {
    line: 36,
    stage: 'prototype',
    title: "UX 顾问：番茄钟交互原型",
    task: "你是UX 顾问。你是 UX 顾问。根据产品文档生成可操作 HTML 原型。\n\n## 项目目录定位（第一步先做）\n项目根：/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files\n用 LS 列出项目根，找到名称以 project-e2e-w18- 开头、以数字 2 结尾的唯一目录（下称「项目目录」，真实名称以 LS 结果为准）。后续所有读写都基于项目目录拼接：\n- 输入文档 = 项目目录下 01_ 开头子目录内的 .md 文档（产品文档 v1.1，已完成 AC 对抗审计收敛，先 Read 全文）\n- 产出文件 = 项目目录/02_UX_DESIGN/prototype.html\n- 截图打开地址 = file:// + 项目目录绝对路径 + /02_UX_DESIGN/prototype.html\n\n## 文档要点\n番茄钟（倒计时番茄钟工具）：形态为浏览器网页（免安装、打开即用，单页面）；一句话定位——「专心干 25 分钟、歇 5 分钟」的倒计时番茄钟，点开始自动数时间，到点自动提醒切换专注/休息。\n\n## 前序必读：用户故事清单\n该文档包含用户故事与 AC 判定标准清单，是你的必读输入。\n你必须先完整 Read 该文件，把每条用户故事列成对照清单；\n后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。\n\n## 约束\n单文件 HTML，内联 CSS；简洁现代风格；覆盖产品文档核心功能；可操作演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态与示例内容用内置示例+JS 状态流转逻辑模拟（参照闪念Tips 原型的做法：六态状态流转、串行队列模拟、故障模拟演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）；点选纠错标记（硬性标准）：所有可操作/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会加载点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名；多视图导航规范：视图索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个视图全部展示，>6 横向滚动不换行；核心视图在 1280x720 首屏不滚动即可见\n\n## 补充说明（用户裁决的遗留问题，请顺带处理）\n上一阶段 AC 审计遗留已知问题 F1（red）：产品文档 §八示例参数 `?focusSec=2&breakSec=1` 与 AC9-1「提示至少持续显示 3 秒」数学冲突。用户已裁决按建议①修复：请把该文档 §八中此示例参数最小改动为 `?focusSec=3&breakSec=3`（只改这一处示例参数，不动其他内容），并在你的原型中相应保证短时长演示模式下完成提示可见性不被立即覆盖。\n\n## 截图渲染自检循环（必须执行，先于 AC 审计）\n⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；\n   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。\n每次生成或修改原型 HTML 后，你必须：\n1. 用 chrome-devtools MCP 的 new_page 打开 file:// + 项目目录绝对路径 + /02_UX_DESIGN/prototype.html（原型绝对路径，先 LS 确认）。\n2. 用 take_screenshot 获取渲染截图。\n3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看 HTML 源文推断）。\n4. 对照用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击确认：点按钮看反馈、填输入看结果——不允许只看 HTML 源文就判可操作，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（视图索引为顶部横向分页窄条且 sticky，核心视图 1280x720 首屏可见，无纵向全屏索引页）、可操作演示达标（原型可真实操作而非静态展示，状态流转/示例内容完整，参照闪念Tips 原型标准）。\n5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。\n\n## AC 对抗审计（必须执行）\n完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：\n\n### 步骤\n1. 用 delegate_agent(inline:true, channel=deepseek, model=deepseek-v4-flash) 创建攻击者，\n   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。\n   审查维度：完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性。\n   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。\n2. 用 delegate_agent(inline:true, channel=glm-zhipu, model=glm-5.3-flash) 创建防御者，\n   让它对照攻击者的发现，用证据反驳或确认。\n   注意：攻击者和防御者是不同模型家族，不能串通。\n3. 【审计流程（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。\n   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。\n   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：\n   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）\n   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。\n4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，\n   用 delegate_agent(inline:true, channel=ad74ac74-64a1-4dbb-80c5-4f5d9916bace, model=MiniMax-M3) 创建独立视觉裁决者。\n   只给它两样输入：用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。\n   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。\n   审查项必含「导航布局合规」：视图索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心视图是否首屏可见。\n5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。\n   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。\n6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。\n\n### 注意\n- 攻击者和防御者必须使用不同的模型家族（deepseek vs glm-zhipu）。\n- 你自己就是作者，不要不经委派就自己下审计结论。\n- 独立视觉裁决者只看用户故事清单与最新截图，防止你自证通过。\n- 修复循环由你驱动，不需要调度员或用户参与。",
    expectedOutput: "产出文件：项目目录/02_UX_DESIGN/prototype.html（单文件 HTML，可操作演示原型，含 data-ai-id/data-ai-type 标记与顶部横向分页窄条），并返回产出文件路径、AC 审计结论摘要（攻防轮次与 red 清零情况）与视觉裁决结论。",
  },
]


describe('W19-C：路径豁免（stripPathTokens + 匹配前剥离）', () => {
  test('stripPathTokens：绝对路径剥离 CJK 碰撞词，保留尾部 ASCII 产出签名（F2）', () => {
    const stripped = stripPathTokens('前序 /home/orphic/.proma-dev/workspace-files/project-e2e-w18-验收2/02_UX_DESIGN/prototype.html 已就绪')
    expect(stripped).toContain('前序')
    expect(stripped).toContain('已就绪')
    // 碰撞源（项目名 CJK 段 + 用户路径）整体消失
    expect(stripped).not.toContain('验收')
    expect(stripped).not.toContain('home/orphic')
    // F2：尾部 ASCII 产出签名保留（末两段均 ASCII）
    expect(stripped).toContain('02_UX_DESIGN/prototype.html')
  })

  test('stripPathTokens：纯 ASCII 相对路径保留（08_APP/index.html 继续参与 OUTPUT 匹配——A3 依赖）', () => {
    expect(stripPathTokens('构建 08_APP/index.html 页面')).toBe('构建 08_APP/index.html 页面')
    expect(stripPathTokens('读 01_PRD/prd.md 后汇总')).toBe('读 01_PRD/prd.md 后汇总')
  })

  test('stripPathTokens：含 CJK 的相对路径剥离碰撞词、保留尾部 ASCII 签名（F2）', () => {
    const stripped = stripPathTokens('读取 project-验收2/06_TESTS/report.json')
    expect(stripped).not.toContain('验收')
    expect(stripped).toContain('06_TESTS/report.json')
  })

  test('stripPathTokens：无斜杠文本零变化（验收标准等正文不误伤）', () => {
    const t = '整理验收标准与测试计划，注意应用形态'
    expect(stripPathTokens(t)).toBe(t)
  })

  test('工单红测试C#1：委派参数含 /home/.../E2E-W18-验收2/02_UX_DESIGN/ 路径 + 正常 UX 词汇 → 放行', () => {
    const result = checkDelegationAgainstStage('prototype', {
      title: 'UX 顾问：番茄钟交互原型',
      task: '根据 PRD 与 /home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-E2E-W18-验收2/02_UX_DESIGN/ 前序原型继续设计，产出可交互界面稿，注意验收标准覆盖',
    })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
  })

  test('F2（审查应修）：尾部签名仅末段 ASCII 时不带 CJK 父段（验收2/首页 类碰撞词不回灌）', () => {
    // 末段 ASCII、父段 CJK → 只保留末段；父段验收2 不回灌
    const stripped = stripPathTokens('产出 /home/x/project-验收2/首页/index.html')
    expect(stripped).not.toContain('验收')
    expect(stripped).not.toContain('首页')
    expect(stripped).toContain('index.html')
    // 末段本身 CJK → 无任何保留
    expect(stripPathTokens('输出 /home/x/项目/验收报告')).not.toContain('验收')
  })
})

describe('W19-C：词表复核回归（移除词不误拦 + 复合词护栏不削弱）', () => {
  test('requirements ROLE 移除词：prototype「根据 PRD 与产品需求文档生成界面稿」→ 放行（实测 deny#1/#2）', () => {
    const result = checkDelegationAgainstStage('prototype', { task: '根据 PRD 与产品需求文档生成界面稿' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
  })

  test('coding ROLE 移除词：prototype「projectCategory: web-fullstack 单页应用的界面设计」→ 放行（deny#3/#7）', () => {
    const result = checkDelegationAgainstStage('prototype', { task: 'projectCategory: web-fullstack 单页应用的可交互界面设计' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
  })

  test('testing ROLE 收紧：prototype「覆盖验收标准的界面稿」→ 放行（验收标准是正常 AC 引用）', () => {
    const result = checkDelegationAgainstStage('prototype', { task: '产出覆盖验收标准的界面稿' })
    expect(result.allowed).toBe(true)
  })

  test('上游引用合法化：coding「按 PRD 实现登录功能」→ 放行 stage（原判 requirements ROLE deny）', () => {
    const result = checkDelegationAgainstStage('coding', { task: '按 PRD 实现登录功能' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
  })

  test('护栏：复合词仍拦——prototype「做一轮需求调研」→ deny(requirements, 需求调研)', () => {
    const result = checkDelegationAgainstStage('prototype', { task: '做一轮需求调研' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('requirements')
    expect(result.violatedKeyword).toBe('需求调研')
  })

  test('护栏：复合词仍拦——prototype「编写验收测试」→ deny(testing)', () => {
    const result = checkDelegationAgainstStage('prototype', { task: '编写验收测试' })
    expect(result.allowed).toBe(false)
    expect(result.violatedStage).toBe('testing')
  })

  test('护栏：A2 回归——testing title「测试工程师」→ 放行（stage）', () => {
    const result = checkDelegationAgainstStage('testing', { title: '测试工程师', task: '编写 GWT 验收测试场景与步骤映射' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
  })

  test('护栏：A3 回归——requirements「按 PRD 生成应用代码」→ deny(coding, 代码)', () => {
    const result = checkDelegationAgainstStage('requirements', { task: '按 PRD 生成应用代码' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('coding')
    expect(result.violatedKeyword).toBe('代码')
  })
})

describe('W19-C：OUTPUT 词邻近语境判定（±20 字符强动词窗口）', () => {
  test('F2（审查应修）探针①：requirements「基于需求，生成 08_APP/首页/index.html 页面」→ deny（CJK 中段路径尾部签名命中）', () => {
    const result = checkDelegationAgainstStage('requirements', { task: '基于需求，生成 08_APP/首页/index.html 页面' })
    expect(result.allowed).toBe(false)
    expect(result.denialKind).toBe('other-stage')
    expect(result.violatedStage).toBe('coding')
    expect(result.violatedKeyword).toBe('index.html')
  })

  test('F2 探针②：requirements「基于需求，生成 /…/project-e2e-w18-验收2/08_APP/index.html」→ deny（绝对路径尾部签名命中，验收不误拦）', () => {
    const result = checkDelegationAgainstStage('requirements', {
      task: '基于需求，生成 /home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-e2e-w18-验收2/08_APP/index.html 首页',
    })
    expect(result.allowed).toBe(false)
    expect(result.violatedStage).toBe('coding')
    expect(result.violatedKeyword).toBe('index.html')
  })

  test('审查语境（实测 deny#6 复盘）：prototype「生成界面稿交付后自查，禁止只看代码就下结论」→ 放行（距离 >20）', () => {
    const result = checkDelegationAgainstStage('prototype', { task: '生成可交互界面稿原型交付；交付后自查环节禁止只看代码就下结论，必须实际点验交互' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
  })

  test('引用语境（实测 deny#8 复盘）：prototype「绘制界面稿并标注使用场景与验收标准」→ 放行', () => {
    const result = checkDelegationAgainstStage('prototype', { task: '绘制界面稿并标注使用场景与验收标准' })
    expect(result.allowed).toBe(true)
    expect(result.matchKind).toBe('stage')
  })

  test('产出语境仍拦（窗口边界）：requirements「对照 PRD 需求，编写 08_APP 应用的全部页面代码」→ deny（距离 18 ≤ 20）', () => {
    const result = checkDelegationAgainstStage('requirements', { task: '对照 PRD 需求，编写 08_APP 应用的全部页面代码' })
    expect(result.allowed).toBe(false)
    expect(result.violatedKeyword).toBe('代码')
  })

  test('产出语境仍拦（英文）：requirements「帮我生成 index.html 首页」→ deny(coding, index.html)', () => {
    const result = checkDelegationAgainstStage('requirements', { task: '帮我生成 index.html 首页' })
    expect(result.allowed).toBe(false)
    expect(result.violatedStage).toBe('coding')
    expect(result.violatedKeyword).toBe('index.html')
  })
})

describe('W19-C：stage-deny telemetry matchContext（命中位置归因）', () => {
  test('deny 事件 violations[].matchContext 记录字段名与前后片段（prose 命中 inPath=false）', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      title: '快速交付',
      task: '直接编写应用代码并跑通主流程',
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'delegate.guard.stage-deny')
    expect(events).toHaveLength(1)
    const violation = (events[0]?.payload.violations as Array<Record<string, unknown>>)[0]
    const ctx = violation?.matchContext as Record<string, unknown>
    expect(violation?.keyword).toBe('代码')
    expect(ctx?.field).toBe('task')
    expect(ctx?.inPath).toBe(false)
    expect(String(ctx?.after)).toContain('跑通主流程')
  })

  test('关键词首处命中在路径内 → inPath=true（项目名碰撞类误拦归因信号）', () => {
    setupProject({ stage: 'requirements' })
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'delegate_agent', {
      task: '读取 /home/x/全栈开发清单/a.md 与全栈开发规范后做汇总',
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'delegate.guard.stage-deny')
    const violation = (events[0]?.payload.violations as Array<Record<string, unknown>>)[0]
    const ctx = violation?.matchContext as Record<string, unknown>
    expect(ctx?.field).toBe('task')
    expect(ctx?.inPath).toBe(true)
    expect(String(ctx?.before)).toContain('读取')
  })
})

describe('W19-C：E2E 9 连拒实测样本重放（telemetry-e2e-w18-验收2 逐条对照）', () => {
  test('全部 10 个实测委派参数（8 拒 + requirements 首委派对照 + 改写后放行对照）重放 → 全部放行', () => {
    const denied: string[] = []
    for (const sample of W19_E2E_REPLAY_SAMPLES) {
      const result = checkDelegationAgainstStage(sample.stage, sample)
      if (!result.allowed) {
        denied.push(`line${sample.line}: ${result.violatedKeyword ?? result.matchedVerb ?? 'unknown'}`)
      }
    }
    expect(denied).toEqual([])
  })

  test('router-gate 集成：被拒样本原文（line 20，命中「需求」那次）经完整门禁 → 放行且 0 stage-deny 事件', () => {
    setupProject({ stage: 'prototype' })
    const sample = W19_E2E_REPLAY_SAMPLES.find((s) => s.line === 20)
    expect(sample).toBeDefined()
    const result = checkNanjuRouterGate('test-ws', 'session-1', 'mcp__collaboration__delegate_agent', {
      title: sample!.title,
      task: sample!.task,
      expectedOutput: sample!.expectedOutput,
    })
    expect(result).toBeNull()
    const events = readTelemetryEvents()
    expect(events.filter((e) => e.eventType === 'delegate.guard.stage-deny')).toHaveLength(0)
  })
})