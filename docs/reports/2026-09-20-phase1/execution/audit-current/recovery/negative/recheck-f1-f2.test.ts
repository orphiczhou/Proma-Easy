/**
 * audit-current 复核（recheck）：F1/F2 修复后的正确行为锁定。
 *
 * F1（nanju-advance-recovery.ts）：eventKey=undefined 不再继承 cancelled/consumed。
 * F2（nanju-project-snapshots.ts）：recoveryState 必须合法 stage+status 才 restored，否则 partial。
 *
 * 只读复核：不改产品代码；本测试断言修复后的正确行为，作为 recheck.md 的可复跑证据。
 * 运行：bun test <本文件>。mock 全部用绝对路径，落盘仅在 mkdtempSync 临时目录。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = '/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib'

let root = ''
mock.module(join(LIB, 'config-paths.ts'), () => ({
  getWorkspaceFilesDir: () => root,
  getAgentWorkspacePath: () => root,
  getConfigDirName: () => '.proma-nonexistent-recheck',
}))
mock.module(join(LIB, 'agent-session-manager.ts'), () => ({
  createAgentSession: () => ({ id: 'stub-session' }),
  getAgentSessionMeta: (id: string) => id.startsWith('missing-') ? undefined : ({ id, workspaceId: 'ws-test' }),
  updateAgentSessionMeta: () => {},
  listAgentSessions: () => [],
  getAgentSessionSDKMessages: () => [],
  forkAgentSession: async ({ sessionId }: { sessionId: string }) => ({ id: `forked-${sessionId}` }),
}))

const store = await import(join(LIB, 'nanju-project.ts'))
const { writeJsonFileAtomic } = await import(join(LIB, 'safe-file.ts'))
const recovery = await import(join(LIB, 'nanju-advance-recovery.ts'))
const gw = await import(join(LIB, 'nanju-project-snapshots.ts'))
const idle = { isBusy: () => false }

const WS = 'audit-ws'
const ID = 'recheck-fixture'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recheck-audit-'))
  const dir = join(root, `project-${ID}`)
  mkdirSync(join(dir, '01_PRD'), { recursive: true })
  mkdirSync(join(dir, '08_APP'), { recursive: true })
  writeFileSync(join(dir, '08_APP', 'index.html'), '<html>v1</html>\n')
  writeJsonFileAtomic(join(root, '_nanju-projects.json'), [{
    projectId: ID, name: 'fixture', mode: 'quick', status: 'active',
    currentStage: 'requirements', sessionId: 'sess-current', workspaceSlug: WS,
    createdAt: 'today', updatedAt: 'today',
  }])
  store.writeProjectInfo(WS, ID, {
    projectId: ID, name: 'fixture', mode: 'quick', sessionId: 'sess-current', workspaceSlug: WS,
    createdAt: 'today', projectDir: dir, docDirs: ['01_PRD', '08_APP'], subStage: 'REQ',
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('F1 复核：eventKey=undefined 不再继承 cancelled/consumed', () => {
  test('指纹失败时取消后新拒因恢复 blocked（不再被静默吞掉）', () => {
    // 阶段产物 >20MB → phaseArtifactFingerprint 抛错 → eventKey undefined
    writeFileSync(join(root, `project-${ID}`, '01_PRD', 'oversized.bin'), '')
    truncateSync(join(root, `project-${ID}`, '01_PRD', 'oversized.bin'), 21 * 1024 * 1024)
    recovery.persistAdvanceCorrection(WS, ID, { kind: 'gate-deny', target: 'prototype', expected: 'prototype', count: 1, message: '第一次', checks: [] })
    expect(store.getProjectPendingAdvanceCorrection(WS, ID)?.eventKey).toBeUndefined()
    recovery.cancelAdvanceCorrection(WS, ID)
    recovery.persistAdvanceCorrection(WS, ID, { kind: 'gate-deny', target: 'prototype', expected: 'prototype', count: 2, message: '第二次全新拒因', checks: [] })
    const second = store.getProjectPendingAdvanceCorrection(WS, ID)!
    // 修复后：eventKey undefined 时不进入 cancelled 继承分支 → 恢复 blocked
    expect(second.executionState).toBe('blocked')
    expect(second.consumedEventKey).toBeUndefined()
    expect(recovery.buildPendingAdvanceRecoveryPrompt(WS, ID)).not.toBeNull()
  })
})

describe('F2 复核：recoveryState 非法时降级 partial，不写非法 stage', () => {
  async function seedCheckpoint(): Promise<number> {
    const cp = await gw.createProjectCheckpoint(WS, ID, 'sess-current', '代码初版', 'confirm')
    store.updateNanjuProject(WS, ID, { currentStage: 'testing' })
    return cp.snapshot.snapshotId
  }
  function tamper(snapshotId: number, patch: (t: Record<string, unknown>) => void): void {
    const snapPath = join(root, `project-${ID}`, '_snapshots.json')
    const snaps = JSON.parse(readFileSync(snapPath, 'utf-8')) as Array<Record<string, unknown>>
    const t = snaps.find(s => s.snapshotId === snapshotId)!
    patch(t)
    writeJsonFileAtomic(snapPath, snaps)
  }

  test('recoveryState={} → status=partial，阶段不回退且不写非法值', async () => {
    const id = await seedCheckpoint()
    tamper(id, (t) => { t.recoveryState = {} })
    const result = await gw.rollbackProjectSnapshot(WS, ID, id, idle)
    expect(result.status).toBe('partial')
    expect(result.message).toContain('旧快照缺少合法阶段信息')
    expect(store.getNanjuProject(WS, ID)?.currentStage).toBe('testing') // 不回退也不写非法值
  })

  test('recoveryState.currentStage 非法串 → status=partial，不写入 garbage-stage', async () => {
    const id = await seedCheckpoint()
    tamper(id, (t) => { t.recoveryState = { currentStage: 'garbage-stage', status: 'active' } })
    const result = await gw.rollbackProjectSnapshot(WS, ID, id, idle)
    expect(result.status).toBe('partial')
    expect(store.getNanjuProject(WS, ID)?.currentStage).toBe('testing') // 关键：不写 garbage-stage
  })

  test('recoveryState 完整合法 → status=restored 且阶段正确回退（对照）', async () => {
    const id = await seedCheckpoint()
    const result = await gw.rollbackProjectSnapshot(WS, ID, id, idle)
    expect(result.status).toBe('restored')
    expect(store.getNanjuProject(WS, ID)?.currentStage).toBe('requirements')
  })
})
