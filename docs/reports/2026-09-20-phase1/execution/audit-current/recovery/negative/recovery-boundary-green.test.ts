/**
 * audit-current 负例（绿）：恢复事务边界保护复核（跨项目/符号链接/损坏 journal/只读自救）。
 *
 * 被测：nanju-project-snapshots.ts 的 getRecoveryToolBlock / findRecoveryProjectForSession /
 *       rollbackProjectSnapshot（损坏 journal 分支）。
 *
 * 只读审计：本组测试固定「当前已正确拒绝」的保护面，作为绿级证据。
 * 运行：bun test <本文件>。mock 全部用绝对路径，落盘仅在 mkdtempSync 临时目录。
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
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
mock.module(join(LIB, 'config-paths.ts'), () => ({ getWorkspaceFilesDir: () => workspaceDir, getAgentWorkspacePath: () => workspaceDir, getConfigDirName: () => '.proma-nonexistent-boundary-green' }))

const gw = await import(join(LIB, 'nanju-project-snapshots.ts'))
const projectStore = await import(join(LIB, 'nanju-project.ts'))
const { writeJsonFileAtomic } = await import(join(LIB, 'safe-file.ts'))
const idle = { isBusy: () => false }

const WORKSPACE = 'audit-ws'
const PROJECT = 'p1'
let projectDir = ''

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'recovery-boundary-audit-'))
  projectDir = join(workspaceDir, `project-${PROJECT}`)
  mkdirSync(join(projectDir, '08_APP'), { recursive: true })
  writeFileSync(join(projectDir, '08_APP', 'index.html'), '<html>v1</html>\n')
  writeJsonFileAtomic(join(workspaceDir, '_nanju-projects.json'), [
    { projectId: PROJECT, name: 'fixture', mode: 'quick', status: 'active', currentStage: 'coding', sessionId: 'sess-current', workspaceSlug: WORKSPACE, createdAt: 'x', updatedAt: 'x' },
    { projectId: 'other', name: 'other', mode: 'quick', status: 'active', currentStage: 'coding', sessionId: 'sess-other', workspaceSlug: WORKSPACE, createdAt: 'x', updatedAt: 'x' },
  ])
  mkdirSync(join(workspaceDir, 'project-other', '08_APP'), { recursive: true })
  projectStore.writeProjectInfo(WORKSPACE, PROJECT, {
    projectId: PROJECT, name: 'fixture', mode: 'quick', sessionId: 'sess-current', createdAt: 'x',
    workspaceSlug: WORKSPACE, projectDir, docDirs: ['08_APP'], subStage: 'CODE',
  })
  projectStore.writeProjectInfo(WORKSPACE, 'other', {
    projectId: 'other', name: 'other', mode: 'quick', sessionId: 'sess-other', createdAt: 'x',
    workspaceSlug: WORKSPACE, projectDir: join(workspaceDir, 'project-other'), docDirs: ['08_APP'],
  })
})
afterEach(() => rmSync(workspaceDir, { recursive: true, force: true }))

function seedPreparedJournal(): void {
  const storage = gw.getProjectFileSnapshotStorageDir(WORKSPACE, PROJECT)
  mkdirSync(storage, { recursive: true })
  writeFileSync(join(storage, '_project-recovery.json'), JSON.stringify({
    version: 1, projectId: PROJECT, phase: 'prepared', message: 'audit prepared',
    beforeProject: { projectId: PROJECT, workspaceSlug: WORKSPACE, sessionId: 'sess-current', currentStage: 'coding', mode: 'quick', status: 'active', name: 'fixture', createdAt: 'x', updatedAt: 'x' },
    beforeInfo: { projectId: PROJECT, workspaceSlug: WORKSPACE, sessionId: 'sess-current' },
    preRestoreSnapshotId: 1, preFileSnapshotId: 'aaa', targetSnapshotId: 2,
  }))
}

describe('写路径符号链接与跨项目归属', () => {
  test('项目外符号链接指向被阻塞工程文件 → 写路径经 realpath 归位后仍被拒', () => {
    seedPreparedJournal()
    const outsideAlias = join(workspaceDir, '..', 'outside-alias')
    symlinkSync(projectDir, outsideAlias)
    const block = gw.getRecoveryToolBlock(WORKSPACE, 'sess-other', 'Write', { file_path: join(outsideAlias, '08_APP', 'index.html') })
    expect(block).not.toBeNull()
    rmSync(outsideAlias, { force: true })
  })

  test('无关工程会话写自身文件不受阻塞；写被阻塞工程文件被拒', () => {
    seedPreparedJournal()
    expect(gw.getRecoveryToolBlock(WORKSPACE, 'sess-other', 'Write', { file_path: join(workspaceDir, 'project-other', '08_APP', 'x.md') })).toBeNull()
    expect(gw.getRecoveryToolBlock(WORKSPACE, 'sess-other', 'Edit', { file_path: join(projectDir, '08_APP', 'index.html') })).not.toBeNull()
  })

  test('被阻塞工程自身会话：读放行（只读自救）、写拒绝', () => {
    seedPreparedJournal()
    expect(gw.getRecoveryToolBlock(WORKSPACE, 'sess-current', 'Read', { path: projectDir })).toBeNull()
    expect(gw.getRecoveryToolBlock(WORKSPACE, 'sess-current', 'Write', { file_path: join(projectDir, '08_APP', 'index.html') })).not.toBeNull()
  })
})

describe('损坏 journal 必须选择完整检查点', () => {
  test('损坏 journal + 目标快照无文件/阶段记录 → 拒绝（不静默放行）', async () => {
    const { createSnapshot } = await import(join(LIB, 'nanju-snapshot.ts'))
    const legacy = await createSnapshot(WORKSPACE, PROJECT, 'sess-current', 'legacy 无文件快照', 'confirm')
    const storage = gw.getProjectFileSnapshotStorageDir(WORKSPACE, PROJECT)
    mkdirSync(storage, { recursive: true })
    writeFileSync(join(storage, '_project-recovery.json'), '{broken')
    const result = await gw.rollbackProjectSnapshot(WORKSPACE, PROJECT, legacy.snapshotId, idle)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('恢复日志损坏')
    expect(projectStore.getNanjuProject(WORKSPACE, PROJECT)?.sessionId).toBe('sess-current')
    expect(gw.getProjectRecoveryBlock(WORKSPACE, PROJECT)).not.toBeNull()
  })

  test('损坏 journal + 完整检查点 → 归档原日志并恢复', async () => {
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-current', '完整检查点', 'confirm')
    const storage = gw.getProjectFileSnapshotStorageDir(WORKSPACE, PROJECT)
    const journalPath = join(storage, '_project-recovery.json')
    writeFileSync(journalPath, '{broken-original')
    writeFileSync(join(projectDir, '08_APP', 'index.html'), '<html>later</html>\n')
    const result = await gw.rollbackProjectSnapshot(WORKSPACE, PROJECT, cp.snapshot.snapshotId, idle)
    expect(result.status).toBe('restored')
    const archived = readdirSync(storage).find(n => n.startsWith('_project-recovery.json.corrupt-'))!
    expect(readFileSync(join(storage, archived), 'utf-8')).toBe('{broken-original')
    expect(readFileSync(join(projectDir, '08_APP', 'index.html'), 'utf-8')).toContain('v1')
    expect(gw.getProjectRecoveryBlock(WORKSPACE, PROJECT)).toBeNull()
  })
})
