const testArchitectureDoc = `
## 交付与运行
目标平台：按项目约定平台
交付产物：08_APP 下架构约定产物
构建方式：执行项目构建配置
启动方式：启动实际产物
## 测试架构
| 层级 | 框架 | 执行方式 | 证据 | 覆盖 |
| --- | --- | --- | --- | --- |
| 行为验收 | 平台测试驱动 | 执行真实产品 | 实际输出 | US-01 |
### 真实与模拟边界
模拟仅用于隔离单元，实际用户故事需真实行为证据。
### 失败回流
失败回开发或测试设计，环境缺失阻塞。
`

/**
 * 南大向导「向导图」阶段内进度单测（W2 S1）
 *
 * 覆盖面：
 * - deriveGuideSubStates 全分支（各位置/空/未知 subStage/未知阶段）
 * - 序列与渲染端 guide-dsl 节点对齐（跨进程契约锁定：JSON 相等 + DSL 节点存在性）
 * - derivePhaseSubNodeStates 前驱继承（序列外结构节点）
 * - emitGuideProgress seq 单调
 * - syncNanjuGuideConfirmState（确认点 C 契约）：产出达标点亮 UC / 未达标不动 / 幂等不重发
 *
 * fixture 模式与 nanju-router-gate.test.ts 同型：mock.module config-paths 指向 tmpdir
 * 后动态导入被测模块；main-window-store mock 捕获主窗广播（emit 的可观测面）。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 当前 fixture 根目录（mock 的 getWorkspaceFilesDir 每次调用时读取） */
let fixtureRoot = ''

// partial mock：spread 真实模块后再覆盖路径函数（bun mock.module 全局生效）
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

/** 主窗广播捕获（emitGuideProgress → win.webContents.send） */
const sentEvents: Array<{ channel: string; payload: Record<string, unknown> }> = []
mock.module('./main-window-store', () => ({
  getMainWindow: () => ({
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => { sentEvents.push({ channel, payload }) },
    },
  }),
}))

const {
  deriveGuideSubStates,
  emitGuideProgress,
  getGuideStageMainNodeId,
  getGuideProgressSnapshot,
  GUIDE_SUBSTAGE_SEQUENCE,
} = await import('./nanju-guide-progress')
const { syncNanjuGuideConfirmState } = await import('./nanju-phase-gate')
const {
  buildGuideDsl,
  derivePhaseSubNodeStates,
  deriveSubStageStates,
  GUIDE_SUBSTAGE_SEQUENCE: RENDERER_SEQUENCE,
} = await import('../../renderer/components/nanju/guide/guide-dsl')

const WORKSPACE_SLUG = 'test-ws'
const PROJECT_ID = 'p1'

/** 合法 PRD fixture（≥100B 且过 requirements 最低格式检查：含 markdown 标题） */
const VALID_PRD = '# 需求文档\n\n## 用户故事\n\n- US-01 作为用户，我希望能看到向导图的阶段内进度，以便了解当前卡在哪一步。\n- US-02 作为用户，我希望产出完成后图上能提示等待我确认，以便我及时确认推进。\n'

/** testing 阶段达标产出 fixture（汇总入口 + 分文件场景 + steps.json，verifyPhaseOutput 目录兑底全过） */
const TESTING_INDEX_FEATURE = '# 验收场景总览（汇总入口）\n\nFeature: US-01 核心流程总览\n本文件为汇总索引；各用户故事的可执行场景见同名分文件（us-01.feature 等），\n步骤映射见成对的 us-01.steps.json（selector 一律 data-ai-id 锚点）。\n'
const TESTING_US01_FEATURE = 'Feature: US-01 核心流程\n  Scenario: US-01 主路径\n    Given 前置条件就绪\n    When 执行核心操作\n    Then 断言预期结果\n'
const TESTING_US01_STEPS = JSON.stringify({ feature: 'US-01 核心流程', scenario: 'US-01 主路径', steps: [] })

/** 构造 tmpdir fixture：_nanju-projects.json（session 关联）+ 可选产出文件 + 可选 subStage */
function setupFixture(opts: {
  stage: string
  prd?: string | null
  subStage?: string
  sessionId?: string
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-guide-progress-'))
  fixtureRoot = dir
  mkdirSync(join(dir, `project-${PROJECT_ID}`), { recursive: true })
  if (opts.stage === 'testing') {
    // testing 达标产出三件套（index.feature 汇总入口 + us-XX.feature 场景 + steps.json 映射）
    const featuresDir = join(dir, `project-${PROJECT_ID}`, '06_TESTS', 'features')
    mkdirSync(featuresDir, { recursive: true })
    writeFileSync(join(featuresDir, 'index.feature'), TESTING_INDEX_FEATURE)
    writeFileSync(join(featuresDir, 'us-01.feature'), TESTING_US01_FEATURE)
    writeFileSync(join(featuresDir, 'us-01.steps.json'), TESTING_US01_STEPS)
  } else if (opts.prd !== null) {
    mkdirSync(join(dir, `project-${PROJECT_ID}`, '01_PRD'), { recursive: true })
    writeFileSync(join(dir, `project-${PROJECT_ID}`, '01_PRD', 'prd.md'), opts.prd ?? VALID_PRD)
  }
  if (opts.subStage !== undefined) {
    writeFileSync(join(dir, `project-${PROJECT_ID}`, '_project-info.json'), JSON.stringify({
      projectId: PROJECT_ID, subStage: opts.subStage,
    }))
  }
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
    projectId: PROJECT_ID,
    name: '进度测试项目',
    mode: 'quick',
    status: 'active',
    currentStage: opts.stage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: opts.sessionId ?? 'session-1',
    workspaceSlug: WORKSPACE_SLUG,
  }]))
  return WORKSPACE_SLUG
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
  sentEvents.length = 0
})

// ===== deriveGuideSubStates 全分支 =====

describe('deriveGuideSubStates（W2 S1 纯函数）', () => {
  test('subStage=REQ_UC（末位，等确认态）：主节点 done、中间节点 pending、UC current（A2 必修-3 修订：UC 仅证明产出就绪，AC 攻防未接数据源不得画成已通过）', () => {
    expect(deriveGuideSubStates('requirements', 'REQ_UC')).toEqual({
      REQ: 'done', REQ_ATK: 'pending', REQ_DEF: 'pending', REQ_UC: 'current',
    })
  })

  test('subStage=REQ_ATK（中间位）：前 done、本身 current、后 pending（非 UC 中间态维持现规则）', () => {
    expect(deriveGuideSubStates('requirements', 'REQ_ATK')).toEqual({
      REQ: 'done', REQ_ATK: 'current', REQ_DEF: 'pending', REQ_UC: 'pending',
    })
  })

  test('subStage=REQ（首位/主节点，作者产出中）：主节点 current、其余 pending', () => {
    expect(deriveGuideSubStates('requirements', 'REQ')).toEqual({
      REQ: 'current', REQ_ATK: 'pending', REQ_DEF: 'pending', REQ_UC: 'pending',
    })
  })

  test('subStage 为空/未传 → 首节点 current（阶段刚开始）', () => {
    expect(deriveGuideSubStates('requirements', '')).toEqual(deriveGuideSubStates('requirements', 'REQ'))
    expect(deriveGuideSubStates('requirements', null)).toEqual(deriveGuideSubStates('requirements', 'REQ'))
    expect(deriveGuideSubStates('requirements', undefined)).toEqual(deriveGuideSubStates('requirements', 'REQ'))
  })

  test('未知 subStage（不在序列内）→ 同空处理，首节点 current（降级安全）', () => {
    expect(deriveGuideSubStates('requirements', 'REQ_XX')).toEqual(deriveGuideSubStates('requirements', 'REQ'))
    expect(deriveGuideSubStates('requirements', 'PROTO')).toEqual(deriveGuideSubStates('requirements', 'REQ'))
  })

  test('未知阶段（delivered/mode-select/乱串）→ 空对象', () => {
    expect(deriveGuideSubStates('delivered', 'REQ')).toEqual({})
    expect(deriveGuideSubStates('mode-select', '')).toEqual({})
    expect(deriveGuideSubStates('???', 'REQ')).toEqual({})
  })

  test('六阶段序列全覆盖（每个阶段的末位 subStage 全推导不为空；UC 态特殊化对含 UC 阶段成立）', () => {
    for (const [stage, seq] of Object.entries(GUIDE_SUBSTAGE_SEQUENCE)) {
      const last = seq[seq.length - 1] as string
      const result = deriveGuideSubStates(stage, last)
      expect(Object.keys(result).length).toBe(seq.length)
      expect(result[last]).toBe('current')
      // 主节点映射：阶段首元素即主节点 id（推进点 B 写入值）
      expect(getGuideStageMainNodeId(stage)).toBe(seq[0])
      // UC 态特殊化（A2 必修-3）：末位为 {主节点}_UC 的阶段，主节点 done、中间节点 pending；
      // testing 序列止于 TEST_JUDGE（机器裁判收口无 UC）不适用
      const ucNodeId = `${seq[0]}_UC`
      if (last === ucNodeId) {
        expect(result[seq[0] as string]).toBe('done')
        for (const id of seq.slice(1, -1)) {
          expect(result[id]).toBe('pending')
        }
      }
    }
    expect(getGuideStageMainNodeId('delivered')).toBeUndefined()
  })
})

// ===== 跨进程契约：序列与渲染端 guide-dsl 对齐 =====

describe('序列与 guide-dsl 节点对齐（跨进程契约锁定）', () => {
  /** 渲染端 guide-dsl.test.ts 的 iterative 路由 fixture（此处重建最小版，字段与 nanju-router 一致；
   *  W13：planning 降 v4-flash；testing 作者 glm-5.3-flash + 防御者 minimax 覆盖；
   *  W13b：architecture/coding 换 glm-zhipu:GLM-5.3 + 防御者 minimax 覆盖（经参数文件下发） */
  const route = [
    { id: 'requirements', role: 'requirement-analyst', title: '需求分析师', channel: 'deepseek', model: 'deepseek-v4-pro', task: '', outputPath: '01_PRD/prd.md', constraints: [], requiresUserConfirmation: true, requiresAC: false, retryLimit: 3, next: 'prototype', acActors: { attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' }, defender: { channel: 'glm-zhipu', model: 'glm-5.3-flash' } } },
    { id: 'prototype', role: 'ux-advisor', title: 'UX 顾问', channel: 'minimax', model: 'MiniMax-M3', task: '', outputPath: '02_UX_DESIGN/prototype.html', constraints: [], requiresUserConfirmation: true, requiresAC: true, retryLimit: 2, next: 'architecture', acActors: { attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' }, defender: { channel: 'glm-zhipu', model: 'glm-5.3-flash' } } },
    { id: 'architecture', role: 'architect', title: '架构师', channel: 'glm-zhipu', model: 'GLM-5.3', task: '', outputPath: '03_ARCHITECTURE/architecture.md', constraints: [], requiresUserConfirmation: true, requiresAC: true, retryLimit: 2, next: 'planning', acActors: { attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' }, defender: { channel: 'minimax', model: 'MiniMax-M3' } } },
    { id: 'planning', role: 'engineering-manager', title: '工程经理', channel: 'deepseek', model: 'deepseek-v4-flash', task: '', outputPath: '05_PROJECT_PLAN/plan.md', constraints: [], requiresUserConfirmation: true, requiresAC: false, retryLimit: 2, next: 'coding', acActors: { attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' }, defender: { channel: 'glm-zhipu', model: 'glm-5.3-flash' } } },
    { id: 'coding', role: 'fullstack-developer', title: '全栈开发', channel: 'glm-zhipu', model: 'GLM-5.3', task: '', outputPath: '08_APP/index.html', constraints: [], requiresUserConfirmation: true, requiresAC: false, retryLimit: 2, next: 'testing', acActors: { attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' }, defender: { channel: 'minimax', model: 'MiniMax-M3' } } },
    { id: 'testing', role: 'test-engineer', title: '测试工程师', channel: 'glm-zhipu', model: 'glm-5.3-flash', task: '', outputPath: '06_TESTS/features/index.feature', constraints: [], requiresUserConfirmation: false, requiresAC: false, retryLimit: 2, next: 'delivered', acActors: { attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' }, defender: { channel: 'minimax', model: 'MiniMax-M3' } } },
  ]

  test('主/渲染两侧序列常量 JSON 相等（改任何一侧必须同步另一侧）', () => {
    expect(JSON.stringify(RENDERER_SEQUENCE)).toBe(JSON.stringify(GUIDE_SUBSTAGE_SEQUENCE))
  })

  test('序列内每个 id 都是全展开 DSL 的真实节点（节点声明形如 `ID[` 或 `ID{`）', () => {
    const dsl = buildGuideDsl({ mode: 'iterative', route: route as never, progress: null, isDark: false })
    for (const seq of Object.values(GUIDE_SUBSTAGE_SEQUENCE)) {
      for (const nodeId of seq) {
        // 节点声明：`ID["label"]`（矩形）或 `ID{"label"}`（菱形）；避免前缀误匹配用行首+空白锚定
        const declared = new RegExp(`(^|\\s|\\.)${nodeId}\\s*[\\[\\{]`).test(dsl)
        expect(declared).toBe(true)
      }
    }
  })

  test('渲染端 deriveSubStageStates 与主端 deriveGuideSubStates 规则一致（全阶段抽样）', () => {
    for (const [stage, seq] of Object.entries(GUIDE_SUBSTAGE_SEQUENCE)) {
      for (const subStage of seq) {
        expect(deriveSubStageStates(stage as never, subStage)).toEqual(deriveGuideSubStates(stage, subStage))
      }
      expect(deriveSubStageStates(stage as never, '')).toEqual(deriveGuideSubStates(stage, ''))
    }
  })

  test('derivePhaseSubNodeStates 前驱继承：UC 态序列内/外中间节点均 pending（A2 必修-3/4 修订）', () => {
    // coding：CODE_UC 等确认 → CODE done、序列外 ATK/DEF（继承基线 pending）、UC current
    expect(derivePhaseSubNodeStates('coding', 'CODE_UC')).toEqual({
      CODE: 'done', CODE_ATK: 'pending', CODE_DEF: 'pending', CODE_UC: 'current',
    })
    // architecture：ARCH_UC → 序列内 ATK/DEF/GATE/ENV 均未接数据源，不画成已通过
    //（ARCH_ENV 三态由 envState 载荷强制映射覆盖，优先于本推导——见 buildGuideDsl）
    expect(derivePhaseSubNodeStates('architecture', 'ARCH_UC')).toEqual({
      ARCH: 'done', ARCH_ATK: 'pending', ARCH_DEF: 'pending', ARCH_GATE: 'pending', ARCH_ENV: 'pending', ARCH_UC: 'current',
    })
    // CODE 产出中（非 UC）：ATK/DEF/UC 均未开始（前驱 current 不继承脉冲，规则不变）
    expect(derivePhaseSubNodeStates('coding', 'CODE')).toEqual({
      CODE: 'current', CODE_ATK: 'pending', CODE_DEF: 'pending', CODE_UC: 'pending',
    })
  })
})

// ===== seq 单调 =====

describe('emitGuideProgress seq 单调', () => {
  test('连续广播 seq 严格递增，载荷含五字段', () => {
    const first = emitGuideProgress('s1', 'p1', 'requirements', 'REQ')
    const second = emitGuideProgress('s1', 'p1', 'requirements', 'REQ_UC')
    const third = emitGuideProgress('s1', 'p1', 'delivered', '')
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
    const last = sentEvents[sentEvents.length - 1]?.payload
    expect(last).toMatchObject({ sessionId: 's1', projectId: 'p1', currentStage: 'delivered', subStage: '' })
    expect(typeof last?.seq).toBe('number')
    expect((last?.seq as number)).toBe(third)
  })
})

// ===== 确认点 C：syncNanjuGuideConfirmState 契约 =====

describe('syncNanjuGuideConfirmState（确认点 C）', () => {
  test('产出达标且未同步 → 写 {MAIN}_UC 并广播（write-then-emit）', () => {
    const ws = setupFixture({ stage: 'requirements', prd: VALID_PRD, subStage: 'REQ' })
    expect(syncNanjuGuideConfirmState(ws, 'session-1')).toBe(true)
    // 落盘断言（write 已发生）
    const info = JSON.parse(readFileSync(join(fixtureRoot, `project-${PROJECT_ID}`, '_project-info.json'), 'utf-8')) as { subStage?: string }
    expect(info.subStage).toBe('REQ_UC')
    // 广播断言（emit 已发生，载荷正确）
    const sent = sentEvents[sentEvents.length - 1]
    expect(sent?.channel).toBe('nanju:guide-progress')
    expect(sent?.payload).toMatchObject({ sessionId: 'session-1', projectId: PROJECT_ID, currentStage: 'requirements', subStage: 'REQ_UC' })
  })

  test('幂等：subStage 已是 {MAIN}_UC → 不重写不重发', () => {
    const ws = setupFixture({ stage: 'requirements', prd: VALID_PRD, subStage: 'REQ_UC' })
    const before = sentEvents.length
    expect(syncNanjuGuideConfirmState(ws, 'session-1')).toBe(false)
    expect(sentEvents.length).toBe(before) // 未重发
  })

  test('产出未达标（PRD 缺失/过小）→ 不动（维持产出中态）', () => {
    const ws = setupFixture({ stage: 'requirements', prd: null, subStage: 'REQ' })
    expect(syncNanjuGuideConfirmState(ws, 'session-1')).toBe(false)
    const info = JSON.parse(readFileSync(join(fixtureRoot, `project-${PROJECT_ID}`, '_project-info.json'), 'utf-8')) as { subStage?: string }
    expect(info.subStage).toBe('REQ') // 未被改写
    expect(sentEvents.length).toBe(0)
  })

  test('非项目会话/无子步骤阶段（delivered）→ 无副作用', () => {
    const ws = setupFixture({ stage: 'delivered' })
    expect(syncNanjuGuideConfirmState(ws, 'session-1')).toBe(false)
    expect(syncNanjuGuideConfirmState(ws, 'other-session')).toBe(false)
    expect(sentEvents.length).toBe(0)
  })

  test('testing 机器裁判收口（序列无 TEST_UC）：达标产出也不点亮、不落盘污染、无广播（A1 必修-1/2）', () => {
    // fixture：testing 阶段达标产出（verifyPhaseOutput 通过——修复前 sync 会返回 true 并写 TEST_UC）
    const ws = setupFixture({ stage: 'testing', subStage: 'TEST' })
    expect(syncNanjuGuideConfirmState(ws, 'session-1')).toBe(false)
    const info = JSON.parse(readFileSync(join(fixtureRoot, `project-${PROJECT_ID}`, '_project-info.json'), 'utf-8')) as { subStage?: string }
    expect(info.subStage).toBe('TEST') // 保持推进点 B 写入值，不被改写为序列外 TEST_UC
    expect(sentEvents.length).toBe(0)
  })
})

// ===== 冷启动快照 =====

describe('getGuideProgressSnapshot（冷启动初值）', () => {
  test('返回 currentStage+subStage+当前 seq；项目不存在返回 null', () => {
    const ws = setupFixture({ stage: 'prototype', subStage: 'PROTO_UC' })
    const seqBefore = emitGuideProgress('session-1', PROJECT_ID, 'prototype', 'PROTO_UC')
    const snapshot = getGuideProgressSnapshot(ws, PROJECT_ID)
    expect(snapshot).toMatchObject({ currentStage: 'prototype', subStage: 'PROTO_UC' })
    expect(snapshot?.seq).toBeGreaterThanOrEqual(seqBefore)
    expect(getGuideProgressSnapshot(ws, 'no-such-project')).toBeNull()
  })

  test('W18 Wave3：快照恒携带 divergences（无偏差为空数组）+ divergenceFingerprint（独立通道数据源）', () => {
    // fixture：requirements 无未来产物 → 空数组（非 undefined，渲染端可据此清角标）
    const ws = setupFixture({ stage: 'requirements', prd: VALID_PRD, subStage: 'REQ' })
    const snapshot = getGuideProgressSnapshot(ws, PROJECT_ID)
    expect(snapshot?.divergences).toEqual([])
    expect(typeof snapshot?.divergenceFingerprint).toBe('string')
  })
})

// ===== M4（AC 审计 A5）：architecture result 侧先同步环境状态再判定 =====

describe('syncNanjuGuideConfirmState · M4 环境状态先行（L2 报 missing 未推进窗口）', () => {
  /** architecture 阶段 fixture：达标产出文档（含环境清单与标记行）+ 桌面品类 */
  function setupArchFixture(envLine: string, category: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'nanju-m4-'))
    fixtureRoot = dir
    const projectDir = join(dir, `project-${PROJECT_ID}`)
    mkdirSync(join(projectDir, '03_ARCHITECTURE'), { recursive: true })
    writeFileSync(join(projectDir, '03_ARCHITECTURE', 'architecture.md'),
      `# 架构文档\n\nprojectCategory: ${category}\n\n## 技术选型\n\nTauri v2 桌面程序，两层架构。\n\n## 环境配置\n\n| 组件 | 版本 | 用途 |\n| --- | --- | --- |\n| node | 20 | 前端 |\n| rustc | 1.75 | 编译 |\n\n${envLine}\n${testArchitectureDoc}`)
    writeFileSync(join(projectDir, '_project-info.json'), JSON.stringify({
      projectId: PROJECT_ID, subStage: 'ARCH', projectCategory: category, projectCategorySource: 'architecture',
    }))
    writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
      projectId: PROJECT_ID, name: 'M4 项目', mode: 'quick', status: 'active',
      currentStage: 'architecture', createdAt: '', updatedAt: '', sessionId: 'session-1',
    }]))
    return 'test-ws'
  }

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('missing 标记行：envReady 先置位 false → 门禁拦截 → UC 不误亮 + ARCH_ENV blocked 广播', () => {
    const ws = setupArchFixture('projectEnv: missing: rustc', 'desktop-app')
    const before = sentEvents.length
    // M4 修复前：envReady undefined → 门禁豁免 → verify 过 → UC 误亮（返回 true）
    expect(syncNanjuGuideConfirmState(ws, 'session-1')).toBe(false)
    const info = JSON.parse(readFileSync(join(fixtureRoot, `project-${PROJECT_ID}`, '_project-info.json'), 'utf-8')) as {
      subStage?: string; envReady?: boolean
    }
    // 环境状态已先行落盘（missing → false）
    expect(info.envReady).toBe(false)
    // UC 未点亮（门禁正确拦截：环境未就绪不得画「可推进」）
    expect(info.subStage).toBe('ARCH')
    // ARCH_ENV blocked 态已广播（置位 emit——「环境卡住」上图可见）
    const envEvent = sentEvents.slice(before).find((e) => e.payload.envState !== undefined)
    expect(envEvent?.payload.envState).toBe('blocked')
  })

  test('ready 标记行：门禁过 → UC 正常点亮（M4 不误伤正常路径）', () => {
    const ws = setupArchFixture('projectEnv: ready', 'desktop-app')
    expect(syncNanjuGuideConfirmState(ws, 'session-1')).toBe(true)
    const info = JSON.parse(readFileSync(join(fixtureRoot, `project-${PROJECT_ID}`, '_project-info.json'), 'utf-8')) as {
      subStage?: string; envReady?: boolean
    }
    expect(info.envReady).toBe(true)
    expect(info.subStage).toBe('ARCH_UC')
  })
})
