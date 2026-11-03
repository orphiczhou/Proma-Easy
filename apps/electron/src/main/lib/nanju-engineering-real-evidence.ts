/**
 * P1 REAL-P 独立能力证据协议层（纯协议，不接设备、不接共享热文件）。
 *
 * 只做协议：证据来源分级、宿主内部登记、绑定校验、canonical 报告摘要、
 * validate 与 consume 分离、真人见证/覆盖边界确认的宿主收据。本文件不读盘、
 * 不联网、不注入输入、不录音；时钟与摘要一律依赖注入，便于确定性测试。
 *
 * 边界（与 W3 架构裁决 §D、REAL.md 一致）：
 * - project-driver 结果永不算独立能力证据；声明 project-driver 生产者一律拒绝。
 * - machineObservable:true 的观察点必须由 host-observer 实测，真人见证不能替代。
 * - machineObservable:false 的观察点必须有同一会话的真人见证。
 * - 登记只接受宿主签发的观察票据；项目侧落盘的 report 文件不是登记入口。
 * - hostRun 重启即失效：新进程的 registry 为空，旧记录/旧收据不再构成证据。
 *
 * REAL-review 返工（本版）：
 * - R1：validate 与 consume 都先用 registryStates 确认 registry 是工厂产物，
 *   非工厂对象一律 fail-closed，不再依赖调用方自觉。
 * - A：真人见证不得只是字符串。新增 opaque HumanWitnessReceipt，只能由
 *   registry.issueHumanWitnessReceipt 依据真实单次批准（requestId + allowed）签发，
 *   并由宿主时钟绑定 session/testId/point/时间；draft 只消费收据，普通 witness 对象
 *   不可信。协议层无法证明 requestId 真实，该对账由 I 在接线处保证。
 * - B：覆盖边界确认不得由宿主自动推导。新增 opaque BoundaryAckReceipt，
 *   只能由真人确认回调创建，绑定 requestId、明确展示的 boundaryCodes 与
 *   observationRunIds；requiresReal 门**永远**要求收据，删除了 requireAck 布尔。
 * - C：时钟拆为 epoch（墙钟，可回拨）与 monotonic（单调，不可回拨）双注入；
 *   新鲜度用单调钟，墙钟回拨不会把旧观察误判为新。
 * - canonical 只接受 plain JSON object / 有限数字 / 无 undefined；Date、类实例、
 *   函数、symbol、bigint 一律拒绝。
 * - registry 的 entries/tickets/收据/消费墓碑都有按 session/age 的清理 API 与上限，
 *   超限 fail-closed。
 * - consume 在全量校验后于同一同步块内原子标墓碑，不跨 await。
 *
 * 终审收口轮（REAL-review-2 后）新增：
 * - INV-C1：观察年龄（记录/见证收据/ack 收据）一律由**宿主（registry）时钟**计算；
 *   调用方 clock 只作为“同源声明”参与一致性校验，偏差超 clockSkewToleranceMs 即
 *   fail-closed，从而不可能因基准不同而低估 age。
 * - 见证收据单独校验新鲜度（见证很早、记录很新时仍须重新见证）。
 * - 窗口参数非正/非有限在构造期 TypeError 拒绝（编程错误 fail-fast），不降级为门禁结论。
 * - 分层 API：validateEngineeringRealEvidenceCompleteness（观察期，不要求 ack）与
 *   validateEngineeringRealEvidence / consumeEngineeringRealEvidence（交付期，必要求 ack）。
 */
import { createHash } from 'node:crypto'

/** requiresReal 证据来源分级。项目驱动永不算独立能力证据。 */
export type EngineeringEvidenceProvenance = 'project-driver' | 'host-observer' | 'human-witness'

/** 门禁拒绝原因。每一条都对应一个可执行指引，不静默放行。 */
export type EngineeringRealGateReason =
  | 'requires-real-unattested'
  | 'project-driver-not-independent'
  | 'real-evidence-untrusted-source'
  | 'real-evidence-stale'
  | 'real-evidence-expired'
  | 'real-evidence-replayed'
  | 'real-evidence-tampered'
  | 'real-evidence-binding-mismatch'
  | 'real-evidence-time-invalid'
  | 'host-observation-missing'
  | 'human-witness-unverified'
  | 'human-witness-missing'
  | 'coverage-unverified-unacked'
  | 'real-evidence-capacity-exceeded'

/** 覆盖边界编码：真人对这些稳定编码做确认，不复述自然语言文本。 */
export const ENGINEERING_REAL_BOUNDARY_CODES = {
  projectDriverNotIndependent: 'real-boundary:project-driver-not-independent',
  hostObservationScope: 'real-boundary:host-observation-scope-device-time-bound',
  humanWitnessLimited: 'real-boundary:human-witness-limited-to-non-machine-points',
} as const

/** 注入时钟：epoch 为墙钟（可回拨），monotonic 为单调（不可回拨）。 */
export interface EngineeringRealClock {
  epochNow(): number
  monotonicNow(): number
}

export interface EngineeringObservationPoint {
  /** 稳定标识，如 'linux.global-hotkey.delivered'。 */
  id: string
  kind: 'hotkey' | 'recording' | 'asr' | 'cursor-input' | 'process' | 'network'
  machineObservable: boolean
  /** 宿主持有的观察接口名；机器可观察点必须与该接口实测一致，禁止项目自报。 */
  observedVia: string
}

export interface EngineeringEvidenceProducer {
  provenance: EngineeringEvidenceProvenance
  observerId: string
  observerVersion: string
  /** 仅 human-witness 生产者携带。 */
  witnessSessionId?: string
}

/** 设备绑定：证明哪台机器、哪个会话、哪个音频源/加速器/靶应用。 */
export interface EngineeringDeviceBinding {
  platform: string
  session: 'x11' | 'wayland' | 'headless'
  display?: string
  audioSource?: string
  accelerator?: string
  targetApp?: string
  networkEndpoint?: string
}

/** 单轮观察绑定：producer+版本+testId/target/covers/evidenceDigest/契约/session/device/hostRun/time。 */
export interface EngineeringRealEvidenceBinding {
  schemaVersion: 1
  producer: EngineeringEvidenceProducer
  projectId: string
  sessionId: string
  /** 宿主进程实例；与当前实例不符即视作重放，重启后失效。 */
  hostRunId: string
  evidenceDigest: string
  contractSha256: string
  testId: string
  target: string
  covers: string[]
  device: EngineeringDeviceBinding
  /** 本轮一次性标识（防重放）。 */
  observationRunId: string
  startedAt: number
  approvedAt: number
  finishedAt: number
}

export interface EngineeringRealObservation {
  pointId: string
  expected: string
  actual: string
  /** 实际使用的宿主接口名 + 值，非项目自报。 */
  observedVia: string
  passed: boolean
}

/** 真人见证记录（仅 machineObservable:false 项），由收据在登记时展开。 */
export interface EngineeringHumanWitness {
  pointId: string
  storyId: string
  assertion: string
  witnessedAt: number
  sessionId: string
  /** 产生该见证的真实单次批准 requestId，便于交付时对账。 */
  requestId: string
}

/** reportDigest 的规范输入范围（不含 reportDigest 本身，避免自指）。 */
export interface EngineeringRealEvidenceDigestInput {
  binding: EngineeringRealEvidenceBinding
  observations: EngineeringRealObservation[]
  witnesses: EngineeringHumanWitness[]
  verdict: 'attested' | 'rejected'
  coverageBoundaryCodes: string[]
  approval: { requestId: string; cancelled: boolean }
}

export interface EngineeringRealEvidenceRecord extends EngineeringRealEvidenceDigestInput {
  /** 观察材料规范序列化后的摘要（防事后编辑）。 */
  reportDigest: string
}

/**
 * 宿主内部登记草稿。结构由宿主观察器填充，producer/hostRunId 由 registry 盖章，
 * 项目侧无法表达这些字段。register 仍按 unknown 校验，因为草稿被视为不可信输入。
 */
export interface EngineeringRealEvidenceDraft {
  testId: string
  target: string
  covers: string[]
  evidenceDigest: string
  contractSha256: string
  sessionId: string
  device: EngineeringDeviceBinding
  observationRunId: string
  startedAt: number
  approvedAt: number
  finishedAt: number
  observations: EngineeringRealObservation[]
  /** 只能放 registry 签发的见证收据；普通 witness 对象会被拒绝。 */
  witnesses: EngineeringHumanWitnessReceipt[]
  verdict: 'attested' | 'rejected'
  coverageBoundaryCodes: string[]
  approval: { requestId: string; cancelled: boolean }
  producer?: { provenance?: unknown; observerId?: unknown; observerVersion?: unknown }
}

/** 宿主观察票据；只有 registry.issueObservationTicket 能签发，项目文件无法构造。 */
export interface EngineeringHostObservationTicket {
  readonly kind: 'host-observation-ticket'
}

/** 真人见证收据（opaque）。字段不可信，事实只在 registry 内部。 */
export interface EngineeringHumanWitnessReceipt {
  readonly kind: 'host-human-witness-receipt'
}

/** 覆盖边界确认收据（opaque）。字段不可信，事实只在 registry 内部。 */
export interface EngineeringBoundaryAckReceipt {
  readonly kind: 'host-boundary-ack-receipt'
}

/** 签发真人见证收据的输入：必须来自真实单次批准的确认回调。 */
export interface EngineeringHumanWitnessDecision {
  /** 真实 permission_request 的 requestId。 */
  requestId: string
  /** 用户明确允许；false 即不签发收据。 */
  allowed: boolean
  testId: string
  sessionId: string
  pointId: string
  storyId: string
  assertion: string
}

/**
 * 签发覆盖边界确认收据的输入：必须来自真人确认回调，且 codes/runIds 是
 * **当时明确展示给真人**的内容；不允许宿主从记录推导后自动签署。
 */
export interface EngineeringBoundaryAckDecision {
  requestId: string
  allowed: boolean
  sessionId: string
  displayedBoundaryCodes: string[]
  displayedObservationRunIds: string[]
}

export interface EngineeringRealEvidenceEntry {
  readonly record: EngineeringRealEvidenceRecord
  /** true 表示已被最终交付消费；再交付即 real-evidence-replayed。 */
  readonly consumed: boolean
}

export type EngineeringRegistrationResult =
  | { ok: true; record: EngineeringRealEvidenceRecord }
  | { ok: false; reason: EngineeringRealGateReason; message: string }

/** registry 容量与保留窗口上限；超限一律 fail-closed。 */
export interface EngineeringRealEvidenceRegistryLimits {
  maxEntries: number
  maxTickets: number
  maxWitnessReceipts: number
  maxBoundaryAckReceipts: number
  maxConsumedRunIds: number
  entryRetentionMonotonicMs: number
  ticketRetentionMonotonicMs: number
  receiptRetentionMonotonicMs: number
  consumedRetentionMonotonicMs: number
}

export const ENGINEERING_REAL_DEFAULT_LIMITS: EngineeringRealEvidenceRegistryLimits = {
  maxEntries: 64,
  maxTickets: 64,
  maxWitnessReceipts: 64,
  maxBoundaryAckReceipts: 32,
  maxConsumedRunIds: 256,
  entryRetentionMonotonicMs: 3_600_000,
  ticketRetentionMonotonicMs: 900_000,
  receiptRetentionMonotonicMs: 900_000,
  consumedRetentionMonotonicMs: 3_600_000,
}

export interface EngineeringRealEvidenceCleanupOptions {
  /** 只清理该会话的对象；缺省清理全部会话。 */
  sessionId?: string
  /** 覆盖各保留窗口（单调毫秒）；缺省用 limits 中的分类窗口。 */
  maxAgeMonotonicMs?: number
}

export interface EngineeringRealEvidenceCleanupReport {
  entries: number
  tickets: number
  witnessReceipts: number
  boundaryAckReceipts: number
  consumed: number
}

export interface EngineeringRealEvidenceRegistryOptions {
  hostRunId: string
  projectId: string
  observer: { observerId: string; observerVersion: string }
  clock: EngineeringRealClock
  /** 注入摘要（canonical 字符串 -> 摘要）。缺省 sha256 十六进制。 */
  digestOf?: (canonical: string) => string
  limits?: Partial<EngineeringRealEvidenceRegistryLimits>
}

export interface EngineeringRealEvidenceRegistry {
  readonly hostRunId: string
  readonly projectId: string
  readonly digestOf: (canonical: string) => string
  readonly limits: EngineeringRealEvidenceRegistryLimits
  /** 满额返回 null（fail-closed）；票据绑定 testId 与 sessionId。 */
  issueObservationTicket(input: { testId: string; sessionId: string }): EngineeringHostObservationTicket | null
  /** 只有 allowed=true 且字段齐备才签发；满额返回 null。 */
  issueHumanWitnessReceipt(input: EngineeringHumanWitnessDecision): EngineeringHumanWitnessReceipt | null
  /** 只有 allowed=true 且字段齐备才签发；满额返回 null。 */
  issueBoundaryAckReceipt(input: EngineeringBoundaryAckDecision): EngineeringBoundaryAckReceipt | null
  /** 唯一登记入口：必须持有本 registry 签发且未使用的票据。 */
  register(ticket: unknown, draft: unknown): EngineeringRegistrationResult
  /** 项目侧 report 文件不是登记入口；此方法永远拒绝，仅用于显式暴露边界。 */
  registerProjectReportFile(raw: unknown): EngineeringRegistrationResult
  /** 幂等只读查询；不改变 registry 状态。 */
  peek(testId: string): EngineeringRealEvidenceEntry | null
  size(): number
  activeTestIds(): readonly string[]
  consumedRunIds(): readonly string[]
  /** 按 session/age 清理 entries、票据、收据与消费墓碑。 */
  cleanup(options?: EngineeringRealEvidenceCleanupOptions): EngineeringRealEvidenceCleanupReport
}

export interface EngineeringRealEvidenceTarget {
  testId: string
  target: string
  covers: string[]
  points: readonly EngineeringObservationPoint[]
}

export interface EngineeringRealEvidenceGateInput {
  registry: EngineeringRealEvidenceRegistry
  projectId: string
  sessionId: string
  /** 当前工程证据摘要：captureEngineeringEvidence(projectDir).evidence.digest。 */
  evidenceDigest: string
  /** 当前契约原文 sha256。 */
  contractSha256: string
  device: EngineeringDeviceBinding
  clock: EngineeringRealClock
  /** 仅传入 requiresReal 的测试及其宿主观察点定义；空数组即放行。 */
  tests: readonly EngineeringRealEvidenceTarget[]
  /** 必需的真人覆盖边界确认收据；没有 requireAck 开关，缺省即拒绝。 */
  ackReceipt?: EngineeringBoundaryAckReceipt
  /** 允许的单轮观察时长上限（毫秒），必须为正。 */
  maxObservationMs: number
  /** 观察完成（登记）后的新鲜度上限（单调毫秒），必须为正。 */
  maxEvidenceAgeMs: number
  /**
   * 调用方时钟与宿主时钟允许的最大偏差（毫秒），必须为正；缺省 2000。
   * 年龄一律由宿主（registry）时钟计算，本参数只用于检出调用方时钟基准被替换/漂移（INV-C1）。
   */
  clockSkewToleranceMs?: number
}

export interface EngineeringRealGateRejection {
  reason: EngineeringRealGateReason
  /** 具体到哪一项 requiresReal 测试；跨项校验（如 ack）为 null。 */
  testId: string | null
  message: string
}

/* ------------------------------------------------------------------ */
/* canonical 序列化与摘要                                               */
/* ------------------------------------------------------------------ */

/** 确定性规范序列化：只接受 plain JSON object / 有限数字 / 字符串 / 布尔 / null / 数组。 */
export function canonicalizeEngineeringValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON 不支持非有限数字')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalizeEngineeringValue(item)).join(',') + ']'
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('canonical JSON 只接受 plain JSON object')
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (item === undefined) throw new Error('canonical JSON 不支持 undefined：' + key)
      return [key, item] as const
    }).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + canonicalizeEngineeringValue(item)).join(',') + '}'
  }
  throw new Error('canonical JSON 不支持的类型：' + (typeof value === 'undefined' ? 'undefined' : typeof value))
}

/** 缺省摘要实现：sha256 十六进制。 */
export function sha256EngineeringDigest(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex')
}

/** 重算 reportDigest；门禁与登记共用同一口径。 */
export function computeEngineeringRealReportDigest(
  input: EngineeringRealEvidenceDigestInput,
  digestOf: (canonical: string) => string = sha256EngineeringDigest,
): string {
  return digestOf(canonicalizeEngineeringValue({
    binding: input.binding,
    observations: input.observations,
    witnesses: input.witnesses,
    verdict: input.verdict,
    coverageBoundaryCodes: input.coverageBoundaryCodes,
    approval: input.approval,
  }))
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                             */
/* ------------------------------------------------------------------ */

interface TicketFacts { testId: string; sessionId: string; issuedAtMonotonic: number; used: boolean }
interface WitnessFacts {
  testId: string; sessionId: string; pointId: string; storyId: string; assertion: string
  requestId: string; witnessedAtEpoch: number; issuedAtMonotonic: number; used: boolean
}
interface AckFacts {
  sessionId: string; requestId: string; displayedBoundaryCodes: string[]; displayedObservationRunIds: string[]
  issuedAtMonotonic: number; used: boolean
}
interface EntryFacts {
  record: EngineeringRealEvidenceRecord
  sessionId: string
  registeredAtMonotonic: number
  /** pointId -> 见证收据的宿主签发单调时刻；用于单独校验见证收据的新鲜度。 */
  witnessReceiptIssuedAtMonotonic: Map<string, number>
  consumedAtMonotonic: number | null
}
interface RegistryState {
  token: symbol
  hostRunId: string
  projectId: string
  observer: { observerId: string; observerVersion: string }
  clock: EngineeringRealClock
  digestOf: (canonical: string) => string
  limits: EngineeringRealEvidenceRegistryLimits
  entries: Map<string, EntryFacts>
  activeByTestId: Map<string, string>
  consumed: Map<string, { atMonotonic: number; sessionId: string }>
  tickets: Map<object, TicketFacts>
  witnessReceipts: Map<object, WitnessFacts>
  boundaryAckReceipts: Map<object, AckFacts>
}

/** registry 实例表：validate/consume 只认宿主工厂产物。 */
const registryStates = new WeakMap<object, RegistryState>()

/** 调用方时钟与宿主时钟的缺省允许偏差（毫秒）。 */
const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 2_000

/** 窗口参数必须在构造期即为正有限数；非法参数是编程错误，fail-fast 抛错而不降级为门禁结论。 */
function assertPositiveWindow(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('工程独立证据门禁参数 ' + name + ' 必须为正有限数（毫秒），实际为 ' + String(value))
  }
}

/** 构造期校验门禁窗口参数（含时钟偏差容差）。 */
function assertGateWindows(input: EngineeringRealEvidenceGateInput): void {
  assertPositiveWindow('maxObservationMs', input.maxObservationMs)
  assertPositiveWindow('maxEvidenceAgeMs', input.maxEvidenceAgeMs)
  if (input.clockSkewToleranceMs !== undefined) assertPositiveWindow('clockSkewToleranceMs', input.clockSkewToleranceMs)
}

/** 构造期校验 registry 上限与保留窗口：计数为非负有限整数，保留窗口为非负有限数。 */
function assertRegistryLimits(limits: EngineeringRealEvidenceRegistryLimits): void {
  const counts: readonly (keyof EngineeringRealEvidenceRegistryLimits)[] =
    ['maxEntries', 'maxTickets', 'maxWitnessReceipts', 'maxBoundaryAckReceipts', 'maxConsumedRunIds']
  for (const key of counts) {
    const value = limits[key]
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError('工程独立证据 registry 上限 ' + key + ' 必须为非负整数，实际为 ' + String(value))
    }
  }
  const retentions: readonly (keyof EngineeringRealEvidenceRegistryLimits)[] =
    ['entryRetentionMonotonicMs', 'ticketRetentionMonotonicMs', 'receiptRetentionMonotonicMs', 'consumedRetentionMonotonicMs']
  for (const key of retentions) {
    const value = limits[key]
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('工程独立证据 registry 保留窗口 ' + key + ' 必须为非负有限数（毫秒），实际为 ' + String(value))
    }
  }
}

const DEVICE_SESSIONS = ['x11', 'wayland', 'headless'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyText)
}
function optionalText(record: Record<string, unknown>, key: string): { ok: true; value?: string } | { ok: false } {
  const raw = record[key]
  if (raw === undefined) return { ok: true }
  return nonEmptyText(raw) ? { ok: true, value: raw } : { ok: false }
}
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort()
  const b = [...new Set(right)].sort()
  return a.length === b.length && a.every((item, index) => item === b[index])
}
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}
/** 仅删除 undefined 键；其余非法值仍会由 canonical 抛出并被上层归类。 */
function stripUndefinedKeys(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item
  return out
}

function readDevice(value: unknown): EngineeringDeviceBinding | null {
  if (!isRecord(value)) return null
  if (!nonEmptyText(value.platform)) return null
  if (typeof value.session !== 'string' || !(DEVICE_SESSIONS as readonly string[]).includes(value.session)) return null
  const display = optionalText(value, 'display')
  const audioSource = optionalText(value, 'audioSource')
  const accelerator = optionalText(value, 'accelerator')
  const targetApp = optionalText(value, 'targetApp')
  const networkEndpoint = optionalText(value, 'networkEndpoint')
  if (!display.ok || !audioSource.ok || !accelerator.ok || !targetApp.ok || !networkEndpoint.ok) return null
  return {
    platform: value.platform,
    session: value.session as EngineeringDeviceBinding['session'],
    ...(display.value === undefined ? {} : { display: display.value }),
    ...(audioSource.value === undefined ? {} : { audioSource: audioSource.value }),
    ...(accelerator.value === undefined ? {} : { accelerator: accelerator.value }),
    ...(targetApp.value === undefined ? {} : { targetApp: targetApp.value }),
    ...(networkEndpoint.value === undefined ? {} : { networkEndpoint: networkEndpoint.value }),
  }
}

function readObservations(value: unknown): EngineeringRealObservation[] | null {
  if (!Array.isArray(value)) return null
  const rows: EngineeringRealObservation[] = []
  for (const row of value) {
    if (!isRecord(row)) return null
    if (!nonEmptyText(row.pointId) || typeof row.expected !== 'string' || typeof row.actual !== 'string'
      || !nonEmptyText(row.observedVia) || typeof row.passed !== 'boolean') return null
    rows.push({ pointId: row.pointId, expected: row.expected, actual: row.actual, observedVia: row.observedVia, passed: row.passed })
  }
  return rows
}

interface ParsedDraft {
  testId: string
  target: string
  covers: string[]
  evidenceDigest: string
  contractSha256: string
  sessionId: string
  device: EngineeringDeviceBinding
  observationRunId: string
  startedAt: number
  approvedAt: number
  finishedAt: number
  observations: EngineeringRealObservation[]
  witnessReceipts: unknown[]
  verdict: 'attested' | 'rejected'
  coverageBoundaryCodes: string[]
  approval: { requestId: string; cancelled: boolean }
  producer?: Record<string, unknown>
}

function readDraft(value: unknown): { ok: true; draft: ParsedDraft } | { ok: false; message: string } {
  if (!isRecord(value)) return { ok: false, message: '登记草稿必须为对象' }
  const device = readDevice(value.device)
  if (!device) return { ok: false, message: '设备绑定字段不合法' }
  const observations = readObservations(value.observations)
  if (!observations) return { ok: false, message: '观察记录结构不合法' }
  if (!Array.isArray(value.witnesses)) return { ok: false, message: '真人见证必须为收据数组' }
  if (value.verdict !== 'attested' && value.verdict !== 'rejected') return { ok: false, message: 'verdict 必须为 attested 或 rejected' }
  if (!isRecord(value.approval) || !nonEmptyText(value.approval.requestId) || typeof value.approval.cancelled !== 'boolean') {
    return { ok: false, message: '批准信息结构不合法' }
  }
  if (!stringArray(value.coverageBoundaryCodes)) return { ok: false, message: '覆盖边界编码必须为非空字符串数组' }
  if (!nonEmptyText(value.testId) || !nonEmptyText(value.target) || !stringArray(value.covers)
    || !nonEmptyText(value.evidenceDigest) || !nonEmptyText(value.contractSha256)
    || !nonEmptyText(value.sessionId) || !nonEmptyText(value.observationRunId)
    || !finiteNumber(value.startedAt) || !finiteNumber(value.approvedAt) || !finiteNumber(value.finishedAt)) {
    return { ok: false, message: '绑定字段缺失或不合法' }
  }
  if (value.producer !== undefined && !isRecord(value.producer)) return { ok: false, message: 'producer 声明必须为对象' }
  return { ok: true, draft: {
    testId: value.testId,
    target: value.target,
    covers: [...new Set(value.covers)].sort(),
    evidenceDigest: value.evidenceDigest,
    contractSha256: value.contractSha256,
    sessionId: value.sessionId,
    device,
    observationRunId: value.observationRunId,
    startedAt: value.startedAt,
    approvedAt: value.approvedAt,
    finishedAt: value.finishedAt,
    observations,
    witnessReceipts: [...value.witnesses],
    verdict: value.verdict,
    coverageBoundaryCodes: [...new Set(value.coverageBoundaryCodes)].sort(),
    approval: { requestId: value.approval.requestId, cancelled: value.approval.cancelled },
    ...(isRecord(value.producer) ? { producer: value.producer } : {}),
  } }
}

function reject(reason: EngineeringRealGateReason, testId: string | null, message: string): EngineeringRealGateRejection {
  return { reason, testId, message }
}
function failed(reason: EngineeringRealGateReason, message: string): EngineeringRegistrationResult {
  return { ok: false, reason, message }
}
function readClock(clock: EngineeringRealClock | undefined): { epoch: number; monotonic: number } | null {
  if (!clock || typeof clock.epochNow !== 'function' || typeof clock.monotonicNow !== 'function') return null
  const epoch = clock.epochNow()
  const monotonic = clock.monotonicNow()
  if (!Number.isFinite(epoch) || !Number.isFinite(monotonic)) return null
  return { epoch, monotonic }
}

/* ------------------------------------------------------------------ */
/* registry（宿主内部登记）                                             */
/* ------------------------------------------------------------------ */

export function createEngineeringRealEvidenceRegistry(options: EngineeringRealEvidenceRegistryOptions): EngineeringRealEvidenceRegistry {
  const state: RegistryState = {
    token: Symbol('nanju.engineering.real-evidence.registry'),
    hostRunId: options.hostRunId,
    projectId: options.projectId,
    observer: { observerId: options.observer.observerId, observerVersion: options.observer.observerVersion },
    clock: options.clock,
    digestOf: options.digestOf ?? sha256EngineeringDigest,
    limits: { ...ENGINEERING_REAL_DEFAULT_LIMITS, ...(options.limits ?? {}) },
    entries: new Map(),
    activeByTestId: new Map(),
    consumed: new Map(),
    tickets: new Map(),
    witnessReceipts: new Map(),
    boundaryAckReceipts: new Map(),
  }
  assertRegistryLimits(state.limits)

  /** 按 session/age 清理；register/签发前自动调用，防止无界增长。 */
  function sweep(options?: EngineeringRealEvidenceCleanupOptions): EngineeringRealEvidenceCleanupReport {
    const monotonic = state.clock.monotonicNow()
    const sessionId = options?.sessionId
    const report: EngineeringRealEvidenceCleanupReport = { entries: 0, tickets: 0, witnessReceipts: 0, boundaryAckReceipts: 0, consumed: 0 }
    const entryRetention = options?.maxAgeMonotonicMs ?? state.limits.entryRetentionMonotonicMs
    for (const [runId, entry] of [...state.entries]) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue
      if (monotonic - entry.registeredAtMonotonic <= entryRetention) continue
      state.entries.delete(runId)
      if (state.activeByTestId.get(entry.record.binding.testId) === runId) state.activeByTestId.delete(entry.record.binding.testId)
      report.entries += 1
    }
    const ticketRetention = options?.maxAgeMonotonicMs ?? state.limits.ticketRetentionMonotonicMs
    for (const [ticket, facts] of [...state.tickets]) {
      if (sessionId !== undefined && facts.sessionId !== sessionId) continue
      if (monotonic - facts.issuedAtMonotonic <= ticketRetention) continue
      state.tickets.delete(ticket)
      report.tickets += 1
    }
    const receiptRetention = options?.maxAgeMonotonicMs ?? state.limits.receiptRetentionMonotonicMs
    for (const [receipt, facts] of [...state.witnessReceipts]) {
      if (sessionId !== undefined && facts.sessionId !== sessionId) continue
      if (monotonic - facts.issuedAtMonotonic <= receiptRetention) continue
      state.witnessReceipts.delete(receipt)
      report.witnessReceipts += 1
    }
    for (const [receipt, facts] of [...state.boundaryAckReceipts]) {
      if (sessionId !== undefined && facts.sessionId !== sessionId) continue
      if (monotonic - facts.issuedAtMonotonic <= receiptRetention) continue
      state.boundaryAckReceipts.delete(receipt)
      report.boundaryAckReceipts += 1
    }
    const consumedRetention = options?.maxAgeMonotonicMs ?? state.limits.consumedRetentionMonotonicMs
    for (const [runId, tombstone] of [...state.consumed]) {
      if (sessionId !== undefined && tombstone.sessionId !== sessionId) continue
      if (monotonic - tombstone.atMonotonic <= consumedRetention) continue
      state.consumed.delete(runId)
      report.consumed += 1
    }
    return report
  }

  const registry: EngineeringRealEvidenceRegistry = {
    hostRunId: state.hostRunId,
    projectId: state.projectId,
    digestOf: state.digestOf,
    limits: state.limits,

    issueObservationTicket(input: { testId: string; sessionId: string }): EngineeringHostObservationTicket | null {
      if (!isRecord(input) || !nonEmptyText(input.testId) || !nonEmptyText(input.sessionId)) return null
      sweep()
      if (state.tickets.size >= state.limits.maxTickets) return null
      const ticket = deepFreeze({ kind: 'host-observation-ticket' as const })
      state.tickets.set(ticket, { testId: input.testId, sessionId: input.sessionId,
        issuedAtMonotonic: state.clock.monotonicNow(), used: false })
      return ticket
    },

    issueHumanWitnessReceipt(input: EngineeringHumanWitnessDecision): EngineeringHumanWitnessReceipt | null {
      if (!isRecord(input) || input.allowed !== true) return null
      if (!nonEmptyText(input.requestId) || !nonEmptyText(input.testId) || !nonEmptyText(input.sessionId)
        || !nonEmptyText(input.pointId) || !nonEmptyText(input.storyId) || !nonEmptyText(input.assertion)) return null
      sweep()
      if (state.witnessReceipts.size >= state.limits.maxWitnessReceipts) return null
      const receipt = deepFreeze({ kind: 'host-human-witness-receipt' as const })
      state.witnessReceipts.set(receipt, { testId: input.testId, sessionId: input.sessionId, pointId: input.pointId,
        storyId: input.storyId, assertion: input.assertion, requestId: input.requestId,
        witnessedAtEpoch: state.clock.epochNow(), issuedAtMonotonic: state.clock.monotonicNow(), used: false })
      return receipt
    },

    issueBoundaryAckReceipt(input: EngineeringBoundaryAckDecision): EngineeringBoundaryAckReceipt | null {
      if (!isRecord(input) || input.allowed !== true) return null
      if (!nonEmptyText(input.requestId) || !nonEmptyText(input.sessionId)) return null
      if (!stringArray(input.displayedBoundaryCodes) || !stringArray(input.displayedObservationRunIds)) return null
      sweep()
      if (state.boundaryAckReceipts.size >= state.limits.maxBoundaryAckReceipts) return null
      const receipt = deepFreeze({ kind: 'host-boundary-ack-receipt' as const })
      state.boundaryAckReceipts.set(receipt, { sessionId: input.sessionId, requestId: input.requestId,
        displayedBoundaryCodes: [...new Set(input.displayedBoundaryCodes)].sort(),
        displayedObservationRunIds: [...new Set(input.displayedObservationRunIds)].sort(),
        issuedAtMonotonic: state.clock.monotonicNow(), used: false })
      return receipt
    },

    register(ticket: unknown, draft: unknown): EngineeringRegistrationResult {
      sweep()
      const ticketObject = isRecord(ticket) ? ticket : null
      const ticketFacts = ticketObject ? state.tickets.get(ticketObject) : undefined
      if (!ticketFacts) {
        return failed('real-evidence-untrusted-source', '缺少本宿主 registry 签发的观察票据：项目报告文件或伪造对象不是登记入口')
      }
      if (ticketFacts.used) return failed('real-evidence-replayed', '该宿主观察票据已使用，不能重复登记')
      const parsed = readDraft(draft)
      if (!parsed.ok) return failed('real-evidence-untrusted-source', '登记草稿不可信：' + parsed.message)
      const value = parsed.draft
      if (value.testId !== ticketFacts.testId) return failed('real-evidence-binding-mismatch', '登记草稿的 testId 与观察票据不一致')
      if (value.sessionId !== ticketFacts.sessionId) return failed('real-evidence-binding-mismatch', '登记草稿的会话与观察票据不一致')
      if (value.producer) {
        const declared = value.producer
        if (declared.provenance === 'project-driver') {
          return failed('project-driver-not-independent', '项目驱动结果永不作为独立能力证据')
        }
        if (declared.provenance !== undefined && declared.provenance !== 'host-observer') {
          return failed('real-evidence-untrusted-source', '证据生产者只允许宿主观察器；真人见证须用见证收据')
        }
        if (declared.observerId !== undefined && declared.observerId !== state.observer.observerId) {
          return failed('real-evidence-untrusted-source', '证据声明的观察器不是本宿主实例')
        }
        if (declared.observerVersion !== undefined && declared.observerVersion !== state.observer.observerVersion) {
          return failed('real-evidence-untrusted-source', '证据声明的观察器版本不是本宿主实例')
        }
      }
      // 真人见证只认收据：普通 witness 对象不可信。
      const witnesses: EngineeringHumanWitness[] = []
      for (const raw of value.witnessReceipts) {
        const witnessFacts = isRecord(raw) ? state.witnessReceipts.get(raw) : undefined
        if (!witnessFacts) {
          return failed('human-witness-unverified', '真人见证必须是宿主签发且绑定真实批准的见证收据，普通对象不可信')
        }
        if (witnessFacts.used) return failed('real-evidence-replayed', '该见证收据已被使用')
        if (witnessFacts.testId !== value.testId || witnessFacts.sessionId !== value.sessionId) {
          return failed('real-evidence-binding-mismatch', '见证收据绑定的测试或会话与观察不一致')
        }
        witnesses.push({ pointId: witnessFacts.pointId, storyId: witnessFacts.storyId, assertion: witnessFacts.assertion,
          witnessedAt: witnessFacts.witnessedAtEpoch, sessionId: witnessFacts.sessionId, requestId: witnessFacts.requestId })
      }
      // 取消或未通过的观察不登记：不残留记录，也不烧票据/收据。
      if (value.approval.cancelled) return failed('requires-real-unattested', '观察已取消，不登记独立证据')
      if (value.verdict !== 'attested') return failed('requires-real-unattested', '宿主观察未通过，不登记独立证据')
      if (state.entries.has(value.observationRunId) || state.consumed.has(value.observationRunId)) {
        return failed('real-evidence-replayed', '该观察轮次标识已登记或已消费')
      }
      if (state.entries.size >= state.limits.maxEntries) {
        return failed('real-evidence-capacity-exceeded', '登记记录已达上限，拒绝新增（fail-closed）')
      }
      const binding: EngineeringRealEvidenceBinding = {
        schemaVersion: 1,
        producer: { provenance: 'host-observer', observerId: state.observer.observerId, observerVersion: state.observer.observerVersion },
        projectId: state.projectId,
        sessionId: value.sessionId,
        hostRunId: state.hostRunId,
        evidenceDigest: value.evidenceDigest,
        contractSha256: value.contractSha256,
        testId: value.testId,
        target: value.target,
        covers: value.covers,
        device: value.device,
        observationRunId: value.observationRunId,
        startedAt: value.startedAt,
        approvedAt: value.approvedAt,
        finishedAt: value.finishedAt,
      }
      const digestInput: EngineeringRealEvidenceDigestInput = { binding, observations: value.observations,
        witnesses, verdict: value.verdict, coverageBoundaryCodes: value.coverageBoundaryCodes, approval: value.approval }
      const draftRecord: EngineeringRealEvidenceRecord = { ...digestInput,
        reportDigest: computeEngineeringRealReportDigest(digestInput, state.digestOf) }
      // 规范往返克隆 + 深冻结：调用方事后修改自己的对象不会影响 registry 事实。
      const record = deepFreeze(JSON.parse(canonicalizeEngineeringValue(draftRecord)) as EngineeringRealEvidenceRecord)
      const witnessReceiptIssuedAtMonotonic = new Map<string, number>()
      for (const raw of value.witnessReceipts) {
        const witnessFacts = isRecord(raw) ? state.witnessReceipts.get(raw) : undefined
        if (witnessFacts) witnessReceiptIssuedAtMonotonic.set(witnessFacts.pointId, witnessFacts.issuedAtMonotonic)
      }
      state.entries.set(record.binding.observationRunId, { record, sessionId: record.binding.sessionId,
        registeredAtMonotonic: state.clock.monotonicNow(), witnessReceiptIssuedAtMonotonic, consumedAtMonotonic: null })
      state.activeByTestId.set(record.binding.testId, record.binding.observationRunId)
      // 成功后统一置一次性标记。
      ticketFacts.used = true
      for (const raw of value.witnessReceipts) {
        const witnessFacts = isRecord(raw) ? state.witnessReceipts.get(raw) : undefined
        if (witnessFacts) witnessFacts.used = true
      }
      return { ok: true, record }
    },

    registerProjectReportFile(raw: unknown): EngineeringRegistrationResult {
      void raw
      return failed('real-evidence-untrusted-source', '项目报告文件只是观察材料的落盘副本，不是登记入口；必须由宿主观察器持票据登记')
    },

    peek(testId: string): EngineeringRealEvidenceEntry | null {
      const runId = state.activeByTestId.get(testId)
      if (!runId) return null
      const entry = state.entries.get(runId)
      return entry ? { record: entry.record, consumed: entry.consumedAtMonotonic !== null } : null
    },

    size(): number { return state.entries.size },
    activeTestIds(): readonly string[] { return [...state.activeByTestId.keys()] },
    consumedRunIds(): readonly string[] { return [...state.consumed.keys()] },
    cleanup(options?: EngineeringRealEvidenceCleanupOptions): EngineeringRealEvidenceCleanupReport { return sweep(options) },
  }
  registryStates.set(registry, state)
  return registry
}

/* ------------------------------------------------------------------ */
/* 门禁：validate（幂等）与 consume（一次性、同步原子）                   */
/* ------------------------------------------------------------------ */

function checkTimeWindow(binding: EngineeringRealEvidenceBinding, epoch: number, maxObservationMs: number): string | null {
  if (binding.finishedAt <= binding.startedAt) return '观察时长非正'
  if (binding.finishedAt - binding.startedAt > maxObservationMs) return '观察时长超过上限'
  if (binding.approvedAt < binding.startedAt || binding.approvedAt > binding.finishedAt) return '批准时间不在观察窗口内'
  if (binding.finishedAt > epoch) return '观察完成时间晚于当前墙钟'
  return null
}

type OneTestResult = { record: EngineeringRealEvidenceRecord } | { rejection: EngineeringRealGateRejection }

function validateOneTest(input: EngineeringRealEvidenceGateInput, target: EngineeringRealEvidenceTarget,
  host: { epoch: number; monotonic: number }, state: RegistryState): OneTestResult {
  const runId = state.activeByTestId.get(target.testId)
  const facts = runId ? state.entries.get(runId) : undefined
  if (!runId || !facts) {
    return { rejection: reject('requires-real-unattested', target.testId,
      '缺少宿主独立观察证据：' + target.testId + ' 仍需宿主观察器实测或同会话真人见证，不能用项目驱动结果解除') }
  }
  if (facts.consumedAtMonotonic !== null) {
    return { rejection: reject('real-evidence-replayed', target.testId, '该观察轮次已被先前交付消费，不能二次交付') }
  }
  const record = facts.record
  const binding = record.binding
  if (binding.producer.provenance !== 'host-observer') {
    return { rejection: reject('project-driver-not-independent', target.testId, '证据生产者不是宿主观察器') }
  }
  if (binding.hostRunId !== input.registry.hostRunId) {
    return { rejection: reject('real-evidence-replayed', target.testId, '证据来自其他宿主进程实例，宿主重启后失效') }
  }
  // 新鲜度一律用宿主（registry）时钟：即使调用方时钟基准不同，也不可能低估观察年龄（INV-C1）。
  const age = host.monotonic - facts.registeredAtMonotonic
  if (age < 0) return { rejection: reject('real-evidence-time-invalid', target.testId, '单调时钟回退，拒绝该观察') }
  if (age > input.maxEvidenceAgeMs) {
    return { rejection: reject('real-evidence-expired', target.testId, '观察完成已超过新鲜度窗口，请重新观察') }
  }
  let expectedDigest: string
  try {
    expectedDigest = computeEngineeringRealReportDigest(record, input.registry.digestOf)
  } catch {
    return { rejection: reject('real-evidence-tampered', target.testId, '观察材料无法规范化，视为被篡改') }
  }
  if (record.reportDigest !== expectedDigest) {
    return { rejection: reject('real-evidence-tampered', target.testId, '观察材料摘要与登记不符，疑似事后编辑') }
  }
  if (binding.evidenceDigest !== input.evidenceDigest || binding.contractSha256 !== input.contractSha256) {
    return { rejection: reject('real-evidence-stale', target.testId, '证据绑定的是旧的工程版本或旧契约，请重新观察') }
  }
  let deviceMatches = false
  try {
    deviceMatches = canonicalizeEngineeringValue(stripUndefinedKeys(binding.device))
      === canonicalizeEngineeringValue(stripUndefinedKeys(input.device))
  } catch {
    deviceMatches = false
  }
  if (binding.projectId !== input.projectId || binding.testId !== target.testId || binding.target !== target.target
    || !sameStringSet(binding.covers, target.covers) || binding.sessionId !== input.sessionId || !deviceMatches) {
    return { rejection: reject('real-evidence-binding-mismatch', target.testId, '证据绑定的项目/测试/用例/会话/设备与当前交付不符') }
  }
  const timeProblem = checkTimeWindow(binding, host.epoch, input.maxObservationMs)
  if (timeProblem) return { rejection: reject('real-evidence-time-invalid', target.testId, timeProblem) }

  for (const point of target.points) {
    if (point.machineObservable) {
      const hit = record.observations.find((observation) => observation.pointId === point.id)
      if (!hit || hit.passed !== true || hit.observedVia !== point.observedVia || !nonEmptyText(hit.actual)) {
        return { rejection: reject('host-observation-missing', target.testId,
          '机器可观察点缺少宿主实测：' + point.id + '（真人见证不能替代机器可观察点）') }
      }
      continue
    }
    const witness = record.witnesses.find((row) => row.pointId === point.id && row.sessionId === binding.sessionId)
    if (!witness) {
      return { rejection: reject('human-witness-missing', target.testId, '不可自动观察点缺少同会话真人见证：' + point.id) }
    }
    // 见证收据本身也有新鲜度：见证很早、记录很新时，仍必须重新见证。
    const witnessAnchor = facts.witnessReceiptIssuedAtMonotonic.get(point.id) ?? facts.registeredAtMonotonic
    const witnessAge = host.monotonic - witnessAnchor
    if (witnessAge < 0) {
      return { rejection: reject('real-evidence-time-invalid', target.testId, '见证收据时间锚点晚于宿主当前时钟，拒绝该见证：' + point.id) }
    }
    if (witnessAge > input.maxEvidenceAgeMs) {
      return { rejection: reject('real-evidence-expired', target.testId, '真人见证收据已超过新鲜度窗口，请重新见证：' + point.id) }
    }
    // 真人确认必然发生在批准之后；早于批准或晚于当前墙钟的见证不可信。
    if (witness.witnessedAt < binding.approvedAt || witness.witnessedAt > host.epoch) {
      return { rejection: reject('real-evidence-time-invalid', target.testId, '真人见证时间不在批准之后或晚于当前墙钟：' + point.id) }
    }
  }
  return { record }
}

function checkDeliveryAck(state: RegistryState, input: EngineeringRealEvidenceGateInput, host: { epoch: number; monotonic: number },
  records: readonly EngineeringRealEvidenceRecord[]): EngineeringRealGateRejection | null {
  const receiptObject = isRecord(input.ackReceipt) ? input.ackReceipt : null
  const facts = receiptObject ? state.boundaryAckReceipts.get(receiptObject) : undefined
  if (!facts) {
    return reject('coverage-unverified-unacked', null,
      '最终交付必须由真人对明确展示的覆盖边界与观察轮次做一次确认（缺宿主签发的 boundary ack 收据）')
  }
  if (facts.used) return reject('real-evidence-replayed', null, 'boundary ack 收据已被先前交付消费')
  const age = host.monotonic - facts.issuedAtMonotonic
  if (age < 0) return reject('real-evidence-time-invalid', null, '单调时钟回退，拒绝该确认收据')
  if (age > input.maxEvidenceAgeMs) return reject('real-evidence-expired', null, '覆盖边界确认已超过新鲜度窗口，请重新确认')
  if (facts.sessionId !== input.sessionId) {
    return reject('real-evidence-binding-mismatch', null, 'boundary ack 收据绑定的会话与当前交付不符')
  }
  const requiredCodes = [...new Set(records.flatMap((record) => record.coverageBoundaryCodes))]
  const missing = requiredCodes.filter((code) => !facts.displayedBoundaryCodes.includes(code))
  if (missing.length) return reject('coverage-unverified-unacked', null, '确认时未展示覆盖边界编码：' + missing.join('、'))
  const runIds = records.map((record) => record.binding.observationRunId)
  if (!sameStringSet(facts.displayedObservationRunIds, runIds)) {
    return reject('real-evidence-binding-mismatch', null,
      '确认时展示的观察轮次集合与当前登记记录集不一致：该确认收据不能跨记录集复用')
  }
  return null
}

/**
 * 门禁内部统一入口。
 * - `delivery`：最终交付语义，要求 BoundaryAckReceipt（validate / consume 均如此）。
 * - `observation`：观察期轻量语义，只验证据完备性与绑定（票据/观察/见证/新鲜度/设备/会话），不要求 ack。
 * 本分层参数不外露；公开 API 各自写死模式，避免再出现 requireAck 式布尔 footgun。
 */
function validateEngineeringRealEvidenceInternal(input: EngineeringRealEvidenceGateInput,
  mode: 'observation' | 'delivery'): EngineeringRealGateRejection | null {
  const state = registryStates.get(input.registry)
  if (!state) return reject('real-evidence-untrusted-source', null, 'registry 不是宿主工厂产物，不能作为交付依据')
  // 窗口参数是编程前置条件：非正/非有限一律构造期 fail-fast。
  assertGateWindows(input)
  const tests = Array.isArray(input.tests) ? input.tests : []
  if (!tests.length) return null
  const host = readClock(state.clock)
  if (!host) return reject('real-evidence-time-invalid', null, '宿主时钟不可用，拒绝校验')
  const gate = readClock(input.clock)
  if (!gate) return reject('real-evidence-time-invalid', null, '调用方时钟不可用，拒绝校验')
  // INV-C1：调用方时钟必须与宿主时钟同源；偏差超容差即 fail-closed，绝不按较低基准低估 age。
  const tolerance = input.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS
  if (Math.abs(gate.epoch - host.epoch) > tolerance || Math.abs(gate.monotonic - host.monotonic) > tolerance) {
    return reject('real-evidence-time-invalid', null,
      '调用方时钟与宿主时钟基准不一致，拒绝按不同基准计算观察年龄（fail-closed）')
  }
  const records: EngineeringRealEvidenceRecord[] = []
  for (const target of tests) {
    const result = validateOneTest(input, target, host, state)
    if ('rejection' in result) return result.rejection
    records.push(result.record)
  }
  if (mode === 'observation') return null
  return checkDeliveryAck(state, input, host, records)
}

/**
 * 最终交付校验（幂等）：证据完备性 + 绑定 + 宿主时钟新鲜度 + 真人覆盖边界确认收据（ack）。
 * 可被普通 fact check 反复调用，不消费任何登记记录；tests 为空（契约无 requiresReal）时放行到既有 GWT 门。
 * 只接受宿主工厂创建的 registry（R1）；年龄一律以宿主时钟为准（INV-C1）。
 */
export function validateEngineeringRealEvidence(input: EngineeringRealEvidenceGateInput): EngineeringRealGateRejection | null {
  return validateEngineeringRealEvidenceInternal(input, 'delivery')
}

/**
 * 观察期轻量校验（B1 缺口补口）：只验证据完备性与绑定（票据/观察/见证/新鲜度/设备/会话），
 * **不要求 BoundaryAckReceipt**，也不改变任何 registry 状态（不会消费 ack 收据）。
 *
 * 分层语义（重要）：
 * - 本函数通过 ≠ 交付通过。它只回答“宿主独立证据是否已齐备、是否仍在新鲜度窗口内”，
 *   供 suite / orchestrator 在观察期判定能否进入最终交付，避免观察期被 coverage-unverified-unacked 卡死。
 * - 最终交付必须走 validateEngineeringRealEvidence + consumeEngineeringRealEvidence，两者都要求 ack 收据。
 * - 可拒绝的原因与交付门一致（unattested / stale / tampered / expired / 绑定不符 / 缺机器观察 / 缺真人见证…），
 *   仅 coverage-unverified-unacked 在本层不可能出现。
 */
export function validateEngineeringRealEvidenceCompleteness(input: EngineeringRealEvidenceGateInput): EngineeringRealGateRejection | null {
  return validateEngineeringRealEvidenceInternal(input, 'observation')
}

/**
 * 最终交付提交时的一次性消费：先完整校验，再在**同一同步块**内原子标墓碑（不跨 await）。
 * 二次调用（或消费后再 validate）返回 real-evidence-replayed。
 * 只在“整轮全部通过且不超消费上限”时才注销，避免部分消费导致状态撕裂。
 */
export function consumeEngineeringRealEvidence(input: EngineeringRealEvidenceGateInput): EngineeringRealGateRejection | null {
  const state = registryStates.get(input.registry)
  if (!state) return reject('real-evidence-untrusted-source', null, 'registry 不是宿主工厂产物，不能消费')
  const rejection = validateEngineeringRealEvidence(input)
  if (rejection) return rejection
  const tests = Array.isArray(input.tests) ? input.tests : []
  if (!tests.length) return null
  const ackObject = isRecord(input.ackReceipt) ? input.ackReceipt : null
  const ackFacts = ackObject ? state.boundaryAckReceipts.get(ackObject) : undefined
  if (!ackFacts) return reject('coverage-unverified-unacked', null, '缺少可消费的 boundary ack 收据')
  // 先算全部待墓碑轮次并做容量预检，再一次性写入，避免半消费。
  const pending = new Map<string, EntryFacts>()
  for (const target of tests) {
    const runId = state.activeByTestId.get(target.testId)
    const entry = runId ? state.entries.get(runId) : undefined
    if (!runId || !entry) return reject('requires-real-unattested', target.testId, '登记记录在消费前消失，请重新观察')
    pending.set(runId, entry)
  }
  const fresh = [...pending.keys()].filter((runId) => !state.consumed.has(runId))
  if (state.consumed.size + fresh.length > state.limits.maxConsumedRunIds) {
    return reject('real-evidence-capacity-exceeded', null, '消费墓碑已达上限，拒绝交付以避免丢失重放保护（fail-closed）')
  }
  const consumedAtMonotonic = state.clock.monotonicNow()
  for (const [runId, entry] of pending) {
    entry.consumedAtMonotonic = consumedAtMonotonic
    state.consumed.set(runId, { atMonotonic: consumedAtMonotonic, sessionId: entry.sessionId })
  }
  ackFacts.used = true
  return null
}
