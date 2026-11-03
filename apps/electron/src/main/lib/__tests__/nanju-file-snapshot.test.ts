/**
 * W-D：不可变工程文件快照与可恢复事务 — 引擎级 BDD 测试
 *
 * 全部场景仅在 mkdtempSync 临时目录 fixture 中执行真实复制/恢复/故障注入，
 * 绝不触及任何真实 Linux 工程、用户工程或 ~/.proma。
 *
 * 覆盖：
 * 1. 正常捕获：真实 copy 非 hardlink、清单 hash 与内容一致
 * 2. 捕获中源文件变更 → 拒绝并失败、staging 清理
 * 3. 排除规则：依赖 / 密钥 / 会话控制文件不入快照
 * 4. 正常恢复：工程回滚到快照内容，恢复前当前工程保留在备份目录
 * 5. 排除类文件跨恢复保留当前值（.env / node_modules 不被快照内容覆盖或丢失）
 * 6. 快照被篡改（hash 不符 / 路径逃逸）→ 恢复中止，当前工程原样保留
 * 7. 恢复后校验失败 → 失败补偿，工程回到恢复前状态
 * 8. 进程中断恢复：rename1 前崩溃 / rename1 后崩溃 / rename2 后崩溃
 * 9. 写失败（只读存储目录）→ 干净失败，无副作用
 * 10. 并发锁：已有活跃恢复事务时拒绝第二个恢复
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
  statSync, chmodSync, readdirSync, symlinkSync, utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const {
  captureFileSnapshot,
  restoreFileSnapshot,
  recoverInterruptedRestore,
  TestCrashError,
} = await import('../nanju-file-snapshot')

// ===== fixture 工具 =====

let root: string
let projectDir: string
let storageDir: string

function seedProject(): void {
  mkdirSync(join(projectDir, 'src', 'lib'), { recursive: true })
  mkdirSync(join(projectDir, 'node_modules', 'foo'), { recursive: true })
  mkdirSync(join(projectDir, 'keys'), { recursive: true })
  writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'v1'\n")
  writeFileSync(join(projectDir, 'src', 'lib', 'util.ts'), 'export const util = 1\n')
  writeFileSync(join(projectDir, 'README.md'), '# demo v1\n')
  writeFileSync(join(projectDir, '.env'), 'SECRET=v1\n')
  writeFileSync(join(projectDir, '.env.example'), 'SECRET=\n')
  writeFileSync(join(projectDir, 'node_modules', 'foo', 'index.js'), 'module.exports = 1\n')
  writeFileSync(join(projectDir, 'keys', 'server.pem'), '-----BEGIN KEY-----\n')
  writeFileSync(join(projectDir, '_snapshots.json'), '[]')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nanju-wd-fs-'))
  projectDir = join(root, 'project')
  storageDir = join(root, 'file-snapshots')
  mkdirSync(projectDir, { recursive: true })
  seedProject()
})

afterEach(() => {
  chmodSync(root, 0o700)
  rmSync(root, { recursive: true, force: true })
})

/** 读取工程内文件内容（断言用） */
function readProject(rel: string): string {
  return readFileSync(join(projectDir, rel), 'utf-8')
}

/** 对恢复成功结果做公共断言后返回备份目录 */
function expectRestoreOk(res: ReturnType<typeof restoreFileSnapshot>): string {
  if (!res.ok) throw new Error(`恢复应成功，实际失败: ${res.reason} ${res.message}`)
  return res.preRestoreBackupDir
}

// ===== 1. 正常捕获 =====

describe('场景：正常捕获生成不可变文件快照', () => {
  test('快照是真实拷贝：修改/删除源文件后快照内容不变，且 inode 不同（非 hardlink）', () => {
    const res = captureFileSnapshot(projectDir, storageDir)
    if (!res.ok) throw new Error(`捕获应成功: ${res.message}`)
    const snapIndex = join(res.snapshotDir, 'files', 'src', 'index.ts')

    // 真实拷贝：不同 inode，且写源后快照字节不变
    expect(statSync(snapIndex).ino).not.toBe(statSync(join(projectDir, 'src', 'index.ts')).ino)
    writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'MUTATED'\n")
    expect(readFileSync(snapIndex, 'utf-8')).toContain("'v1'")
    expect(readFileSync(join(res.snapshotDir, 'files', 'README.md'), 'utf-8')).toBe('# demo v1\n')
  })

  test('清单 hash 与磁盘文件一致，contentHash 可重算验证', () => {
    const res = captureFileSnapshot(projectDir, storageDir)
    if (!res.ok) throw new Error(`捕获应成功: ${res.message}`)
    const { manifest } = res
    expect(manifest.algorithm).toBe('sha256-v1')
    expect(manifest.entries.length).toBeGreaterThan(0)

    for (const entry of manifest.entries) {
      const bytes = readFileSync(join(res.snapshotDir, 'files', entry.path))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
      expect(statSync(join(res.snapshotDir, 'files', entry.path)).size).toBe(entry.size)
    }
    // 总哈希 = 排序后 path+hash 串联的 sha256
    const recalculated = createHash('sha256')
      .update(manifest.entries.map((e) => `${e.path}:${e.sha256}`).sort().join('\n'))
      .digest('hex')
    expect(manifest.contentHash).toBe(recalculated)
  })
})

// ===== 2. 捕获中变更拒绝 =====

describe('场景：捕获期间源文件被修改 → 拒绝并失败', () => {
  test('onProgress 注入变更：捕获中止、changedPaths 指明被改文件、无快照残留', () => {
    const res = captureFileSnapshot(projectDir, storageDir, {
      onProgress: (info) => {
        // README.md 复制完成后、src/index.ts 尚未复制时篡改源（改变长度确保 size 检出）
        if (info.file === 'README.md') {
          writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'CHANGED-DURING-CAPTURE-LONGER'\n")
        }
      },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('changed-during-capture')
    expect(res.changedPaths).toContain('src/index.ts')
    // staging 已清理，不产生可用快照。
    // 注意：storageDir/snapshots 属于固定布局目录（ensureStorageLayout 会预先创建），
    // 断言「无快照残留」必须看内容而非目录存在性，否则会因布局目录存在而误判。
    expect(readdirSync(join(storageDir, 'snapshots'))).toEqual([])
    const stagingNames = existsSync(join(storageDir, '_staging')) ? readdirSync(join(storageDir, '_staging')) : []
    expect(stagingNames.filter((name) => name.startsWith('capture-'))).toEqual([])
  })
})

// ===== 3. 排除规则 =====

describe('场景：依赖/密钥/会话控制文件不入快照', () => {
  test('清单与快照磁盘均不含排除项，但 .env.example 保留', () => {
    const res = captureFileSnapshot(projectDir, storageDir)
    if (!res.ok) throw new Error(`捕获应成功: ${res.message}`)
    const paths = res.manifest.entries.map((e) => e.path)
    expect(paths).toContain('src/index.ts')
    expect(paths).toContain('.env.example') // 模板不是密钥
    for (const banned of ['node_modules/foo/index.js', '.env', 'keys/server.pem', '_snapshots.json']) {
      expect(paths).not.toContain(banned)
      expect(existsSync(join(res.snapshotDir, 'files', banned))).toBe(false)
    }
    expect(res.manifest.excludedCount).toBeGreaterThan(0)
  })
})

// ===== 4. 正常恢复 =====

describe('场景：正常恢复到快照内容，恢复前当前工程保留', () => {
  test('恢复后工程回到快照内容；恢复前状态（含新增文件）完整保留在备份目录', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)

    // 当前工程继续演化：改内容、删文件、加新文件
    writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'v2-advanced'\n")
    rmSync(join(projectDir, 'README.md'))
    writeFileSync(join(projectDir, 'NEW.txt'), 'brand new\n')

    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    const backupDir = expectRestoreOk(res)

    // 工程回到快照内容
    expect(readProject('src/index.ts')).toContain("'v1'")
    expect(readProject('README.md')).toBe('# demo v1\n')
    expect(existsSync(join(projectDir, 'NEW.txt'))).toBe(false)
    expect(readProject('src/lib/util.ts')).toBe('export const util = 1\n')

    // 恢复前当前工程保留：v2 内容、删除的 README 不在、新增 NEW.txt 在
    expect(readFileSync(join(backupDir, 'files', 'src', 'index.ts'), 'utf-8')).toContain('v2-advanced')
    expect(existsSync(join(backupDir, 'files', 'README.md'))).toBe(false)
    expect(readFileSync(join(backupDir, 'files', 'NEW.txt'), 'utf-8')).toBe('brand new\n')
    expect(existsSync(backupDir)).toBe(true) // 备份不被自动删除
  })
})

// ===== 5. 排除类文件跨恢复保留当前值 =====

describe('场景：排除类文件（密钥/依赖）跨恢复保留当前值', () => {
  test('恢复后 .env 与 node_modules 是恢复前的当前内容，不来自快照也不丢失', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)

    // 当前工程中密钥轮转 + 依赖变化
    writeFileSync(join(projectDir, '.env'), 'SECRET=v2-rotated\n')
    writeFileSync(join(projectDir, 'node_modules', 'foo', 'index.js'), 'module.exports = 2\n')

    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expectRestoreOk(res)
    expect(readProject('.env')).toBe('SECRET=v2-rotated\n')
    expect(readProject('node_modules/foo/index.js')).toBe('module.exports = 2\n')
    expect(readProject('src/index.ts')).toContain("'v1'") // 受管内容回滚
  })
})

// ===== 6. 快照被篡改 → 中止且不动当前工程 =====

describe('场景：快照损坏或被篡改 → 恢复中止，当前工程原样保留', () => {
  test('快照文件内容被改写（hash 不符）→ 中止，工程保持当前内容', () => {
    writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'v2-precious'\n")
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)

    writeFileSync(join(cap.snapshotDir, 'files', 'src', 'index.ts'), 'TAMPERED\n')
    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('hash-mismatch')
    // 当前工程一个字节都没动
    expect(readProject('src/index.ts')).toContain('v2-precious')
  })

  test('清单被篡改含路径逃逸（../）→ unsafe-path 拒绝，工程原样保留', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    const manifestPath = join(cap.snapshotDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { entries: Array<{ path: string; sha256: string; size: number; mode: number }> }
    manifest.entries.push({ path: '../../../escape.txt', sha256: '0'.repeat(64), size: 3, mode: 0o644 })
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('unsafe-path')
    expect(existsSync(join(root, 'escape.txt'))).toBe(false)
    expect(readProject('src/index.ts')).toContain("'v1'")
  })

  test('快照目录不存在 → snapshot-missing，工程原样保留', () => {
    const res = restoreFileSnapshot(join(storageDir, 'snapshots', 'nope'), projectDir, storageDir)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('snapshot-missing')
    expect(readProject('src/index.ts')).toContain("'v1'")
  })
})

// ===== 7. 恢复后校验失败 → 失败补偿 =====

describe('场景：恢复落位后校验失败 → 失败补偿回滚到恢复前状态', () => {
  test('补偿后工程与恢复前逐字节一致，journal 记录 compensated', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    writeFileSync(join(projectDir, 'PENDING-WORK.txt'), 'unsaved\n')

    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir, {
      injectFault: (point) => { if (point === 'force-restore-verify-fail') throw new Error('forced verify failure') },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('restore-verify-failed')
    expect(res.compensated).toBe(true)
    // 工程回到恢复前状态：受管文件与未保存新增文件都在
    expect(readProject('src/index.ts')).toContain("'v1'")
    expect(readProject('PENDING-WORK.txt')).toBe('unsaved\n')
    expect(readProject('.env')).toBe('SECRET=v1\n')
  })
})

// ===== 8. 进程中断恢复 =====

describe('场景：进程在恢复事务中途崩溃 → 下次 recover 可恢复/可清理', () => {
  test('rename1 之前崩溃（备份后）：工程未动，recover 清理 staging 并报告 aborted-clean', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'v2-live'\n")

    expect(() =>
      restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir, {
        injectFault: (point) => { if (point === 'after-backup') throw new TestCrashError('模拟进程死亡') },
      }),
    ).toThrow(TestCrashError)
    // 工程未动，staging 残留
    expect(readProject('src/index.ts')).toContain('v2-live')
    expect(existsSync(join(storageDir, '_staging'))).toBe(true)

    const rec = recoverInterruptedRestore(projectDir, storageDir)
    expect(rec.ok).toBe(true)
    expect(rec.action).toBe('aborted-clean')
    expect(readProject('src/index.ts')).toContain('v2-live')
    expect(existsSync(join(storageDir, '_staging'))).toBe(false)
    // 清理后可再次正常恢复
    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expectRestoreOk(res)
    expect(readProject('src/index.ts')).toContain("'v1'")
  })

  test('rename1 之后、rename2 之前崩溃：工程目录缺失，recover 完成恢复并保留备份', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'v2-live'\n")

    expect(() =>
      restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir, {
        injectFault: (point) => { if (point === 'after-current-moved') throw new TestCrashError('模拟进程死亡') },
      }),
    ).toThrow(TestCrashError)
    // 崩溃现场：工程目录缺失（两 rename 非原子的真实窗口）
    expect(existsSync(projectDir)).toBe(false)

    const rec = recoverInterruptedRestore(projectDir, storageDir)
    expect(rec.ok).toBe(true)
    expect(rec.action).toBe('completed-restore')
    expect(readProject('src/index.ts')).toContain("'v1'")
    expect(readProject('.env')).toBe('SECRET=v2-rotated-never\n'.replace('v2-rotated-never', 'v1'))
    expect(existsSync(join(storageDir, '_trash'))).toBe(false)
  })

  test('rename2 之后崩溃：工程已是快照内容，recover 清理 trash 报告 completed-restore', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'v2-live'\n")

    expect(() =>
      restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir, {
        injectFault: (point) => { if (point === 'after-restore-moved') throw new TestCrashError('模拟进程死亡') },
      }),
    ).toThrow(TestCrashError)
    expect(readProject('src/index.ts')).toContain("'v1'") // 新内容已就位
    expect(existsSync(join(storageDir, '_trash'))).toBe(true)

    const rec = recoverInterruptedRestore(projectDir, storageDir)
    expect(rec.ok).toBe(true)
    expect(rec.action).toBe('completed-restore')
    expect(readProject('src/index.ts')).toContain("'v1'")
    expect(existsSync(join(storageDir, '_trash'))).toBe(false)
  })

  test('无中断残留时 recover 报告 nothing-to-recover 且不动工程', () => {
    const rec = recoverInterruptedRestore(projectDir, storageDir)
    expect(rec.ok).toBe(true)
    expect(rec.action).toBe('nothing-to-recover')
    expect(readProject('src/index.ts')).toContain("'v1'")
  })
})

// ===== 9. 写失败 =====

describe('场景：存储目录只读 → 捕获/恢复干净失败', () => {
  test('捕获阶段 staging 无法创建 → io-error，源工程未动', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // root 下 chmod 0o500 无法制造 EACCES：改用真实文件系统故障
      // （存储路径被普通文件占据 → 在其中创建 snapshots/_staging 必然 ENOTDIR/EEXIST）。
      writeFileSync(storageDir, 'not-a-directory\n')
    } else {
      mkdirSync(storageDir, { recursive: true })
      chmodSync(storageDir, 0o500) // 只读：无法在其中创建 snapshots/_staging
    }
    const res = captureFileSnapshot(projectDir, storageDir)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('io-error')
    expect(readProject('src/index.ts')).toContain("'v1'")
  })

  test('恢复阶段备份无法写入 → 中止，当前工程未动', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return
    }
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'v2-precious'\n")
    chmodSync(storageDir, 0o500)
    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    chmodSync(storageDir, 0o700)
    expect(res.ok).toBe(false)
    expect(readProject('src/index.ts')).toContain('v2-precious')
  })
})

// ===== 10. 并发锁 =====

describe('场景：已有活跃恢复事务 → 第二个恢复被锁拒绝', () => {
  test('持锁方 pid 存活时 restore 返回 locked；pid 已死时接管并先 recover', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)

    // 活跃锁（当前测试进程 pid 存活）
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(join(storageDir, '_restore.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    const locked = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expect(locked.ok).toBe(false)
    if (!locked.ok) expect(locked.reason).toBe('locked')

    // 陈旧锁（不可能存活的 pid）
    writeFileSync(join(storageDir, '_restore.lock'), JSON.stringify({ pid: 2_147_000_000, startedAt: new Date().toISOString() }))
    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expectRestoreOk(res)
    expect(readProject('src/index.ts')).toContain("'v1'")
  })
})

// ===== 附：目录与产物形状 =====

describe('场景：产物形状稳定（供 D2/集成消费）', () => {
  test('storageDir 只含 snapshots/_staging/_pre-restore-backups 与 journal，快照目录含 manifest.json+files/', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    expect(readdirSync(join(cap.snapshotDir)).sort()).toEqual(['files', 'manifest.json'])
    writeFileSync(join(projectDir, 'src', 'index.ts'), 'x\n')
    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    const backup = expectRestoreOk(res)
    expect(readdirSync(backup).sort()).toEqual(['files', 'manifest.json'])
    // journal 已提交收尾
    const journalText = readFileSync(join(storageDir, '_restore-journal.json'), 'utf-8')
    expect(JSON.parse(journalText)).toMatchObject({ phase: 'committed' })
  })
})

// ===== D4 轮补测：D-review / D-review-2 要求的 S1–S11 行为锁定（只增不重写） =====

/** 读 journal 对象 */
function readJournalObj(): { phase?: string } {
  return JSON.parse(readFileSync(join(storageDir, '_restore-journal.json'), 'utf-8')) as { phase?: string }
}

describe('场景 S1：恢复锁在所有出口都被自己释放，且不误删他人锁', () => {
  test('补偿成功后 _restore.lock 已释放，同进程第二次 restore 不再返回 locked', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    writeFileSync(join(projectDir, 'PENDING.txt'), 'wip\n')

    const first = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir, {
      injectFault: (point) => {
        if (point === 'force-restore-verify-fail') throw new Error('forced verify fail')
      },
    })
    expect(first.ok).toBe(false)
    if (first.ok) return
    expect(first.compensated).toBe(true)
    // 补偿路径已进入破坏性阶段，锁必须在 finally 中被释放
    expect(existsSync(join(storageDir, '_restore.lock'))).toBe(false)

    // 同进程立刻第二次恢复：若锁泄漏会拿到 locked，这里必须能正常完成
    const second = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expectRestoreOk(second)
    expect(readProject('src/index.ts')).toContain("'v1'")
  })

  test('早期被他人活跃锁拒绝时不删除他人锁（token 不被误清）', () => {
    mkdirSync(storageDir, { recursive: true })
    const lockFile = join(storageDir, '_restore.lock')
    const foreign = { pid: process.pid, startedAt: new Date().toISOString(), token: 'other-owner' }
    writeFileSync(lockFile, JSON.stringify(foreign))

    const res = restoreFileSnapshot(join(storageDir, 'snapshots', 'does-not-exist'), projectDir, storageDir)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('locked')
    // 他人的锁文件原样保留
    const onDisk = JSON.parse(readFileSync(lockFile, 'utf-8')) as { token?: string }
    expect(onDisk.token).toBe('other-owner')
  })
})

describe('场景 S2：Proma 控制状态文件不入快照，恢复不回滚当前控制状态', () => {
  test('_project-info.json / _repair-log.json（含 .bak）不进清单不进快照，恢复后保持当前值', () => {
    const infoPath = join(projectDir, '_project-info.json')
    const repairPath = join(projectDir, '_repair-log.json')
    writeFileSync(infoPath, JSON.stringify({ phaseGuards: { coded: { failCount: 1 } } }))
    writeFileSync(repairPath, JSON.stringify({ attempts: [1] }))
    writeFileSync(join(projectDir, '_project-info.json.bak'), '{"phaseGuards":{}}')
    writeFileSync(join(projectDir, '_regression-audit.jsonl'), '{"round":1}\n')

    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    const paths = cap.manifest.entries.map((e) => e.path)
    const banned = ['_project-info.json', '_project-info.json.bak', '_repair-log.json', '_regression-audit.jsonl', '_snapshots.json']
    for (const name of banned) {
      expect(paths).not.toContain(name)
      expect(existsSync(join(cap.snapshotDir, 'files', name))).toBe(false)
    }

    // 运行期推进：修复预算 + phaseGuard 计数变化
    writeFileSync(infoPath, JSON.stringify({ phaseGuards: { coded: { failCount: 9 } } }))
    writeFileSync(repairPath, JSON.stringify({ attempts: [1, 2, 3] }))

    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expectRestoreOk(res)
    expect(JSON.parse(readProject('_project-info.json'))).toMatchObject({ phaseGuards: { coded: { failCount: 9 } } })
    expect(JSON.parse(readProject('_repair-log.json'))).toEqual({ attempts: [1, 2, 3] })
  })
})

describe('场景 S3：projectDir / storageDir 布局非法 → invalid-layout fail-closed 且无写入残留', () => {
  test('storageDir 嵌套在 projectDir 内：capture/restore/recover 全部 invalid-layout，不创建 staging/journal', () => {
    const nested = join(projectDir, '.file-snapshots')

    const cap = captureFileSnapshot(projectDir, nested)
    expect(cap.ok).toBe(false)
    if (cap.ok) return
    expect(cap.reason).toBe('invalid-layout')
    expect(existsSync(nested)).toBe(false)
    expect(existsSync(join(nested, '_staging'))).toBe(false)
    expect(existsSync(join(nested, '_restore-journal.json'))).toBe(false)

    // 用合法快照目录调用 restore，但存储指向嵌套路径 → 必须在任何写入前拒绝
    const good = captureFileSnapshot(projectDir, storageDir)
    if (!good.ok) throw new Error(`捕获应成功: ${good.message}`)
    const res = restoreFileSnapshot(good.snapshotDir, projectDir, nested)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('invalid-layout')
    expect(existsSync(join(nested, '_staging'))).toBe(false)
    expect(existsSync(join(nested, '_restore-journal.json'))).toBe(false)
    expect(readProject('src/index.ts')).toContain("'v1'")

    const rec = recoverInterruptedRestore(projectDir, nested)
    expect(rec.ok).toBe(false)
    expect(rec.action).toBe('invalid-layout')
  })

  test('projectDir 与 storageDir 同址：capture/restore 拒绝，工程不受影响', () => {
    const cap = captureFileSnapshot(projectDir, projectDir)
    expect(cap.ok).toBe(false)
    if (cap.ok) return
    expect(cap.reason).toBe('invalid-layout')
    expect(existsSync(join(projectDir, '_restore-journal.json'))).toBe(false)

    const good = captureFileSnapshot(projectDir, storageDir)
    if (!good.ok) throw new Error(`捕获应成功: ${good.message}`)
    writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'v2'\n")
    const res = restoreFileSnapshot(good.snapshotDir, projectDir, projectDir)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('invalid-layout')
    // 拒绝发生在任何移动之前：工程保持当前内容
    expect(readProject('src/index.ts')).toContain("'v2'")
  })
})

describe('场景 S5：陈旧锁被接管而非永久 locked', () => {
  test('锁内 procStart 与当前进程不符（pid 被复用）→ 接管并完成恢复', () => {
    if (process.platform !== 'linux') return // 依赖 /proc/<pid>/stat
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(join(storageDir, '_restore.lock'), JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), token: 'old-owner', procStart: '0',
    }))
    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expectRestoreOk(res)
    expect(existsSync(join(storageDir, '_restore.lock'))).toBe(false)
  })

  test('锁超过 TTL（pid 存活但 startedAt 过旧）→ 接管并完成恢复', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(join(storageDir, '_restore.lock'), JSON.stringify({
      pid: process.pid, startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(), token: 'old-owner',
    }))
    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expectRestoreOk(res)
    expect(existsSync(join(storageDir, '_restore.lock'))).toBe(false)
  })
})

describe('场景 S6：rename2 完成但 journal 未更新窗口（掉电）→ recover 判已完成', () => {
  test('故障点 after-restore-rename-before-journal：落位已发生，recover 报 completed-restore 且清 trash', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    writeFileSync(join(projectDir, 'src', 'index.ts'), "export const v = 'v2-live'\n")

    expect(() =>
      restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir, {
        injectFault: (point) => {
          if (point === 'after-restore-rename-before-journal') throw new TestCrashError('模拟掉电')
        },
      }),
    ).toThrow(TestCrashError)

    // rename2 已发生：工程已是快照内容，staging 消失，trash 仍在，journal 仍停在 current-moved
    expect(readProject('src/index.ts')).toContain("'v1'")
    const stagingLeft = existsSync(join(storageDir, '_staging'))
      ? readdirSync(join(storageDir, '_staging')).filter((n) => n.startsWith('restore-'))
      : []
    expect(stagingLeft).toEqual([])
    expect(readdirSync(join(storageDir, '_trash')).length).toBeGreaterThan(0)
    expect(readJournalObj().phase).toBe('current-moved')

    const rec = recoverInterruptedRestore(projectDir, storageDir)
    expect(rec.ok).toBe(true)
    expect(rec.action).toBe('completed-restore')
    expect(readProject('src/index.ts')).toContain("'v1'")
    expect(existsSync(join(storageDir, '_trash'))).toBe(false)
  })
})

describe('场景 S7：同 size 同 mtime 的内容变更被 sha256 二次比对检出', () => {
  test('把已处理文件改成等长内容并还原 mtime → changed-during-capture 而非静默放过', () => {
    const target = join(projectDir, 'README.md')
    const st = statSync(target)
    const res = captureFileSnapshot(projectDir, storageDir, {
      onProgress: (info) => {
        if (info.file === 'README.md') {
          writeFileSync(target, '# DEMO v1\n') // 与 '# demo v1\n' 等长
          utimesSync(target, st.atime, st.mtime) // 还原 mtime，使 stat 比对无法察觉
        }
      },
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('changed-during-capture')
    expect(res.changedPaths).toContain('README.md')
    // 失败后无快照残留
    const snaps = existsSync(join(storageDir, 'snapshots')) ? readdirSync(join(storageDir, 'snapshots')) : []
    expect(snaps).toEqual([])
  })
})

describe('场景 S8：symlink 不入快照且列入不可恢复清单，恢复语义不夸大', () => {
  test('manifest.unrecoverable 记录 symlink；restore 返回 notRestored 且 complete=false', () => {
    symlinkSync('README.md', join(projectDir, 'link-to-readme'))

    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    const entry = cap.manifest.unrecoverable.find((u) => u.path === 'link-to-readme')
    expect(entry?.kind).toBe('symlink')
    expect(cap.manifest.symlinksSkipped).toBeGreaterThan(0)
    expect(cap.manifest.entries.map((e) => e.path)).not.toContain('link-to-readme')

    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    if (!res.ok) throw new Error(`恢复应成功: ${res.reason} ${res.message}`)
    expect(res.notRestored).toContain('link-to-readme')
    expect(res.complete).toBe(false)
    expect(existsSync(join(projectDir, 'link-to-readme'))).toBe(false)
  })
})

describe('场景 S9：projectDir 与 storageDir 跨文件系统 → restore 明确 cross-device 拒绝', () => {
  test('跨设备 rename 不静默降级；无第二文件系统时跳过（Linux 上 /dev/shm 常为 tmpfs）', () => {
    const alt = '/dev/shm'
    if (!existsSync(alt)) return
    if (statSync(alt).dev === statSync(tmpdir()).dev) return

    const altRoot = mkdtempSync(join(alt, 'nanju-wd-xdev-'))
    try {
      const altStorage = join(altRoot, 'file-snapshots')
      // 捕获（不同 fs 也可完成，staging→snapshots 同源 fs）
      const cap = captureFileSnapshot(projectDir, altStorage)
      if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
      const res = restoreFileSnapshot(cap.snapshotDir, projectDir, altStorage)
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toBe('cross-device')
      // 拒绝发生在任何移动之前
      expect(readProject('src/index.ts')).toContain("'v1'")
    } finally {
      rmSync(altRoot, { recursive: true, force: true })
    }
  })
})

describe('场景 S10：备份为全量（含 node_modules/.git）且返回 backupSizeBytes，不自动删除', () => {
  test('恢复前备份包含依赖与 .git，结果携带 backupSizeBytes，备份目录保留', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    mkdirSync(join(projectDir, '.git'), { recursive: true })
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    const backup = expectRestoreOk(res)
    if (!res.ok) return
    expect(res.backupSizeBytes).toBeGreaterThan(0)
    expect(existsSync(join(backup, 'files', 'node_modules', 'foo', 'index.js'))).toBe(true)
    expect(existsSync(join(backup, 'files', '.git', 'HEAD'))).toBe(true)
    expect(existsSync(backup)).toBe(true)
  })
})

describe('场景 S11：清单 contentHash 与实际 entries 自洽性校验', () => {
  test('篡改 entries（重复条目使文件 hash 仍过）→ contentHash 不符被拒', () => {
    const cap = captureFileSnapshot(projectDir, storageDir)
    if (!cap.ok) throw new Error(`捕获应成功: ${cap.message}`)
    const manifestPath = join(cap.snapshotDir, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      entries: Array<{ path: string; sha256: string; size: number; mode: number }>
    }
    const first = manifest.entries[0]
    if (!first) throw new Error('清单应至少含一个条目')
    manifest.entries.push({ ...first }) // 文件级 hash 仍能通过，但 contentHash 不再自洽
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const res = restoreFileSnapshot(cap.snapshotDir, projectDir, storageDir)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('hash-mismatch')
    expect(res.message).toContain('contentHash')
    expect(readProject('src/index.ts')).toContain("'v1'")
  })
})
