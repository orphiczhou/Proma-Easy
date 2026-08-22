/**
 * 熔断状态机单测（v0.17.64 Sprint C1，设计稿 Q2）
 *
 * 覆盖：计数（fail/error 独立累计）/ 阈值判定（fail≥3 或 error≥1 → open；
 * failCount 为失败事件数，3 = 1 首产 + 2 回炉，与 GWT_RETRY_LIMIT=2 对齐）/
 * 熔断动作数据面（previous/current 支持新熔断检测）/ 重置 / 持久化
 * （_project-info.json 原子写回读）/ 老项目无信息文件的升级路径 / NANJU_GUARDS 配置口径。
 *
 * nanju-project 依赖 config-paths.getWorkspaceFilesDir 定位项目目录——
 * 按本仓库既有模式（nanju-router-gate.test.ts）先 mock.module 指向 tmpdir。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PhaseGuardState } from './nanju-project'

let fixtureRoot = ''

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const {
  createNanjuProject,
  getPhaseGuards,
  updatePhaseGuard,
  isPhaseGuardCircuitOpen,
  NANJU_GUARDS,
} = await import('./nanju-project')

const WS = 'test-ws'

function setupProject(projectId = 'demo'): void {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-guard-'))
  fixtureRoot = dir
  createNanjuProject({ name: projectId, mode: 'quick', workspaceSlug: WS })
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

describe('NANJU_GUARDS 配置口径（不写死：常量集中可调）', () => {
  test('软超时 1200s / 硬超时 2100s / 轮询 60s / fail 阈值 3（1 首产 + 2 回炉） / error 阈值 1', () => {
    expect(NANJU_GUARDS.delegationSoftTimeoutMs).toBe(1200 * 1000)
    expect(NANJU_GUARDS.delegationHardTimeoutMs).toBe(2100 * 1000)
    expect(NANJU_GUARDS.delegationPollIntervalMs).toBe(60 * 1000)
    expect(NANJU_GUARDS.phaseFailBreakThreshold).toBe(3)
    expect(NANJU_GUARDS.phaseErrorBreakThreshold).toBe(1)
  })
})

describe('updatePhaseGuard 计数（单一写入点）', () => {
  test('初始无 phaseGuards → getPhaseGuards 返回空对象；首次 fail 计数 failCount=1', () => {
    setupProject()
    expect(getPhaseGuards(WS, 'demo')).toEqual({})
    const { previous, current } = updatePhaseGuard(WS, 'demo', 'testing', { kind: 'fail', note: 'GWT fail' })
    expect(previous).toBeNull()
    expect(current).toEqual({ failCount: 1, errorCount: 0, lastErrorAt: expect.any(String) })
  })

  test('fail 与 error 独立累计：fail+fail+error → failCount=2 errorCount=1（#6 异常独立计数器）', () => {
    setupProject()
    updatePhaseGuard(WS, 'demo', 'coding', { kind: 'fail' })
    updatePhaseGuard(WS, 'demo', 'coding', { kind: 'fail' })
    const { current } = updatePhaseGuard(WS, 'demo', 'coding', { kind: 'error' })
    expect(current.failCount).toBe(2)
    expect(current.errorCount).toBe(1)
  })

  test('reset 清零计数并清除 lastErrorAt', () => {
    setupProject()
    updatePhaseGuard(WS, 'demo', 'prototype', { kind: 'error' })
    const { current } = updatePhaseGuard(WS, 'demo', 'prototype', { kind: 'reset' })
    expect(current).toEqual({ failCount: 0, errorCount: 0 })
  })

  test('阶段间互不影响：testing 计数不泄漏到 coding', () => {
    setupProject()
    updatePhaseGuard(WS, 'demo', 'testing', { kind: 'fail' })
    updatePhaseGuard(WS, 'demo', 'testing', { kind: 'fail' })
    const coding = getPhaseGuards(WS, 'demo').coding
    expect(coding).toBeUndefined()
    expect(getPhaseGuards(WS, 'demo').testing?.failCount).toBe(2)
  })

  test('老项目无 _project-info.json：写入时构造骨架不抛错（升级路径）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nanju-guard-legacy-'))
    fixtureRoot = dir
    const { current } = updatePhaseGuard(WS, 'legacy', 'testing', { kind: 'error' })
    expect(current.errorCount).toBe(1)
    expect(existsSync(join(dir, 'project-legacy', '_project-info.json'))).toBe(true)
  })
})

describe('isPhaseGuardCircuitOpen 阈值判定', () => {
  test('undefined / 零计数 → closed', () => {
    expect(isPhaseGuardCircuitOpen(undefined).open).toBe(false)
    expect(isPhaseGuardCircuitOpen({ failCount: 0, errorCount: 0 }).open).toBe(false)
  })

  test('failCount 是失败事件数（1 起）：failCount=2（首产+1 回炉失败）→ closed；failCount≥3（回炉预算耗尽）→ open', () => {
    expect(isPhaseGuardCircuitOpen({ failCount: 1, errorCount: 0 }).open).toBe(false)
    expect(isPhaseGuardCircuitOpen({ failCount: 2, errorCount: 0 }).open).toBe(false)
    const opened = isPhaseGuardCircuitOpen({ failCount: 3, errorCount: 0 })
    expect(opened.open).toBe(true)
    expect(opened.reason).toContain('失败累计 3 次')
  })

  test('errorCount=1 → 立即 open（执行异常重试无意义，阈值 1）', () => {
    const opened = isPhaseGuardCircuitOpen({ failCount: 0, errorCount: 1 })
    expect(opened.open).toBe(true)
    expect(opened.reason).toContain('执行异常累计 1 次')
  })

  test('熔断全链路：三次 fail 事件（1 首产 + 2 回炉）后状态从 closed → open（previous/current 支持新熔断检测）', () => {
    setupProject()
    const first = updatePhaseGuard(WS, 'demo', 'testing', { kind: 'fail' })
    expect(isPhaseGuardCircuitOpen(first.current).open).toBe(false)
    const second = updatePhaseGuard(WS, 'demo', 'testing', { kind: 'fail' })
    expect(isPhaseGuardCircuitOpen(second.current).open).toBe(false)
    const third = updatePhaseGuard(WS, 'demo', 'testing', { kind: 'fail' })
    // 新熔断判定：previous 未达阈值 且 current 达阈值
    const justOpened = !isPhaseGuardCircuitOpen(third.previous ?? undefined).open
      && isPhaseGuardCircuitOpen(third.current).open
    expect(justOpened).toBe(true)
    // reset 后复位 closed（用户驱动的复位路径：阶段推进收口）
    const reset = updatePhaseGuard(WS, 'demo', 'testing', { kind: 'reset' })
    expect(isPhaseGuardCircuitOpen(reset.current).open).toBe(false)
  })
})

describe('持久化（_project-info.json 原子写）', () => {
  test('计数写入后磁盘可读回，且保留既有身份字段（projectId/name/docDirs）', () => {
    setupProject()
    updatePhaseGuard(WS, 'demo', 'testing', { kind: 'fail' })
    const guards: PhaseGuardState | undefined = getPhaseGuards(WS, 'demo').testing
    expect(guards?.failCount).toBe(1)
    const info = JSON.parse(readFileSync(join(fixtureRoot, 'project-demo', '_project-info.json'), 'utf-8'))
    expect(info.projectId).toBe('demo')
    expect(info.name).toBe('demo')
    expect(Array.isArray(info.docDirs)).toBe(true)
    expect(info.phaseGuards.testing.failCount).toBe(1)
  })
})
