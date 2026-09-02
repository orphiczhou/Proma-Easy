/**
 * 南大向导「跨大环节回归流」单测（W2c 判定协议 v1，v0.17.69）
 *
 * 覆盖面：
 * - detectRegressionSignal 硬规则三分支（新 US 编号 regress / 已有编号 null / 撤销关键词 null）
 *   + 编号规范化（US-05 与 US-5 等同）+ 边界（无编号意见/空意见）
 * - recordRegressionEvent：写入 regressionEvents + 同 from→to 5 分钟窗口去重合并 count++
 *   + 不同 from→to 不合并 + 审计日志 _regression-audit.jsonl 逐条落盘（含 judgment）
 * - recordGwtFailureRegression：behavior→coding / mapping→testing 两条事件（A2 触发点 3）
 * - projectRegressions：按边聚合 + active 判定（currentStage === to）
 *
 * fixture 模式与 nanju-guide-progress.test.ts 同型：mock.module config-paths 指向 tmpdir
 * 后动态导入被测模块。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 当前 fixture 根目录（mock 的 getWorkspaceFilesDir 每次调用时读取） */
let fixtureRoot = ''

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
  detectRegressionSignal,
  recordRegressionEvent,
  recordGwtFailureRegression,
  getRegressionEvents,
  projectRegressions,
  REGRESSION_DEDUP_WINDOW_MS,
} = await import('./nanju-regression')
const { readProjectInfo } = await import('./nanju-project')

const WORKSPACE_SLUG = 'test-ws'
const PROJECT_ID = 'p1'

/** 构造 tmpdir fixture：项目目录 + 最小 _project-info.json + 项目列表（sessionId 关联） */
function setupFixture(subStage?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-regression-'))
  fixtureRoot = dir
  const projectDir = join(dir, `project-${PROJECT_ID}`)
  mkdirSync(projectDir, { recursive: true })
  writeJson(join(dir, '_nanju-projects.json'), [
    { projectId: PROJECT_ID, name: '测试项目', mode: 'quick', status: 'active', currentStage: 'prototype', sessionId: 's1', createdAt: '', updatedAt: '', workspaceSlug: WORKSPACE_SLUG },
  ])
  writeJson(join(projectDir, '_project-info.json'), {
    projectId: PROJECT_ID, name: '测试项目', mode: 'quick',
    createdAt: '', workspaceSlug: WORKSPACE_SLUG, projectDir: `project-${PROJECT_ID}`, docDirs: [],
    ...(subStage !== undefined ? { subStage } : {}),
  })
  return dir
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSyncSafe(path, JSON.stringify(data))
}
import { writeFileSync as writeFileSyncSafe } from 'node:fs'

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

// ===== detectRegressionSignal（纯函数，硬规则三分支） =====

describe('detectRegressionSignal（判定协议 v1 硬规则）', () => {
  const PRD = '# 需求\n\n## US-01 记事\n## US-02 搜索\n'

  test('意见引入 PRD 未有的新 US 编号 → regress（rule=new-us-id）', () => {
    const signal = detectRegressionSignal(['再加一个导出功能 US-03'], PRD)
    expect(signal).toEqual({ regress: true, rule: 'new-us-id', matched: 'US-03' })
  })

  test('意见指向 PRD 已有 US-xx → null（修改非新需求）', () => {
    expect(detectRegressionSignal(['US-01 的按钮改成圆角'], PRD)).toBeNull()
    expect(detectRegressionSignal(['US-02 搜索支持拼音'], PRD)).toBeNull()
  })

  test('意见含「删掉/不要/取消」→ null（需求撤回，撤销优先于新编号判定）', () => {
    expect(detectRegressionSignal(['删掉 US-03 这个功能'], PRD)).toBeNull()
    expect(detectRegressionSignal(['不要 US-03'], PRD)).toBeNull()
    expect(detectRegressionSignal(['取消 US-03 需求'], PRD)).toBeNull()
  })

  test('编号规范化：US-05 与 US-5 视为同一条（PRD 编号位数容错）', () => {
    expect(detectRegressionSignal(['US-5 再细化一下'], '# US-05 测试\n')).toBeNull()
    expect(detectRegressionSignal(['us-6 新增'], '# US-06 测试\n')).toBeNull()
    // 大小写不敏感 + PRD 无 07 条目
    expect(detectRegressionSignal(['us-07 新增'], '# US-06 测试\n')).toEqual({ regress: true, rule: 'new-us-id', matched: 'us-07' })
  })

  test('边界 default 非回归：无编号意见 / 空意见 / 空数组 → null', () => {
    expect(detectRegressionSignal(['这个按钮大一点'], PRD)).toBeNull()
    expect(detectRegressionSignal([''], PRD)).toBeNull()
    expect(detectRegressionSignal([], PRD)).toBeNull()
  })

  test('多意见集合：任一条命中即返回首个命中（边界低敏感度）', () => {
    const signal = detectRegressionSignal(['US-01 改色', '新增 US-08 统计页', 'US-02 微调'], PRD)
    expect(signal?.regress).toBe(true)
    expect(signal?.matched).toBe('US-08')
  })
})

// ===== recordRegressionEvent（唯一写入点） =====

describe('recordRegressionEvent（唯一写入点 + 5 分钟去重 + 审计日志）', () => {
  test('首次写入：regressionEvents 追加事件 + 审计日志落盘 + 埋点/广播触发', () => {
    const dir = setupFixture('PROTO_UC')
    const event = recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements',
      '意见引入新需求 US-03', { opinion: '再加一个导出功能 US-03', sessionId: 's1' })

    expect(event).toMatchObject({ from: 'prototype', to: 'requirements', count: 1 })
    // 状态文件
    const info = readProjectInfo(WORKSPACE_SLUG, PROJECT_ID)
    expect(info?.regressionEvents).toHaveLength(1)
    expect(info?.regressionEvents?.[0]).toMatchObject({ from: 'prototype', to: 'requirements', reason: '意见引入新需求 US-03', count: 1 })
    // 审计日志逐条追加（含 opinion）
    const auditPath = join(dir, `project-${PROJECT_ID}`, '_regression-audit.jsonl')
    expect(existsSync(auditPath)).toBe(true)
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ from: 'prototype', to: 'requirements', opinion: '再加一个导出功能 US-03' })
    // 广播载荷带 regressions 投影（active：当前 stage=prototype≠to=requirements → false）
    const last = sentEvents[sentEvents.length - 1]
    expect(last?.channel).toBe('nanju:guide-progress')
    expect(last?.payload.regressions).toEqual([
      { from: 'prototype', to: 'requirements', count: 1, active: false },
    ])
  })

  test('5 分钟窗口去重：同 from→to 二次触发合并 count++（不追加条目，审计日志仍逐条）', () => {
    setupFixture()
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', '第一次')
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', '第二次（窗口内）')

    const events = getRegressionEvents(WORKSPACE_SLUG, PROJECT_ID)
    expect(events).toHaveLength(1)
    expect(events[0]?.count).toBe(2)
    // 审计日志不合并（可回放）
    const lines = readFileSync(join(fixtureRoot, `project-${PROJECT_ID}`, '_regression-audit.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  test('不同 from→to 不合并（testing→coding 与 prototype→requirements 独立成条）', () => {
    setupFixture()
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', 'A')
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'testing', 'coding', 'B')
    const events = getRegressionEvents(WORKSPACE_SLUG, PROJECT_ID)
    expect(events).toHaveLength(2)
    expect(events.map((e) => `${e.from}->${e.to}`)).toEqual(['prototype->requirements', 'testing->coding'])
  })

  test('窗口外（伪造旧 at）触发 → 新条目不合并', async () => {
    setupFixture()
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', '第一条')
    // 伪造已过期的首条事件（回写 at 为窗口外时间），再触发应新开一条
    const info = readProjectInfo(WORKSPACE_SLUG, PROJECT_ID)
    if (info?.regressionEvents?.[0]) {
      info.regressionEvents[0].at = new Date(Date.now() - REGRESSION_DEDUP_WINDOW_MS - 60_000).toISOString()
      const { writeProjectInfo } = await import('./nanju-project')
      writeProjectInfo(WORKSPACE_SLUG, PROJECT_ID, info)
    }
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', '窗口外第二条')
    const events = getRegressionEvents(WORKSPACE_SLUG, PROJECT_ID)
    expect(events).toHaveLength(2)
  })

  test('L1 语义判定必附 judgment（审计日志含 judgment 字段）', () => {
    setupFixture()
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', 'L1 语义判定：意见引入新需求', {
      opinion: '支持多人协作',
      judgment: '「支持多人协作」超出既有 US-xx 清单范围，属于新需求',
    })
    const line = JSON.parse(readFileSync(join(fixtureRoot, `project-${PROJECT_ID}`, '_regression-audit.jsonl'), 'utf-8').trim()) as Record<string, unknown>
    expect(line.judgment).toBe('「支持多人协作」超出既有 US-xx 清单范围，属于新需求')
  })
})

// ===== GWT 失败分流（A2 触发点 3） =====

describe('recordGwtFailureRegression（GWT 失败分流两条事件）', () => {
  test('behavior → from=testing to=coding；mapping → from=testing to=testing', () => {
    setupFixture()
    recordGwtFailureRegression(WORKSPACE_SLUG, PROJECT_ID, 'behavior')
    recordGwtFailureRegression(WORKSPACE_SLUG, PROJECT_ID, 'mapping')
    const events = getRegressionEvents(WORKSPACE_SLUG, PROJECT_ID)
    expect(events.map((e) => `${e.from}->${e.to}`)).toEqual(['testing->coding', 'testing->testing'])
    expect(events[0]?.reason).toContain('行为类失败')
    expect(events[1]?.reason).toContain('映射类失败')
  })
})

// ===== projectRegressions（渲染端投影） =====

describe('projectRegressions（边聚合 + active 判定）', () => {
  test('同边多条聚合 count 累加；active = currentStage === to', () => {
    const now = new Date().toISOString()
    const edges = projectRegressions([
      { from: 'prototype', to: 'requirements', at: now, reason: 'a', count: 1 },
      { from: 'prototype', to: 'requirements', at: now, reason: 'b', count: 2 },
      { from: 'testing', to: 'coding', at: now, reason: 'c', count: 1 },
    ], 'requirements')
    expect(edges).toHaveLength(2)
    expect(edges.find((e) => e.from === 'prototype')).toMatchObject({ count: 3, active: true })
    expect(edges.find((e) => e.from === 'testing')).toMatchObject({ count: 1, active: false })
  })

  test('无事件 → 空数组', () => {
    expect(projectRegressions([], 'requirements')).toEqual([])
  })
})

// ===== M6（AC 审计 A8.2）：去重从尾向前扫描（交叉边场景） =====

describe('recordRegressionEvent · M6 交叉边去重（末条是其他边时同边仍合并）', () => {
  test('A→B, C→D, A→B（窗口内）：末条是 C→D 时 A→B 第二次触发仍合并到首条', () => {
    setupFixture()
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', 'A1')
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'testing', 'coding', 'C1')
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', 'A2')

    const events = getRegressionEvents(WORKSPACE_SLUG, PROJECT_ID)
    expect(events).toHaveLength(2)
    // prototype→requirements 合并 count=2（M6 修复前：末条是 testing→coding，A2 会误开第三条）
    expect(events[0]).toMatchObject({ from: 'prototype', to: 'requirements', count: 2 })
    expect(events[1]).toMatchObject({ from: 'testing', to: 'coding', count: 1 })
  })

  test('合并写入位置：count 更新在原事件位（顺序保持首次触发序）', () => {
    setupFixture()
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', 'A1')
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'testing', 'coding', 'C1')
    recordRegressionEvent(WORKSPACE_SLUG, PROJECT_ID, 'prototype', 'requirements', 'A2')
    const events = getRegressionEvents(WORKSPACE_SLUG, PROJECT_ID)
    // 首条仍为 prototype→requirements（原位合并，不移动到尾部）
    expect(events[0]?.from).toBe('prototype')
    expect(events[0]?.count).toBe(2)
  })
})
