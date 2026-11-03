/**
 * W-D/旧快照兼容：nanju-snapshot 会话快照的「文件可恢复性」BDD。
 *
 * 关注点：
 * - 旧 fork 会话快照没有工程文件快照时，**不能声称可以恢复工程文件**；
 * - S4：只有经 linkFileSnapshot **校验过真实存在的 W-D 快照**（snapshotDir/manifest + hash 有效）
 *   才能让 hasFileSnapshot=true；任意 UUID 不得到达真状态。
 *
 * 依赖隔离：agent-session-manager / config-paths 均被 stub，
 * 所有落盘仅发生在 mkdtempSync 临时目录，绝不触碰任何真实工作区或用户工程。
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 真实模块链顶层 import electron（本机无 electron 二进制），按仓库既有模式完全 stub。
mock.module('./agent-session-manager', () => ({
  createAgentSession: () => ({ id: 'stub-session' }),
  getAgentSessionMeta: () => undefined,
  updateAgentSessionMeta: () => {},
  listAgentSessions: () => [],
  getAgentSessionSDKMessages: () => [],
  forkAgentSession: async ({ sessionId }: { sessionId: string }) => ({ id: `forked-${sessionId}` }),
}))

let workspaceDir: string

// 把工作区文件目录指向 tmp，避免 getWorkspaceFilesDir 在真实 ~/.proma 下建目录/写文件。
mock.module('./config-paths', () => ({
  getWorkspaceFilesDir: () => workspaceDir,
}))

const {
  createSnapshot,
  listSnapshots,
  rollbackToSnapshot,
  linkFileSnapshot,
  hasFileSnapshot,
  describeSnapshotRecovery,
} = await import('./nanju-snapshot')
const { captureFileSnapshot } = await import('./nanju-file-snapshot')
type ProjectSnapshot = import('./nanju-snapshot').ProjectSnapshot

const WORKSPACE = 'tmp-workspace'
const PROJECT = 'p1'

let storageDir: string
let projectDir: string

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'nanju-snapshot-test-'))
  // 生产路径里 project-<id> 目录由工程创建流程建立；这里对齐预建，避免测试噪声。
  mkdirSync(join(workspaceDir, `project-${PROJECT}`), { recursive: true })
  projectDir = join(workspaceDir, 'engineering')
  storageDir = join(workspaceDir, 'file-snapshots')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'main.ts'), 'export const v = 1\n')
})

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
})

function snapshotsFile(): string {
  return join(workspaceDir, `project-${PROJECT}`, '_snapshots.json')
}

/** 直接写入一个「旧 fork 快照」元数据（无 fileSnapshotId 字段），模拟历史会话快照 */
function seedLegacySnapshot(): ProjectSnapshot {
  const legacy: ProjectSnapshot = {
    snapshotId: 1,
    projectId: PROJECT,
    timestamp: new Date().toISOString(),
    description: 'legacy fork',
    triggerType: 'confirm',
    sessionId: 's-1',
    forkedSessionId: 's-1-fork',
    isCurrent: true,
  }
  mkdirSync(join(workspaceDir, `project-${PROJECT}`), { recursive: true })
  writeFileSync(snapshotsFile(), JSON.stringify([legacy], null, 2))
  return legacy
}

/** 在 tmp storageDir 里真实捕获一个 W-D 文件快照，返回其 id */
function realFileSnapshot(): string {
  const cap = captureFileSnapshot(projectDir, storageDir)
  if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
  return cap.manifest.snapshotId
}

describe('场景：旧 fork 会话快照（无文件快照）不得声称可恢复工程文件', () => {
  test('缺 fileSnapshotId → fileRollback=false，描述明确「不恢复工程文件」，fork 元数据不当证据', () => {
    const legacy = seedLegacySnapshot()
    expect(hasFileSnapshot(legacy)).toBe(false)

    const cap = describeSnapshotRecovery(legacy)
    expect(cap.sessionRollback).toBe(true)
    expect(cap.fileRollback).toBe(false)
    expect(cap.fileSnapshotId).toBeNull()
    expect(cap.description).toContain('不恢复工程文件')

    // 已写入磁盘的旧快照读回后仍是 legacy 语义
    const [read] = listSnapshots(WORKSPACE, PROJECT)
    if (!read) throw new Error('应读到旧快照')
    expect(hasFileSnapshot(read)).toBe(false)
    expect(describeSnapshotRecovery(read).fileRollback).toBe(false)

    // 回滚只改会话 isCurrent，不改文件快照字段
    const rolled = rollbackToSnapshot(WORKSPACE, PROJECT, 1)
    if (!rolled) throw new Error('应能回滚')
    expect(hasFileSnapshot(rolled)).toBe(false)
    expect(describeSnapshotRecovery(rolled).fileRollback).toBe(false)
  })

  test('未知会话快照 id 回滚返回 null；link 对不存在会话快照返回 session-snapshot-missing 且不改数据', () => {
    seedLegacySnapshot()
    expect(rollbackToSnapshot(WORKSPACE, PROJECT, 999)).toBeNull()
    const linked = linkFileSnapshot(WORKSPACE, PROJECT, 999, 'fs-x', storageDir)
    expect(linked.ok).toBe(false)
    expect(linked.reason).toBe('session-snapshot-missing')
    const raw = JSON.parse(readFileSync(snapshotsFile(), 'utf-8')) as ProjectSnapshot[]
    expect(raw).toHaveLength(1)
    expect(raw[0]?.fileSnapshotId).toBeUndefined()
  })
})

describe('场景：S4 只有校验通过的真实文件快照才能声明可恢复', () => {
  test('createSnapshot 不接受文件快照参数：新建会话快照默认无文件恢复能力', async () => {
    const plain = await createSnapshot(WORKSPACE, PROJECT, 's-1', '会话快照')
    expect(hasFileSnapshot(plain)).toBe(false)
    expect(describeSnapshotRecovery(plain).fileRollback).toBe(false)
  })

  test('任意 UUID 关联 → file-snapshot-missing，hasFileSnapshot 仍为 false（不得冒称可恢复）', async () => {
    const created = await createSnapshot(WORKSPACE, PROJECT, 's-1', '会话快照')
    const linked = linkFileSnapshot(WORKSPACE, PROJECT, created.snapshotId, '00000000-0000-4000-8000-000000000000', storageDir)
    expect(linked.ok).toBe(false)
    expect(linked.reason).toBe('file-snapshot-missing')

    const [fromDisk] = listSnapshots(WORKSPACE, PROJECT)
    if (!fromDisk) throw new Error('应读到快照')
    expect(hasFileSnapshot(fromDisk)).toBe(false)
    expect(describeSnapshotRecovery(fromDisk).fileRollback).toBe(false)
    expect(describeSnapshotRecovery(fromDisk).description).toContain('不恢复工程文件')
  })

  test('非法 id（含路径分隔符）→ invalid-id，拒绝防逃逸', async () => {
    const created = await createSnapshot(WORKSPACE, PROJECT, 's-1', '会话快照')
    const linked = linkFileSnapshot(WORKSPACE, PROJECT, created.snapshotId, '../../etc/passwd', storageDir)
    expect(linked.ok).toBe(false)
    expect(linked.reason).toBe('invalid-id')
  })

  test('真实存在的 W-D 快照 → 关联成功且持久化，fileRollback=true', async () => {
    const created = await createSnapshot(WORKSPACE, PROJECT, 's-1', '会话快照')
    const fileSnapshotId = realFileSnapshot()
    const linked = linkFileSnapshot(WORKSPACE, PROJECT, created.snapshotId, fileSnapshotId, storageDir)
    expect(linked.ok).toBe(true)

    const [fromDisk] = listSnapshots(WORKSPACE, PROJECT)
    if (!fromDisk) throw new Error('应读到快照')
    expect(fromDisk.fileSnapshotId).toBe(fileSnapshotId)
    const cap = describeSnapshotRecovery(fromDisk)
    expect(cap.fileRollback).toBe(true)
    expect(cap.fileSnapshotId).toBe(fileSnapshotId)
    expect(cap.description).toContain('恢复工程文件')
  })
})
