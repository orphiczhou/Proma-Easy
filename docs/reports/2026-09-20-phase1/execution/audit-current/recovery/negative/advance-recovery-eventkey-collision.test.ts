/**
 * audit-current 负例：指纹失败时 eventKey=undefined 的幂等键碰撞。
 *
 * 被测：nanju-advance-recovery.ts 的 persistAdvanceCorrection / cancelAdvanceCorrection /
 *       buildPendingAdvanceRecoveryPrompt / claimAdvanceCorrectionContinuation。
 *
 * 反例命题：当 phaseArtifactFingerprint 抛错（阶段产物 > 20MB 等），eventKey 为 undefined；
 *           persistAdvanceCorrection 以 `previous.eventKey === eventKey` 判定「同事件」，
 *           而 `undefined === undefined` 恒真，导致：
 *           - 用户取消一次（executionState='cancelled'）后，**不同**的后续拒收会被
 *             `executionState: previous?.eventKey === eventKey && previous?.executionState==='cancelled'
 *             ? 'cancelled' : 'blocked'` 误判为同一事件，继承 'cancelled'；
 *           - buildPendingAdvanceRecoveryPrompt 见到 'cancelled' 直接返回 null，新拒因被静默吞掉。
 *
 * 只读审计：不改产品代码；本测试仅固定当前行为作为证据。
 * 运行：bun test <本文件>。mock 全部用绝对路径，落盘仅在 mkdtempSync 临时目录。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIB = '/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib'

let root = ''
mock.module(join(LIB, 'config-paths.ts'), () => ({
  getWorkspaceFilesDir: () => root,
  getAgentWorkspacePath: () => root,
  getConfigDirName: () => '.proma-nonexistent-eventkey-audit',
}))
const store = await import(join(LIB, 'nanju-project.ts'))
const { writeJsonFileAtomic } = await import(join(LIB, 'safe-file.ts'))
const recovery = await import(join(LIB, 'nanju-advance-recovery.ts'))

const ws = 'audit-ws'
const id = 'eventkey-fixture'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eventkey-audit-'))
  const dir = join(root, `project-${id}`)
  mkdirSync(join(dir, '01_PRD'), { recursive: true })
  // 阶段产物内放置一个 >20MB 的文件，迫使 phaseArtifactFingerprint 抛错（eventKey=undefined）
  writeFileSync(join(dir, '01_PRD', 'oversized.bin'), '')
  truncateSync(join(dir, '01_PRD', 'oversized.bin'), 21 * 1024 * 1024)
  writeJsonFileAtomic(join(root, '_nanju-projects.json'), [{
    projectId: id, name: 'fixture', mode: 'quick', status: 'active',
    currentStage: 'requirements', sessionId: 's', workspaceSlug: ws,
    createdAt: 'today', updatedAt: 'today',
  }])
  store.writeProjectInfo(ws, id, {
    projectId: id, name: 'fixture', mode: 'quick', sessionId: 's', workspaceSlug: ws,
    createdAt: 'today', projectDir: join(root, `project-${id}`), docDirs: [],
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('指纹失败（eventKey=undefined）下的幂等键碰撞', () => {
  test('指纹缺失时不同拒收事件被同化为同一事件：取消后新拒因被静默吞掉', () => {
    recovery.persistAdvanceCorrection(ws, id, { kind: 'gate-deny', target: 'prototype', expected: 'prototype', count: 1, message: '第一次拒因', checks: [] })
    const first = store.getProjectPendingAdvanceCorrection(ws, id)!
    expect(first.eventKey).toBeUndefined()          // 指纹失败 → 无幂等键
    expect(first.executionState).toBe('blocked')
    expect(recovery.claimAdvanceCorrectionContinuation(ws, id)).toBe(false)

    recovery.cancelAdvanceCorrection(ws, id)
    expect(store.getProjectPendingAdvanceCorrection(ws, id)?.executionState).toBe('cancelled')

    recovery.persistAdvanceCorrection(ws, id, { kind: 'gate-deny', target: 'prototype', expected: 'prototype', count: 2, message: '第二次全新拒因', checks: [] })
    const second = store.getProjectPendingAdvanceCorrection(ws, id)!

    // 缺陷证据：两次不同事件因 undefined===undefined 被当作同事件，新拒因继承 'cancelled'
    expect(second.executionState).toBe('cancelled')
    expect(recovery.buildPendingAdvanceRecoveryPrompt(ws, id)).toBeNull()
    expect(recovery.claimAdvanceCorrectionContinuation(ws, id)).toBe(false)
  })

  test('对照：指纹可用且产物变化时，取消后新拒因恢复为 blocked 且可被消费', () => {
    rmSync(join(root, `project-${id}`, '01_PRD', 'oversized.bin'), { force: true })
    recovery.persistAdvanceCorrection(ws, id, { kind: 'gate-deny', target: 'prototype', expected: 'prototype', count: 1, message: '第一次', checks: [] })
    const first = store.getProjectPendingAdvanceCorrection(ws, id)!
    expect(first.eventKey).toBeDefined()
    recovery.cancelAdvanceCorrection(ws, id)
    // 改变产物 → 指纹变化 → 新 eventKey ≠ 旧 eventKey → 新事件恢复 blocked
    writeFileSync(join(root, `project-${id}`, '01_PRD', 'prd.md'), '# 变化后的PRD\n' + 'US-001 用户故事\n'.repeat(20))
    recovery.persistAdvanceCorrection(ws, id, { kind: 'gate-deny', target: 'prototype', expected: 'prototype', count: 2, message: '第二次', checks: [] })
    const second = store.getProjectPendingAdvanceCorrection(ws, id)!
    expect(second.executionState).toBe('blocked')
    expect(second.eventKey).not.toBe(first.eventKey)
    expect(recovery.buildPendingAdvanceRecoveryPrompt(ws, id)).not.toBeNull()
    expect(recovery.claimAdvanceCorrectionContinuation(ws, id)).toBe(true)
  })
})
