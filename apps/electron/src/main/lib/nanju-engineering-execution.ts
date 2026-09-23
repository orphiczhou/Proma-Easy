/** 工程测试执行协议。注册驱动才可运行；批准不等于OS沙箱，结构结果不代替真实产品验收。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureEngineeringEvidence, ENGINEERING_CONTRACT_PATH, parseEngineeringContract } from './nanju-engineering-contract'
import type { EngineeringEvidence, EngineeringTestPlan } from './nanju-engineering-contract'
import { isEngineeringDriverIo, type EngineeringDriverIo } from './nanju-engineering-driver-io'

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
  /** P0-2：驱动 stdout/stderr 尾部（管道后）；error 轮由 gwt 报告层生成诊断摘要与旁挂。 */
  driverIo?: EngineeringDriverIo
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

/**
 * Task 11（2026-09-20）：结构化环境阻塞（新协议）宿主校验。
 * 骨架 emit_blocked 输出 {blocked:{kind:'environment',missing:[...],scenarioExecuted:false},checks:[]}
 * 并 exit 2。宿主必须校验标记来源、诊断与「被测场景未执行」声明才认定为 blocked；
 * 否则归 error（fail-closed）——产品 fail / 崩溃 / 坏 schema 与伪造 exit 2 一律不得洗成环境阻塞。
 */
function interpretBlocked(base: EngineeringExecutionResult, raw: Record<string, unknown>, invalid: (reason: string) => EngineeringExecutionResult): EngineeringExecutionResult {
  if (raw.exitCode !== 2) return invalid('阻塞标记与退出码不一致（结构化 blocked 必须伴随 exit 2，实际 ' + String(raw.exitCode) + '）')
  const blocked = raw.blocked
  if (!object(blocked)) return invalid('阻塞标记形态非法')
  if (blocked.kind !== 'environment') return invalid('阻塞标记 kind 非法：' + (blocked.kind === undefined ? '缺失' : String(blocked.kind)) + '（仅接受 environment）')
  if (!Array.isArray(blocked.missing) || blocked.missing.length === 0 || !blocked.missing.every(nonempty)) return invalid('阻塞诊断缺少缺失项（missing 必须是非空字符串数组）')
  if (blocked.scenarioExecuted !== false) return invalid('阻塞标记声称被测场景已执行，与 blocked 语义冲突')
  if (Array.isArray(raw.checks) && raw.checks.length > 0) return invalid('阻塞结果不得携带产品检查项')
  if (raw.error !== undefined) return invalid('阻塞结果不得同时携带错误信息')
  return { ...base, status: 'blocked', reason: `环境阻塞：缺失 ${blocked.missing.join('、')}（驱动未执行被测场景，不计入产品修复）`, coveredUs: [], checks: [] }
}

/**
 * Task 11（2026-09-20）：旧协议 exit-2 自检拦截兼容。新骨架改用结构化 blocked 标记后，
 * 已复制到存量工程的旧骨架仍走此路径。exit 2 是自检拦截出口：环境缺失与 schema 违规共用。
 *
 * 「环境前置自检」单独 label 不是可信签名——必须同时满足：单条 check + label 逐字 +
 * expected==='环境就绪' + actual 以「缺失: 」前缀且非空 + evidence 为非空字符串数组；
 * 任一不符都不被视为环境阻塞（伪装产品失败落回 fail/error，异常 exit 2 不被洗成 blocked）。
 * 「输出schema自检」→ error（坏 schema 不得洗成 blocked）。
 */
function isLegacyEnvironmentBlock(check: Record<string, unknown>): string | null {
  if (check.label !== '环境前置自检') return null
  if (check.expected !== '环境就绪') return null
  if (typeof check.actual !== 'string' || !check.actual.startsWith('缺失: ')) return null
  const missing = check.actual.slice('缺失: '.length).trim()
  if (!missing) return null
  if (!Array.isArray(check.evidence) || !check.evidence.length || !check.evidence.every((item): item is string => typeof item === 'string' && item.trim().length > 0)) return null
  return missing
}

function interpretLegacyExit2(base: EngineeringExecutionResult, raw: Record<string, unknown>, invalid: (reason: string) => EngineeringExecutionResult): EngineeringExecutionResult | null {
  const checks = raw.checks
  const single = Array.isArray(checks) && checks.length === 1 && object(checks[0]) ? checks[0] : null
  if (single) {
    const missing = isLegacyEnvironmentBlock(single)
    if (missing !== null) return { ...base, status: 'blocked', reason: `环境阻塞：${missing}（驱动未执行被测场景，不计入产品修复）`, coveredUs: [], checks: [] }
    if (single.label === '输出schema自检') return invalid('驱动输出违反宿主协议 schema（自检拦截）')
  }
  // 非旧自检签名的 exit 2：不在此拦截，落回正常产品判定（非零退出即 fail；空 checks 即 error）——
  // 异常 exit 2 不会被洗成 blocked。
  return null
}

/** 结果必须绑定已批准的测试对象；US来源于契约，不能由驱动任意扩大覆盖。 */
function interpret(input: EngineeringExecutionInput, raw: unknown): EngineeringExecutionResult {
  const base: EngineeringExecutionResult = { testId: input.test.id, target: input.test.target, status: 'error', reason: null, coveredUs: [], checks: [], evidenceDigest: input.evidence.digest }
  // P0-2：driverIo 由宿主 process-driver 附加（非驱动自报）；形态异常时静默丢弃不阻断判定。
  if (object(raw) && isEngineeringDriverIo(raw.driverIo)) base.driverIo = raw.driverIo
  const invalid = (reason: string): EngineeringExecutionResult => ({ ...base, reason: '测试驱动结果不可用：' + reason })
  if (!object(raw) || raw.testId !== input.test.id || raw.target !== input.test.target) return invalid('测试编号或被测产物不对应')
  if (typeof raw.exitCode !== 'number' || !Number.isInteger(raw.exitCode)) return invalid('缺少实际退出状态')
  // Task 11（2026-09-20）：结构化环境阻塞（新协议）与旧协议 exit-2 自检拦截的宿主识别。
  // exit 2 本身不足以证明 blocked——先校验结构化标记 / 旧签名，非自检签名落回产品判定。
  if (raw.blocked !== undefined) return interpretBlocked(base, raw, invalid)
  if (raw.exitCode === 2) {
    const legacy = interpretLegacyExit2(base, raw, invalid)
    if (legacy !== null) return legacy
  }
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
    // P0-2：进程驱动错误携带的 IO 尾部随 error 轮结果透传（崩溃/超时/非法 JSON 同样有尾部）
    const carrier = error instanceof Error ? (error as unknown as { driverIo?: unknown }) : null
    const io = carrier && isEngineeringDriverIo(carrier.driverIo) ? carrier.driverIo : undefined
    return { ...blocked('测试执行异常：' + (error instanceof Error ? error.message : String(error))), status: 'error', ...(io ? { driverIo: io } : {}) }
  }
}
