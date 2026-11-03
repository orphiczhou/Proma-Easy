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

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { captureEngineeringEvidence, ENGINEERING_CONTRACT_PATH } from './nanju-engineering-contract'
import {
  HUMAN_HOLD_LEASE_MS,
  MACHINE_WITNESS_TTL_MS,
  computeProjectArtifactDigest,
  freezeWitnessForHumanConfirmation,
  verifyWitnessFreshness,
} from './nanju-engineering-witness-clock'
import type { WitnessClockRecord } from './nanju-engineering-witness-clock'
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
/**
 * 观察完成后的新鲜度上限（机器窗口）。
 * NEXT-01（P1-3）：由 10 分钟放宽至 **15 分钟**（= MACHINE_WITNESS_TTL_MS，双阶段见证时钟
 * 的 execution_active 阶段窗口）。人类挂起期不再挤占此窗口——交付确认询问发起时经
 * `freezeWitnessClockForDelivery` 冻结，适用 24 小时租约（HUMAN_HOLD_LEASE_MS）。
 */
export const ENGINEERING_REAL_MAX_EVIDENCE_AGE_MS = MACHINE_WITNESS_TTL_MS
/** 调用方时钟与宿主时钟允许偏差（INV-C1 检出阈值）。 */
export const ENGINEERING_REAL_CLOCK_SKEW_TOLERANCE_MS = 2_000
/**
 * 保留窗口 ≥ 新鲜度窗口 + 交付时延（提前清理会表现为 requires-real-unattested，语义不同）。
 * NEXT-01：见证冻结后人类挂起期最长 24h，登记记录/收据必须活过整个租约期，
 * 否则冻结语义失效（记录被回收 → 门禁退化为 unattested 拒绝，人类确认反而被惩罚）。
 */
const REGISTRY_RETENTION_MS = MACHINE_WITNESS_TTL_MS + HUMAN_HOLD_LEASE_MS + 5 * 60_000

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
        // A-1（审查 REQUIRED）：保留窗放大到租约级（≈24h20m）后，容量上限必须同步提升，
        // 否则长会话 24h 内 70+ 次登记即耗尽票据/条目容量，fail-closed 拒绝一切真实登记。
        maxEntries: 256,
        maxTickets: 256,
        maxWitnessReceipts: 256,
        // ack 收据与 entry 同为租约级保留（每轮见证签 1 张、按年龄回收），同类容量失配一并提升
        maxBoundaryAckReceipts: 256,
        maxConsumedRunIds: 512,
        // entry 必须活过整个人类挂起租约期（冻结语义的前提）。
        entryRetentionMonotonicMs: REGISTRY_RETENTION_MS,
        // 票据是一次性消费凭证（登记即 used）：不需要活过租约，回归短窗尽快回收容量。
        ticketRetentionMonotonicMs: MACHINE_WITNESS_TTL_MS + 5 * 60_000,
        // ack 收据必须活过租约期（人类挂起后确认交付时仍需读它）；协议接口中
        // witness 收据与 ack 收据共用 receiptRetention（不可拆分），取租约级保留。
        receiptRetentionMonotonicMs: REGISTRY_RETENTION_MS,
        // 墓碑防线与 entry 同窗：不早于 entry 消失出现断层（重放保护连续）。
        consumedRetentionMonotonicMs: REGISTRY_RETENTION_MS,
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
    // NEXT-01：见证时钟随会话清理（停止后的会话不得用旧冻结租约交付）
    for (const key of [...witnessClockByScope.keys()]) {
      if (key.endsWith(`::${sessionId}`)) witnessClockByScope.delete(key)
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
  witnessClockByScope.clear()
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
/* NEXT-01（P1-3）：双阶段见证时钟（进程内 per project+session）              */
/* ------------------------------------------------------------------ */

/**
 * 见证时钟状态表（与 registry 同生命周期：进程内、不经 IPC、不外泄）。
 * 键为 `projectId::sessionId`；交付成功消费后清除，会话停止时随 cleanup 清除。
 */
const witnessClockByScope = new Map<string, WitnessClockRecord>()

/** 仅测试/审计：读取某 scope 当前的见证时钟状态（不改变状态）。 */
export function peekWitnessClockForTests(projectId: string, sessionId: string): WitnessClockRecord | undefined {
  return witnessClockByScope.get(scopeKey(projectId, sessionId))
}

/**
 * GWT 验收通过时刻锚定见证时钟（阶段一 execution_active 起点）。
 *
 * 调用点：`agent-orchestrator` 的 GWT `outcome.verdict === 'pass'` 分支（登记交付挑战
 * 的同一处）。锚点 `witnessedAt` = 当前时刻（GWT 刚全 pass = 机器刚背书过产物现状），
 * `artifactDigest` = 当前项目产物指纹；随后紧接 `freezeWitnessClockForDelivery` 冻结。
 *
 * 返回 `ok:false`（reason='no-witness-record'）表示该项不适用双阶段时钟（真实观察器
 * 链路未接入且无任何 requiresReal 登记记录）——此时交付门维持纯机器窗口语义。
 */
export function beginWitnessClockForDelivery(
  scope: EngineeringRealEvidenceScope,
  tests: readonly EngineeringRealEvidenceTestTarget[],
): { ok: boolean; reason?: string } {
  let hasWitnessRecord = false
  try {
    const reg = registryFor(scope.projectId)
    for (const test of tests) {
      if (reg.peek(test.testId)) { hasWitnessRecord = true; break }
    }
  } catch { /* registry 不可读 → 按不适用处理（交付门退回机器窗口，宁严不宽） */ }
  if (!hasWitnessRecord) return { ok: false, reason: 'no-witness-record' }
  witnessClockByScope.set(scopeKey(scope.projectId, scope.sessionId), {
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    witnessedAt: engineeringRealClock.epochNow(),
    artifactDigest: computeProjectArtifactDigest(scope.projectDir),
    clockPhase: 'execution_active',
  })
  return { ok: true }
}

/**
 * 发起交付确认询问时冻结见证时钟（阶段二 awaiting_human_confirm，24h 租约）。
 *
 * 内部走纯函数 `freezeWitnessForHumanConfirmation`：指纹不一致 / 超 15 分钟机器窗口
 * 均拒绝（交付门退回机器窗口语义，即 15 分钟后过期 → 提示重跑）；成功则写回冻结态。
 */
export function freezeWitnessClockForDelivery(
  scope: EngineeringRealEvidenceScope,
): { ok: boolean; reason?: string } {
  const key = scopeKey(scope.projectId, scope.sessionId)
  const record = witnessClockByScope.get(key)
  if (!record) return { ok: false, reason: 'no-witness-clock' }
  const result = freezeWitnessForHumanConfirmation(record, scope.projectDir, engineeringRealClock.epochNow())
  if (!result.ok || !result.updated) {
    // A-4：冻结失败不止于日志——把原因写回时钟记录（保持 execution_active 机器窗语义），
    // 交付门拒绝时由 resolveWitnessClockGate 带进 message，用户/Agent 可观测。
    witnessClockByScope.set(key, { ...record, freezeFailedReason: result.reason ?? 'E_WITNESS_FREEZE_FAILED' })
    return { ok: false, reason: result.reason ?? 'E_WITNESS_FREEZE_FAILED' }
  }
  witnessClockByScope.set(key, result.updated)
  return { ok: true }
}

/** 见证时钟对交付门的语义映射：拦截拒绝（E_WITNESS_* → 协议层既有 reason）与窗口放大。 */
interface WitnessClockGateResolution {
  rejection: EngineeringRealGateRejection | null
  /** 冻结租约有效时传给协议层的等效 maxEvidenceAgeMs（覆盖「登记→冻结点 + 24h」）。 */
  effectiveMaxEvidenceAgeMs?: number
}

/**
 * 交付门前的见证时钟判定：
 * 1. 无时钟记录（未锚定/旧路径）→ 不拦截，窗口维持 ENGINEERING_REAL_MAX_EVIDENCE_AGE_MS；
 * 2. 有记录 → verifyWitnessFreshness（指纹篡改第一优先级）；无效时映射为协议层既有
 *    reason（协议文件冻结不能新增枚举，E_WITNESS_* 码保留在 message 前缀，可辨识）；
 * 3. 冻结有效 → 放大窗口 = (冻结点-锚定点) + 24h + 时钟偏差容忍（协议层单调钟 age 从
 *    登记时刻起算，需覆盖到租约期末；精确 24h 租约判定由本层 verifyWitnessFreshness
 *    用 epoch 时钟独立承担，协议层只负责「不误拦」）。
 */
function resolveWitnessClockGate(scope: EngineeringRealEvidenceScope): WitnessClockGateResolution {
  const record = witnessClockByScope.get(scopeKey(scope.projectId, scope.sessionId))
  if (!record) return { rejection: null }
  const verdict = verifyWitnessFreshness(record, scope.projectDir, engineeringRealClock.epochNow())
  if (!verdict.valid) {
    // E_WITNESS_DIGEST_MISMATCH → real-evidence-tampered；其余（租约/机器窗超时）→ real-evidence-expired
    const reason: EngineeringRealGateRejection['reason'] = verdict.code === 'E_WITNESS_DIGEST_MISMATCH'
      ? 'real-evidence-tampered'
      : 'real-evidence-expired'
    // A-4：带出冻结失败原因（若有），补齐「为何未进入 24h 租约」的观测链路
    const freezeNote = record.freezeFailedReason ? `（发起交付询问时见证时钟冻结失败：${record.freezeFailedReason}）` : ''
    return { rejection: { reason, testId: null, message: (verdict.message ?? '见证时钟校验失败') + freezeNote } }
  }
  if (record.clockPhase === 'awaiting_human_confirm' && typeof record.holdStartedAt === 'number') {
    // A-2（审查建议）：补 MACHINE_WITNESS_TTL_MS 安全垫。依据：协议层单调钟 age 锚定
    // registeredAtMonotonic（人证登记时刻），构造上界早于 witnessedAt（GWT 通过锚定时刻）
    // 最多 15 分钟（execution_active 窗口长度）——不垫会被误拦 0~15 分钟。
    // 精确 24h 租约判定仍由本层 verifyWitnessFreshness 用 epoch 时钟独立承担，
    // 协议层只负责「不误拦」，多放的部分不会突破租约。
    return {
      rejection: null,
      effectiveMaxEvidenceAgeMs: (record.holdStartedAt - record.witnessedAt) + HUMAN_HOLD_LEASE_MS + MACHINE_WITNESS_TTL_MS + ENGINEERING_REAL_CLOCK_SKEW_TOLERANCE_MS,
    }
  }
  return { rejection: null }
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
  options: { withAck: boolean; maxEvidenceAgeMs?: number },
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
      // NEXT-01：缺省 15 分钟机器窗口；见证冻结租约有效时由调用方传入放大窗口
      maxEvidenceAgeMs: options.maxEvidenceAgeMs ?? ENGINEERING_REAL_MAX_EVIDENCE_AGE_MS,
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
  // NEXT-01：见证时钟先行拦截（指纹篡改第一优先级），冻结租约有效时放大机器窗口
  const clockGate = resolveWitnessClockGate(scope)
  if (clockGate.rejection) return { rejection: clockGate.rejection, boundaryCodes }
  const input = buildGateInput(scope, tests, { withAck: true, ...(clockGate.effectiveMaxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: clockGate.effectiveMaxEvidenceAgeMs } : {}) })
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
  // NEXT-01：见证时钟先行拦截（指纹篡改第一优先级），冻结租约有效时放大机器窗口
  const clockGate = resolveWitnessClockGate(scope)
  if (clockGate.rejection) return { rejection: clockGate.rejection, boundaryCodes }
  const input = buildGateInput(scope, tests, { withAck: true, ...(clockGate.effectiveMaxEvidenceAgeMs !== undefined ? { maxEvidenceAgeMs: clockGate.effectiveMaxEvidenceAgeMs } : {}) })
  if (!input) {
    return {
      rejection: { reason: 'requires-real-unattested', testId: null, message: '工程证据或契约不可读，无法判定真实能力证据（不放行）' },
      boundaryCodes,
    }
  }
  // 以下保持同步、无中间 await（原子性：validate 与 consume 之间不得插入写盘/发事件）
  const rejection = validateEngineeringRealEvidence(input)
  if (rejection) return { rejection, boundaryCodes }
  const consumeRejection = consumeEngineeringRealEvidence(input)
  // NEXT-01：交付消费成功（无拒绝）即终结本轮见证时钟（后续同 scope 交付按全新链路重新锚定）
  if (!consumeRejection) witnessClockByScope.delete(scopeKey(scope.projectId, scope.sessionId))
  return { rejection: consumeRejection, boundaryCodes }
}

/* ------------------------------------------------------------------ */
/* 方案1（2026-10-01 用户裁决，Issue #P1-REAL-002）：最小「同会话真人见证」接线      */
/* ------------------------------------------------------------------ */

/** 见证询问应答（来自真实 permission/Ask 回调；allowed=false 即不登记）。 */
export interface SessionHumanWitnessAskResult {
  allowed: boolean
  /** 真实 permission 请求 ID（登记收据与 ack 均绑定它）。 */
  requestId: string
}

/**
 * 最小人证见证登记：GWT 驱动层全 pass 但 requiresReal 项缺独立证据时，由宿主向
 * 用户发**一次**真实确认（ask 回调 = permissionService 询问）；明确允许后对每个
 * requiresReal 测试登记一轮「宿主见证观察」并签发交付层 boundary ack。
 *
 * 协议语义（不冒充、不绕过）：
 * - producer=host-observer、**不声明机器观察点**（observationPointsByTestId 不动）
 *   → 门禁观察点循环零次，不冒充机器实测；
 * - coverageBoundaryCodes 如实携带 `human-witness-limited` 边界（消费侧与报告可见）；
 * - 观察期与交付 validate/consume 全部走既有协议入口（registerHostObserverEvidence
 *   同族路径，无新增绕过口）；ack 经 issueBoundaryAckAfterRealConfirmation 签发。
 * - 用户拒绝 → 不登记不签发，工程保持 blocked（等宿主观察器接入或再次见证）。
 */
export async function registerSessionHumanWitnessEvidence(
  scope: EngineeringRealEvidenceScope,
  tests: readonly EngineeringRealEvidenceTestTarget[],
  ask: (message: string) => Promise<SessionHumanWitnessAskResult>,
): Promise<{ ok: boolean; message: string; boundaryCodes: string[] }> {
  const boundaryCodes = resolveCoverageBoundaryCodes(scope, tests)
  if (tests.length === 0) return { ok: true, message: '无需见证（契约无 requiresReal 项）', boundaryCodes }
  let evidenceDigest: string
  let contractSha256: string
  try {
    const evidence = captureEngineeringEvidence(scope.projectDir).evidence
    if (!evidence) return { ok: false, message: '工程证据不可读，拒绝见证登记（不放行）', boundaryCodes }
    evidenceDigest = evidence.digest
    contractSha256 = sha256Hex(readFileSync(join(scope.projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8'))
  } catch {
    return { ok: false, message: '工程证据或契约不可读，拒绝见证登记（不放行）', boundaryCodes }
  }
  const lines = tests.map((t) => `· ${t.testId}（被测产物 08_APP/${t.target}，覆盖 ${t.covers.join('、') || '辅助测试'}）`).join('\n')
  const message = '【工程验收·真人见证请求】以下验收项的项目驱动检查已全部通过，但契约声明 requiresReal，'
    + '需要独立于项目驱动的真实能力证据。当前宿主自动观察器尚未接入——是否由你（本会话真人）确认这些行为真实成立？\n'
    + lines
    + '\n\n确认后登记为「同会话真人见证」级别（覆盖边界 human-witness-limited，不等同宿主机器实测）；'
    + '拒绝则工程保持 blocked（可等宿主观察器接入或人工核查后再试）。'
  // 单轮观察窗口 5 分钟（ENGINEERING_REAL_MAX_OBSERVATION_MS）：Ask 等待计入观察时长。
  const startedAt = engineeringRealClock.epochNow()
  const decision = await ask(message)
  // 观察时长必须为正；但不能用 startedAt+1 伪造——同步应答时若后续校验落在同一毫秒，
  // 「完成时间晚于当前墙钟」会被协议层 fail-closed（组合测试预热后偶发，NEXT-01 实测复现）。
  // 改为真实跨毫秒等待；带上界（250×2ms）防墙钟回拨/停滞时的无界自旋，超限 fail-closed。
  let finishedAt = engineeringRealClock.epochNow()
  for (let attempt = 0; finishedAt <= startedAt && attempt < 250; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2))
    finishedAt = engineeringRealClock.epochNow()
  }
  if (finishedAt <= startedAt) {
    return { ok: false, message: '宿主墙钟回拨或停滞，无法确定观察窗口（fail-closed，拒绝登记本轮见证）', boundaryCodes }
  }
  if (!decision || decision.allowed !== true || !decision.requestId) {
    return { ok: false, message: '用户未确认见证，工程保持 blocked', boundaryCodes }
  }
  const registry = registryFor(scope.projectId)
  const displayCodes = [...new Set([...boundaryCodes, ENGINEERING_REAL_BOUNDARY_CODES.humanWitnessLimited])].sort()
  const runIds: string[] = []
  for (const test of tests) {
    const ticket = registry.issueObservationTicket({ testId: test.testId, sessionId: scope.sessionId })
    if (!ticket) return { ok: false, message: '观察票据签发失败（容量上限），本轮见证未登记', boundaryCodes }
    const observationRunId = `human-witness-${randomUUID()}`
    const result = registry.register(ticket, {
      testId: test.testId,
      target: test.target,
      covers: [...test.covers],
      evidenceDigest,
      contractSha256,
      sessionId: scope.sessionId,
      device: resolveEngineeringDeviceBinding(scope.deviceDetail ?? {}),
      observationRunId,
      startedAt,
      approvedAt: finishedAt,
      finishedAt,
      observations: [],
      witnesses: [],
      verdict: 'attested',
      coverageBoundaryCodes: displayCodes,
      approval: { requestId: decision.requestId, cancelled: false },
    })
    if (!result.ok) return { ok: false, message: '见证登记被协议拒绝：' + result.message, boundaryCodes }
    runIds.push(observationRunId)
  }
  const ackReceipt = issueBoundaryAckAfterRealConfirmation(
    { projectId: scope.projectId, sessionId: scope.sessionId },
    { requestId: decision.requestId, allowed: true, displayedBoundaryCodes: displayCodes, displayedObservationRunIds: runIds },
  )
  if (!ackReceipt) return { ok: false, message: '边界确认收据签发失败，本轮见证未生效（可重试）', boundaryCodes }
  return { ok: true, message: `已登记 ${runIds.length} 项同会话真人见证（human-witness-limited），交付门已具备 ack`, boundaryCodes }
}
