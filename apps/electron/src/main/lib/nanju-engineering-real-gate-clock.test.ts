/**
 * NEXT-01（Phase 2，缺陷 P1-3）：交付验收**双阶段见证时钟**测试。
 *
 * BDD 覆盖（蓝图 §2.2/§2.3 契约）：
 * - 纯函数层（nanju-engineering-witness-clock）：指纹排除规则、冻结前置校验、
 *   两阶段时钟判定（篡改立即 STALE / 15min 机器窗 / 24h 租约）；
 * - 集成层（nanju-engineering-real-gate）：见证登记流程（人证登记 → 锚定 → 冻结）→ 交付门全链路、
 *   篡改拦截、消费后时钟终结、cleanup 清理、观察期不受冻结影响、旧路径向后兼容。
 *
 * 隔离：全部用 tmpdir 临时目录，不触碰线上 ~/.proma 真实路径；
 * registry/时钟单例按 projectId 隔离（每个用例独立 projectId + 结尾 reset）。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  MACHINE_WITNESS_TTL_MS,
  HUMAN_HOLD_LEASE_MS,
  computeProjectArtifactDigest,
  freezeWitnessForHumanConfirmation,
  verifyWitnessFreshness,
} = await import('./nanju-engineering-witness-clock')
const {
  __resetEngineeringRealGateForTests,
  beginWitnessClockForDelivery,
  cleanupEngineeringRealEvidence,
  commitDeliveryRealEvidence,
  freezeWitnessClockForDelivery,
  peekWitnessClockForTests,
  registerSessionHumanWitnessEvidence,
  resolveSuiteRealEvidence,
} = await import('./nanju-engineering-real-gate')

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

/** 纯函数层用：最小项目目录（一个业务产物文件）。 */
function makeDigestFixture(): { projectDir: string; cleanup: () => void } {
  const projectDir = mkdtempSync(join(tmpdir(), 'witness-clock-digest-'))
  mkdirSync(join(projectDir, '08_APP'), { recursive: true })
  writeFileSync(join(projectDir, '08_APP/index.html'), '<html>交付产物</html>')
  return { projectDir, cleanup: () => { try { rmSync(projectDir, { recursive: true, force: true }) } catch { /* 忽略 */ } } }
}

/** 纯函数层用：构造一条 execution_active 见证时钟记录（锚定指纹 = 建档时刻指纹）。 */
function makeRecord(projectDir: string, witnessedAt: number, projectId = 'wp-1'): {
  projectId: string
  sessionId: string
  witnessedAt: number
  artifactDigest: string
  clockPhase: 'execution_active' | 'awaiting_human_confirm'
} {
  return {
    projectId,
    sessionId: 'ws-1',
    witnessedAt,
    artifactDigest: computeProjectArtifactDigest(projectDir),
    clockPhase: 'execution_active',
  }
}

/** 集成层用：完整工程 fixture（契约 + PRD + 产物），与 witness 测试同型。 */
let seq = 0
function makeGateFixture() {
  const projectDir = mkdtempSync(join(tmpdir(), 'witness-clock-gate-'))
  for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(projectDir, sub))
  writeFileSync(join(projectDir, '01_PRD/prd.md'), '# PRD\nUS-01 输出结果')
  writeFileSync(join(projectDir, '08_APP/app'), '#!/bin/sh\necho ok')
  writeFileSync(join(projectDir, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
    schemaVersion: 1,
    target: { kind: 'cli', platform: 'Linux', entry: 'app' },
    artifacts: ['app'], build: 'fixture', run: 'fixture',
    tests: [{ id: 't1', layer: 'acceptance', adapter: 'cli-driver', target: 'app', command: '真实CLI', covers: ['US-01'], requiresReal: true }],
  }))
  const projectId = `witness-clock-fixture-${Date.now()}-${seq++}`
  const sessionId = `sess-clock-${seq}`
  return {
    scope: { workspaceSlug: 'ws-clock', projectId, sessionId, projectDir },
    tests: [{ testId: 't1', target: 'app', covers: ['US-01'] }] as Array<{ testId: string; target: string; covers: string[] }>,
    projectDir,
    cleanup: () => { try { rmSync(projectDir, { recursive: true, force: true }) } catch { /* 忽略 */ } },
  }
}

/** 等待文件系统 mtime 分辨率推进（避免同毫秒写入被指纹视为未变化）。 */
async function tickFs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 12))
}

afterEach(() => {
  __resetEngineeringRealGateForTests()
})

/* ------------------------------------------------------------------ */
/* 产物指纹：computeProjectArtifactDigest                               */
/* ------------------------------------------------------------------ */

describe('Given 项目目录 When 计算产物指纹 Then 运行期文件被排除、业务产物必计入', () => {
  test('排除清单内文件变化不改变指纹（_project-info.json/_snapshots.json/_telemetry*/隐藏/node_modules）', () => {
    const f = makeDigestFixture()
    try {
      const before = computeProjectArtifactDigest(f.projectDir)
      writeFileSync(join(f.projectDir, '_project-info.json'), '{"deliveryAck":true}')
      writeFileSync(join(f.projectDir, '_snapshots.json'), '{"snap":2}')
      mkdirSync(join(f.projectDir, '_telemetry'))
      writeFileSync(join(f.projectDir, '_telemetry/events-2026-11.jsonl'), 'event')
      mkdirSync(join(f.projectDir, '.git'))
      writeFileSync(join(f.projectDir, '.git/HEAD'), 'ref')
      mkdirSync(join(f.projectDir, 'node_modules/pkg'), { recursive: true })
      writeFileSync(join(f.projectDir, 'node_modules/pkg/index.js'), 'x')
      expect(computeProjectArtifactDigest(f.projectDir)).toBe(before)
    } finally {
      f.cleanup()
    }
  })

  test('交付产物被修改（内容变化）指纹必变', async () => {
    const f = makeDigestFixture()
    try {
      const before = computeProjectArtifactDigest(f.projectDir)
      await tickFs()
      writeFileSync(join(f.projectDir, '08_APP/index.html'), '<html>被篡改的产物</html>')
      expect(computeProjectArtifactDigest(f.projectDir)).not.toBe(before)
    } finally {
      f.cleanup()
    }
  })

  test('深度超过 5 层的文件不计入指纹；目录缺失返回确定值', () => {
    const f = makeDigestFixture()
    try {
      const before = computeProjectArtifactDigest(f.projectDir)
      // deep-file 位于 projectDir/08_APP/a/b/c/d/e/f/（第 7 层）——递归在 depth=5 后剪枝，不计入
      const deep = join(f.projectDir, '08_APP/a/b/c/d/e/f')
      mkdirSync(deep, { recursive: true })
      writeFileSync(join(deep, 'deep-file.txt'), '深处文件（depth 超限，不计入）')
      expect(computeProjectArtifactDigest(f.projectDir)).toBe(before)
      // 不存在的目录返回空目录哈希（确定值，不抛错）
      expect(computeProjectArtifactDigest(join(f.projectDir, '不存在的目录'))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    } finally {
      f.cleanup()
    }
  })

  test('构建产物/依赖目录（dist/build/venv/target/__pycache__）不计入指纹（A-6）', () => {
    const f = makeDigestFixture()
    try {
      const before = computeProjectArtifactDigest(f.projectDir)
      for (const dir of ['dist', 'build', 'venv', 'target', '__pycache__']) {
        mkdirSync(join(f.projectDir, dir, 'nested'), { recursive: true })
        writeFileSync(join(f.projectDir, dir, 'nested/artifact.bin'), '构建产物不应卡指纹遍历')
      }
      expect(computeProjectArtifactDigest(f.projectDir)).toBe(before)
    } finally {
      f.cleanup()
    }
  })

  test('G6：模拟交付确认登记写盘（setProjectDeliveryAck 同型写 _project-info.json）后指纹不变', () => {
    const f = makeDigestFixture()
    try {
      const before = computeProjectArtifactDigest(f.projectDir)
      // 与 setProjectDeliveryAck → writeProjectInfo 同型：原子写 _project-info.json
      // （含 deliveryAck/deliveryChallenge/phaseGuards 等运行期字段更新）
      writeFileSync(join(f.projectDir, '_project-info.json'), JSON.stringify({
        deliveryAck: { at: '2026-11-03T01:30:00.000Z', reportRunId: 'run-1', rewritten: false },
        phaseGuards: { testing: { failCount: 1, errorCount: 0 } },
        currentStage: 'testing',
      }))
      expect(computeProjectArtifactDigest(f.projectDir)).toBe(before)
    } finally {
      f.cleanup()
    }
  })
})

/* ------------------------------------------------------------------ */
/* A-1（审查 REQUIRED）：保留窗×容量失配压力测试                            */
/* ------------------------------------------------------------------ */

describe('Given 24h 租约级保留窗 When 长会话 70 次连续登记 Then 不耗尽容量（无 capacity-exceeded）', () => {
  test('70 次人证登记全部成功（票据/条目容量 256，短窗票据回收）', async () => {
    const f = makeGateFixture()
    try {
      // 真实时钟下连续登记 70 轮（同 testId：覆盖 activeByTestId，entries 表累积，
      // 与审查复现脚本「rounds=100 gap=16min」等效的容量压力——年龄均为 0 不触发回收）
      for (let round = 0; round < 70; round++) {
        const witness = await registerSessionHumanWitnessEvidence(
          f.scope, f.tests, async () => ({ allowed: true, requestId: `req-capacity-${round}` }),
        )
        if (!witness.ok) {
          throw new Error(`第 ${round + 1} 轮登记失败：${witness.message}（疑似 capacity-exceeded）`)
        }
      }
      // 全部登记成功后观察期仍可用（最新记录在场）
      const suite = resolveSuiteRealEvidence(f.scope, f.tests)
      expect(suite.rejections).toEqual([])
    } finally {
      f.cleanup()
    }
  })
})

/* ------------------------------------------------------------------ */
/* 冻结：freezeWitnessForHumanConfirmation                              */
/* ------------------------------------------------------------------ */

describe('Given 发起交付确认询问 When 冻结见证时钟 Then 校验指纹与机器窗口', () => {
  test('指纹一致且在 15 分钟内 → 转入 awaiting_human_confirm 并起租', () => {
    const f = makeDigestFixture()
    try {
      const t0 = 1_000_000
      const record = makeRecord(f.projectDir, t0)
      const result = freezeWitnessForHumanConfirmation(record, f.projectDir, t0 + 5 * 60_000)
      expect(result.ok).toBe(true)
      expect(result.updated?.clockPhase).toBe('awaiting_human_confirm')
      expect(result.updated?.holdStartedAt).toBe(t0 + 5 * 60_000)
    } finally {
      f.cleanup()
    }
  })

  test('重复冻结幂等：保持原 holdStartedAt 不重新起租', () => {
    const f = makeDigestFixture()
    try {
      const t0 = 1_000_000
      const record = makeRecord(f.projectDir, t0)
      const first = freezeWitnessForHumanConfirmation(record, f.projectDir, t0 + 60_000)
      expect(first.ok).toBe(true)
      const second = freezeWitnessForHumanConfirmation(first.updated!, f.projectDir, t0 + 90_000)
      expect(second.ok).toBe(true)
      expect(second.updated?.holdStartedAt).toBe(t0 + 60_000)
    } finally {
      f.cleanup()
    }
  })

  test('GWT 通过后产物已被改 → E_WITNESS_ARTIFACT_DIRTY 拒绝冻结', async () => {
    const f = makeDigestFixture()
    try {
      const t0 = 1_000_000
      const record = makeRecord(f.projectDir, t0)
      await tickFs()
      writeFileSync(join(f.projectDir, '08_APP/index.html'), '<html>询问前就被改了</html>')
      const result = freezeWitnessForHumanConfirmation(record, f.projectDir, t0 + 60_000)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('E_WITNESS_ARTIFACT_DIRTY')
    } finally {
      f.cleanup()
    }
  })

  test('锚定后超 15 分钟才发起询问 → E_WITNESS_EXPIRED_BEFORE_ASK 拒绝冻结', () => {
    const f = makeDigestFixture()
    try {
      const t0 = 1_000_000
      const record = makeRecord(f.projectDir, t0)
      const result = freezeWitnessForHumanConfirmation(record, f.projectDir, t0 + MACHINE_WITNESS_TTL_MS + 1)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('E_WITNESS_EXPIRED_BEFORE_ASK')
    } finally {
      f.cleanup()
    }
  })
})

/* ------------------------------------------------------------------ */
/* 交付门判定：verifyWitnessFreshness（双阶段时钟）                       */
/* ------------------------------------------------------------------ */

describe('Given 交付门禁校验 When verifyWitnessFreshness Then 双阶段时钟语义', () => {
  test('两阶段正常链路 PASS：锚定 → 冻结 → 人类等待远超 10 分钟仍有效（P1-3 核心场景）', () => {
    const f = makeDigestFixture()
    try {
      const t0 = 1_000_000
      const anchored = makeRecord(f.projectDir, t0)
      const frozen = freezeWitnessForHumanConfirmation(anchored, f.projectDir, t0 + 3 * 60_000)
      expect(frozen.ok).toBe(true)
      // 人类阅读 28 分钟（旧 10 分钟窗口下必死）+ 交付确认应答
      const verdict = verifyWitnessFreshness(frozen.updated!, f.projectDir, t0 + 3 * 60_000 + 28 * 60_000)
      expect(verdict.valid).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  test('冻结后哪怕只过 10 秒，产物被篡改 → 立即 STALE（E_WITNESS_DIGEST_MISMATCH）', async () => {
    const f = makeDigestFixture()
    try {
      const t0 = 1_000_000
      const anchored = makeRecord(f.projectDir, t0)
      const frozen = freezeWitnessForHumanConfirmation(anchored, f.projectDir, t0 + 60_000)
      expect(frozen.ok).toBe(true)
      await tickFs()
      writeFileSync(join(f.projectDir, '08_APP/index.html'), '<html>人类等待期被篡改</html>')
      const verdict = verifyWitnessFreshness(frozen.updated!, f.projectDir, t0 + 60_000 + 10_000)
      expect(verdict.valid).toBe(false)
      expect(verdict.code).toBe('E_WITNESS_DIGEST_MISMATCH')
    } finally {
      f.cleanup()
    }
  })

  test('未冻结（execution_active）且超 15 分钟机器窗口 → E_WITNESS_MACHINE_TTL_EXPIRED', () => {
    const f = makeDigestFixture()
    try {
      const t0 = 1_000_000
      const anchored = makeRecord(f.projectDir, t0)
      const verdict = verifyWitnessFreshness(anchored, f.projectDir, t0 + MACHINE_WITNESS_TTL_MS + 1)
      expect(verdict.valid).toBe(false)
      expect(verdict.code).toBe('E_WITNESS_MACHINE_TTL_EXPIRED')
      // 恰好 15 分钟边界：仍有效（闭区间）
      expect(verifyWitnessFreshness(anchored, f.projectDir, t0 + MACHINE_WITNESS_TTL_MS).valid).toBe(true)
    } finally {
      f.cleanup()
    }
  })

  test('冻结后 24 小时内（含 23:59:59）→ PASS；超 24 小时 → E_WITNESS_HUMAN_LEASE_EXPIRED', () => {
    const f = makeDigestFixture()
    try {
      const t0 = 1_000_000
      const anchored = makeRecord(f.projectDir, t0)
      const frozen = freezeWitnessForHumanConfirmation(anchored, f.projectDir, t0 + 60_000)
      expect(frozen.ok).toBe(true)
      const hold = frozen.updated!.holdStartedAt!
      expect(verifyWitnessFreshness(frozen.updated!, f.projectDir, hold + HUMAN_HOLD_LEASE_MS - 1_000).valid).toBe(true)
      const expired = verifyWitnessFreshness(frozen.updated!, f.projectDir, hold + HUMAN_HOLD_LEASE_MS + 1)
      expect(expired.valid).toBe(false)
      expect(expired.code).toBe('E_WITNESS_HUMAN_LEASE_EXPIRED')
    } finally {
      f.cleanup()
    }
  })
})

/* ------------------------------------------------------------------ */
/* 集成：real-gate 交付门全链路                                          */
/* ------------------------------------------------------------------ */

describe('Given real-gate 交付门 When 接入双阶段见证时钟 Then 全链路语义', () => {
  test('见证登记：人证询问允许 → 锚定 → 冻结 → 交付消费通过，时钟记录终结', async () => {
    const f = makeGateFixture()
    try {
      // 1. 人证登记（见证询问允许）
      const witness = await registerSessionHumanWitnessEvidence(f.scope, f.tests, async () => ({ allowed: true, requestId: 'req-clock-1' }))
      expect(witness.ok).toBe(true)
      // 2. GWT 通过时刻锚定 + 发起交付询问前冻结
      expect(beginWitnessClockForDelivery(f.scope, f.tests).ok).toBe(true)
      expect(peekWitnessClockForTests(f.scope.projectId, f.scope.sessionId)?.clockPhase).toBe('execution_active')
      expect(freezeWitnessClockForDelivery(f.scope).ok).toBe(true)
      const clock = peekWitnessClockForTests(f.scope.projectId, f.scope.sessionId)
      expect(clock?.clockPhase).toBe('awaiting_human_confirm')
      expect(typeof clock?.holdStartedAt).toBe('number')
      // 3. 交付门消费通过（指纹锁定 + 租约窗口）
      const delivery = commitDeliveryRealEvidence(f.scope, f.tests)
      expect(delivery.rejection).toBeNull()
      // 4. 消费成功即终结时钟（后续同 scope 交付按全新链路重新锚定）
      expect(peekWitnessClockForTests(f.scope.projectId, f.scope.sessionId)).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })

  test('冻结后产物被篡改 → 交付门第一优先级拦截（real-evidence-tampered + E_WITNESS_DIGEST_MISMATCH）', async () => {
    const f = makeGateFixture()
    try {
      const witness = await registerSessionHumanWitnessEvidence(f.scope, f.tests, async () => ({ allowed: true, requestId: 'req-clock-2' }))
      expect(witness.ok).toBe(true)
      expect(beginWitnessClockForDelivery(f.scope, f.tests).ok).toBe(true)
      expect(freezeWitnessClockForDelivery(f.scope).ok).toBe(true)
      await tickFs()
      writeFileSync(join(f.projectDir, '08_APP/app'), '#!/bin/sh\necho hacked')
      const delivery = commitDeliveryRealEvidence(f.scope, f.tests)
      expect(delivery.rejection).not.toBeNull()
      expect(delivery.rejection?.reason).toBe('real-evidence-tampered')
      expect(delivery.rejection?.message).toContain('E_WITNESS_DIGEST_MISMATCH')
    } finally {
      f.cleanup()
    }
  })

  test('只锚定不冻结（execution_active）且未超窗 → 交付仍通过（机器窗口语义）', async () => {
    const f = makeGateFixture()
    try {
      const witness = await registerSessionHumanWitnessEvidence(f.scope, f.tests, async () => ({ allowed: true, requestId: 'req-clock-3' }))
      expect(witness.ok).toBe(true)
      expect(beginWitnessClockForDelivery(f.scope, f.tests).ok).toBe(true)
      const delivery = commitDeliveryRealEvidence(f.scope, f.tests)
      expect(delivery.rejection).toBeNull()
    } finally {
      f.cleanup()
    }
  })

  test('未锚定的旧路径 → 交付门维持既有语义（向后兼容，witness 测试主链路）', async () => {
    const f = makeGateFixture()
    try {
      const witness = await registerSessionHumanWitnessEvidence(f.scope, f.tests, async () => ({ allowed: true, requestId: 'req-clock-4' }))
      expect(witness.ok).toBe(true)
      const delivery = commitDeliveryRealEvidence(f.scope, f.tests)
      expect(delivery.rejection).toBeNull()
    } finally {
      f.cleanup()
    }
  })

  test('无见证记录（未登记任何人证）→ begin 返回 no-witness-record（不适用双阶段时钟）', async () => {
    const f = makeGateFixture()
    try {
      const begun = beginWitnessClockForDelivery(f.scope, f.tests)
      expect(begun.ok).toBe(false)
      expect(begun.reason).toBe('no-witness-record')
      expect(peekWitnessClockForTests(f.scope.projectId, f.scope.sessionId)).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })

  test('观察期校验（resolveSuiteRealEvidence）不受冻结时钟拦截', async () => {
    const f = makeGateFixture()
    try {
      const witness = await registerSessionHumanWitnessEvidence(f.scope, f.tests, async () => ({ allowed: true, requestId: 'req-clock-5' }))
      expect(witness.ok).toBe(true)
      expect(beginWitnessClockForDelivery(f.scope, f.tests).ok).toBe(true)
      expect(freezeWitnessClockForDelivery(f.scope).ok).toBe(true)
      const suite = resolveSuiteRealEvidence(f.scope, f.tests)
      expect(suite.rejections).toEqual([])
    } finally {
      f.cleanup()
    }
  })

  test('会话停止清理 → 冻结时钟随之清除', async () => {
    const f = makeGateFixture()
    try {
      const witness = await registerSessionHumanWitnessEvidence(f.scope, f.tests, async () => ({ allowed: true, requestId: 'req-clock-6' }))
      expect(witness.ok).toBe(true)
      expect(beginWitnessClockForDelivery(f.scope, f.tests).ok).toBe(true)
      expect(freezeWitnessClockForDelivery(f.scope).ok).toBe(true)
      cleanupEngineeringRealEvidence(f.scope.sessionId)
      expect(peekWitnessClockForTests(f.scope.projectId, f.scope.sessionId)).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })
})
