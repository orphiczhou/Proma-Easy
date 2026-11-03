/**
 * W-I B-d：修复环调度适配器 BDD（真行为，非源码断言）。
 *
 * 覆盖冻结裁决：
 * - 首产不计修复次数、修复 1/2/3 共三次（attempt 号 = attemptsUsed + 1，策略按序轮换）；
 * - `blocked`/`pass` 不烧预算（skip，`:791-794` 早退同口径）；
 * - 环境类不写 attempt（不进入修复循环）；
 * - 熔断文案**同时**读 `failClosed` 与 `exhausted`：fail-closed 不得被说成「已用尽 3 次」；
 * - 回滚措辞由结构化结果决定：成功才说「已恢复到」，未尝试一律「未回滚代码」；
 * - append 失败 → writeFailed 带入下一轮（fail-closed，不从零重试）。
 *
 * 宿主全部注入：`plan` 用 E 的真实纯函数 `planNextRepair`，其余用假实现记录调用。
 */
import { describe, expect, test } from 'bun:test'
import { dispatchRepairDecision } from './nanju-repair-dispatch'
import { planNextRepair } from './nanju-repair-loop'
import type { FileRollbackResult, RepairAttempt, RepairPlanState } from './nanju-repair-loop'
import type { RepairDispatchHost, RepairDispatchRequest } from './nanju-repair-dispatch'

interface HostLog {
  planCalls: Array<Partial<RepairPlanState>>
  appended: RepairAttempt[]
  rollbacks: string[]
}

function buildHost(opts: {
  attempts?: RepairAttempt[]
  appendOk?: boolean
  appendReason?: string
  snapshotId?: string | null
  rollbackResult?: FileRollbackResult | null
} = {}): { host: RepairDispatchHost; log: HostLog } {
  const attempts = opts.attempts ?? []
  const log: HostLog = { planCalls: [], appended: [], rollbacks: [] }
  const host: RepairDispatchHost = {
    plan: (request) => {
      log.planCalls.push(request)
      return planNextRepair({ ...request, attempts, logStatus: 'valid' })
    },
    readAttempts: () => attempts,
    appendAttempt: (attempt) => {
      log.appended.push(attempt)
      return opts.appendOk === false
        ? { ok: false, reason: opts.appendReason ?? '磁盘只读' }
        : { ok: true }
    },
    rollback: async (snapshotId) => {
      log.rollbacks.push(snapshotId)
      return opts.rollbackResult ?? { ok: true, restoredFiles: 12, preRestoreBackupDir: '/tmp/backup-x' }
    },
    resolveSnapshotId: () => opts.snapshotId === undefined ? 'snap-uuid-1' : opts.snapshotId,
  }
  return { host, log }
}

function request(overrides: Partial<RepairDispatchRequest> = {}): RepairDispatchRequest {
  return {
    mode: 'quick',
    verdict: 'fail',
    failureKind: 'behavior',
    errorReason: 'TypeError: x is not a function',
    consecutiveCircuitCount: 1,
    fileRollbackAvailable: true,
    logWriteFailed: false,
    snapshotLabel: '进入编码前',
    now: new Date('2026-09-17T08:00:00.000Z'),
    ...overrides,
  }
}

const attempt = (n: number, strategy: RepairAttempt['strategy'] = 'direct-fix'): RepairAttempt => ({
  attempt: n,
  strategy,
  failureClass: 'code',
  failureSignature: 'code:typeerror: <path>',
  at: '2026-09-17T07:00:00.000Z',
})

describe('B-d 资格门：pass/blocked 不烧修复预算', () => {
  test('pass → skip，规划/追加/回滚一律不调用', async () => {
    const { host, log } = buildHost()
    const outcome = await dispatchRepairDecision(request({ verdict: 'pass' }), host)
    expect(outcome.action).toBe('skip')
    expect(log.planCalls.length).toBe(0)
    expect(log.appended.length).toBe(0)
    expect(log.rollbacks.length).toBe(0)
  })

  test('blocked → skip（环境/驱动阻塞等真人处理，与 orchestrator 早退同口径）', async () => {
    const { host, log } = buildHost()
    const outcome = await dispatchRepairDecision(request({ verdict: 'blocked' }), host)
    expect(outcome.action).toBe('skip')
    expect(log.appended.length).toBe(0)
  })
})

describe('B-d 环境类：不写 attempt（不耗预算）', () => {
  test('failureKind=environment → notify-environment，且 append 零调用', async () => {
    const { host, log } = buildHost()
    const outcome = await dispatchRepairDecision(
      request({ failureKind: 'environment', errorReason: 'ENOSPC: no space left on device' }),
      host,
    )
    expect(outcome.action).toBe('notify-environment')
    if (outcome.action !== 'notify-environment') throw new Error('unreachable')
    expect(outcome.failureClass).toBe('environment')
    expect(outcome.message).toContain('不计入自动修复次数')
    expect(log.appended.length).toBe(0)
  })

  test('环境类不会因为「已有 3 条记录」而转熔断——直接给出环境安抚', async () => {
    const { host } = buildHost({ attempts: [attempt(1), attempt(2), attempt(3)] })
    const outcome = await dispatchRepairDecision(
      request({ errorReason: 'EACCES: permission denied, open /dev/null' }),
      host,
    )
    expect(outcome.action).toBe('notify-environment')
  })
})

describe('B-d 修复预算：首产不计、修复 1/2/3 共三次', () => {
  test('空日志 + 首产失败 → 第 1 次修复（direct-fix），attempt 号 = 1', async () => {
    const { host, log } = buildHost()
    const outcome = await dispatchRepairDecision(request(), host)
    expect(outcome.action).toBe('repair')
    if (outcome.action !== 'repair') throw new Error('unreachable')
    expect(outcome.attempt.attempt).toBe(1)
    expect(outcome.attempt.strategy).toBe('direct-fix')
    expect(outcome.attempt.failureClass).toBe('code')
    expect(outcome.attempt.at).toBe('2026-09-17T08:00:00.000Z')
    expect(outcome.writeFailed).toBe(false)
    expect(log.appended.length).toBe(1)
  })

  test('已有 1 条 → 第 2 次修复换策略（re-read-design，不重复同一手段）', async () => {
    const { host } = buildHost({ attempts: [attempt(1, 'direct-fix')] })
    const outcome = await dispatchRepairDecision(request(), host)
    if (outcome.action !== 'repair') throw new Error('unreachable')
    expect(outcome.attempt.attempt).toBe(2)
    expect(outcome.attempt.strategy).toBe('re-read-design')
  })

  test('已有 2 条 → 第 3 次修复（alternate-approach，预算最后一次）', async () => {
    const { host } = buildHost({ attempts: [attempt(1, 'direct-fix'), attempt(2, 're-read-design')] })
    const outcome = await dispatchRepairDecision(request(), host)
    if (outcome.action !== 'repair') throw new Error('unreachable')
    expect(outcome.attempt.attempt).toBe(3)
    expect(outcome.attempt.strategy).toBe('alternate-approach')
  })

  test('已有 3 条 → 熔断：exhausted=true / failClosed=false，文案说「用尽 3 次」并按结构化结果说恢复', async () => {
    const { host, log } = buildHost({ attempts: [attempt(1), attempt(2, 're-read-design'), attempt(3, 'alternate-approach')] })
    const outcome = await dispatchRepairDecision(request({ consecutiveCircuitCount: 1 }), host)
    expect(outcome.action).toBe('circuit-break')
    if (outcome.action !== 'circuit-break') throw new Error('unreachable')
    expect(outcome.exhausted).toBe(true)
    expect(outcome.failClosed).toBe(false)
    expect(outcome.message).toContain('已用尽 3 次')
    expect(outcome.message).toContain('已恢复到')
    expect(outcome.logText).toContain('[南大自修复熔断]')
    expect(outcome.logText).toContain('第 3 次修复')
    expect(log.rollbacks).toEqual(['snap-uuid-1'])
    expect(log.appended.length).toBe(0)
  })

  test('连续熔断 ≥3 次走特化文案（简化版建议）', async () => {
    const { host } = buildHost({ attempts: [attempt(1), attempt(2), attempt(3)] })
    const outcome = await dispatchRepairDecision(request({ consecutiveCircuitCount: 3 }), host)
    if (outcome.action !== 'circuit-break') throw new Error('unreachable')
    expect(outcome.message).toContain('连续 3 次触发熔断')
    expect(outcome.message).toContain('缩小这次要做的范围')
  })
})

describe('B-d fail-closed：状态不可信 ≠ 预算用尽', () => {
  test('logWriteFailed=true → failClosed=true / exhausted=false，文案明确「不是已用尽 3 次」且不回滚', async () => {
    const { host, log } = buildHost()
    const outcome = await dispatchRepairDecision(request({ logWriteFailed: true }), host)
    expect(outcome.action).toBe('circuit-break')
    if (outcome.action !== 'circuit-break') throw new Error('unreachable')
    expect(outcome.failClosed).toBe(true)
    expect(outcome.exhausted).toBe(false)
    expect(outcome.message).toContain('修复记录不可信')
    expect(outcome.message).toContain('不是「已用尽 3 次自动修复」')
    expect(outcome.logText).toContain('预算计数不可信')
    expect(log.rollbacks.length).toBe(0)
  })

  test('append 写失败 → writeFailed=true 并带原因（调用方须带入下一轮 fail-closed）', async () => {
    const { host } = buildHost({ appendOk: false, appendReason: 'EROFS: read-only file system' })
    const outcome = await dispatchRepairDecision(request(), host)
    if (outcome.action !== 'repair') throw new Error('unreachable')
    expect(outcome.writeFailed).toBe(true)
    expect(outcome.writeReason).toContain('EROFS')
  })
})

describe('B-d 回滚措辞严格由结构化结果决定', () => {
  test('无可用快照 id → 不调回滚，文案「未回滚代码」', async () => {
    const { host, log } = buildHost({ attempts: [attempt(1), attempt(2), attempt(3)], snapshotId: null })
    const outcome = await dispatchRepairDecision(request(), host)
    if (outcome.action !== 'circuit-break') throw new Error('unreachable')
    expect(log.rollbacks.length).toBe(0)
    expect(outcome.rollback).toBeNull()
    expect(outcome.message).toContain('未回滚代码')
    expect(outcome.message).not.toContain('已恢复到')
  })

  test('回滚被锁占用（locked）→ 明说未回滚 + 可稍后重试，不得声称已恢复', async () => {
    const { host } = buildHost({
      attempts: [attempt(1), attempt(2), attempt(3)],
      rollbackResult: { ok: false, reason: 'locked', message: '恢复事务被占用', compensated: false },
    })
    const outcome = await dispatchRepairDecision(request(), host)
    if (outcome.action !== 'circuit-break') throw new Error('unreachable')
    expect(outcome.message).toContain('稍后可重试')
    expect(outcome.message).toContain('未回滚代码')
    expect(outcome.message).not.toContain('已恢复到')
  })

  test('回滚已补偿（compensated）→ 说明工程已回到恢复前状态', async () => {
    const { host } = buildHost({
      attempts: [attempt(1), attempt(2), attempt(3)],
      rollbackResult: { ok: false, reason: 'restore-verify-failed', message: '校验失败', compensated: true },
    })
    const outcome = await dispatchRepairDecision(request(), host)
    if (outcome.action !== 'circuit-break') throw new Error('unreachable')
    expect(outcome.message).toContain('工程已补偿回恢复前状态')
    expect(outcome.message).not.toContain('已恢复到快照')
  })
})

describe('B-d 规划入参同源（E 的规划器读到真实分类与签名）', () => {
  test('environment kind 进分类器；fileRollbackAvailable / logWriteFailed 原样透传', async () => {
    const { host, log } = buildHost()
    await dispatchRepairDecision(
      request({ failureKind: 'device', errorReason: '麦克风不可用', fileRollbackAvailable: false }),
      host,
    )
    expect(log.planCalls.length).toBe(1)
    expect(log.planCalls[0]?.failureClass).toBe('environment')
    expect(log.planCalls[0]?.fileRollbackAvailable).toBe(false)
    expect(log.planCalls[0]?.logWriteFailed).toBe(false)
    expect(log.planCalls[0]?.mode).toBe('quick')
  })

  test('failureKind=coverage → design-constraint（提示换方向而非原地重试）', async () => {
    const { host } = buildHost()
    const outcome = await dispatchRepairDecision(
      request({ failureKind: 'coverage', errorReason: '用户故事 US-03 未覆盖' }),
      host,
    )
    if (outcome.action !== 'repair') throw new Error('unreachable')
    expect(outcome.attempt.failureClass).toBe('design-constraint')
  })
})
