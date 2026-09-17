/**
 * W-I B-f：REAL 真实证据门禁**宿主接线层**（I 拥有）。
 *
 * 职责边界（本层只做接线，不做观察）：
 * - **registry 生命周期**：进程内按项目持有（同 `hostRunId`、同一时钟实例），惰性创建；
 *   重启即新建 → 旧记录/旧收据自然失效。
 * - **单一时钟实例**：同一个 `EngineeringRealClock` 实例同时交给 registry 与门禁（INV-C1：
 *   两套实现会被判 `real-evidence-time-invalid`，「基准不同 → 低估 age」在结构上不可能）。
 * - **门禁路由**：观察期走 `validateEngineeringRealEvidenceCompleteness`（不要求 ack、不消费），
 *   最终交付走 `validateEngineeringRealEvidence`（幂等 fact check）+ `consumeEngineeringRealEvidence`
 *   （一次性消费，同一同步块内，前后不插 `await`）。
 * - **收据签发入口**：只暴露「真实 Ask/permission 回调」可调用的签发函数；本层不生成观察数据。
 *
 * 硬边界（不越界声明能力）：
 * - 本层**不含观察器**：观察行为（热键注入、录音、ASR 调用、靶窗读回）在
 *   `nanju-engineering-linux-observer.ts`；本层只提供「持票据登记」的**接线点**。
 *   没有任何真实 host-observer 登记时，门禁一律 `requires-real-unattested`（逐项指出 testId），
 *   交付门保持拒绝（G2 起：有登记才是 attested，不是「接了线就放行」）。
 * - registry 引用**不外泄**：不经 IPC、不进 `engineeringExecution.services` 对项目可见路径、
 *   不给 renderer（本模块只导出「按 scope 求结论」的函数与显式标注 `__…ForTests` 的测试钩子）。
 * - 观察点定义（`points`）来自**宿主观察器登记时声明**（G2）：登记会把声明写进进程内
 *   `observationPointsByTestId`，门禁据此逐点校验机器实测；**未声明即空数组**，空点**不会**
 *   形成假通过（无登记轮次仍 `requires-real-unattested`），但也**不**凭空放宽——
 *   声明过观察点的 testId，其记录缺少对应观测即 `host-observation-missing`。
 *
 * 与 REAL-impl §6.4「每宿主进程实例一个 registry」的差异（如实披露）：
 * 协议层 `EngineeringRealEvidenceRegistryOptions.projectId` 是**必填**且会被写进登记记录的
 * binding（`record.binding.projectId = state.projectId`），门禁又要求 `binding.projectId ===
 * input.projectId`。若强行进程级单实例并固定一个 projectId，未来真实观察器登记后**任何项目**
 * 都会被 `real-evidence-binding-mismatch` 拒（结构性假阴性）。故本层落实为「进程内**每项目**一个
 * 单例（同 hostRunId、同一时钟、不经 IPC/不进 services）」，并把该取舍记入 I.md 待父裁决。
 * 协议文件是 REAL 冻结文件，I 无权改 `projectId` 为登记入参。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { captureEngineeringEvidence, ENGINEERING_CONTRACT_PATH } from './nanju-engineering-contract'
import {
  ENGINEERING_REAL_BOUNDARY_CODES,
  consumeEngineeringRealEvidence,
  createEngineeringRealEvidenceRegistry,
  validateEngineeringRealEvidence,
  validateEngineeringRealEvidenceCompleteness,
} from './nanju-engineering-real-evidence'
import type {
  EngineeringBoundaryAckDecision,
  EngineeringBoundaryAckReceipt,
  EngineeringDeviceBinding,
  EngineeringHumanWitnessDecision,
  EngineeringHumanWitnessReceipt,
  EngineeringObservationPoint,
  EngineeringRealClock,
  EngineeringRealEvidenceGateInput,
  EngineeringRealEvidenceRegistry,
  EngineeringRealEvidenceTarget,
  EngineeringRealGateRejection,
  EngineeringRealObservation,
  EngineeringRegistrationResult,
} from './nanju-engineering-real-evidence'

/* ------------------------------------------------------------------ */
/* 窗口参数（正数常量；不从配置透传未校验值）                              */
/* ------------------------------------------------------------------ */

/** 单轮观察时长上限：真实观察（热键/录音/输入）不可能长于 5 分钟。 */
export const ENGINEERING_REAL_MAX_OBSERVATION_MS = 5 * 60_000
/** 观察完成后的新鲜度上限：观察与交付之间不得超过 10 分钟（REAL-impl §6.10）。 */
export const ENGINEERING_REAL_MAX_EVIDENCE_AGE_MS = 10 * 60_000
/** 调用方时钟与宿主时钟允许偏差（INV-C1 检出阈值）。 */
export const ENGINEERING_REAL_CLOCK_SKEW_TOLERANCE_MS = 2_000
/** 保留窗口 ≥ 新鲜度窗口 + 交付时延（提前清理会表现为 requires-real-unattested，语义不同）。 */
const REGISTRY_RETENTION_MS = ENGINEERING_REAL_MAX_EVIDENCE_AGE_MS + 5 * 60_000

/* ------------------------------------------------------------------ */
/* registry（进程内每项目单例）+ 单一时钟实例                              */
/* ------------------------------------------------------------------ */

/** 宿主双时钟：epoch 墙钟 + monotonic 单调钟。**同一实例**同时交给 registry 与门禁。 */
export const engineeringRealClock: EngineeringRealClock = Object.freeze({
  epochNow: () => Date.now(),
  monotonicNow: () => performance.now(),
})

/** 宿主进程实例 id（重启即变 → 旧记录/旧收据失效）。 */
const hostRunId = `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const registries = new Map<string, EngineeringRealEvidenceRegistry>()

/** 进程内按项目取得（唯一创建点；调用方拿不到 registry 引用的对外出口）。 */
function registryFor(projectId: string): EngineeringRealEvidenceRegistry {
  let item = registries.get(projectId)
  if (!item) {
    item = createEngineeringRealEvidenceRegistry({
      hostRunId,
      projectId,
      observer: { observerId: 'host-observer-main', observerVersion: '0.17.124' },
      clock: engineeringRealClock,
      limits: {
        entryRetentionMonotonicMs: REGISTRY_RETENTION_MS,
        receiptRetentionMonotonicMs: REGISTRY_RETENTION_MS,
        ticketRetentionMonotonicMs: REGISTRY_RETENTION_MS,
      },
    })
    registries.set(projectId, item)
  }
  return item
}

/**
 * 会话停止/删除时清理该会话残留（长会话不积压）。
 *
 * 如实语义（勿当删除用）：
 * - **本层**：丢弃该会话的 ack 收据（`boundaryAckByScope`）——停止后不能用旧确认交付；
 * - **协议层** `registry.cleanup({sessionId})` 是「按会话 + 保留窗口」的回收（age > retention 才删），
 *   **不删新鲜记录**（协议无「立即吊销」API，且同一会话可再次发起验收，硬吊销会误伤重试）。
 * - 因此停止后的安全边界靠**两层绑定**而非删除：ack 已丢 → `coverage-unverified-unacked`；
 *   残留记录换会话/换项目必然 `real-evidence-binding-mismatch`（协议层 `binding.sessionId` 校验）。
 */
export function cleanupEngineeringRealEvidence(sessionId: string): void {
  try {
    for (const reg of registries.values()) reg.cleanup({ sessionId })
    for (const key of [...boundaryAckByScope.keys()]) {
      if (key.endsWith(`::${sessionId}`)) boundaryAckByScope.delete(key)
    }
  } catch { /* 清理失败不影响会话停止 */ }
}

/**
 * 宿主观察器为某个 testId **声明的观察点**（进程内，按 testId）。
 *
 * 写入时机：`registerHostObserverEvidence`（唯一入口，即宿主观察器登记路径）。门禁据此逐点
 * 校验「机器可观察点是否真被宿主实测」；未声明过的 testId 保持空数组（不凭空声明观察点）。
 * 重启即空（与 registry 同生命周期，不经 IPC、不外泄）。
 */
const observationPointsByTestId = new Map<string, readonly EngineeringObservationPoint[]>()

/** 仅供测试：重置全部单例（生产代码不得调用）。 */
export function __resetEngineeringRealGateForTests(): void {
  registries.clear()
  boundaryAckByScope.clear()
  observationPointsByTestId.clear()
}

/** 仅供测试/审计：读取某 testId 当前声明的观察点（不改变 registry 状态）。 */
export function peekObservationPointsForTests(testId: string): readonly EngineeringObservationPoint[] {
  return observationPointsByTestId.get(testId) ?? []
}

/** 仅供测试：取得 registry（生产路径不暴露 registry 引用）。 */
export function __peekEngineeringRealRegistryForTests(projectId: string): EngineeringRealEvidenceRegistry {
  return registryFor(projectId)
}

/* ------------------------------------------------------------------ */
/* 收据签发入口（唯一合法来源：真实 Ask / permission 回调）                 */
/* ------------------------------------------------------------------ */

/** 覆盖边界 ack 收据（按 project+session 存放；交付门读取）。字段 opaque，事实只在 registry 内。 */
const boundaryAckByScope = new Map<string, EngineeringBoundaryAckReceipt>()

const scopeKey = (projectId: string, sessionId: string): string => `${projectId}::${sessionId}`

/**
 * 真人对覆盖边界**明确确认**后签发 ack 收据——**唯一合法入口**。
 *
 * 前置条件（调用方负责，本层只做结构校验）：
 * 1. `decision.requestId` 必须是真实 Ask / permission 请求的 id（不是宿主自造）；
 * 2. `displayedBoundaryCodes` / `displayedObservationRunIds` 必须是**当时展示给真人**内容的原样拷贝
 *    （禁止宿主从记录推导后自动签署，否则 `coverage-unverified-unacked` 会退化成恒真门）；
 * 3. `allowed !== true` 一律不签发。
 *
 * 生产调用点：真实 Ask/permission 确认回调（本波尚未接入观察器 → 无调用点，
 * 交付门因此保持 `coverage-unverified-unacked` 拒绝，属预期 fail-closed）。
 */
export function issueBoundaryAckAfterRealConfirmation(
  scope: { projectId: string; sessionId: string },
  decision: Omit<EngineeringBoundaryAckDecision, 'sessionId'>,
): EngineeringBoundaryAckReceipt | null {
  if (!scope?.projectId || !scope?.sessionId) return null
  const receipt = registryFor(scope.projectId).issueBoundaryAckReceipt({ ...decision, sessionId: scope.sessionId })
  if (!receipt) return null
  boundaryAckByScope.set(scopeKey(scope.projectId, scope.sessionId), receipt)
  return receipt
}

/**
 * 真人**明确允许**后签发见证收据——**唯一合法入口**（`allowed:false` 不签发）。
 *
 * 生产调用点：`nanju-engineering-approval` 的 `requestSingleApproval` 返回 allow 后
 * （本波未接入 → 无调用点；`requiresReal` 仍 blocked）。
 */
export function issueHumanWitnessAfterRealApproval(
  projectId: string,
  decision: EngineeringHumanWitnessDecision,
): EngineeringHumanWitnessReceipt | null {
  if (decision?.allowed !== true || !projectId) return null
  return registryFor(projectId).issueHumanWitnessReceipt(decision)
}

/** 当前会话的 ack 收据（交付门读取；无则 undefined → 门禁按缺 ack 拒绝）。 */
export function currentBoundaryAckReceipt(projectId: string, sessionId: string): EngineeringBoundaryAckReceipt | undefined {
  return boundaryAckByScope.get(scopeKey(projectId, sessionId))
}

/* ------------------------------------------------------------------ */
/* 门禁入参组装                                                          */
/* ------------------------------------------------------------------ */

/** 门禁 scope：一次工程验收的会话/项目上下文。 */
export interface EngineeringRealEvidenceScope {
  workspaceSlug: string
  projectId: string
  sessionId: string
  projectDir: string
  /**
   * 可选设备细化（音源 / 加速器 / 靶应用 / ASR 端点）。
   * 登记与门禁**必须用同一个 scope**：协议层按 canonical 全等比较 device，两侧不一致即
   * `real-evidence-binding-mismatch`（这是结构性防线，不是可选项）。
   */
  deviceDetail?: Partial<EngineeringDeviceBinding>
}

/** 逐项处理的门禁目标（由工程契约派生；**只放 requiresReal 的测试**，避免稀释门禁）。 */
export interface EngineeringRealEvidenceTestTarget {
  testId: string
  target: string
  covers: readonly string[]
  /**
   * 观察点声明（可选）：缺省取 `registerHostObserverEvidence` 登记的声明，再缺省为空数组。
   * 机器可观察点必须与记录中的观测 `observedVia` 严格一致，否则 `host-observation-missing`。
   */
  points?: readonly EngineeringObservationPoint[]
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

/**
 * 设备绑定：证明哪台机器、哪个会话类型（Linux 口径；Wayland 注入未评估）。
 * `detail` 用于补齐观察器声明的音源 / 加速器 / 靶应用 / ASR 端点（未给的字段不写入）。
 */
export function resolveEngineeringDeviceBinding(detail: Partial<EngineeringDeviceBinding> = {}): EngineeringDeviceBinding {
  const display = process.env.DISPLAY
  const session: EngineeringDeviceBinding['session'] = process.platform === 'linux'
    ? (display ? 'x11' : 'headless')
    : 'headless'
  // platform/session/display 由宿主解析，不接收调用方覆写（否则可用伪造设备类型绕过绑定对账）。
  return {
    ...detail,
    platform: process.platform,
    session,
    ...(display ? { display } : {}),
  }
}

/** 门禁入参（缺证据/契约时返回 null → 调用方按「无法判定」拒绝，不放行）。 */
function buildGateInput(
  scope: EngineeringRealEvidenceScope,
  tests: readonly EngineeringRealEvidenceTestTarget[],
  options: { withAck: boolean },
): EngineeringRealEvidenceGateInput | null {
  try {
    const evidence = captureEngineeringEvidence(scope.projectDir).evidence
    if (!evidence) return null
    const contractSha256 = sha256Hex(readFileSync(join(scope.projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8'))
    const ack = options.withAck ? currentBoundaryAckReceipt(scope.projectId, scope.sessionId) : undefined
    // points 来自宿主观察器登记时声明的观察点（未声明即空数组，不凭空声明）。
    const targets: EngineeringRealEvidenceTarget[] = tests.map((test) => ({
      testId: test.testId,
      target: test.target,
      covers: [...test.covers],
      points: [...(test.points ?? observationPointsByTestId.get(test.testId) ?? [])],
    }))
    return {
      registry: registryFor(scope.projectId),
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      evidenceDigest: evidence.digest,
      contractSha256,
      device: resolveEngineeringDeviceBinding(scope.deviceDetail ?? {}),
      // INV-C1：与 registry 同一实例（禁止另建实现）
      clock: engineeringRealClock,
      tests: targets,
      ...(ack ? { ackReceipt: ack } : {}),
      maxObservationMs: ENGINEERING_REAL_MAX_OBSERVATION_MS,
      maxEvidenceAgeMs: ENGINEERING_REAL_MAX_EVIDENCE_AGE_MS,
      clockSkewToleranceMs: ENGINEERING_REAL_CLOCK_SKEW_TOLERANCE_MS,
    }
  } catch {
    return null
  }
}

/**
 * 覆盖边界编码（合流进 `coverageUnverified`）：把**已登记**记录里的 codes 与本宿主的
 * 结构性边界（项目驱动结果不独立 / 宿主观察受设备与时间约束）合并去重。
 */
export function resolveCoverageBoundaryCodes(
  scope: EngineeringRealEvidenceScope,
  tests: readonly EngineeringRealEvidenceTestTarget[],
): string[] {
  const codes = new Set<string>([
    ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent,
    ENGINEERING_REAL_BOUNDARY_CODES.hostObservationScope,
  ])
  try {
    const reg = registryFor(scope.projectId)
    for (const test of tests) {
      const entry = reg.peek(test.testId)
      for (const code of entry?.record.coverageBoundaryCodes ?? []) codes.add(code)
    }
  } catch { /* peek 失败只影响边界码合流，不影响门禁结论 */ }
  return [...codes].sort()
}

/* ------------------------------------------------------------------ */
/* 宿主观察器登记入口（G2 接线点：持票据登记，registry 引用不外泄）           */
/* ------------------------------------------------------------------ */

/**
 * 宿主观察器提交的登记载荷（由 `nanju-engineering-linux-observer.ts` 产出）。
 *
 * 安全边界：`evidenceDigest` / `contractSha256` / `device` / `producer` / `hostRunId` 都**不由
 * 调用方提供**——本层在登记时从 `scope` 现算并盖章，避免「观察材料自己声明工程版本」。
 */
export interface EngineeringHostObserverRegistration {
  testId: string
  target: string
  covers: readonly string[]
  sessionId: string
  observationRunId: string
  startedAt: number
  approvedAt: number
  finishedAt: number
  observations: readonly EngineeringRealObservation[]
  /** 观察器声明的观察点（机器点必须与观测 `observedVia` 一致；写入进程内声明表）。 */
  points: readonly EngineeringObservationPoint[]
  verdict: 'attested' | 'rejected'
  coverageBoundaryCodes?: readonly string[]
  /** 只能放 `issueHumanWitnessAfterRealApproval` 签发的收据；普通对象会被 registry 拒。 */
  witnessReceipts?: readonly EngineeringHumanWitnessReceipt[]
  approval: { requestId: string; cancelled: boolean }
}

/**
 * 宿主观察器登记（**唯一**持票据的登记入口；registry 引用仍留在本层）。
 *
 * 行为：
 * 1. 先落地观察点声明（即使本轮登记失败，该 testId 也按已声明观察点接受后续校验，宁严不宽）；
 * 2. 用 `scope` 现算 evidenceDigest / contractSha256 / device，再取票据登记；
 * 3. 登记失败原因原样回传（`requires-real-unattested` / `real-evidence-replayed` 等），不静默。
 */
export function registerHostObserverEvidence(
  scope: EngineeringRealEvidenceScope,
  input: EngineeringHostObserverRegistration,
): EngineeringRegistrationResult {
  const registry = registryFor(scope.projectId)
  if (input.points.length > 0) observationPointsByTestId.set(input.testId, [...input.points])
  try {
    const evidence = captureEngineeringEvidence(scope.projectDir).evidence
    if (!evidence) {
      return { ok: false, reason: 'requires-real-unattested', message: '工程证据不可读，拒绝登记宿主观察（不放行）' }
    }
    const contractSha256 = sha256Hex(readFileSync(join(scope.projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8'))
    const ticket = registry.issueObservationTicket({ testId: input.testId, sessionId: input.sessionId })
    if (!ticket) return { ok: false, reason: 'real-evidence-capacity-exceeded', message: '观察票据已达上限，拒绝登记（fail-closed）' }
    return registry.register(ticket, {
      testId: input.testId,
      target: input.target,
      covers: [...input.covers],
      evidenceDigest: evidence.digest,
      contractSha256,
      sessionId: input.sessionId,
      device: resolveEngineeringDeviceBinding(scope.deviceDetail ?? {}),
      observationRunId: input.observationRunId,
      startedAt: input.startedAt,
      approvedAt: input.approvedAt,
      finishedAt: input.finishedAt,
      observations: [...input.observations],
      witnesses: [...(input.witnessReceipts ?? [])],
      verdict: input.verdict,
      coverageBoundaryCodes: [...(input.coverageBoundaryCodes ?? [])],
      approval: { requestId: input.approval.requestId, cancelled: input.approval.cancelled },
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'requires-real-unattested',
      message: '登记宿主观察失败：' + (error instanceof Error ? error.message : String(error)),
    }
  }
}

/* ------------------------------------------------------------------ */
/* 观察期：suite 逐项判定（不要求 ack、不消费）                            */
/* ------------------------------------------------------------------ */

/** suite 观察期逐项结果（供 `EngineeringExecutionServices.resolveRealEvidence` 返回）。 */
export interface EngineeringSuiteRealEvidenceResolution {
  /** 宿主是否已接入门禁（false 或缺省 → suite 维持「尚未接入」硬拦语义）。 */
  available: boolean
  /** 逐项拒绝；空数组表示全部证据齐备。 */
  rejections: Array<{ testId: string | null; reason: string; message: string }>
  /** 覆盖边界编码（suite 合流进 coverageUnverified，不静默丢弃）。 */
  boundaryCodes: string[]
}

/**
 * 观察期判定（suite 调用）：逐项走 `validateEngineeringRealEvidenceCompleteness`。
 * 语义：**通过 ≠ 可交付**（交付仍需 ack + consume）。
 */
export function resolveSuiteRealEvidence(
  scope: EngineeringRealEvidenceScope,
  tests: readonly EngineeringRealEvidenceTestTarget[],
): EngineeringSuiteRealEvidenceResolution {
  const boundaryCodes = resolveCoverageBoundaryCodes(scope, tests)
  if (tests.length === 0) return { available: true, rejections: [], boundaryCodes }
  const rejections: EngineeringSuiteRealEvidenceResolution['rejections'] = []
  for (const test of tests) {
    const input = buildGateInput(scope, [test], { withAck: false })
    if (!input) {
      rejections.push({
        testId: test.testId,
        reason: 'requires-real-unattested',
        message: '工程证据或契约不可读，无法判定真实能力证据（不放行）',
      })
      continue
    }
    const rejection = validateEngineeringRealEvidenceCompleteness(input)
    if (rejection) {
      rejections.push({ testId: rejection.testId ?? test.testId, reason: rejection.reason, message: rejection.message })
    }
  }
  return { available: true, rejections, boundaryCodes }
}

/** suite 服务注入用的解析器工厂（gwt-runner 调用点使用；scope 绑定本次验收）。 */
export function createSuiteRealEvidenceResolver(
  scope: EngineeringRealEvidenceScope,
): (tests: readonly EngineeringRealEvidenceTestTarget[]) => EngineeringSuiteRealEvidenceResolution {
  return (tests) => resolveSuiteRealEvidence(scope, tests)
}

/* ------------------------------------------------------------------ */
/* 交付门：validate（幂等）+ consume（一次性，同同步块）                    */
/* ------------------------------------------------------------------ */

export interface EngineeringDeliveryRealEvidenceResult {
  rejection: EngineeringRealGateRejection | null
  boundaryCodes: string[]
}

/** 交付前 fact check（幂等，不消费）——普通校验路径使用。 */
export function checkDeliveryRealEvidence(
  scope: EngineeringRealEvidenceScope,
  tests: readonly EngineeringRealEvidenceTestTarget[],
): EngineeringDeliveryRealEvidenceResult {
  const boundaryCodes = resolveCoverageBoundaryCodes(scope, tests)
  if (tests.length === 0) return { rejection: null, boundaryCodes }
  const input = buildGateInput(scope, tests, { withAck: true })
  if (!input) {
    return {
      rejection: { reason: 'requires-real-unattested', testId: null, message: '工程证据或契约不可读，无法判定真实能力证据（不放行）' },
      boundaryCodes,
    }
  }
  return { rejection: validateEngineeringRealEvidence(input), boundaryCodes }
}

/**
 * 最终交付提交：**同一同步块内** validate + consume（函数体无 `await`；调用方在调用前也不得插 `await`）。
 * 失败 reason 原样透传（调用方转中文指引，不静默）。
 */
export function commitDeliveryRealEvidence(
  scope: EngineeringRealEvidenceScope,
  tests: readonly EngineeringRealEvidenceTestTarget[],
): EngineeringDeliveryRealEvidenceResult {
  const boundaryCodes = resolveCoverageBoundaryCodes(scope, tests)
  if (tests.length === 0) return { rejection: null, boundaryCodes }
  const input = buildGateInput(scope, tests, { withAck: true })
  if (!input) {
    return {
      rejection: { reason: 'requires-real-unattested', testId: null, message: '工程证据或契约不可读，无法判定真实能力证据（不放行）' },
      boundaryCodes,
    }
  }
  // 以下保持同步、无中间 await（原子性：validate 与 consume 之间不得插入写盘/发事件）
  const rejection = validateEngineeringRealEvidence(input)
  if (rejection) return { rejection, boundaryCodes }
  return { rejection: consumeEngineeringRealEvidence(input), boundaryCodes }
}
