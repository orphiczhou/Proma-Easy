/**
 * REAL-P 协议层 BDD 测试（REAL-review 返工版）。
 *
 * 全部依赖注入（epoch/monotonic 双时钟 fake、摘要 fake）、不写盘、不联网、不注入输入、不录音。
 * 唯一涉及“文件”的是显式模型化的项目报告文件对象，用来锁死“伪造文件不能绕过 registry”。
 */
import { expect, test } from 'bun:test'
import {
  ENGINEERING_REAL_BOUNDARY_CODES,
  canonicalizeEngineeringValue,
  computeEngineeringRealReportDigest,
  consumeEngineeringRealEvidence,
  createEngineeringRealEvidenceRegistry,
  sha256EngineeringDigest,
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
  EngineeringRealEvidenceGateInput,
  EngineeringRealEvidenceRecord,
  EngineeringRealEvidenceRegistry,
  EngineeringRealEvidenceRegistryLimits,
  EngineeringRealEvidenceTarget,
  EngineeringRegistrationResult,
} from './nanju-engineering-real-evidence'

const T0 = 1_800_000_000_000
const M0 = 900_000
const MACHINE_HOTKEY = 'linux.global-hotkey.delivered'
const MACHINE_RECORDING = 'linux.recording.started'
const HUMAN_SEMANTIC = 'linux.asr.semantic'

let epoch = T0
let monotonic = M0
const clock = { epochNow: () => epoch, monotonicNow: () => monotonic }
function rewindClock(): void { epoch = T0; monotonic = M0 }

/** 注入的确定性摘要，避免测试依赖具体 hash 实现。 */
function fakeDigest(canonical: string): string {
  let hash = 2166136261
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return 'fake-' + hash.toString(16)
}

function pointsAll(): EngineeringObservationPoint[] {
  return [
    { id: MACHINE_HOTKEY, kind: 'hotkey', machineObservable: true, observedVia: 'host.xtest.inject' },
    { id: MACHINE_RECORDING, kind: 'recording', machineObservable: true, observedVia: 'host.pipewire.source-outputs' },
    { id: HUMAN_SEMANTIC, kind: 'asr', machineObservable: false, observedVia: 'host.human-witness' },
  ]
}
function device(): EngineeringDeviceBinding {
  return { platform: 'linux', session: 'x11', display: ':0', audioSource: 'alsa_input.pci-0000',
    accelerator: 'Control+Super+Space', targetApp: 'proma-target-editor' }
}
function hostObservations(): unknown[] {
  return [
    { pointId: MACHINE_HOTKEY, expected: 'recording-start', actual: 'source-output#42', observedVia: 'host.xtest.inject', passed: true },
    { pointId: MACHINE_RECORDING, expected: 'capture-stream', actual: 'source-output#42', observedVia: 'host.pipewire.source-outputs', passed: true },
  ]
}
function makeRegistry(hostRunId = 'host-run-1',
  limits?: Partial<EngineeringRealEvidenceRegistryLimits>): EngineeringRealEvidenceRegistry {
  return createEngineeringRealEvidenceRegistry({
    hostRunId, projectId: 'proj-1',
    observer: { observerId: 'host-linux-desktop@1', observerVersion: '1.0.0' },
    clock, digestOf: fakeDigest, ...(limits ? { limits } : {}),
  })
}
function makeTicket(registry: EngineeringRealEvidenceRegistry, testId = 'acc-real',
  sessionId = 'session-1') {
  return registry.issueObservationTicket({ testId, sessionId })
}
function makeWitness(registry: EngineeringRealEvidenceRegistry,
  overrides: Partial<EngineeringHumanWitnessDecision> = {}): EngineeringHumanWitnessReceipt | null {
  return registry.issueHumanWitnessReceipt({ requestId: 'permission-witness-1', allowed: true, testId: 'acc-real',
    sessionId: 'session-1', pointId: HUMAN_SEMANTIC, storyId: 'US-01', assertion: '口述内容与转写语义一致', ...overrides })
}
function makeAck(registry: EngineeringRealEvidenceRegistry,
  overrides: Partial<EngineeringBoundaryAckDecision> = {}): EngineeringBoundaryAckReceipt | null {
  return registry.issueBoundaryAckReceipt({ requestId: 'permission-ack-1', allowed: true, sessionId: 'session-1',
    displayedBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
    displayedObservationRunIds: ['run-1'], ...overrides })
}
function makeDraft(witness: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    testId: 'acc-real',
    target: 'app',
    covers: ['US-01'],
    evidenceDigest: 'ev-1',
    contractSha256: 'sha-contract-1',
    sessionId: 'session-1',
    device: device(),
    observationRunId: 'run-1',
    startedAt: T0 - 10_000,
    approvedAt: T0 - 9_000,
    finishedAt: T0 - 1_000,
    observations: hostObservations(),
    witnesses: witness === null ? [] : [witness],
    verdict: 'attested',
    coverageBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
    approval: { requestId: 'approval-1', cancelled: false },
    ...overrides,
  }
}
function registerDraft(registry: EngineeringRealEvidenceRegistry, draft: unknown, ticket: unknown = makeTicket(registry)): EngineeringRegistrationResult {
  return registry.register(ticket, draft)
}
function realTarget(overrides: Partial<EngineeringRealEvidenceTarget> = {}): EngineeringRealEvidenceTarget {
  return { testId: 'acc-real', target: 'app', covers: ['US-01'], points: pointsAll(), ...overrides }
}
function gate(registry: EngineeringRealEvidenceRegistry, ack: unknown, overrides: Partial<EngineeringRealEvidenceGateInput> = {}): EngineeringRealEvidenceGateInput {
  return {
    registry, projectId: 'proj-1', sessionId: 'session-1',
    evidenceDigest: 'ev-1', contractSha256: 'sha-contract-1',
    device: device(), clock, ackReceipt: ack as EngineeringBoundaryAckReceipt,
    tests: [realTarget()], maxObservationMs: 600_000, maxEvidenceAgeMs: 120_000,
    ...overrides,
  }
}
function regReason(result: EngineeringRegistrationResult): string { return result.ok ? 'ok' : result.reason }function recordOf(result: EngineeringRegistrationResult): EngineeringRealEvidenceRecord {
  if (!result.ok) throw new Error('fixture 登记失败：' + result.reason)
  return result.record
}

/* ------------------------------------------------------------------ */
/* R1：validate 与 consume 都必须确认工厂 registry                       */
/* ------------------------------------------------------------------ */

test('R1-1 Given 鸭子类型/伪造 registry When validate 或 consume Then real-evidence-untrusted-source', () => {
  rewindClock()
  const forged = {
    hostRunId: 'host-run-1', projectId: 'proj-1', digestOf: fakeDigest,
    limits: {}, issueObservationTicket: () => null, issueHumanWitnessReceipt: () => null,
    issueBoundaryAckReceipt: () => null,
    register: () => ({ ok: false, reason: 'real-evidence-untrusted-source', message: 'forged' }),
    registerProjectReportFile: () => ({ ok: false, reason: 'real-evidence-untrusted-source', message: 'forged' }),
    peek: () => null, size: () => 0, activeTestIds: () => [], consumedRunIds: () => [],
    cleanup: () => ({ entries: 0, tickets: 0, witnessReceipts: 0, boundaryAckReceipts: 0, consumed: 0 }),
  } as unknown as EngineeringRealEvidenceRegistry
  expect(validateEngineeringRealEvidence(gate(forged, undefined))?.reason).toBe('real-evidence-untrusted-source')
  expect(consumeEngineeringRealEvidence(gate(forged, undefined))?.reason).toBe('real-evidence-untrusted-source')
})

test('R1-2 Given 工厂 registry When validate/consume Then 正常走通，且 consume 仍拒二次', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  expect(regReason(registerDraft(registry, makeDraft(makeWitness(registry))))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(registry, ack))).toBeNull()
  expect(consumeEngineeringRealEvidence(gate(registry, ack))).toBeNull()
  expect(consumeEngineeringRealEvidence(gate(registry, makeAck(registry)))?.reason).toBe('real-evidence-replayed')
})

/* ------------------------------------------------------------------ */
/* 伪造入口与票据                                                       */
/* ------------------------------------------------------------------ */

test('Given 伪造的项目报告文件对象 When 直接登记 Then 拒绝且 registry 为空，交付门仍 requires-real-unattested', () => {
  rewindClock()
  const registry = makeRegistry()
  const forged = { ...makeDraft(makeWitness(registry)), producer: { provenance: 'host-observer', observerId: 'host-linux-desktop@1', observerVersion: '1.0.0' }, reportDigest: 'forged' }
  expect(regReason(registry.registerProjectReportFile(forged))).toBe('real-evidence-untrusted-source')
  expect(registry.size()).toBe(0)
  const rejection = validateEngineeringRealEvidence(gate(registry, makeAck(registry)))
  expect(rejection?.reason).toBe('requires-real-unattested')
  expect(rejection?.testId).toBe('acc-real')
})

test('Given 未持有宿主票据的伪造对象或跨实例票据 When register Then 拒绝且不登记', () => {
  rewindClock()
  const registry = makeRegistry()
  const witness = makeWitness(registry)
  expect(regReason(registry.register({ testId: 'acc-real' }, makeDraft(witness)))).toBe('real-evidence-untrusted-source')
  expect(regReason(registry.register(undefined, makeDraft(witness)))).toBe('real-evidence-untrusted-source')
  const other = makeRegistry('host-run-2')
  expect(regReason(registry.register(makeTicket(other), makeDraft(witness)))).toBe('real-evidence-untrusted-source')
  expect(registry.size()).toBe(0)
})

test('Given 票据绑定的 testId/会话与草稿不一致 When register Then real-evidence-binding-mismatch', () => {
  rewindClock()
  const registry = makeRegistry()
  const witness = makeWitness(registry)
  expect(regReason(registry.register(makeTicket(registry, 'other-test'), makeDraft(witness)))).toBe('real-evidence-binding-mismatch')
  expect(regReason(registry.register(makeTicket(registry, 'acc-real', 'session-9'), makeDraft(witness)))).toBe('real-evidence-binding-mismatch')
  expect(registry.size()).toBe(0)
})

/* ------------------------------------------------------------------ */
/* validate 幂等 / consume 一次性                                        */
/* ------------------------------------------------------------------ */

test('Given 完整登记 When 普通 fact check Then 通过；重复 validate 仍通过且不消费', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  const registered = registerDraft(registry, makeDraft(makeWitness(registry)))
  expect(regReason(registered)).toBe('ok')
  expect(Object.isFrozen(recordOf(registered))).toBe(true)
  expect(validateEngineeringRealEvidence(gate(registry, ack))).toBeNull()
  expect(validateEngineeringRealEvidence(gate(registry, ack))).toBeNull()
  expect(registry.consumedRunIds()).toEqual([])
  expect(registry.size()).toBe(1)
})

test('Given 同一轮记录 When 最终交付 consume Then 同步原子生效；再次 validate/consume Then replayed', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  const input = gate(registry, ack)
  expect(consumeEngineeringRealEvidence(input)).toBeNull()
  // 同一同步调用返回后墓碑已生效（不跨 await）。
  expect(registry.consumedRunIds()).toEqual(['run-1'])
  expect(registry.peek('acc-real')?.consumed).toBe(true)
  expect(validateEngineeringRealEvidence(input)?.reason).toBe('real-evidence-replayed')
  expect(consumeEngineeringRealEvidence(input)?.reason).toBe('real-evidence-replayed')
})

test('Given 多测试交付中有一项缺证据 When consume Then 不产生半消费', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  const both: EngineeringRealEvidenceTarget[] = [realTarget(), realTarget({ testId: 'acc-2', target: 'app2' })]
  expect(consumeEngineeringRealEvidence(gate(registry, ack, { tests: both }))?.reason).toBe('requires-real-unattested')
  expect(registry.consumedRunIds()).toEqual([])
  expect(validateEngineeringRealEvidence(gate(registry, ack))).toBeNull()
  expect(consumeEngineeringRealEvidence(gate(registry, ack))).toBeNull()
})

/* ------------------------------------------------------------------ */
/* 篡改 / 过期 / 错绑定                                                  */
/* ------------------------------------------------------------------ */

test('Given 记录内容与登记摘要不再一致 When validate Then real-evidence-tampered', () => {
  rewindClock()
  let digestCalls = 0
  const registry = createEngineeringRealEvidenceRegistry({
    hostRunId: 'host-run-1', projectId: 'proj-1',
    observer: { observerId: 'host-linux-desktop@1', observerVersion: '1.0.0' },
    clock, digestOf: (canonical: string) => { digestCalls += 1; return 'digest-' + digestCalls + '-' + fakeDigest(canonical) },
  })
  const ack = makeAck(registry)
  expect(regReason(registerDraft(registry, makeDraft(makeWitness(registry))))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(registry, ack))?.reason).toBe('real-evidence-tampered')
})

test('Given 工程产物版本或契约已变化 When validate Then real-evidence-stale', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  expect(validateEngineeringRealEvidence(gate(registry, ack, { evidenceDigest: 'ev-2' }))?.reason).toBe('real-evidence-stale')
  expect(validateEngineeringRealEvidence(gate(registry, ack, { contractSha256: 'sha-contract-2' }))?.reason).toBe('real-evidence-stale')
})

test('Given 绑定会话/设备/项目/产物/用例不符 When validate Then real-evidence-binding-mismatch', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  expect(validateEngineeringRealEvidence(gate(registry, ack, { sessionId: 'session-2' }))?.reason).toBe('real-evidence-binding-mismatch')
  expect(validateEngineeringRealEvidence(gate(registry, ack, { device: { ...device(), accelerator: 'Other+Key' } }))?.reason).toBe('real-evidence-binding-mismatch')
  expect(validateEngineeringRealEvidence(gate(registry, ack, { device: { ...device(), session: 'headless' } }))?.reason).toBe('real-evidence-binding-mismatch')
  expect(validateEngineeringRealEvidence(gate(registry, ack, { projectId: 'proj-2' }))?.reason).toBe('real-evidence-binding-mismatch')
  expect(validateEngineeringRealEvidence(gate(registry, ack, { tests: [realTarget({ target: 'other-app' })] }))?.reason).toBe('real-evidence-binding-mismatch')
  expect(validateEngineeringRealEvidence(gate(registry, ack, { tests: [realTarget({ covers: ['US-02'] })] }))?.reason).toBe('real-evidence-binding-mismatch')
})

/* ------------------------------------------------------------------ */
/* A：真人见证必须是收据                                                 */
/* ------------------------------------------------------------------ */

test('A-1 Given 普通 witness 对象（含全部字段）When register Then human-witness-unverified，不登记', () => {
  rewindClock()
  const registry = makeRegistry()
  const plainWitness = { pointId: HUMAN_SEMANTIC, storyId: 'US-01', assertion: '我确认语义一致',
    witnessedAt: T0 - 5_000, sessionId: 'session-1' }
  const result = registerDraft(registry, makeDraft(plainWitness))
  expect(regReason(result)).toBe('human-witness-unverified')
  expect(registry.size()).toBe(0)
})

test('A-2 Given 收据绑定其他会话/其他测试 When register Then binding-mismatch', () => {
  rewindClock()
  const registry = makeRegistry()
  expect(regReason(registerDraft(registry, makeDraft(makeWitness(registry, { sessionId: 'session-2' }))))).toBe('real-evidence-binding-mismatch')
  expect(regReason(registerDraft(registry, makeDraft(makeWitness(registry, { testId: 'other-test' }))))).toBe('real-evidence-binding-mismatch')
})

test('A-3 Given 用户拒绝批准 When 签发见证收据 Then 返回 null，无法伪造见证', () => {
  rewindClock()
  const registry = makeRegistry()
  expect(registry.issueHumanWitnessReceipt({ requestId: 'permission-witness-1', allowed: false, testId: 'acc-real',
    sessionId: 'session-1', pointId: HUMAN_SEMANTIC, storyId: 'US-01', assertion: '我确认' })).toBeNull()
  expect(registry.issueHumanWitnessReceipt({ requestId: '', allowed: true, testId: 'acc-real',
    sessionId: 'session-1', pointId: HUMAN_SEMANTIC, storyId: 'US-01', assertion: '我确认' })).toBeNull()
})

test('A-4 Given 同一见证收据被复用 When 二次登记 Then real-evidence-replayed', () => {
  rewindClock()
  const registry = makeRegistry()
  const witness = makeWitness(registry)
  expect(regReason(registerDraft(registry, makeDraft(witness)))).toBe('ok')
  expect(regReason(registerDraft(registry, makeDraft(witness, { observationRunId: 'run-2' })))).toBe('real-evidence-replayed')
})

test('A-5 Given 机器可观察点只有真人见证或观察接口名不符 When validate Then host-observation-missing', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  expect(regReason(registerDraft(registry, makeDraft(makeWitness(registry), { observations: [] })))).toBe('ok')
  const rejection = validateEngineeringRealEvidence(gate(registry, ack))
  expect(rejection?.reason).toBe('host-observation-missing')
  expect(rejection?.message).toContain(MACHINE_HOTKEY)

  const second = makeRegistry('host-run-2')
  const secondAck = makeAck(second)
  const draft = makeDraft(makeWitness(second), { observations: [
    { pointId: MACHINE_HOTKEY, expected: 'recording-start', actual: 'x', observedVia: 'project.self-report', passed: true },
    { pointId: MACHINE_RECORDING, expected: 'capture-stream', actual: 'x', observedVia: 'host.pipewire.source-outputs', passed: true },
  ] })
  expect(regReason(registerDraft(second, draft))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(second, secondAck))?.reason).toBe('host-observation-missing')
})

test('A-6 Given 完全缺少真人见证 When validate Then human-witness-missing', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  expect(regReason(registerDraft(registry, makeDraft(null)))).toBe('ok')
  const rejection = validateEngineeringRealEvidence(gate(registry, ack))
  expect(rejection?.reason).toBe('human-witness-missing')
  expect(rejection?.message).toContain(HUMAN_SEMANTIC)
})

/* ------------------------------------------------------------------ */
/* 取消 / producer / verdict                                            */
/* ------------------------------------------------------------------ */

test('Given 批准后取消 When register Then 不登记、不残留，票据不烧可重试', () => {
  rewindClock()
  const registry = makeRegistry()
  const witness = makeWitness(registry)
  const ticket = makeTicket(registry)
  expect(regReason(registerDraft(registry, makeDraft(witness, { approval: { requestId: 'approval-1', cancelled: true } }), ticket))).toBe('requires-real-unattested')
  expect(registry.size()).toBe(0)
  expect(validateEngineeringRealEvidence(gate(registry, makeAck(registry)))?.reason).toBe('requires-real-unattested')
  expect(regReason(registerDraft(registry, makeDraft(witness), ticket))).toBe('ok')
})

test('Given 生产者声明 project-driver / human-witness / 他人观察器 When register Then 拒绝', () => {
  rewindClock()
  const registry = makeRegistry()
  const witness = makeWitness(registry)
  expect(regReason(registerDraft(registry, makeDraft(witness, { producer: { provenance: 'project-driver' } })))).toBe('project-driver-not-independent')
  expect(regReason(registerDraft(registry, makeDraft(witness, { producer: { provenance: 'human-witness' } })))).toBe('real-evidence-untrusted-source')
  expect(regReason(registerDraft(registry, makeDraft(witness, { producer: { provenance: 'host-observer', observerId: 'host-someone-else@1' } })))).toBe('real-evidence-untrusted-source')
  expect(registry.size()).toBe(0)
})

test('Given 宿主观察未通过 When register Then 不登记独立证据', () => {
  rewindClock()
  const registry = makeRegistry()
  expect(regReason(registerDraft(registry, makeDraft(makeWitness(registry), { verdict: 'rejected' })))).toBe('requires-real-unattested')
  expect(registry.size()).toBe(0)
})

/* ------------------------------------------------------------------ */
/* hostRun 重启失效                                                     */
/* ------------------------------------------------------------------ */

test('Given 宿主进程重启 When validate Then requires-real-unattested，且旧票据/旧收据都不被承认', () => {
  rewindClock()
  const first = makeRegistry('host-run-1')
  const oldTicket = makeTicket(first)
  const oldWitness = makeWitness(first)
  const oldAck = makeAck(first)
  expect(regReason(registerDraft(first, makeDraft(oldWitness), oldTicket))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(first, oldAck))).toBeNull()

  const restarted = makeRegistry('host-run-2')
  expect(restarted.size()).toBe(0)
  expect(validateEngineeringRealEvidence(gate(restarted, oldAck))?.reason).toBe('requires-real-unattested')
  expect(regReason(restarted.register(oldTicket, makeDraft(oldWitness)))).toBe('real-evidence-untrusted-source')
  expect(regReason(registerDraft(restarted, makeDraft(oldWitness)))).toBe('human-witness-unverified')
  // 新进程有新记录，但旧进程的 ack 收据仍不被承认。
  expect(regReason(registerDraft(restarted, makeDraft(makeWitness(restarted))))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(restarted, oldAck))?.reason).toBe('coverage-unverified-unacked')
})

/* ------------------------------------------------------------------ */
/* C：双时钟与新鲜度                                                     */
/* ------------------------------------------------------------------ */

test('C-1 Given 观察完成已超过新鲜度窗口 When validate Then real-evidence-expired', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  expect(validateEngineeringRealEvidence(gate(registry, ack))).toBeNull()
  monotonic = M0 + 120_001
  expect(validateEngineeringRealEvidence(gate(registry, ack))?.reason).toBe('real-evidence-expired')
})

test('C-2 Given 墙钟被回拨 When validate Then 绝不误放（新鲜度按单调钟，墙钟项 fail-closed）', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  // 墙钟回拨到观察完成之前：不得放行。
  epoch = T0 - 60_000
  const rolledBack = validateEngineeringRealEvidence(gate(registry, ack))
  expect(rolledBack).not.toBeNull()
  expect(rolledBack?.reason).toBe('real-evidence-time-invalid')
  // 墙钟回拨 + 单调钟已过期：仍不得放行（过期优先）。
  monotonic = M0 + 120_001
  epoch = T0 - 60_000
  expect(validateEngineeringRealEvidence(gate(registry, ack))?.reason).toBe('real-evidence-expired')
  rewindClock()
})

test('C-3 Given 单调钟回退 When validate Then real-evidence-time-invalid（fail-closed）', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  monotonic = M0 - 1
  expect(validateEngineeringRealEvidence(gate(registry, ack))?.reason).toBe('real-evidence-time-invalid')
  rewindClock()
})

test('Given 观察时长超上限 / 批准越界 / 完成于未来 When validate Then real-evidence-time-invalid', () => {
  rewindClock()
  const overlong = makeRegistry()
  const overlongAck = makeAck(overlong)
  expect(regReason(registerDraft(overlong, makeDraft(makeWitness(overlong), { startedAt: T0 - 900_000, approvedAt: T0 - 800_000, finishedAt: T0 - 1_000 })))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(overlong, overlongAck))?.reason).toBe('real-evidence-time-invalid')

  const early = makeRegistry()
  const earlyAck = makeAck(early)
  expect(regReason(registerDraft(early, makeDraft(makeWitness(early), { startedAt: T0 - 10_000, approvedAt: T0 - 20_000, finishedAt: T0 - 1_000 })))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(early, earlyAck))?.reason).toBe('real-evidence-time-invalid')

  const future = makeRegistry()
  const futureAck = makeAck(future)
  expect(regReason(registerDraft(future, makeDraft(makeWitness(future), { startedAt: T0 + 1_000, approvedAt: T0 + 2_000, finishedAt: T0 + 3_000 })))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(future, futureAck))?.reason).toBe('real-evidence-time-invalid')
})

test('Given 真人见证早于批准 When validate Then real-evidence-time-invalid', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  epoch = T0 - 30_000
  const witness = makeWitness(registry)
  epoch = T0
  expect(regReason(registerDraft(registry, makeDraft(witness)))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(registry, ack))?.reason).toBe('real-evidence-time-invalid')
})

/* ------------------------------------------------------------------ */
/* B：覆盖边界确认收据                                                   */
/* ------------------------------------------------------------------ */

test('B-1 Given 未提供 boundary ack 收据 When validate/consume Then coverage-unverified-unacked', () => {
  rewindClock()
  const registry = makeRegistry()
  registerDraft(registry, makeDraft(makeWitness(registry)))
  expect(validateEngineeringRealEvidence(gate(registry, undefined))?.reason).toBe('coverage-unverified-unacked')
  expect(consumeEngineeringRealEvidence(gate(registry, undefined))?.reason).toBe('coverage-unverified-unacked')
})

test('B-2 Given 用户拒绝确认 When 签发 ack 收据 Then 返回 null；未展示的边界编码不可通过', () => {
  rewindClock()
  const registry = makeRegistry()
  expect(registry.issueBoundaryAckReceipt({ requestId: 'permission-ack-1', allowed: false, sessionId: 'session-1',
    displayedBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
    displayedObservationRunIds: ['run-1'] })).toBeNull()
  registerDraft(registry, makeDraft(makeWitness(registry)))
  const incomplete = makeAck(registry, { displayedBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.hostObservationScope] })
  expect(validateEngineeringRealEvidence(gate(registry, incomplete))?.reason).toBe('coverage-unverified-unacked')
})

test('B-3 Given ack 收据的会话或观察轮次与当前交付不符 When validate Then binding-mismatch', () => {
  rewindClock()
  const registry = makeRegistry()
  registerDraft(registry, makeDraft(makeWitness(registry)))
  expect(validateEngineeringRealEvidence(gate(registry, makeAck(registry, { displayedObservationRunIds: ['run-other'] })))?.reason).toBe('real-evidence-binding-mismatch')
  expect(validateEngineeringRealEvidence(gate(registry, makeAck(registry, { sessionId: 'session-9' })))?.reason).toBe('real-evidence-binding-mismatch')
})

test('B-4 Given ack 收据已超过新鲜度窗口 When validate Then real-evidence-expired', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  // 记录在 ack 之后登记，使只有 ack 超龄（记录仍新鲜），隔离 ack 年龄分支。
  monotonic = M0 + 100_000
  registerDraft(registry, makeDraft(makeWitness(registry)))
  monotonic = M0 + 120_001
  expect(validateEngineeringRealEvidence(gate(registry, ack))?.reason).toBe('real-evidence-expired')
})

test('B-5 Given ack 收据完整 When 最终交付 consume Then 通过且收据只被消费一次', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  const input = gate(registry, ack)
  expect(validateEngineeringRealEvidence(input)).toBeNull()
  expect(consumeEngineeringRealEvidence(input)).toBeNull()
  expect(consumeEngineeringRealEvidence(input)?.reason).toBe('real-evidence-replayed')
})

test('Given 契约无 requiresReal（待审测试列表为空）When validate/consume Then 放行给既有 GWT 门', () => {
  rewindClock()
  const registry = makeRegistry()
  expect(validateEngineeringRealEvidence(gate(registry, undefined, { tests: [] }))).toBeNull()
  expect(consumeEngineeringRealEvidence(gate(registry, undefined, { tests: [] }))).toBeNull()
})

/* ------------------------------------------------------------------ */
/* 容量与清理（fail-closed）                                             */
/* ------------------------------------------------------------------ */

test('Given 登记记录达上限 When 再登记 Then real-evidence-capacity-exceeded', () => {
  rewindClock()
  const registry = makeRegistry('host-run-1', { maxEntries: 1 })
  expect(regReason(registerDraft(registry, makeDraft(makeWitness(registry))))).toBe('ok')
  const second = registerDraft(registry, makeDraft(makeWitness(registry), { observationRunId: 'run-2' }), makeTicket(registry))
  expect(regReason(second)).toBe('real-evidence-capacity-exceeded')
})

test('Given 票据/收据达上限 When 再签发 Then 返回 null（fail-closed）', () => {
  rewindClock()
  const tickets = makeRegistry('host-run-1', { maxTickets: 1 })
  expect(makeTicket(tickets)).not.toBeNull()
  expect(makeTicket(tickets)).toBeNull()

  const witnesses = makeRegistry('host-run-1', { maxWitnessReceipts: 1 })
  expect(makeWitness(witnesses)).not.toBeNull()
  expect(makeWitness(witnesses)).toBeNull()

  const acks = makeRegistry('host-run-1', { maxBoundaryAckReceipts: 1 })
  expect(makeAck(acks)).not.toBeNull()
  expect(makeAck(acks)).toBeNull()
})

test('Given 消费墓碑达上限 When consume Then real-evidence-capacity-exceeded 且不半消费', () => {
  rewindClock()
  const registry = makeRegistry('host-run-1', { maxConsumedRunIds: 0 })
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  expect(consumeEngineeringRealEvidence(gate(registry, ack))?.reason).toBe('real-evidence-capacity-exceeded')
  expect(registry.consumedRunIds()).toEqual([])
  expect(registry.peek('acc-real')?.consumed).toBe(false)
})

test('Given 记录超过保留窗口 When cleanup Then 按 age 清理且门禁回到 unattested', () => {
  rewindClock()
  const registry = makeRegistry('host-run-1', { entryRetentionMonotonicMs: 1_000 })
  registerDraft(registry, makeDraft(makeWitness(registry)))
  expect(registry.size()).toBe(1)
  monotonic = M0 + 2_000
  const report = registry.cleanup({ maxAgeMonotonicMs: 1_000 })
  expect(report.entries).toBe(1)
  expect(report.tickets).toBe(1)
  expect(report.witnessReceipts).toBe(1)
  expect(registry.size()).toBe(0)
  expect(validateEngineeringRealEvidence(gate(registry, makeAck(registry)))?.reason).toBe('requires-real-unattested')
})

test('Given 只清理指定会话 When cleanup(sessionId) Then 其他会话对象保留', () => {
  rewindClock()
  const registry = makeRegistry('host-run-1', { entryRetentionMonotonicMs: 0 })
  const witnessOne = makeWitness(registry, { testId: 'acc-1' })
  expect(regReason(registerDraft(registry, makeDraft(witnessOne, { testId: 'acc-1' }), makeTicket(registry, 'acc-1')))).toBe('ok')
  const witnessTwo = makeWitness(registry, { testId: 'acc-2', sessionId: 'session-2' })
  expect(regReason(registerDraft(registry, makeDraft(witnessTwo, { testId: 'acc-2', sessionId: 'session-2', observationRunId: 'run-2' }), makeTicket(registry, 'acc-2', 'session-2')))).toBe('ok')
  expect(registry.size()).toBe(2)
  monotonic = M0 + 1
  const report = registry.cleanup({ sessionId: 'session-1' })
  expect(report.entries).toBe(1)
  expect(registry.peek('acc-1')).toBeNull()
  expect(registry.peek('acc-2')).not.toBeNull()
})

/* ------------------------------------------------------------------ */
/* canonical 严格化                                                     */
/* ------------------------------------------------------------------ */

test('R2-1 Given 非 plain JSON 值 When canonicalize Then 抛错，且语义不同的对象不产生相同规范串', () => {
  expect(canonicalizeEngineeringValue({ b: 1, a: [2, { d: 3, c: 4 }] }))
    .toBe(canonicalizeEngineeringValue({ a: [2, { c: 4, d: 3 }], b: 1 }))
  class Box { value = 1 }
  expect(() => canonicalizeEngineeringValue(new Box())).toThrow()
  expect(() => canonicalizeEngineeringValue(new Date(0))).toThrow()
  expect(() => canonicalizeEngineeringValue(new Map())).toThrow()
  expect(() => canonicalizeEngineeringValue({ a: undefined })).toThrow()
  expect(() => canonicalizeEngineeringValue([undefined])).toThrow()
  expect(() => canonicalizeEngineeringValue(Number.NaN)).toThrow()
  expect(() => canonicalizeEngineeringValue(Number.POSITIVE_INFINITY)).toThrow()
  expect(() => canonicalizeEngineeringValue(() => 1)).toThrow()
  expect(canonicalizeEngineeringValue(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}')
  expect(canonicalizeEngineeringValue({ a: 1 })).not.toBe(canonicalizeEngineeringValue({ a: 2 }))
})

test('Given 记录被追加观察项 When 重算 reportDigest Then 结果变化；缺省 sha256 为 64 hex', () => {
  rewindClock()
  const registry = makeRegistry()
  const record = recordOf(registerDraft(registry, makeDraft(makeWitness(registry))))
  const digestInput = { binding: record.binding, observations: record.observations, witnesses: record.witnesses,
    verdict: record.verdict, coverageBoundaryCodes: record.coverageBoundaryCodes, approval: record.approval }
  expect(computeEngineeringRealReportDigest(digestInput, fakeDigest)).toBe(record.reportDigest)
  const changed = { ...digestInput, observations: [...record.observations, { pointId: 'extra', expected: 'x', actual: 'x', observedVia: 'host.x', passed: true }] }
  expect(computeEngineeringRealReportDigest(changed, fakeDigest)).not.toBe(record.reportDigest)
  expect(sha256EngineeringDigest('abc')).toMatch(/^[0-9a-f]{64}$/)
})

test('Given 调用方在登记后修改自己的草稿对象 When validate Then registry 事实不受影响', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  const draft = makeDraft(makeWitness(registry))
  expect(regReason(registerDraft(registry, draft))).toBe('ok')
  draft.observations = []
  draft.verdict = 'rejected'
  draft.coverageBoundaryCodes = []
  expect(validateEngineeringRealEvidence(gate(registry, ack))).toBeNull()
})

/* ------------------------------------------------------------------ */
/* 终审收口轮：INV-C1 双时钟源 + 见证收据新鲜度 + ack 记录集绑定           */
/* ------------------------------------------------------------------ */

/** 与宿主时钟“基准不同”的调用方时钟：整体平移（模拟不同 origin）。 */
function shiftedClock(epochDelta: number, monotonicDelta: number) {
  return { epochNow: () => epoch + epochDelta, monotonicNow: () => monotonic + monotonicDelta }
}

test('INV-C1-1 Given 调用方时钟基准下移（仍在容差内）When 真实年龄已超窗 Then 不得低估，仍 real-evidence-expired', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  // 宿主时钟：真实年龄 120_001ms，已超 maxEvidenceAgeMs(120_000)。
  monotonic = M0 + 120_001
  // 若信任调用方时钟，年龄会被低估到 118_501ms 而“看起来新鲜”——这是必须堵住的误放路径。
  expect(monotonic - 1_500 - M0).toBeLessThanOrEqual(120_000)
  const rejection = validateEngineeringRealEvidence(gate(registry, ack, { clock: shiftedClock(-1_500, -1_500) }))
  expect(rejection?.reason).toBe('real-evidence-expired')
  expect(rejection?.message).toContain('观察完成已超过新鲜度窗口')
  rewindClock()
})

test('INV-C1-2 Given 调用方时钟偏差超过容差 When validate/consume/completeness Then 一律 real-evidence-time-invalid', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  const skewed = { clock: shiftedClock(-60_000, -60_000) }
  expect(validateEngineeringRealEvidence(gate(registry, ack, skewed))?.reason).toBe('real-evidence-time-invalid')
  expect(consumeEngineeringRealEvidence(gate(registry, ack, skewed))?.reason).toBe('real-evidence-time-invalid')
  expect(validateEngineeringRealEvidenceCompleteness(gate(registry, undefined, skewed))?.reason).toBe('real-evidence-time-invalid')
  expect(registry.consumedRunIds()).toEqual([])
  // 容差可收紧到 1ms；同源时钟仍必须通过。
  expect(validateEngineeringRealEvidence(gate(registry, ack, { clockSkewToleranceMs: 1 }))).toBeNull()
  // 墙钟单独漂移同样被检出。
  expect(validateEngineeringRealEvidence(gate(registry, ack, { clock: shiftedClock(60_000, 0) }))?.reason).toBe('real-evidence-time-invalid')
})

test('Given 见证收据本身超过新鲜度窗口（记录仍新鲜）When validate Then real-evidence-expired，指向见证点', () => {
  rewindClock()
  const registry = makeRegistry()
  const witness = makeWitness(registry)          // 见证于 M0 签发
  monotonic = M0 + 100_000
  const ack = makeAck(registry)                  // ack 于 M0+100_000 签发（保持新鲜）
  expect(regReason(registerDraft(registry, makeDraft(witness)))).toBe('ok')
  monotonic = M0 + 120_001                        // 记录年龄 20_001ms（新鲜），见证收据年龄 120_001ms（超窗）
  const rejection = validateEngineeringRealEvidence(gate(registry, ack))
  expect(rejection?.reason).toBe('real-evidence-expired')
  expect(rejection?.message).toContain(HUMAN_SEMANTIC)
  expect(rejection?.message).toContain('见证')
  rewindClock()
})

test('Given 同一 ack 收据被用于另一组观察记录 When validate Then binding-mismatch，不能跨记录集复用', () => {
  rewindClock()
  const registry = makeRegistry()
  const witnessOne = makeWitness(registry)
  expect(regReason(registerDraft(registry, makeDraft(witnessOne)))).toBe('ok')          // acc-real / run-1
  const witnessTwo = makeWitness(registry, { testId: 'acc-2' })
  const draftTwo = makeDraft(witnessTwo, { testId: 'acc-2', observationRunId: 'run-2' })
  expect(regReason(registerDraft(registry, draftTwo, makeTicket(registry, 'acc-2')))).toBe('ok')
  // ack 只展示了 run-1，却拿去交付“run-1 + run-2”的记录集 → 拒。
  const narrow = makeAck(registry, { displayedObservationRunIds: ['run-1'] })
  expect(validateEngineeringRealEvidence(gate(registry, narrow, { tests: [realTarget(), realTarget({ testId: 'acc-2' })] }))?.reason)
    .toBe('real-evidence-binding-mismatch')
  // ack 展示了两个轮次，却拿去交付“仅 run-1”的记录集 → 同样拒（超集方向）。
  const wide = makeAck(registry, { displayedObservationRunIds: ['run-1', 'run-2'] })
  expect(validateEngineeringRealEvidence(gate(registry, wide))?.reason).toBe('real-evidence-binding-mismatch')
  expect(registry.consumedRunIds()).toEqual([])
  // 重新观察后记录集变化，旧 ack 同样失效。
  const witnessThree = makeWitness(registry)
  expect(regReason(registerDraft(registry, makeDraft(witnessThree, { observationRunId: 'run-3' })))).toBe('ok')
  expect(validateEngineeringRealEvidence(gate(registry, makeAck(registry, { displayedObservationRunIds: ['run-1'] })))?.reason)
    .toBe('real-evidence-binding-mismatch')
  rewindClock()
})

test('Given 窗口参数非正或非有限 When 调用门禁/构造 registry Then 构造期 TypeError（fail-fast）', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  expect(() => validateEngineeringRealEvidence(gate(registry, ack, { maxEvidenceAgeMs: 0 }))).toThrow(TypeError)
  expect(() => validateEngineeringRealEvidence(gate(registry, ack, { maxEvidenceAgeMs: -1 }))).toThrow(TypeError)
  expect(() => validateEngineeringRealEvidence(gate(registry, ack, { maxEvidenceAgeMs: Number.NaN }))).toThrow(TypeError)
  expect(() => validateEngineeringRealEvidence(gate(registry, ack, { maxObservationMs: 0 }))).toThrow(TypeError)
  expect(() => validateEngineeringRealEvidence(gate(registry, ack, { clockSkewToleranceMs: 0 }))).toThrow(TypeError)
  expect(() => validateEngineeringRealEvidenceCompleteness(gate(registry, undefined, { maxEvidenceAgeMs: 0 }))).toThrow(TypeError)
  expect(() => consumeEngineeringRealEvidence(gate(registry, ack, { maxEvidenceAgeMs: 0 }))).toThrow(TypeError)
  expect(() => createEngineeringRealEvidenceRegistry({ hostRunId: 'h', projectId: 'p',
    observer: { observerId: 'o', observerVersion: '1' }, clock, digestOf: fakeDigest, limits: { maxEntries: -1 } })).toThrow(TypeError)
  expect(() => createEngineeringRealEvidenceRegistry({ hostRunId: 'h', projectId: 'p',
    observer: { observerId: 'o', observerVersion: '1' }, clock, digestOf: fakeDigest, limits: { entryRetentionMonotonicMs: -5 } })).toThrow(TypeError)
})

test('给定分层：观察期轻量校验不要求 ack，交付期必须 ack（同一记录、同一时刻）', () => {
  rewindClock()
  const registry = makeRegistry()
  const ack = makeAck(registry)
  registerDraft(registry, makeDraft(makeWitness(registry)))
  // 无 ack：观察期过、交付期拒。
  expect(validateEngineeringRealEvidenceCompleteness(gate(registry, undefined))).toBeNull()
  expect(validateEngineeringRealEvidence(gate(registry, undefined))?.reason).toBe('coverage-unverified-unacked')
  // 观察期校验不消耗 ack 收据，交付链仍可用。
  expect(consumeEngineeringRealEvidence(gate(registry, ack))).toBeNull()
})

test('Given 证据不完备 When 观察期轻量校验 Then 与交付门同样拒绝（不降级）', () => {
  rewindClock()
  const empty = makeRegistry()
  expect(validateEngineeringRealEvidenceCompleteness(gate(empty, undefined))?.reason).toBe('requires-real-unattested')

  const noWitness = makeRegistry()
  expect(regReason(registerDraft(noWitness, makeDraft(null)))).toBe('ok')
  expect(validateEngineeringRealEvidenceCompleteness(gate(noWitness, undefined))?.reason).toBe('human-witness-missing')

  const stale = makeRegistry()
  expect(regReason(registerDraft(stale, makeDraft(makeWitness(stale))))).toBe('ok')
  expect(validateEngineeringRealEvidenceCompleteness(gate(stale, undefined, { evidenceDigest: 'ev-9' }))?.reason).toBe('real-evidence-stale')

  const expired = makeRegistry()
  expect(regReason(registerDraft(expired, makeDraft(makeWitness(expired))))).toBe('ok')
  monotonic = M0 + 120_001
  expect(validateEngineeringRealEvidenceCompleteness(gate(expired, undefined))?.reason).toBe('real-evidence-expired')
  rewindClock()

  // 契约无 requiresReal：观察期同样放行。
  expect(validateEngineeringRealEvidenceCompleteness(gate(makeRegistry(), undefined, { tests: [] }))).toBeNull()
})
