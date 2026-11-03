/**
 * audit-current 负例：target.recoveryState 形状损坏时的「假 restored」。
 *
 * 被测：nanju-project-snapshots.ts rollbackProjectSnapshot。
 *
 * 历史（2026-09-20 审计）：`complete` 只对 recoveryState 做 truthy 判定，磁盘上
 * `recoveryState: {}`（或 currentStage 缺失/非法）会被当作合法恢复 → status='restored'，
 * 文案声称「已恢复…阶段」，但阶段实际未回退，甚至写入非法 stage 串。
 *
 * 2026-11-03 NEXT-05 复核：该缺陷已修复——实现新增 validRecoveryState 校验
 * （currentStage 必须在合法阶段枚举内且 status 存在），不合法时 safeState=null →
 * 返回 status='partial'，文案明确「未恢复阶段」，且不写入非法 stage。
 * 本文件因此从「缺陷固定（红）」转为「修复回归守卫（绿）」：断言修复后的契约，
 * 一旦有人回退成 truthy 判定，这些用例会立刻变红。原始缺陷证据见 git 历史 4e4f4630。
 *
 * 运行：bun test <本文件>。mock 全部用绝对路径，落盘仅在 mkdtempSync 临时目录。
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = '/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib'

mock.module(join(LIB, 'agent-session-manager.ts'), () => ({
  createAgentSession: () => ({ id: 'stub-session' }),
  getAgentSessionMeta: (id: string) => id.startsWith('missing-') ? undefined : ({ id, workspaceId: 'ws-test' }),
  updateAgentSessionMeta: () => {},
  listAgentSessions: () => [],
  getAgentSessionSDKMessages: () => [],
  forkAgentSession: async ({ sessionId }: { sessionId: string }) => ({ id: `forked-${sessionId}` }),
}))
let workspaceDir = ''
mock.module(join(LIB, 'config-paths.ts'), () => ({ getWorkspaceFilesDir: () => workspaceDir, getAgentWorkspacePath: () => workspaceDir, getConfigDirName: () => '.proma-nonexistent-state-corruption' }))

const gw = await import(join(LIB, 'nanju-project-snapshots.ts'))
const projectStore = await import(join(LIB, 'nanju-project.ts'))
const { writeJsonFileAtomic } = await import(join(LIB, 'safe-file.ts'))
const idle = { isBusy: () => false }

const WORKSPACE = 'audit-ws'
const PROJECT = 'p1'

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'recovery-state-audit-'))
  const projectDir = join(workspaceDir, `project-${PROJECT}`)
  mkdirSync(join(projectDir, '08_APP'), { recursive: true })
  writeFileSync(join(projectDir, '08_APP', 'index.html'), '<html>v1</html>\n')
  writeJsonFileAtomic(join(workspaceDir, '_nanju-projects.json'), [{
    projectId: PROJECT, name: 'fixture', mode: 'quick', status: 'active',
    currentStage: 'coding', sessionId: 'sess-current', workspaceSlug: WORKSPACE,
    createdAt: '2026-09-20', updatedAt: '2026-09-20',
  }])
  projectStore.writeProjectInfo(WORKSPACE, PROJECT, {
    projectId: PROJECT, name: 'fixture', mode: 'quick', sessionId: 'sess-current',
    createdAt: '2026-09-20', workspaceSlug: WORKSPACE, projectDir,
    docDirs: ['08_APP'], subStage: 'CODE',
  })
})
afterEach(() => rmSync(workspaceDir, { recursive: true, force: true }))

describe('target.recoveryState 形状损坏', () => {
  test('recoveryState={}：status=restored 但阶段未回退（假 restored 证据）', async () => {
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-current', '代码初版', 'confirm')
    projectStore.updateNanjuProject(WORKSPACE, PROJECT, { currentStage: 'testing' })
    writeFileSync(join(workspaceDir, `project-${PROJECT}`, '08_APP', 'index.html'), '<html>v2</html>\n')
    const snapPath = join(workspaceDir, `project-${PROJECT}`, '_snapshots.json')
    const snaps = JSON.parse(readFileSync(snapPath, 'utf-8')) as Array<Record<string, unknown>>
    const target = snaps.find(s => s.snapshotId === cp.snapshot.snapshotId)!
    target.recoveryState = {}
    writeJsonFileAtomic(snapPath, snaps)

    const result = await gw.rollbackProjectSnapshot(WORKSPACE, PROJECT, cp.snapshot.snapshotId, idle)

    // 修复后契约：不合法 recoveryState → 不允许声称「已恢复阶段」，降级为 partial 并明示未恢复阶段
    expect(result.status).toBe('partial')
    expect(result.message).toContain('未恢复阶段')
    expect(result.message).not.toContain('已恢复会话、工程文件与阶段')
    const currentStage = projectStore.getNanjuProject(WORKSPACE, PROJECT)?.currentStage
    expect(currentStage).toBe('testing') // 未回退（也不得伪造回退）
  })

  test('recoveryState.currentStage 为非法串：不得写入非法 currentStage，降级 partial', async () => {
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-current', '代码初版', 'confirm')
    projectStore.updateNanjuProject(WORKSPACE, PROJECT, { currentStage: 'testing' })
    const snapPath = join(workspaceDir, `project-${PROJECT}`, '_snapshots.json')
    const snaps = JSON.parse(readFileSync(snapPath, 'utf-8')) as Array<Record<string, unknown>>
    const target = snaps.find(s => s.snapshotId === cp.snapshot.snapshotId)!
    target.recoveryState = { currentStage: 'garbage-stage', status: 'active' }
    writeJsonFileAtomic(snapPath, snaps)

    const result = await gw.rollbackProjectSnapshot(WORKSPACE, PROJECT, cp.snapshot.snapshotId, idle)
    expect(result.status).toBe('partial')
    // 非法 stage 不得被写进项目索引（修复前会落成 'garbage-stage'）
    expect(projectStore.getNanjuProject(WORKSPACE, PROJECT)?.currentStage).toBe('testing')
  })

  test('对照：recoveryState 完整时阶段正确回退（正常路径）', async () => {
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-current', '代码初版', 'confirm')
    projectStore.updateNanjuProject(WORKSPACE, PROJECT, { currentStage: 'testing' })
    writeFileSync(join(workspaceDir, `project-${PROJECT}`, '08_APP', 'index.html'), '<html>v2</html>\n')
    const result = await gw.rollbackProjectSnapshot(WORKSPACE, PROJECT, cp.snapshot.snapshotId, idle)
    expect(result.status).toBe('restored')
    expect(projectStore.getNanjuProject(WORKSPACE, PROJECT)?.currentStage).toBe('coding')
    expect(readFileSync(join(workspaceDir, `project-${PROJECT}`, '08_APP', 'index.html'), 'utf-8')).toContain('v1')
  })
})
