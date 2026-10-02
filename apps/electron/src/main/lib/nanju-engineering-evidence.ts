/**
 * Task 11（2026-09-20）：工程执行证据归档——06_TESTS/evidence/<runId>/<testId>/。
 *
 * 只归档宿主实测的**只读证据**（checks / driverIo / hash / 来源 / 时间）；重启后可审阅历史。
 * **不复用宿主交付授权**：归档不写 approve() 结果、不写任何交付票据/白名单/授权令牌——
 * 需要新鲜宿主票据的交付仍由 GWT 交付门 + 单次批准重新验证，归档不可作为可重放授权。
 * 归档失败不阻断判定（best-effort，调用方 catch 后继续）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import type { EngineeringExecutionResult } from './nanju-engineering-execution'

/** 证据归档根目录（相对工程根）。 */
export const ENGINEERING_EVIDENCE_DIR = '06_TESTS/evidence'
/** 证据来源：宿主驱动执行（只读证据，非交付授权票据）。 */
export type EngineeringEvidenceSource = 'driver-execution'

export interface EvidenceTestMeta {
  runId: string
  testId: string
  target: string
  /** 来源固定为宿主驱动执行——归档不承载交付授权。 */
  source: EngineeringEvidenceSource
  generatedAt: string
  /** 绑定批准时的工程指纹（与交付门同一 evidenceDigest）。 */
  evidenceDigest: string
  status: 'pass' | 'fail' | 'error' | 'blocked'
  reason: string | null
  coveredUs: string[]
}

export interface EvidenceIndexEntry {
  testId: string
  status: string
  sha256: string
  generatedAt: string
}

export interface EvidenceIndex {
  schemaVersion: 1
  runId: string
  generatedAt: string
  source: EngineeringEvidenceSource
  tests: EvidenceIndexEntry[]
}

function evidenceRoot(projectDir: string): string {
  return join(projectDir, ENGINEERING_EVIDENCE_DIR)
}
function testDir(projectDir: string, runId: string, testId: string): string {
  return join(evidenceRoot(projectDir), runId, testId)
}
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

/**
 * 归档单条测试证据（evidence.json）到 06_TESTS/evidence/<runId>/<testId>/。
 * 返回 { path, sha256 }（sha256 = evidence.json 内容哈希，供索引登记）。
 */
export function archiveEngineeringTestEvidence(
  projectDir: string,
  result: EngineeringExecutionResult,
  runId: string,
  generatedAt: string = new Date().toISOString(),
): { path: string; sha256: string } {
  const dir = testDir(projectDir, runId, result.testId)
  mkdirSync(dir, { recursive: true })
  const meta: EvidenceTestMeta = {
    runId,
    testId: result.testId,
    target: result.target,
    source: 'driver-execution',
    generatedAt,
    evidenceDigest: result.evidenceDigest,
    status: result.status,
    reason: result.reason,
    coveredUs: result.coveredUs,
  }
  const payload = {
    schemaVersion: 1,
    meta,
    checks: result.checks,
    ...(result.driverIo ? { driverIo: result.driverIo } : {}),
  }
  const json = JSON.stringify(payload, null, 2)
  const hash = sha256(json)
  writeJsonFileAtomic(join(dir, 'evidence.json'), payload)
  return { path: join(dir, 'evidence.json'), sha256: hash }
}

/** 写 runId 级索引 index.json（含每条 testId 的 hash/状态/时间）；返回索引路径。 */
export function writeEngineeringEvidenceIndex(
  projectDir: string,
  runId: string,
  entries: EvidenceIndexEntry[],
  generatedAt: string = new Date().toISOString(),
): string {
  const index: EvidenceIndex = { schemaVersion: 1, runId, generatedAt, source: 'driver-execution', tests: entries }
  const runDir = join(evidenceRoot(projectDir), runId)
  mkdirSync(runDir, { recursive: true })
  const path = join(runDir, 'index.json')
  writeJsonFileAtomic(path, index)
  return path
}

/** 读取 runId 级索引（重启后审阅历史）；缺失/损坏返回 null。 */
export function readEngineeringEvidenceIndex(projectDir: string, runId: string): EvidenceIndex | null {
  return readJsonFileSafe<EvidenceIndex>(join(evidenceRoot(projectDir), runId, 'index.json'))
}

/** 读取单条测试证据（重启后审阅）；缺失/损坏返回 null。 */
export function readEngineeringTestEvidence(projectDir: string, runId: string, testId: string): { meta: EvidenceTestMeta; checks: unknown[] } | null {
  return readJsonFileSafe<{ meta: EvidenceTestMeta; checks: unknown[] }>(join(testDir(projectDir, runId, testId), 'evidence.json'))
}
