/**
 * audit-current 负例：target.recoveryState 形状损坏时的「假 restored」。
 *
 * 被测：nanju-project-snapshots.ts rollbackProjectSnapshot。
 *
 * 反例命题：`complete = Boolean(fileRestore?.ok && fileRestore.complete && state)` 只对
 *           `state`（target.recoveryState）做 truthy 判定，未校验 `currentStage`/`status`
 *           字段真实存在。磁盘上 `_snapshots.json` 若被部分损坏为 `recoveryState: {}`
 *           （或 currentStage 缺失/非法），则：
 *           - `state` 为 {}（truthy）→ complete 可为 true → status='restored'，文案声称
 *             「已恢复会话、工程文件与阶段」；
 *           - 但 `restoredStage = state?.currentStage ?? project.currentStage` 因 currentStage
 *             缺失退化为当前阶段，**阶段实际未回退**，甚至写入非法 stage 串。
 *
 * 只读审计：不改产品代码；本测试仅固定当前行为作为证据。
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

    expect(result.status).toBe('restored')
    expect(result.message).toContain('已恢复会话、工程文件与阶段')
    const currentStage = projectStore.getNanjuProject(WORKSPACE, PROJECT)?.currentStage
    expect(currentStage).toBe('testing')   // 正确应为 'coding'，当前因 recoveryState 缺失退化
  })

  test('recoveryState.currentStage 为非法串：直接写入非法 currentStage 且仍报 restored', async () => {
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-current', '代码初版', 'confirm')
    projectStore.updateNanjuProject(WORKSPACE, PROJECT, { currentStage: 'testing' })
    const snapPath = join(workspaceDir, `project-${PROJECT}`, '_snapshots.json')
    const snaps = JSON.parse(readFileSync(snapPath, 'utf-8')) as Array<Record<string, unknown>>
    const target = snaps.find(s => s.snapshotId === cp.snapshot.snapshotId)!
    target.recoveryState = { currentStage: 'garbage-stage', status: 'active' }
    writeJsonFileAtomic(snapPath, snaps)

    const result = await gw.rollbackProjectSnapshot(WORKSPACE, PROJECT, cp.snapshot.snapshotId, idle)
    expect(result.status).toBe('restored')
    expect(projectStore.getNanjuProject(WORKSPACE, PROJECT)?.currentStage).toBe('garbage-stage')
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
