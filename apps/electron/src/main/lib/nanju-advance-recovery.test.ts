import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let root = ''
mock.module('./config-paths', () => ({ getWorkspaceFilesDir: () => root, getAgentWorkspacePath: () => root, getConfigDirName: () => '.proma-nonexistent-advance-recovery-test' }))
const store = await import('./nanju-project')
const { writeJsonFileAtomic } = await import('./safe-file')
const recovery = await import('./nanju-advance-recovery')
const gate = await import('./nanju-router-gate')
const ws = 'test-workspace'
const id = 'recovery-fixture'
let dir = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'advance-recovery-'))
  dir = join(root, `project-${id}`)
  mkdirSync(join(dir, '01_PRD'), { recursive: true })
  writeJsonFileAtomic(join(root, '_nanju-projects.json'), [{ projectId: id, name: 'fixture', mode: 'quick', status: 'active', currentStage: 'requirements', sessionId: 's', workspaceSlug: ws, createdAt: 'today', updatedAt: 'today' }])
  store.writeProjectInfo(ws, id, { projectId: id, name: 'fixture', mode: 'quick', sessionId: 's', workspaceSlug: ws, createdAt: 'today', projectDir: dir, docDirs: [] })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('推进拒因重启恢复', () => {
  test('首次拒收即保存同源checks；同产物同拒因幂等键不变，变更产物后必须重验', () => {
    const verdict = gate.evaluatePhaseOutput(ws, id, 'requirements')
    expect(verdict.checks[0]?.id).toBe('output.exists')
    const correction = { kind: 'gate-deny' as const, target: 'prototype', expected: 'prototype', count: 1, message: '请补PRD', checks: verdict.checks }
    recovery.persistAdvanceCorrection(ws, id, correction)
    const first = store.getProjectPendingAdvanceCorrection(ws, id)!
    expect(first.executionState).toBe('blocked')
    expect(first.checks).toEqual(verdict.checks)
    recovery.persistAdvanceCorrection(ws, id, correction)
    expect(store.getProjectPendingAdvanceCorrection(ws, id)?.eventKey).toBe(first.eventKey)
    writeFileSync(join(dir, '01_PRD', 'prd.md'), '# PRD\n' + 'US-001: 用户故事\n'.repeat(30))
    recovery.persistAdvanceCorrection(ws, id, { ...correction, checks: undefined })
    expect(store.getProjectPendingAdvanceCorrection(ws, id)?.eventKey).not.toBe(first.eventKey)
    expect(store.getNanjuProject(ws, id)?.currentStage).toBe('requirements')
  })

  test('重新读取磁盘拒因形成下轮上下文，既不授权也不新增委派；旧schema同样可恢复', () => {
    store.setProjectPendingAdvanceCorrection(ws, id, { kind: 'gate-deny', target: 'prototype', expected: 'prototype', count: 19, at: 'yesterday' })
    const prompt = recovery.buildPendingAdvanceRecoveryPrompt(ws, id)!
    expect(prompt).toContain('非推进授权')
    expect(prompt).toContain('output.exists')
    expect(prompt).toContain('历史版本只保存了拒收目标')
    expect(store.getConfirmAuthorization(ws, id)).toBeNull()
    expect(store.getNanjuProject(ws, id)?.currentStage).toBe('requirements')
  })

  test('跨阶段残留不注入，敏感拒因脱敏；目录伪装产出拒绝', () => {
    recovery.persistAdvanceCorrection(ws, id, { kind: 'gate-deny', target: 'prototype', expected: 'prototype', count: 1, message: 'api_key=secret-value Bearer abc.def.ghi' })
    const saved = store.getProjectPendingAdvanceCorrection(ws, id)!
    expect(saved.message).not.toContain('secret-value')
    expect(saved.message).not.toContain('abc.def.ghi')
    mkdirSync(join(dir, '01_PRD', 'prd.md'))
    expect(gate.evaluatePhaseOutput(ws, id, 'requirements').checks[0]?.id).toBe('output.regular-file')
    store.updateNanjuProject(ws, id, { currentStage: 'coding' })
    expect(recovery.buildPendingAdvanceRecoveryPrompt(ws, id)).toBeNull()
  })
})

test('同事件仅领取一次，取消不重新注入或续接；变化后必须重新生成事件', () => {
  const correction = { kind: 'gate-deny' as const, target: 'prototype', expected: 'prototype', count: 1, message: 'AWS_SECRET_ACCESS_KEY=private-value PRIVATE_KEY=private-key' }
  recovery.persistAdvanceCorrection(ws, id, correction)
  expect(recovery.claimAdvanceCorrectionContinuation(ws, id)).toBe(true)
  recovery.persistAdvanceCorrection(ws, id, correction)
  expect(recovery.claimAdvanceCorrectionContinuation(ws, id)).toBe(false)
  recovery.cancelAdvanceCorrection(ws, id)
  recovery.persistAdvanceCorrection(ws, id, correction)
  expect(recovery.buildPendingAdvanceRecoveryPrompt(ws, id)).toBeNull()
  expect(recovery.claimAdvanceCorrectionContinuation(ws, id)).toBe(false)
  expect(recovery.getAdvanceCorrectionView(ws, id)?.message).not.toContain('private-value')
  expect(recovery.getAdvanceCorrectionView(ws, id)?.message).not.toContain('private-key')
  writeFileSync(join(dir, '01_PRD', 'prd.md'), '# 变化后的PRD\n' + 'US-001 项目要求\n'.repeat(20))
  recovery.persistAdvanceCorrection(ws, id, correction)
  expect(recovery.claimAdvanceCorrectionContinuation(ws, id)).toBe(true)
  expect(store.getNanjuProject(ws, id)?.currentStage).toBe('requirements')
})
