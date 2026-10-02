/**
 * P0 修复（2026-09-26）：续接空闲巡检（continuation idle watch）源码断言测试。
 *
 * 背景（E2E-Desktop 桌面便签 architecture→coding 卡死，观察员 O2/O4 终报定根因）：
 * `advance.reject-escalate{continuation-giveup}` 后无重触发机制——调度员 L1 会话在
 * runNanjuGuardContinuation 的 6 次（60s）快速重试期间持续忙碌（阻塞在 wait_for_delegations
 * /流式收尾），重试耗尽直接 onGiveUp，导致「可操作出口（nextAction）」永久不送达调度员，
 * 流程停摆 39 小时。
 *
 * 修复：giveup 前先启动长期空闲巡检（startNanjuContinuationIdleWatch），每 30s 检查一次，
 * 会话一旦空闲立即重新投递续接；巡检有上限（20 次 ≈ 10 分钟），期间 epoch 失效（用户 stop
 * /新消息）或工程 pendingAdvanceCorrection 被取消即停；耗尽才真正 onGiveUp。
 *
 * 说明：agent-orchestrator 为大方法类，无法轻量实例化单测（与 agent-orchestrator-preflight.test.ts
 * 同源码断言模式）；本文件读源码断言关键结构与顺序。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')

function idleWatchBlock(): string {
  const start = SRC.indexOf('private startNanjuContinuationIdleWatch(')
  expect(start).toBeGreaterThan(-1)
  const end = SRC.indexOf('private runNanjuGuardContinuation(', start)
  expect(end).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

function guardContinuationGiveupBranch(): string {
  const start = SRC.indexOf('private runNanjuGuardContinuation(')
  const end = SRC.indexOf('const meta = getAgentSessionMeta(sessionId)', start)
  return SRC.slice(start, end)
}

describe('P0 续接空闲巡检：giveup 分支接入', () => {
  test('快速重试耗尽（retriesLeft 分支的 else）不再直接 onGiveUp，而是启动空闲巡检', () => {
    const block = guardContinuationGiveupBranch()
    // else 分支（retriesLeft 耗尽）调用 startNanjuContinuationIdleWatch，而非立即 onGiveUp
    const elseIdx = block.indexOf('startNanjuContinuationIdleWatch(sessionId, message, onGiveUp, epoch)')
    expect(elseIdx).toBeGreaterThan(-1)
    const retryIdx = block.indexOf("runNanjuGuardContinuation(sessionId, message, retriesLeft - 1, onGiveUp, epoch)")
    expect(retryIdx).toBeGreaterThan(-1)
    // 重试分支在 else 巡检分支之前
    expect(retryIdx).toBeLessThan(elseIdx)
  })

  test('cancel 检查抽取为 isNanjuContinuationCancelled（快速重试与巡检共用）', () => {
    const block = guardContinuationGiveupBranch()
    expect(block).toContain('this.isNanjuContinuationCancelled(sessionId)')
  })
})

describe('P0 续接空闲巡检：巡检本身语义', () => {
  const block = idleWatchBlock()

  test('epoch 失效（用户 stop/新消息）即停止巡检', () => {
    expect(block).toContain('epoch !== (this.nanjuContinuationEpoch.get(sessionId) ?? 0)')
    expect(block).toContain('getAgentSessionMeta(sessionId)?.stoppedByUser')
  })

  test('工程 pendingAdvanceCorrection 被取消即停止巡检', () => {
    expect(block).toContain('this.isNanjuContinuationCancelled(sessionId)')
  })

  test('会话空闲后重新投递续接（从头重跑快速重试，retriesLeft 重置为 6）', () => {
    expect(block).toContain('!this.isActive(sessionId)')
    expect(block).toContain('this.runNanjuGuardContinuation(sessionId, message, 6, onGiveUp, epoch)')
  })

  test('巡检耗尽（attemptsLeft 归零）才真正 onGiveUp', () => {
    expect(block).toContain('cur.attemptsLeft <= 0')
    const giveUpIdx = block.indexOf('onGiveUp?.(sessionId, message)')
    const exhaustIdx = block.indexOf('cur.attemptsLeft <= 0')
    expect(giveUpIdx).toBeGreaterThan(exhaustIdx)
  })

  test('巡检有上限（20 次）且单次间隔 30s，避免无限占用', () => {
    expect(block).toContain('const maxIdleAttempts = 20')
    expect(block).toContain('const idleIntervalMs = 30_000')
  })
})
