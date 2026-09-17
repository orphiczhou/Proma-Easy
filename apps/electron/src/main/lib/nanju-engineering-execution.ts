/** 工程测试执行协议。注册驱动才可运行；批准不等于OS沙箱，结构结果不代替真实产品验收。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureEngineeringEvidence, ENGINEERING_CONTRACT_PATH, parseEngineeringContract } from './nanju-engineering-contract'
import type { EngineeringEvidence, EngineeringTestPlan } from './nanju-engineering-contract'

export class EngineeringExecutionBlocked extends Error {}

export interface EngineeringExecutionInput {
  projectDir: string
  test: EngineeringTestPlan
  evidence: EngineeringEvidence
  signal: AbortSignal
}
export interface EngineeringRegisteredDriver {
  adapter: EngineeringTestPlan['adapter']
  /** 无副作用环境预检；在请求批准前说明缺失项。 */
  preflight?(input: EngineeringExecutionInput): string | null
  /** 返回实际执行记录；宿主不信任外部verdict，统一验证结构与断言。 */
  execute(input: EngineeringExecutionInput): Promise<unknown>
}
/**
 * W-I B-f：观察期真实能力证据门禁的**宿主钩子入参**（只放 `requiresReal` 的测试）。
 * 结构类型（不 import 门禁模块）——suite 只负责「问」，宿主负责「答」，
 * registry/时钟/观察点等全部留在宿主侧（不经 services 对项目可见路径外泄）。
 */
export interface EngineeringSuiteRealEvidenceRequest {
  projectDir: string
  tests: ReadonlyArray<{ testId: string; target: string; covers: readonly string[]; requiresReal: boolean }>
}

/** 宿主门禁答复：`available:false`/缺省即「未接入观察器」（suite 维持原硬拦语义）。 */
export interface EngineeringSuiteRealEvidenceOutcome {
  available: boolean
  /** 逐项拒绝（空数组 = 证据齐备）；reason 取 REAL 门禁 reason 全集。 */
  rejections: ReadonlyArray<{ testId: string | null; reason: string; message: string }>
  /** 覆盖边界编码（suite 合流进 coverageUnverified，不静默丢弃）。 */
  boundaryCodes: readonly string[]
}

export interface EngineeringExecutionServices {
  drivers: readonly EngineeringRegisteredDriver[]
  /** 实际宿主必须接单次真人批准；不能用模型输出或会话白名单代替。 */
  approve(input: EngineeringExecutionInput): Promise<boolean>
  /**
   * W-I B-f：观察期真实能力证据判定（宿主观测器/门禁）。缺省 = 未接入 → suite 维持
   * 「真实系统行为证据尚未接入」硬拦。**不要求 ack、不消费**（交付另走 validate+consume）。
   */
  resolveRealEvidence?: (request: EngineeringSuiteRealEvidenceRequest) => EngineeringSuiteRealEvidenceOutcome
}
export interface EngineeringCheckResult {
  storyId: string | null
  label: string
  expected: string
  actual: string
  evidence: string[]
  passed: boolean
}
export interface EngineeringExecutionResult {
  testId: string
  target: string
  status: 'pass' | 'fail' | 'error' | 'blocked'
  reason: string | null
  coveredUs: string[]
  checks: EngineeringCheckResult[]
  evidenceDigest: string
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function normalizeStory(value: string): string {
  return `US-${String(Number(value.slice(3))).padStart(2, '0')}`
}

/** 结果必须绑定已批准的测试对象；US来源于契约，不能由驱动任意扩大覆盖。 */
function interpret(input: EngineeringExecutionInput, raw: unknown): EngineeringExecutionResult {
  const base: EngineeringExecutionResult = { testId: input.test.id, target: input.test.target, status: 'error', reason: null, coveredUs: [], checks: [], evidenceDigest: input.evidence.digest }
  const invalid = (reason: string): EngineeringExecutionResult => ({ ...base, reason: '测试驱动结果不可用：' + reason })
  if (!object(raw) || raw.testId !== input.test.id || raw.target !== input.test.target) return invalid('测试编号或被测产物不对应')
  if (typeof raw.exitCode !== 'number' || !Number.isInteger(raw.exitCode)) return invalid('缺少实际退出状态')
  if (!Array.isArray(raw.checks) || !raw.checks.length) return invalid('没有行为检查，退出成功不能代替验收')
  const planned = new Set(input.test.covers.map(normalizeStory))
  const checks: EngineeringCheckResult[] = []
  for (const row of raw.checks) {
    if (!object(row) || !nonempty(row.label) || typeof row.expected !== 'string' || typeof row.actual !== 'string'
      || !Array.isArray(row.evidence) || !row.evidence.length || !row.evidence.every(nonempty)) return invalid('检查缺少期望、实际或证据记录')
    let storyId: string | null = null
    if (input.test.layer === 'acceptance') {
      if (typeof row.storyId !== 'string' || !/^US-\d+$/i.test(row.storyId)) return invalid('验收检查缺少用户故事编号')
      storyId = normalizeStory(row.storyId)
      if (!planned.has(storyId)) return invalid('检查引用了本项计划以外的用户故事')
    } else if (row.storyId !== null && row.storyId !== undefined) return invalid('辅助测试不得登记为用户故事覆盖')
    checks.push({ storyId, label: row.label, expected: row.expected, actual: row.actual, evidence: row.evidence, passed: row.expected === row.actual })
  }
  const observed = new Set(checks.flatMap((check) => check.storyId ? [check.storyId] : []))
  if ([...planned].some((story) => !observed.has(story))) return invalid('部分计划用户故事没有检查记录')
  const passed = raw.exitCode === 0 && checks.every((check) => check.passed)
  return { ...base, status: passed ? 'pass' : 'fail', reason: passed ? null : '实际结果与期望不符或驱动退出失败', checks,
    coveredUs: [...planned].filter((story) => raw.exitCode === 0 && checks.filter((check) => check.storyId === story).every((check) => check.passed)) }
}

export async function runRegisteredEngineeringTest(input: EngineeringExecutionInput, services: EngineeringExecutionServices): Promise<EngineeringExecutionResult> {
  const blocked = (reason: string): EngineeringExecutionResult => ({ testId: input.test.id, target: input.test.target, status: 'blocked', reason, coveredUs: [], checks: [], evidenceDigest: input.evidence.digest })
  const current = (): boolean => captureEngineeringEvidence(input.projectDir).evidence?.digest === input.evidence.digest
  if (input.signal.aborted) return blocked('测试已取消')
  const drivers = services.drivers.filter((driver) => driver.adapter === input.test.adapter)
  if (drivers.length !== 1) return blocked('测试驱动未注册或注册不唯一：' + input.test.adapter)
  if (!current()) return blocked('工程版本已变化，请重新准备测试')
  try {
    const prerequisite = drivers[0]!.preflight?.(input)
    if (prerequisite) return blocked(prerequisite)
  } catch (error) {
    if (input.signal.aborted) return blocked('测试已取消')
    if (error instanceof EngineeringExecutionBlocked) return blocked(error.message)
    return { ...blocked('测试预检异常：' + (error instanceof Error ? error.message : String(error))), status: 'error' }
  }
  // 防止调用方的test对象与指纹对应的契约不一致；批准界面和驱动执行使用同一份计划。
  try {
    const contract = parseEngineeringContract(readFileSync(join(input.projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8')).contract
    const declared = contract?.tests.find((test) => test.id === input.test.id)
    if (!declared || JSON.stringify(declared) !== JSON.stringify(input.test)) return blocked('测试计划与当前契约不对应')
  } catch { return blocked('工程契约不可读') }
  try {
    const approved = await services.approve(input)
    if (!approved || input.signal.aborted) return blocked(input.signal.aborted ? '测试已取消' : '用户未批准本次测试执行')
    if (!current()) return blocked('等待批准期间工程版本变化，旧批准失效')
    const raw = await drivers[0]!.execute(input)
    if (input.signal.aborted) return blocked('测试已取消，本轮结果不用于交付')
    if (!current()) return blocked('执行期间工程版本变化，本轮结果已作废')
    return interpret(input, raw)
  } catch (error) {
    if (input.signal.aborted) return blocked('测试已取消')
    if (error instanceof EngineeringExecutionBlocked) return blocked(error.message)
    return { ...blocked('测试执行异常：' + (error instanceof Error ? error.message : String(error))), status: 'error' }
  }
}
