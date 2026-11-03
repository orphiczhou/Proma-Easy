/**
 * audit-r2 恢复核心回归锁定测试（父已修复 C1/C2/C4/C6 后复核）。
 *
 * 用途：把 r1 审计中的四个反例固化为可复跑回归，锁定修复不退化。
 *   C1（nanju-snapshot.ts）: 并发 createSnapshot 不再产生相同 snapshotId（原 length+1 竞态）。
 *   C2（nanju-file-snapshot.ts）: recoverInterruptedRestore 现在先获取引擎锁（原无锁绕过）。
 *   C4（nanju-snapshot.ts / nanju-project-snapshots.ts）: 路径段拒绝 slash/NUL/点路径（原穿越）。
 *   C6（nanju-project-snapshots.ts）: resolveRepairRollbackSnapshot 排除 pre-restore（原语义污染）。
 *
 * 运行：bun test <本文件>。所有 mock 用绝对路径，落盘仅在 mkdtempSync 临时目录。
 * 注意：本文件位于 docs/reports/ 下，不随产品测试套件默认运行；仅作审计证据留档。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = '/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib'

let workspaceDir = ''

// —— 依赖隔离：agent-session-manager（引入 electron，本机不可载）与 config-paths 全部 stub ——
let forkGate: (() => void)[] = []
let blockingFork = false
mock.module(join(LIB, 'agent-session-manager.ts'), () => ({
  createAgentSession: () => ({ id: 'stub' }),
  getAgentSessionMeta: (id: string) => (id.startsWith('missing-') ? undefined : { id, workspaceId: 'ws-test' }),
  updateAgentSessionMeta: () => {},
  listAgentSessions: () => [],
  getAgentSessionSDKMessages: () => [],
  forkAgentSession: async ({ sessionId }: { sessionId: string }) => {
    if (blockingFork) await new Promise<void>((r) => forkGate.push(r))
    return { id: `forked-${sessionId}` }
  },
}))
mock.module(join(LIB, 'config-paths.ts'), () => ({
  getWorkspaceFilesDir: () => workspaceDir,
  getAgentWorkspacePath: () => workspaceDir,
}))

// nanju-file-snapshot 无 electron/config-paths 依赖，直接真实导入。
const fileSnapshot = await import(join(LIB, 'nanju-file-snapshot.ts'))
const snapshots = await import(join(LIB, 'nanju-snapshot.ts'))
const projectSnapshots = await import(join(LIB, 'nanju-project-snapshots.ts'))
const projectStore = await import(join(LIB, 'nanju-project.ts'))
const { writeJsonFileAtomic } = await import(join(LIB, 'safe-file.ts'))

const WORKSPACE = 'audit-ws'
const PROJECT = 'p1'

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'audit-r2-negative-'))
  mkdirSync(join(workspaceDir, `project-${PROJECT}`), { recursive: true })
  forkGate = []
  blockingFork = false
})
afterEach(() => { rmSync(workspaceDir, { recursive: true, force: true }) })

describe('C1 回归：并发 createSnapshot 必须产生互不相同的 snapshotId', () => {
  test('两个并发 createSnapshot 交错在 fork await 后重读时间轴，不再覆盖', async () => {
    const first = await snapshots.createSnapshot(WORKSPACE, PROJECT, 's0', '基线')
    expect(first.snapshotId).toBe(1)

    blockingFork = true
    const pA = snapshots.createSnapshot(WORKSPACE, PROJECT, 's1', '并发A')
    const pB = snapshots.createSnapshot(WORKSPACE, PROJECT, 's2', '并发B')
    while (forkGate.length < 2) await new Promise((r) => setTimeout(r, 1))
    forkGate.forEach((g) => g())

    const [a, b] = await Promise.all([pA, pB])
    // 修复后：fork 完成 → 同步重读 → max(id)+1，两个并发快照拿到不同 id，且都落盘
    expect(a.snapshotId).not.toBe(b.snapshotId)
    const ids = snapshots.listSnapshots(WORKSPACE, PROJECT).map((s) => s.snapshotId)
    expect(ids).toContain(a.snapshotId)
    expect(ids).toContain(b.snapshotId)
    expect(new Set(ids).size).toBe(ids.length) // 无重复 id
  })
})

describe('C2 回归：recoverInterruptedRestore 必须尊重活跃引擎锁', () => {
  test('活跃锁在场（他进程）时返回 locked 而非完成恢复', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-c2-'))
    try {
      const projectDir = join(root, 'project')
      const storageDir = join(root, 'file-snapshots')
      mkdirSync(storageDir, { recursive: true })
      // 活跃锁：pid=当前存活进程、token 非本调用方；不写 procStart 使 isPidAlive 走 kill(pid,0)=true，
      // 从而 isLockStale=false（活跃锁）。r1 反例曾误用 procStart:'0'（该值使锁被正确判陈旧并接管）。
      writeFileSync(join(storageDir, '_restore.lock'), JSON.stringify({
        pid: process.pid, startedAt: new Date().toISOString(), token: 'other-owner',
      }))
      // 构造 rename1 已发生的现场（projectDir 缺失 + trash/staging 在场）
      const trashDir = join(storageDir, '_trash', 'txn1')
      const stagingDir = join(storageDir, '_staging', 'restore-txn1')
      mkdirSync(trashDir, { recursive: true })
      mkdirSync(stagingDir, { recursive: true })
      writeFileSync(join(trashDir, 'old.txt'), 'old\n')
      writeFileSync(join(stagingDir, 'new.txt'), 'new\n')
      writeFileSync(join(storageDir, '_restore-journal.json'), JSON.stringify({
        txnId: 'txn1', snapshotDir: join(storageDir, 'snapshots', 'x'),
        projectDir, stagingDir, backupDir: join(storageDir, '_pre-restore-backups', 'txn1'), trashDir,
        phase: 'current-moved', updatedAt: new Date().toISOString(),
      }))

      const rec = fileSnapshot.recoverInterruptedRestore(projectDir, storageDir)
      expect(rec.ok).toBe(false)
      expect(rec.action).toBe('locked')
      // 关键：不得把 staging 搬成 projectDir
      expect(existsSync(projectDir)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('无锁时 recover 正常完成（锁守卫不误伤正常恢复）', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-c2b-'))
    try {
      const projectDir = join(root, 'project')
      const storageDir = join(root, 'file-snapshots')
      mkdirSync(storageDir, { recursive: true })
      const rec = fileSnapshot.recoverInterruptedRestore(projectDir, storageDir)
      expect(rec.ok).toBe(true)
      expect(rec.action).toBe('nothing-to-recover')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('C4 回归：路径段必须拒绝 slash/NUL/点路径，防穿越', () => {
  test('listSnapshots 对含斜杠/点段的 projectId 抛错而非读任意路径', () => {
    expect(() => snapshots.listSnapshots(WORKSPACE, '../../etc')).toThrow(/标识非法/)
    expect(() => snapshots.listSnapshots(WORKSPACE, '..')).toThrow(/标识非法/)
    expect(() => snapshots.listSnapshots(WORKSPACE, 'a/b')).toThrow(/标识非法/)
    expect(() => snapshots.listSnapshots(WORKSPACE, 'a\\b')).toThrow(/标识非法/)
    expect(() => snapshots.listSnapshots(WORKSPACE, 'x\0y')).toThrow(/标识非法/)
  })

  test('getProjectFileSnapshotStorageDir 同样拒绝恶意 projectId', () => {
    expect(() => projectSnapshots.getProjectFileSnapshotStorageDir(WORKSPACE, '../../../x')).toThrow(/标识非法/)
    expect(() => projectSnapshots.getProjectFileSnapshotStorageDir(WORKSPACE, '..')).toThrow(/标识非法/)
  })

  test('合法 projectId 正常返回路径（不误伤）', () => {
    const dir = projectSnapshots.getProjectFileSnapshotStorageDir(WORKSPACE, 'p1')
    expect(dir).toContain('project-p1-file-snapshots')
    expect(snapshots.listSnapshots(WORKSPACE, 'p1')).toEqual([])
  })
})

describe('C6 回归：resolveRepairRollbackSnapshot 必须排除 pre-restore', () => {
  test('存在 pre-restore 与 pre-modify 时，repair 回滚目标选 pre-modify 而非 pre-restore', () => {
    const path = join(workspaceDir, `project-${PROJECT}`, '_snapshots.json')
    const seed = [
      { snapshotId: 1, projectId: PROJECT, timestamp: 't1', description: '编码前健康态', triggerType: 'pre-modify', sessionId: 's', forkedSessionId: 'f1', isCurrent: false, fileSnapshotId: 'file-1' },
      { snapshotId: 2, projectId: PROJECT, timestamp: 't2', description: '恢复前的版本', triggerType: 'pre-restore', sessionId: 's', forkedSessionId: 'f2', isCurrent: false, fileSnapshotId: 'file-2' },
    ]
    writeJsonFileAtomic(path, seed)
    const target = projectSnapshots.resolveRepairRollbackSnapshot(WORKSPACE, PROJECT)
    expect(target).not.toBeNull()
    expect(target!.snapshotId).toBe('file-1') // 选的是 pre-modify 的 fileSnapshotId，而非 pre-restore 的 file-2
  })
})
