/**
 * W-I B-c：工程文件快照生产接线网关 BDD。
 *
 * 覆盖 D-review-2 §5 的 I 侧硬约束：
 * - 三段式检查点：createSnapshot → captureFileSnapshot → linkFileSnapshot（S4 唯一写入路径）
 * - 捕获失败 fail-closed：会话快照仍在，但**不得**写 fileSnapshotId（不得让 UI 误称可恢复）
 * - S8：恢复不完整时文案含 notRestored 且不得声称完整
 * - S9：cross-device 给可行动提示（工程未改动）
 * - S10：占用统计 + 「不自动清理」口径
 * - 回滚语义：无文件快照时明确「只回滚会话分支，不恢复工程文件」
 *
 * 依赖隔离：agent-session-manager / config-paths stub；落盘仅在 mkdtempSync 临时目录。
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('./agent-session-manager', () => ({
  createAgentSession: () => ({ id: 'stub-session' }),
  getAgentSessionMeta: () => undefined,
  updateAgentSessionMeta: () => {},
  listAgentSessions: () => [],
  getAgentSessionSDKMessages: () => [],
  forkAgentSession: async ({ sessionId }: { sessionId: string }) => ({ id: `forked-${sessionId}` }),
}))

let workspaceDir: string
mock.module('./config-paths', () => ({
  getWorkspaceFilesDir: () => workspaceDir,
}))

const gw = await import('./nanju-project-snapshots')

const WORKSPACE = 'tmp-workspace'
const PROJECT = 'p1'
let projectDir: string

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'nanju-proj-snap-'))
  projectDir = join(workspaceDir, `project-${PROJECT}`)
  mkdirSync(join(projectDir, '08_APP'), { recursive: true })
  writeFileSync(join(projectDir, '08_APP', 'index.html'), '<html>v1</html>\n')
})

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe('B-c 存储位置与捕获', () => {
  test('storageDir 在工程目录之外（D 布局守卫）且可被捕获复用', () => {
    const storage = gw.getProjectFileSnapshotStorageDir(WORKSPACE, PROJECT)
    // 同头名称（project-p1 vs project-p1-file-snapshots）不是嵌套：按路径段判定
    expect(storage === projectDir || storage.startsWith(projectDir + '/')).toBe(false)
    expect(projectDir === storage || projectDir.startsWith(storage + '/')).toBe(false)
    const outcome = gw.captureProjectFileSnapshot(WORKSPACE, PROJECT, '[init] ')
    expect(outcome.ok).toBe(true)
    expect(typeof outcome.snapshotId).toBe('string')
    expect(outcome.message).toContain('文件快照已捕获')
    expect(outcome.snapshotDir).toBe(join(storage, 'snapshots', outcome.snapshotId as string))
  })

  test('工程目录不存在 → fail-closed 不返回 snapshotId 也不建快照目录', () => {
    const outcome = gw.captureProjectFileSnapshot(WORKSPACE, 'ghost')
    expect(outcome.ok).toBe(false)
    expect(outcome.snapshotId).toBeUndefined()
    expect(outcome.message).toContain('不创建文件恢复点')
  })
})

describe('B-c 三段式检查点（S4：fileSnapshotId 唯一写入路径）', () => {
  test('捕获成功 → 会话快照携带 fileSnapshotId 且描述含文件恢复承诺', async () => {
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-1', '进入开发前', 'pre-modify')
    expect(cp.fileSnapshotId).toBe(cp.fileCapture.snapshotId as string)
    expect(cp.snapshot.fileSnapshotId).toBe(cp.fileSnapshotId)
    expect(cp.message).toContain('会话分支 + 工程文件')
    const { describeSnapshotRecovery } = await import('./nanju-snapshot')
    expect(describeSnapshotRecovery(cp.snapshot).fileRollback).toBe(true)
  })

  test('捕获失败（存储目录不可写）→ 会话快照仍在但 fileSnapshotId 不写（fail-closed）', async () => {
    const { chmodSync } = await import('node:fs')
    // 让 workspace 只读：工程目录内仍可写（已有 +x 穿越），但 storageDir 无法创建 → 捕获 io-error
    chmodSync(workspaceDir, 0o500)
    try {
      const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-2', '基线', 'init')
      expect(cp.snapshot).toBeTruthy()
      expect(cp.fileCapture.ok).toBe(false)
      expect(cp.fileSnapshotId).toBeNull()
      expect(cp.snapshot.fileSnapshotId).toBeUndefined()
      expect(cp.message).toContain('不恢复工程文件')
      const { describeSnapshotRecovery } = await import('./nanju-snapshot')
      expect(describeSnapshotRecovery(cp.snapshot).fileRollback).toBe(false)
    } finally {
      chmodSync(workspaceDir, 0o700)
    }
  })

  test('S4 守卫：清单被篡改的捕获快照不得被关联为文件可恢复', async () => {
    const capture = gw.captureProjectFileSnapshot(WORKSPACE, PROJECT, '[tamper] ')
    expect(capture.ok).toBe(true)
    const storageDir = gw.getProjectFileSnapshotStorageDir(WORKSPACE, PROJECT)
    const manifestPath = join(storageDir, 'snapshots', capture.snapshotId as string, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { contentHash: string; entries: unknown[] }
    manifest.entries = manifest.entries ?? []
    manifest.contentHash = 'tampered-hash'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    const { createSnapshot, linkFileSnapshot, hasFileSnapshot } = await import('./nanju-snapshot')
    const snapshot = await createSnapshot(WORKSPACE, PROJECT, 'sess-tamper', '篡改', 'confirm')
    const linked = linkFileSnapshot(WORKSPACE, PROJECT, snapshot.snapshotId, capture.snapshotId as string, storageDir)
    expect(linked.ok).toBe(false)
    expect(linked.reason).toBe('file-snapshot-invalid')
    expect(linked.snapshot).toBeNull()
    const persisted = (await import('./nanju-snapshot')).listSnapshots(WORKSPACE, PROJECT).find((s) => s.snapshotId === snapshot.snapshotId)!
    expect(hasFileSnapshot(persisted)).toBe(false)
  })
})

describe('B-c 恢复（S8 完整性 / S9 跨设备 / S10 占用）', () => {
  test('S8：含符号链接的工程恢复后 complete=false 且文案列出 notRestored', async () => {
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-s8', '含链接', 'confirm')
    // 在快照之后新增符号链接：快照中无它，恢复后不得残留（且必须被报告为不可恢复项）
    symlinkSync(join(projectDir, '08_APP', 'index.html'), join(projectDir, '08_APP', 'link.html'))
    // 第二次捕获把符号链接计入 unrecoverable
    const cp2 = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-s8b', '含链接2', 'confirm')
    expect(cp2.fileCapture.message).toContain('符号链接')
    const outcome = gw.restoreProjectFileSnapshot(WORKSPACE, PROJECT, cp2.fileSnapshotId as string)
    expect(outcome.ok).toBe(true)
    expect(outcome.complete).toBe(false)
    expect(outcome.notRestored.length).toBeGreaterThan(0)
    expect(outcome.actionable).toBe(true)
    expect(outcome.userMessage).toContain('不完整')
    expect(outcome.userMessage).toContain('不得按「已完整恢复」处置')
    expect(cp.fileSnapshotId).toBeTruthy()
  })

  test('恢复完整时文案含备份占用与「不自动清理」', async () => {
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-ok', '完整恢复', 'confirm')
    writeFileSync(join(projectDir, '08_APP', 'index.html'), '<html>v2</html>\n')
    const outcome = gw.restoreProjectFileSnapshot(WORKSPACE, PROJECT, cp.fileSnapshotId as string)
    expect(outcome.ok).toBe(true)
    expect(outcome.complete).toBe(true)
    expect(outcome.actionable).toBe(false)
    expect(outcome.userMessage).toContain('已恢复完整')
    expect(outcome.userMessage).toContain('系统不自动清理备份')
    expect(readFileSync(join(projectDir, '08_APP', 'index.html'), 'utf-8')).toContain('v1')
  })

  test('S9：快照 id 非法/快照目录缺失 → 给可行动提示且不动工程', () => {
    writeFileSync(join(projectDir, '08_APP', 'index.html'), '<html>keep</html>\n')
    const outcome = gw.restoreProjectFileSnapshot(WORKSPACE, PROJECT, 'not-exist-id')
    expect(outcome.ok).toBe(false)
    expect(outcome.actionable).toBe(true)
    expect(outcome.userMessage).toContain('快照不可用')
    expect(readFileSync(join(projectDir, '08_APP', 'index.html'), 'utf-8')).toContain('keep')
  })

  test('S10：占用统计列出快照与备份数量/字节，且明确不自动清理', async () => {
    await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-fp', '占用', 'confirm')
    const fp = gw.describeSnapshotStorageFootprint(WORKSPACE, PROJECT)
    expect(fp.snapshotCount).toBe(1)
    expect(fp.snapshotBytes).toBeGreaterThan(0)
    expect(fp.storageDir).toBe(gw.getProjectFileSnapshotStorageDir(WORKSPACE, PROJECT))
    expect(fp.message).toContain('系统不会自动清理快照与备份')
  })

  test('无任何快照时占用统计为零且不抛错', () => {
    const fp = gw.describeSnapshotStorageFootprint(WORKSPACE, 'nope')
    expect(fp.snapshotCount).toBe(0)
    expect(fp.snapshotBytes).toBe(0)
    expect(existsSync(fp.storageDir)).toBe(false)
  })
})

describe('B-c 回滚语义（会话分支 vs 工程文件不得混说）', () => {
  test('已关联文件快照 → 回滚同时恢复工程文件', async () => {
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-rb', '回滚点', 'confirm')
    writeFileSync(join(projectDir, '08_APP', 'index.html'), '<html>changed</html>\n')
    const result = await gw.rollbackProjectSnapshot(WORKSPACE, PROJECT, cp.snapshot.snapshotId)
    expect(result.ok).toBe(true)
    expect(result.fileRestore?.ok).toBe(true)
    expect(readFileSync(join(projectDir, '08_APP', 'index.html'), 'utf-8')).toContain('v1')
    expect(result.message).toContain('已恢复完整')
  })

  test('未关联文件快照（legacy fork 快照）→ 明确只回滚会话分支', async () => {
    const { createSnapshot } = await import('./nanju-snapshot')
    const legacy = await createSnapshot(WORKSPACE, PROJECT, 'sess-legacy', '无文件快照', 'confirm')
    const result = await gw.rollbackProjectSnapshot(WORKSPACE, PROJECT, legacy.snapshotId)
    expect(result.ok).toBe(true)
    expect(result.fileRestore).toBeNull()
    expect(result.message).toContain('未关联工程文件快照')
    expect(result.message).toContain('请勿按「已恢复工程」处置')
  })

  test('快照不存在 → ok=false 且不抛错', async () => {
    const result = await gw.rollbackProjectSnapshot(WORKSPACE, PROJECT, 999)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('会话快照不存在')
  })
})

describe('B-d FileRollbackPort 薄壳（E 的 D 端口适配）', () => {
  test('capture 成功返回 D 的 UUID 字符串快照 id（原样透传，不做数值派生）', async () => {
    const port = gw.createProjectFileRollbackPort(WORKSPACE, PROJECT)
    const { snapshotId } = await port.capture('修复前 ')
    expect(typeof snapshotId).toBe('string')
    expect(snapshotId).toMatch(/^[0-9a-f-]{36}$/)
    expect(existsSync(join(gw.getProjectFileSnapshotStorageDir(WORKSPACE, PROJECT), 'snapshots', snapshotId))).toBe(true)
  })

  test('capture 失败必须抛错（不得静默成功）：工程目录缺失 → 抛错且原因可读', async () => {
    rmSync(projectDir, { recursive: true, force: true })
    const port = gw.createProjectFileRollbackPort(WORKSPACE, PROJECT)
    await expect(port.capture('修复前 ')).rejects.toThrow(/文件快照捕获失败/)
  })

  test('rollback 原样透传 D 结构结果：成功时 ok=true + restoredFiles + 备份目录', async () => {
    const port = gw.createProjectFileRollbackPort(WORKSPACE, PROJECT)
    const { snapshotId } = await port.capture('回滚点 ')
    writeFileSync(join(projectDir, '08_APP', 'index.html'), '<html>broken</html>\n')
    const result = await port.rollback(snapshotId)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.restoredFiles).toBeGreaterThan(0)
    expect(readFileSync(join(projectDir, '08_APP', 'index.html'), 'utf-8')).toContain('v1')
  })

  test('rollback 快照目录不可用 → ok=false + 语义 reason（不抛错、不碰工程）', async () => {
    const port = gw.createProjectFileRollbackPort(WORKSPACE, PROJECT)
    const result = await port.rollback('00000000-0000-4000-8000-000000000000')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('snapshot-missing')
    expect(result.compensated).toBe(false)
  })
})

describe('B-d 回滚目标选取（只认已关联文件快照的快照）', () => {
  test('无快照 → null（调用方据此 fileRollbackAvailable=false）', () => {
    expect(gw.resolveRepairRollbackSnapshot(WORKSPACE, PROJECT)).toBeNull()
  })

  test('存在 pre-modify 已关联快照 → 选它（本次修改前的健康态），标签取描述', async () => {
    await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-1', '项目初始化', 'init')
    const cp = await gw.createProjectCheckpoint(WORKSPACE, PROJECT, 'sess-1', '进入编码前', 'pre-modify')
    const target = gw.resolveRepairRollbackSnapshot(WORKSPACE, PROJECT)
    expect(target).not.toBeNull()
    expect(target!.snapshotId).toBe(cp.fileSnapshotId as string)
    expect(target!.label).toContain('进入编码前')
  })

  test('只有未关联文件快照的会话快照 → null（避免把「只切分支」说成能恢复工程）', async () => {
    const { createSnapshot } = await import('./nanju-snapshot')
    await createSnapshot(WORKSPACE, PROJECT, 'sess-1', '手工快照', 'confirm')
    expect(gw.resolveRepairRollbackSnapshot(WORKSPACE, PROJECT)).toBeNull()
  })
})
