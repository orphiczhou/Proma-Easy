/** 非浏览器工程测试汇总：全部计划逐项执行，辅助结果不冒充用户故事覆盖。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureEngineeringEvidence, ENGINEERING_CONTRACT_PATH, parseEngineeringContract } from './nanju-engineering-contract'
import { parseUserStories } from './nanju-user-stories'
import { EngineeringExecutionBlocked, runRegisteredEngineeringTest } from './nanju-engineering-execution'
import type { EngineeringEvidence } from './nanju-engineering-contract'
import type { EngineeringExecutionResult, EngineeringExecutionServices } from './nanju-engineering-execution'

export interface EngineeringSuiteResult {
  verdict: 'pass' | 'fail' | 'error' | 'blocked'
  reason: string | null
  evidence: EngineeringEvidence | null
  tests: EngineeringExecutionResult[]
  coveredUs: string[]
  uncoveredUs: string[]
  /** 项目测试驱动的语义真实性仍需独立核验，尤其是系统/设备能力。 */
  coverageUnverified: string[]
}
export const ENGINEERING_DRIVER_EVIDENCE_BOUNDARY = '项目驱动记录的断言不等于独立观察到真实系统行为；桌面热键、设备、服务及外部应用效果须另有实际验收证据。'

export async function runEngineeringSuite(projectDir: string, services: EngineeringExecutionServices, signal: AbortSignal, onProgress?: (counts: { current: number; total: number; passed: number; failed: number; skipped: number }) => void): Promise<EngineeringSuiteResult> {
  const base: EngineeringSuiteResult = { verdict: 'blocked', reason: null, evidence: null, tests: [], coveredUs: [], uncoveredUs: [], coverageUnverified: [ENGINEERING_DRIVER_EVIDENCE_BOUNDARY] }
  const captured = captureEngineeringEvidence(projectDir)
  if (!captured.evidence) return { ...base, reason: captured.problems.join('；') }
  base.evidence = captured.evidence
  let raw: string
  let stories: string[]
  try {
    raw = readFileSync(join(projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8')
    stories = parseUserStories(readFileSync(join(projectDir, '01_PRD/prd.md'), 'utf-8'))
  } catch { return { ...base, reason: '工程契约或PRD不可读' } }
  const contract = parseEngineeringContract(raw).contract
  if (!contract) return { ...base, reason: '工程契约不完整' }
  const planned = new Set(contract.tests.filter((test) => test.layer === 'acceptance').flatMap((test) => test.covers.map((id) => `US-${String(Number(id.slice(3))).padStart(2, '0')}`)))
  base.uncoveredUs = stories
  if (!stories.length || stories.some((id) => !planned.has(id)) || [...planned].some((id) => !stories.includes(id))) return { ...base, reason: '工程测试计划与当前PRD用户故事不对应' }
  const notify = (): void => {
    try { onProgress?.({ current: base.tests.length, total: contract.tests.length,
      passed: base.tests.filter((test) => test.status === 'pass').length,
      failed: base.tests.filter((test) => test.status === 'fail' || test.status === 'error').length,
      skipped: base.tests.filter((test) => test.status === 'blocked').length }) } catch { /* 进度展示异常不影响测试 */ }
  }
  notify()
  // 先检查全部驱动是否可用，避免前几项获批执行后才发现后续根本不能运行。
  for (const test of contract.tests) {
    if (signal.aborted) return { ...base, reason: '测试已取消' }
    const drivers = services.drivers.filter((driver) => driver.adapter === test.adapter)
    if (drivers.length !== 1) return { ...base, reason: '测试驱动未就绪：' + test.id + '（' + test.adapter + '）' }
    try {
      const reason = drivers[0]!.preflight?.({ projectDir, test, evidence: captured.evidence, signal })
      if (reason) return { ...base, reason }
    } catch (error) {
      if (signal.aborted) return { ...base, reason: '测试已取消' }
      if (error instanceof EngineeringExecutionBlocked) return { ...base, reason: error.message }
      return { ...base, verdict: 'error', reason: '测试预检异常：' + (error instanceof Error ? error.message : String(error)) }
    }
  }
  for (const test of contract.tests) {
    const result = await runRegisteredEngineeringTest({ projectDir, test, evidence: captured.evidence, signal }, services)
    base.tests.push(result)
    notify()
    if (result.status === 'blocked') return { ...base, reason: result.reason }
    if (result.status === 'error') return { ...base, verdict: 'error', reason: result.reason }
  }
  if (captureEngineeringEvidence(projectDir).evidence?.digest !== captured.evidence.digest) return { ...base, reason: '测试期间版本变化，汇总结果作废' }
  base.coveredUs = [...new Set(base.tests.flatMap((test) => test.coveredUs))]
  base.uncoveredUs = stories.filter((id) => !base.coveredUs.includes(id))
  const failed = base.tests.some((test) => test.status !== 'pass') || base.uncoveredUs.length > 0
  if (failed) return { ...base, verdict: 'fail', reason: '部分测试或用户故事检查未通过' }
  // 真实能力证据（W-I B-f）：只提供项目脚本结果的注册驱动不能独立确认 requiresReal。
  // 原「一律硬拦」改为**逐项**走宿主门禁（观察期 API，不要求 ack、不消费）：
  // - 宿主未接入（无 hook / available=false）→ 保持原硬拦语义（不能据此交付）；
  // - 已接入 → 逐项判定，缺证据时**指出具体 testId**（不静默、不整片拦）；
  // - 无论结论如何，**已记录的覆盖边界编码必须合流进 coverageUnverified**（不丢弃边界事实）。
  const realTests = contract.tests.filter((test) => test.requiresReal)
  if (realTests.length > 0) {
    const resolver = services.resolveRealEvidence
    if (!resolver) return { ...base, reason: '驱动检查已完成，但真实系统行为的独立验收证据尚未接入，不能据此交付。' }
    let outcome: ReturnType<NonNullable<EngineeringExecutionServices['resolveRealEvidence']>>
    try {
      outcome = resolver({
        projectDir,
        tests: realTests.map((test) => ({ testId: test.id, target: test.target, covers: test.covers, requiresReal: true })),
      })
    } catch (error) {
      return { ...base, reason: '真实能力证据门禁异常：' + (error instanceof Error ? error.message : String(error)) }
    }
    base.coverageUnverified = [...new Set([...base.coverageUnverified, ...(outcome?.boundaryCodes ?? [])])]
    if (outcome?.available !== true) return { ...base, reason: '驱动检查已完成，但真实系统行为的独立验收证据尚未接入，不能据此交付。' }
    const first = outcome.rejections?.[0]
    if (first) {
      return { ...base, reason: '真实能力证据未齐备：' + first.message + '（测试项 ' + (first.testId ?? realTests[0]!.id) + '）' }
    }
  }
  return { ...base, verdict: 'pass', reason: null }
}
