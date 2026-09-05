/**
 * W18 Wave3 · F4 产物/阶段偏差可观测性（主进程侧红测试）
 *
 * 弱断言口径（审查 SHOULD-6）：观测到的是「未来阶段 outputPath 文件已存在且 >100B」，
 * 不能证明谁写的/何时写的/是否越阶段施工 → 字段 observedAt、文案「可能存在」。
 *
 * 用例对齐波次方案：
 * - D1 requirements + 08_APP/index.html(>100B) → 含 coding
 * - D2 08_APP 例外：currentStage∈{coding,testing,delivered} 同文件不报（用户裁定口径）
 * - D3 coding + 06_TESTS/features/index.feature → 含 testing
 * - D4 仅空目录骨架（建项目即预创建 8 目录）→ 空（严禁目录存在性判断）
 * - D5 快照恒携带 divergences+fingerprint；emit 挂点（extra.workspaceSlug 现算）
 * - D6 删除越阶段文件 → divergences 消失
 * 边界：size 恰 100B 不报（>100B 严格）；04/07 目录不纳入；过去阶段产物不报；
 * quick 路由无 planning → plan.md 不报；未知阶段不判定；指纹稳定/与顺序无关。
 *
 * fixture 模式与 nanju-guide-progress.test.ts 同型：mock.module config-paths 指向
 * tmpdir 后动态导入被测模块；main-window-store mock 捕获主窗广播。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 当前 fixture 根目录（mock 的 getWorkspaceFilesDir 每次调用时读取） */
let fixtureRoot = ''

const actualConfigPaths = await import('../config-paths')
mock.module('../config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

/** 主窗广播捕获（emitGuideProgress → win.webContents.send） */
const sentEvents: Array<{ channel: string; payload: Record<string, unknown> }> = []
mock.module('../main-window-store', () => ({
  getMainWindow: () => ({
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => { sentEvents.push({ channel, payload }) },
    },
  }),
}))

const {
  detectStageDivergence,
  divergenceFingerprint,
  isArtifactNormalAtStage,
} = await import('../nanju-state-divergence')
const { emitGuideProgress, getGuideProgressSnapshot } = await import('../nanju-guide-progress')

const PROJECT_ID = 'p1'

/** 建项目即预创建的 8 目录骨架（nanju-project.ts:225-233）——D4 严禁目录存在性判断 */
const SKELETON_DIRS = [
  '00_ENGINEERING_TEMPLATE', '01_PRD', '02_UX_DESIGN', '03_ARCHITECTURE',
  '04_API_SPEC', '05_PROJECT_PLAN', '06_TESTS', '07_VERSIONS', '08_APP',
]

/** 构造 fixture：空目录骨架 + _nanju-projects.json（stage/mode 可配）+ 可选产物文件 */
function setupFixture(opts: {
  stage: string
  mode?: 'quick' | 'iterative'
  artifacts?: Array<{ path: string; bytes?: number }>
}): void {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-w18-div-'))
  fixtureRoot = dir
  const projectDir = join(dir, `project-${PROJECT_ID}`)
  for (const d of SKELETON_DIRS) mkdirSync(join(projectDir, d), { recursive: true })
  for (const a of opts.artifacts ?? []) {
    const filePath = join(projectDir, a.path)
    mkdirSync(join(filePath, '..'), { recursive: true })
    const bytes = a.bytes ?? 101
    writeFileSync(filePath, 'x'.repeat(bytes))
  }
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
    projectId: PROJECT_ID,
    name: '偏差测试项目',
    mode: opts.mode ?? 'quick',
    status: 'active',
    currentStage: opts.stage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: 'session-1',
    workspaceSlug: 'test-ws',
  }]))
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
  sentEvents.length = 0
})

// ===== detectStageDivergence 核心判定 =====

describe('detectStageDivergence（W18 Wave3）', () => {
  test('D1：requirements + 08_APP/index.html(>100B) → 含 {stage:"coding"}，observedAt 为 ISO 时刻', () => {
    setupFixture({ stage: 'requirements', artifacts: [{ path: '08_APP/index.html' }] })
    const list = detectStageDivergence('test-ws', PROJECT_ID)
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({ stage: 'coding', artifact: '08_APP/index.html' })
    expect(typeof list[0]?.observedAt).toBe('string')
    expect(Number.isNaN(Date.parse(list[0]?.observedAt ?? ''))).toBe(false)
  })

  test('D2：08_APP 例外（用户裁定）——currentStage∈{testing,delivered} 同文件不报；prototype 阶段出现仍报', () => {
    // testing：coding 是过去阶段 + 08_APP 是 GWT 对象 → 正常
    setupFixture({ stage: 'testing', artifacts: [{ path: '08_APP/index.html' }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
    // delivered：交付结果 → 正常
    setupFixture({ stage: 'delivered', artifacts: [{ path: '08_APP/index.html' }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
    // coding：本阶段正式产出 → 正常（未来阶段判定天然不含 coding 自身）
    setupFixture({ stage: 'coding', artifacts: [{ path: '08_APP/index.html' }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
    // prototype（未来阶段）→ 报（仅 requirements/prototype/architecture/planning 出现才算偏差）
    setupFixture({ stage: 'prototype', artifacts: [{ path: '08_APP/index.html' }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID).map((d) => d.stage)).toEqual(['coding'])
  })

  test('D2c：isArtifactNormalAtStage 显式口径——coding 产物仅在 coding/testing/delivered 正常', () => {
    for (const stage of ['coding', 'testing', 'delivered']) {
      expect(isArtifactNormalAtStage('coding', stage)).toBe(true)
    }
    for (const stage of ['requirements', 'prototype', 'architecture', 'planning']) {
      expect(isArtifactNormalAtStage('coding', stage)).toBe(false)
    }
    // 其他阶段产物无例外表（任何 currentStage 都不豁免）
    expect(isArtifactNormalAtStage('testing', 'requirements')).toBe(false)
    expect(isArtifactNormalAtStage('testing', 'testing')).toBe(false) // 未来阶段判定不含自身，不属「正常例外」语义
  })

  test('D3：coding + 06_TESTS/features/index.feature(>100B) → 含 {stage:"testing"}', () => {
    setupFixture({ stage: 'coding', artifacts: [{ path: '06_TESTS/features/index.feature' }] })
    const list = detectStageDivergence('test-ws', PROJECT_ID)
    expect(list.map((d) => d.stage)).toEqual(['testing'])
    expect(list[0]).toMatchObject({ artifact: '06_TESTS/features/index.feature' })
  })

  test('D4：仅空目录骨架（新建项目）→ 空列表（严禁目录存在性判断）', () => {
    setupFixture({ stage: 'requirements' })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
  })

  test('D6：删除越阶段文件 → divergences 消失', () => {
    setupFixture({ stage: 'requirements', artifacts: [{ path: '08_APP/index.html' }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID).length).toBe(1)
    rmSync(join(fixtureRoot, `project-${PROJECT_ID}`, '08_APP', 'index.html'))
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
  })

  test('size 恰 100B 不报（>100B 严格门槛）；101B 报', () => {
    setupFixture({ stage: 'requirements', artifacts: [{ path: '08_APP/index.html', bytes: 100 }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
    setupFixture({ stage: 'requirements', artifacts: [{ path: '08_APP/index.html', bytes: 101 }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID).length).toBe(1)
  })

  test('04_API_SPEC / 07_VERSIONS 无 outputPath 映射 → 不纳入（放文件不报）', () => {
    setupFixture({
      stage: 'requirements',
      artifacts: [{ path: '04_API_SPEC/api.md' }, { path: '07_VERSIONS/v1.txt' }],
    })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
  })

  test('过去阶段产物不报（testing 阶段的 prd/prototype/architecture 均为合法前序产出）', () => {
    setupFixture({
      stage: 'testing',
      artifacts: [
        { path: '01_PRD/prd.md' },
        { path: '02_UX_DESIGN/prototype.html' },
        { path: '03_ARCHITECTURE/architecture.md' },
        { path: '08_APP/index.html' },
      ],
    })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
  })

  test('iterative：requirements + 05_PROJECT_PLAN/plan.md → 含 planning；quick 无 planning 阶段 → 同文件不报（路由感知）', () => {
    setupFixture({ stage: 'requirements', mode: 'iterative', artifacts: [{ path: '05_PROJECT_PLAN/plan.md' }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID).map((d) => d.stage)).toEqual(['planning'])
    setupFixture({ stage: 'requirements', mode: 'quick', artifacts: [{ path: '05_PROJECT_PLAN/plan.md' }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
  })

  test('未知阶段（mode-select/乱串）→ 空列表（无法定义未来阶段，保守不判定）', () => {
    setupFixture({ stage: 'mode-select', artifacts: [{ path: '08_APP/index.html' }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
    setupFixture({ stage: '???', artifacts: [{ path: '08_APP/index.html' }] })
    expect(detectStageDivergence('test-ws', PROJECT_ID)).toEqual([])
  })

  test('项目不存在 → 空列表（降级安全）', () => {
    setupFixture({ stage: 'requirements' })
    expect(detectStageDivergence('test-ws', 'no-such')).toEqual([])
  })

  test('多偏差并列：requirements(iterative) + app + 测试场景 → coding 与 testing 同时上报', () => {
    setupFixture({
      stage: 'requirements', mode: 'iterative',
      artifacts: [
        { path: '08_APP/index.html' },
        { path: '06_TESTS/features/index.feature' },
        { path: '03_ARCHITECTURE/architecture.md' },
      ],
    })
    const stages = detectStageDivergence('test-ws', PROJECT_ID).map((d) => d.stage)
    expect(stages).toContain('architecture')
    expect(stages).toContain('coding')
    expect(stages).toContain('testing')
    expect(stages).not.toContain('requirements')
  })
})

// ===== divergenceFingerprint（纯函数） =====

describe('divergenceFingerprint（事实集合指纹）', () => {
  const dv = (stage: string, artifact: string, observedAt = '2026-09-05T00:00:00.000Z') =>
    ({ stage, artifact, observedAt }) as never

  test('observedAt 不参与指纹：同一事实集两次观测（时刻不同）指纹相等', () => {
    const a = [dv('coding', '08_APP/index.html', '2026-09-05T01:00:00.000Z')]
    const b = [dv('coding', '08_APP/index.html', '2026-09-05T09:00:00.000Z')]
    expect(divergenceFingerprint(a)).toBe(divergenceFingerprint(b))
  })

  test('顺序无关：同一集合乱序指纹相等', () => {
    const a = [dv('coding', '08_APP/index.html'), dv('testing', '06_TESTS/features/index.feature')]
    const b = [dv('testing', '06_TESTS/features/index.feature'), dv('coding', '08_APP/index.html')]
    expect(divergenceFingerprint(a)).toBe(divergenceFingerprint(b))
  })

  test('不同事实集指纹不同；空列表指纹稳定', () => {
    const empty1 = divergenceFingerprint([])
    const empty2 = divergenceFingerprint([])
    expect(empty1).toBe(empty2)
    expect(empty1).not.toBe(divergenceFingerprint([dv('coding', '08_APP/index.html')]))
    expect(divergenceFingerprint([dv('coding', '08_APP/index.html')]))
      .not.toBe(divergenceFingerprint([dv('coding', '08_APP/other.html')]))
  })
})

// ===== 载荷接入：快照恒携带 + 事件挂点 =====

describe('载荷接入（nanju-guide-progress）', () => {
  test('D1 快照面：getGuideProgressSnapshot 恒携带 divergences+fingerprint（含 coding 偏差）', () => {
    setupFixture({ stage: 'requirements', artifacts: [{ path: '08_APP/index.html' }] })
    const snapshot = getGuideProgressSnapshot('test-ws', PROJECT_ID)
    expect(snapshot?.divergences?.map((d) => d.stage)).toEqual(['coding'])
    expect(typeof snapshot?.divergenceFingerprint).toBe('string')
    expect(snapshot?.divergenceFingerprint?.length ?? 0).toBeGreaterThan(0)
  })

  test('D4/D6 快照面：无偏差项目 divergences 为空数组（非 undefined，渲染端可据此清角标）', () => {
    setupFixture({ stage: 'requirements' })
    const snapshot = getGuideProgressSnapshot('test-ws', PROJECT_ID)
    expect(snapshot?.divergences).toEqual([])
    expect(typeof snapshot?.divergenceFingerprint).toBe('string')
  })

  test('D6 快照面：删除越阶段文件后快照 divergences 清空、指纹变化', () => {
    setupFixture({ stage: 'requirements', artifacts: [{ path: '08_APP/index.html' }] })
    const before = getGuideProgressSnapshot('test-ws', PROJECT_ID)
    rmSync(join(fixtureRoot, `project-${PROJECT_ID}`, '08_APP', 'index.html'))
    const after = getGuideProgressSnapshot('test-ws', PROJECT_ID)
    expect(before?.divergences?.length).toBe(1)
    expect(after?.divergences).toEqual([])
    expect(after?.divergenceFingerprint).not.toBe(before?.divergenceFingerprint)
  })

  test('事件挂点：emitGuideProgress 传 extra.workspaceSlug → 载荷携带现算 divergences+fingerprint', () => {
    setupFixture({ stage: 'requirements', artifacts: [{ path: '08_APP/index.html' }] })
    emitGuideProgress('session-1', PROJECT_ID, 'requirements', 'REQ', { workspaceSlug: 'test-ws' })
    const payload = sentEvents[sentEvents.length - 1]?.payload
    expect(payload?.divergences).toMatchObject([{ stage: 'coding', artifact: '08_APP/index.html' }])
    expect(typeof payload?.divergenceFingerprint).toBe('string')
  })

  test('向前兼容：emitGuideProgress 未传 workspaceSlug → 载荷不含 divergences 字段（既有五字段不变）', () => {
    setupFixture({ stage: 'requirements', artifacts: [{ path: '08_APP/index.html' }] })
    emitGuideProgress('session-1', PROJECT_ID, 'requirements', 'REQ')
    const payload = sentEvents[sentEvents.length - 1]?.payload
    expect(payload).toMatchObject({ sessionId: 'session-1', projectId: PROJECT_ID, currentStage: 'requirements', subStage: 'REQ' })
    expect('divergences' in (payload ?? {})).toBe(false)
    expect('divergenceFingerprint' in (payload ?? {})).toBe(false)
  })
})
