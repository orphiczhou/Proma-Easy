/**
 * Task 11（2026-09-20）：工程执行证据归档单测。
 * 覆盖：归档→索引→读取往返一致（重启可审阅）、content 哈希一致、不持久化交付授权、
 * 缺失索引返回 null、多测试条目索引。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  archiveEngineeringTestEvidence, writeEngineeringEvidenceIndex, readEngineeringEvidenceIndex, readEngineeringTestEvidence,
  ENGINEERING_EVIDENCE_DIR,
} from './nanju-engineering-evidence'
import type { EngineeringExecutionResult } from './nanju-engineering-execution'

let root = ''
afterEach(() => { if (root) { rmSync(root, { recursive: true, force: true }); root = '' } })

function result(status: EngineeringExecutionResult['status']): EngineeringExecutionResult {
  return {
    testId: 'acceptance', target: 'app', status, reason: status === 'pass' ? null : 'fixture reason',
    coveredUs: status === 'pass' ? ['US-01'] : [],
    checks: [{ storyId: 'US-01', label: '标准输出', expected: 'hello', actual: status === 'pass' ? 'hello' : 'goodbye', evidence: ['受控fixture'], passed: status === 'pass' }],
    evidenceDigest: 'fixture-digest',
    driverIo: { stdoutTail: 'ok', stderrTail: '' },
  }
}

describe('Given 工程执行证据，When 归档→索引→读取，Then 往返一致且重启后可审阅', () => {
  test('Then 单条归档 + 索引，读取回来 runId/testId/hash 一致', () => {
    root = mkdtempSync(join(tmpdir(), 'nanju-evidence-'))
    const r = result('pass')
    const { path, sha256 } = archiveEngineeringTestEvidence(root, r, 'run-1', '2026-09-20T06:00:00.000Z')
    const idxPath = writeEngineeringEvidenceIndex(root, 'run-1', [{ testId: r.testId, status: r.status, sha256, generatedAt: '2026-09-20T06:00:00.000Z' }], '2026-09-20T06:00:00.000Z')
    expect(existsSync(path)).toBe(true)
    expect(existsSync(idxPath)).toBe(true)
    // 模拟重启后重新读取（不依赖内存态）
    const idx = readEngineeringEvidenceIndex(root, 'run-1')
    expect(idx?.schemaVersion).toBe(1)
    expect(idx?.runId).toBe('run-1')
    expect(idx?.source).toBe('driver-execution')
    expect(idx?.tests[0]?.testId).toBe('acceptance')
    expect(idx?.tests[0]?.status).toBe('pass')
    expect(idx?.tests[0]?.sha256).toBe(sha256)
    const evidence = readEngineeringTestEvidence(root, 'run-1', 'acceptance')
    expect(evidence?.meta.source).toBe('driver-execution')
    expect(evidence?.meta.status).toBe('pass')
    expect(evidence?.meta.evidenceDigest).toBe('fixture-digest')
    expect(evidence?.checks.length).toBe(1)
  })

  test('Then content 哈希与 evidence.json 实际内容一致（可核验未被篡改）', () => {
    root = mkdtempSync(join(tmpdir(), 'nanju-evidence-'))
    const { sha256 } = archiveEngineeringTestEvidence(root, result('pass'), 'run-1')
    const content = readFileSync(join(root, ENGINEERING_EVIDENCE_DIR, 'run-1', 'acceptance', 'evidence.json'), 'utf-8')
    expect(sha256).toBe(createHash('sha256').update(content, 'utf-8').digest('hex'))
  })

  test('Then blocked 结果也归档（status/coveredUs 空如实入档），不因阻塞丢证据', () => {
    root = mkdtempSync(join(tmpdir(), 'nanju-evidence-'))
    const r = result('blocked')
    archiveEngineeringTestEvidence(root, r, 'run-1')
    const evidence = readEngineeringTestEvidence(root, 'run-1', 'acceptance')
    expect(evidence?.meta.status).toBe('blocked')
    expect(evidence?.meta.coveredUs).toEqual([])
  })

  test('Then 多条测试条目索引逐条登记 hash/状态/时间', () => {
    root = mkdtempSync(join(tmpdir(), 'nanju-evidence-'))
    const a = result('pass')
    const b = result('fail')
    const { sha256: ha } = archiveEngineeringTestEvidence(root, a, 'run-1')
    const { sha256: hb } = archiveEngineeringTestEvidence(root, { ...b, testId: 'unit' }, 'run-1')
    writeEngineeringEvidenceIndex(root, 'run-1', [
      { testId: a.testId, status: a.status, sha256: ha, generatedAt: 'g' },
      { testId: 'unit', status: b.status, sha256: hb, generatedAt: 'g' },
    ])
    const idx = readEngineeringEvidenceIndex(root, 'run-1')
    expect(idx?.tests.length).toBe(2)
    expect(idx?.tests.map((t) => t.sha256).sort()).toEqual([ha, hb].sort())
  })
})

describe('Given 证据归档边界，When 读取/检查，Then 不持久化交付授权且缺失时安全返回', () => {
  test('Then 归档只含只读证据（source=driver-execution），不写 approve/authorization/ticket 字段', () => {
    root = mkdtempSync(join(tmpdir(), 'nanju-evidence-'))
    archiveEngineeringTestEvidence(root, result('pass'), 'run-1')
    const payload = JSON.parse(readFileSync(join(root, ENGINEERING_EVIDENCE_DIR, 'run-1', 'acceptance', 'evidence.json'), 'utf-8')) as Record<string, unknown>
    expect(payload.meta).toBeDefined()
    expect((payload.meta as Record<string, unknown>).source).toBe('driver-execution')
    const json = JSON.stringify(payload)
    for (const forbidden of ['approve', 'authorization', 'ticket', 'approved']) {
      expect(Object.prototype.hasOwnProperty.call(payload, forbidden)).toBe(false)
      expect(json).not.toContain('"delivery' + forbidden)
    }
  })

  test('Then 缺失索引/证据读取返回 null（不抛异常）', () => {
    root = mkdtempSync(join(tmpdir(), 'nanju-evidence-'))
    expect(readEngineeringEvidenceIndex(root, 'no-such-run')).toBeNull()
    expect(readEngineeringTestEvidence(root, 'no-such-run', 't')).toBeNull()
  })
})
