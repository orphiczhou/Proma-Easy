/**
 * 方案1（2026-10-01 用户裁决，Issue #P1-REAL-002）：最小「同会话真人见证」接线测试。
 *
 * 验证协议闭环：允许 → 登记人证观察（无机器点、human-witness-limited 边界）+ ack 签发
 * → 观察期校验（resolveSuiteRealEvidence）通过 → 交付 validate+consume 通过、重放被拒；
 * 拒绝 → 不登记、观察期仍 unattested。
 * 隔离：registry 按 projectId 进程级单例——每个用例独立 projectId。
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  registerSessionHumanWitnessEvidence,
  resolveSuiteRealEvidence,
  commitDeliveryRealEvidence,
} = await import('./nanju-engineering-real-gate')

let seq = 0
function fixtureScope() {
  const projectDir = mkdtempSync(join(tmpdir(), 'real-gate-witness-'))
  for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(projectDir, sub))
  writeFileSync(join(projectDir, '01_PRD/prd.md'), '# PRD\nUS-01 输出结果')
  writeFileSync(join(projectDir, '08_APP/app'), '#!/bin/sh\necho ok')
  writeFileSync(join(projectDir, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
    schemaVersion: 1,
    target: { kind: 'cli', platform: 'Linux', entry: 'app' },
    artifacts: ['app'], build: 'fixture', run: 'fixture',
    tests: [{ id: 't1', layer: 'acceptance', adapter: 'cli-driver', target: 'app', command: '真实CLI', covers: ['US-01'], requiresReal: true }],
  }))
  const projectId = `witness-fixture-${Date.now()}-${seq++}`
  return {
    scope: { workspaceSlug: 'ws-fixture', projectId, sessionId: 'sess-fixture', projectDir },
    tests: [{ testId: 't1', target: 'app', covers: ['US-01'] }] as { testId: string, target: string, covers: string[] }[],
    projectDir,
  }
}

describe('方案1：registerSessionHumanWitnessEvidence 协议闭环', () => {
  test('用户允许 → 登记 + ack → 观察期通过 → 交付 validate+consume 通过、重放被拒', async () => {
    const f = fixtureScope()
    const before = resolveSuiteRealEvidence(f.scope, f.tests)
    expect(before.rejections.length).toBeGreaterThan(0)
    expect(before.rejections[0]!.reason).toBe('requires-real-unattested')

    const witness = await registerSessionHumanWitnessEvidence(f.scope, f.tests, async () => ({ allowed: true, requestId: 'req-real-1' }))
    expect(witness.ok).toBe(true)
    expect(witness.message).toContain('human-witness-limited')

    const after = resolveSuiteRealEvidence(f.scope, f.tests)
    expect(after.rejections).toEqual([])

    const delivery = commitDeliveryRealEvidence(f.scope, f.tests)
    expect(delivery.rejection).toBeNull()
    const replay = commitDeliveryRealEvidence(f.scope, f.tests)
    expect(replay.rejection).not.toBeNull()
  })

  test('用户拒绝 → 不登记不签发，观察期保持 unattested', async () => {
    const f = fixtureScope()
    const witness = await registerSessionHumanWitnessEvidence(f.scope, f.tests, async () => ({ allowed: false, requestId: 'req-real-2' }))
    expect(witness.ok).toBe(false)
    const after = resolveSuiteRealEvidence(f.scope, f.tests)
    expect(after.rejections[0]!.reason).toBe('requires-real-unattested')
  })

  test('工程证据不可读 → 拒绝登记（fail-closed）', async () => {
    const f = fixtureScope()
    writeFileSync(join(f.projectDir, '03_ARCHITECTURE/engineering.json'), '{broken')
    const witness = await registerSessionHumanWitnessEvidence(f.scope, f.tests, async () => ({ allowed: true, requestId: 'r' }))
    expect(witness.ok).toBe(false)
  })
})
