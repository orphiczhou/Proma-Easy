/**
 * W-I B-f：真实能力证据门禁宿主接线层测试（`nanju-engineering-real-gate.ts`）。
 *
 * 测试口径：
 * - **行为为主**：用真实协议层（`nanju-engineering-real-evidence`）+ fixture 工程目录，验证
 *   观察期/交付期两条路由、分层语义（观察期不要 ack）、原子消费、逐项指出 testId、边界码合流；
 * - **不虚构观察数据**：登记草稿在测试内显式构造（等价于未来 host-observer 的真实登记），
 *   生产代码路径里没有任何自动登记/自动签署；
 * - 只 mock 证据捕获与契约路径（避免依赖真实工程骨架文件），协议层与时钟为真实实现。
 *
 * Bun 独立运行：`bun test apps/electron/src/main/lib/__tests__/w-i-b-f-real-gate.test.ts`
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONTRACT_REL = '07_ENGINEERING/contract.md'
const CONTRACT_TEXT = '# 工程契约（B-f 夹具）\n'
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf-8').digest('hex')

// 夹具化「证据捕获 / 契约路径」：目录名含 no-contract → 契约不可读；含 no-evidence → 证据缺失
mock.module('../nanju-engineering-contract', () => ({
  ENGINEERING_CONTRACT_PATH: CONTRACT_REL,
  captureEngineeringEvidence: (projectDir: string) => ({
    evidence: projectDir.includes('no-evidence') ? null : { digest: 'ev-1' },
    problems: [],
  }),
}))

const gate = await import('../nanju-engineering-real-gate')
const { ENGINEERING_REAL_BOUNDARY_CODES } = await import('../nanju-engineering-real-evidence')

const TARGET = { testId: 'acc-real', target: 'app', covers: ['US-01'] as const }

function makeProjectDir(prefix = 'bf-gate-', withContract = true): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  if (withContract) {
    mkdirSync(join(dir, '07_ENGINEERING'), { recursive: true })
    writeFileSync(join(dir, CONTRACT_REL), CONTRACT_TEXT)
  }
  return dir
}

function scopeFor(projectDir: string) {
  return { workspaceSlug: 'ws', projectId: 'p1', sessionId: 'session-1', projectDir }
}

/** 登记一份「宿主观察器产出」的 attest 证据（等价未来真实 observer 的登记动作）。 */
function registerAttested(projectDir: string, overrides: Record<string, unknown> = {}) {
  const registry = gate.__peekEngineeringRealRegistryForTests('p1')
  const ticket = registry.issueObservationTicket({ testId: TARGET.testId, sessionId: 'session-1' })
  const now = gate.engineeringRealClock.epochNow()
  const result = registry.register(ticket, {
    testId: TARGET.testId,
    target: TARGET.target,
    covers: [...TARGET.covers],
    evidenceDigest: 'ev-1',
    contractSha256: sha256(CONTRACT_TEXT),
    sessionId: 'session-1',
    device: gate.resolveEngineeringDeviceBinding(),
    observationRunId: 'run-1',
    startedAt: now - 3_000,
    approvedAt: now - 2_000,
    finishedAt: now - 1_000,
    observations: [],
    witnesses: [],
    verdict: 'attested',
    coverageBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
    approval: { requestId: 'permission-approve-1', cancelled: false },
    ...overrides,
  })
  void projectDir
  return result
}

let projectDir: string

beforeEach(() => {
  gate.__resetEngineeringRealGateForTests()
  projectDir = makeProjectDir()
})

describe('W-I B-f｜观察期路由（suite：逐项、不要求 ack、不消费）', () => {
  test('Given 无任何登记 When 观察期判定 Then 逐项 requires-real-unattested 且指出 testId', () => {
    const result = gate.resolveSuiteRealEvidence(scopeFor(projectDir), [TARGET])
    expect(result.available).toBe(true)
    expect(result.rejections).toHaveLength(1)
    expect(result.rejections[0]?.reason).toBe('requires-real-unattested')
    expect(result.rejections[0]?.testId).toBe('acc-real')
    expect(result.rejections[0]?.message).toContain('acc-real')
  })

  test('Given 已登记 attest 证据但无 ack When 观察期判定 Then 通过（分层：观察期不要求 ack）', () => {
    const registered = registerAttested(projectDir)
    expect(registered.ok).toBe(true)
    const result = gate.resolveSuiteRealEvidence(scopeFor(projectDir), [TARGET])
    expect(result.rejections).toEqual([])
    expect(result.available).toBe(true)
  })

  test('Given 契约不可读 When 观察期判定 Then 拒绝且不抛（不放行）', () => {
    const bare = makeProjectDir('bf-nocontract-', false)
    const result = gate.resolveSuiteRealEvidence(scopeFor(bare), [TARGET])
    expect(result.rejections).toHaveLength(1)
    expect(result.rejections[0]?.reason).toBe('requires-real-unattested')
    expect(result.rejections[0]?.message).toContain('不可读')
  })

  test('Given 服务端未接观察器（available=false）When suite 集成 Then 维持原「尚未接入」硬拦（由 suite 断言覆盖，见 w-i-b-f 源断言）', () => {
    // 本层只负责「已接入时的判定」；未接入分支由 suite 的 no-hook 分支处理。
    const result = gate.resolveSuiteRealEvidence(scopeFor(projectDir), [])
    expect(result.available).toBe(true)
    expect(result.rejections).toEqual([])
  })

  test('Given 观察期判定 When 检查 registry 状态 Then 未被消费（可继续走交付）', () => {
    registerAttested(projectDir)
    gate.resolveSuiteRealEvidence(scopeFor(projectDir), [TARGET])
    const entry = gate.__peekEngineeringRealRegistryForTests('p1').peek('acc-real')
    expect(entry?.consumed).toBe(false)
  })
})

describe('W-I B-f｜交付期路由（validate + consume 必带 ack）', () => {
  test('Given 已登记证据但无 ack When 交付校验 Then coverage-unverified-unacked（不消费）', () => {
    registerAttested(projectDir)
    const check = gate.checkDeliveryRealEvidence(scopeFor(projectDir), [TARGET])
    expect(check.rejection?.reason).toBe('coverage-unverified-unacked')
    const commit = gate.commitDeliveryRealEvidence(scopeFor(projectDir), [TARGET])
    expect(commit.rejection?.reason).toBe('coverage-unverified-unacked')
    // 未消费：ack 补齐后仍可交付
    expect(gate.__peekEngineeringRealRegistryForTests('p1').peek('acc-real')?.consumed).toBe(false)
  })

  test('Given 无登记 When 交付校验 Then requires-real-unattested（先证据后 ack 的判定序）', () => {
    const check = gate.checkDeliveryRealEvidence(scopeFor(projectDir), [TARGET])
    expect(check.rejection?.reason).toBe('requires-real-unattested')
    expect(check.rejection?.testId).toBe('acc-real')
  })

  test('Given ack 由真实确认签发 When 交付提交 Then 通过并原子消费；二次提交 replayed', () => {
    registerAttested(projectDir)
    const receipt = gate.issueBoundaryAckAfterRealConfirmation(
      { projectId: 'p1', sessionId: 'session-1' },
      {
        requestId: 'permission-ack-1',
        allowed: true,
        displayedBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
        displayedObservationRunIds: ['run-1'],
      },
    )
    expect(receipt).not.toBeNull()
    const check = gate.checkDeliveryRealEvidence(scopeFor(projectDir), [TARGET])
    expect(check.rejection).toBeNull()
    const first = gate.commitDeliveryRealEvidence(scopeFor(projectDir), [TARGET])
    expect(first.rejection).toBeNull()
    expect(gate.__peekEngineeringRealRegistryForTests('p1').peek('acc-real')?.consumed).toBe(true)
    const second = gate.commitDeliveryRealEvidence(scopeFor(projectDir), [TARGET])
    expect(second.rejection?.reason).toBe('real-evidence-replayed')
  })

  test('Given allowed=false When 签发 ack Then null（不签发），且交付保持拒绝', () => {
    registerAttested(projectDir)
    const receipt = gate.issueBoundaryAckAfterRealConfirmation(
      { projectId: 'p1', sessionId: 'session-1' },
      {
        requestId: 'permission-ack-1',
        allowed: false,
        displayedBoundaryCodes: [],
        displayedObservationRunIds: [],
      },
    )
    expect(receipt).toBeNull()
    expect(gate.currentBoundaryAckReceipt('p1', 'session-1')).toBeUndefined()
    expect(gate.checkDeliveryRealEvidence(scopeFor(projectDir), [TARGET]).rejection?.reason).toBe('coverage-unverified-unacked')
  })

  test('Given ack 展示的轮次集与登记集不一致 When 交付提交 Then binding-mismatch（收据不可跨记录集复用）', () => {
    registerAttested(projectDir)
    gate.issueBoundaryAckAfterRealConfirmation(
      { projectId: 'p1', sessionId: 'session-1' },
      {
        requestId: 'permission-ack-1',
        allowed: true,
        displayedBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
        displayedObservationRunIds: ['run-other'],
      },
    )
    const commit = gate.commitDeliveryRealEvidence(scopeFor(projectDir), [TARGET])
    expect(commit.rejection?.reason).toBe('real-evidence-binding-mismatch')
  })

  test('Given ack 未展示登记记录声明的边界码 When 交付提交 Then coverage-unverified-unacked（不静默放行）', () => {
    registerAttested(projectDir)
    gate.issueBoundaryAckAfterRealConfirmation(
      { projectId: 'p1', sessionId: 'session-1' },
      {
        requestId: 'permission-ack-1',
        allowed: true,
        displayedBoundaryCodes: [],
        displayedObservationRunIds: ['run-1'],
      },
    )
    const commit = gate.commitDeliveryRealEvidence(scopeFor(projectDir), [TARGET])
    expect(commit.rejection?.reason).toBe('coverage-unverified-unacked')
    expect(commit.rejection?.message).toContain('未展示覆盖边界编码')
  })

  test('Given ack 属于其他会话 When 交付提交 Then binding-mismatch', () => {
    registerAttested(projectDir)
    gate.issueBoundaryAckAfterRealConfirmation(
      { projectId: 'p1', sessionId: 'session-other' },
      {
        requestId: 'permission-ack-1',
        allowed: true,
        displayedBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
        displayedObservationRunIds: ['run-1'],
      },
    )
    // 该 receipt 存在但绑定其它会话 → 当前会话无 ack
    expect(gate.currentBoundaryAckReceipt('p1', 'session-1')).toBeUndefined()
    expect(gate.checkDeliveryRealEvidence(scopeFor(projectDir), [TARGET]).rejection?.reason).toBe('coverage-unverified-unacked')
  })

  test('Given requiresReal 测试为空 When 交付/观察期判定 Then 直接放行（不因门禁改变既有 GWT 门）', () => {
    expect(gate.checkDeliveryRealEvidence(scopeFor(projectDir), []).rejection).toBeNull()
    expect(gate.commitDeliveryRealEvidence(scopeFor(projectDir), []).rejection).toBeNull()
    expect(gate.resolveSuiteRealEvidence(scopeFor(projectDir), []).rejections).toEqual([])
  })

  test('Given 证据缺失（capture 返回 null）When 交付提交 Then 拒绝且不消费', () => {
    const noEvidence = makeProjectDir('bf-no-evidence-')
    const result = gate.commitDeliveryRealEvidence(scopeFor(noEvidence), [TARGET])
    expect(result.rejection?.reason).toBe('requires-real-unattested')
    expect(result.rejection?.message).toContain('无法判定')
  })
})

describe('W-I B-f｜registry 生命周期与边界码合流', () => {
  test('Given 同项目多次取用 When 取 registry Then 同一实例（单例）；不同项目则不同实例', () => {
    const a = gate.__peekEngineeringRealRegistryForTests('p1')
    const b = gate.__peekEngineeringRealRegistryForTests('p1')
    const c = gate.__peekEngineeringRealRegistryForTests('p2')
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    expect(a.hostRunId).toBe(c.hostRunId)
    expect(a.projectId).toBe('p1')
    expect(c.projectId).toBe('p2')
  })

  test('Given 会话停止清理 When 再判定 Then ack 已丢弃（交付必拒）且跨会话不可复用残留记录', () => {
    registerAttested(projectDir)
    expect(gate.resolveSuiteRealEvidence(scopeFor(projectDir), [TARGET]).rejections).toEqual([])
    gate.issueBoundaryAckAfterRealConfirmation(
      { projectId: 'p1', sessionId: 'session-1' },
      {
        requestId: 'permission-ack-1',
        allowed: true,
        displayedBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
        displayedObservationRunIds: ['run-1'],
      },
    )
    expect(gate.checkDeliveryRealEvidence(scopeFor(projectDir), [TARGET]).rejection).toBeNull()
    gate.cleanupEngineeringRealEvidence('session-1')
    // 停止后：ack 已丢 → 交付必被拒（不能用停止前的确认继续交付）
    expect(gate.currentBoundaryAckReceipt('p1', 'session-1')).toBeUndefined()
    expect(gate.commitDeliveryRealEvidence(scopeFor(projectDir), [TARGET]).rejection?.reason)
      .toBe('coverage-unverified-unacked')
    // 协议层 cleanup 只按「会话 + 保留窗口」回收，不删新鲜记录 → 安全靠绑定：
    // 残留记录换会话即 binding-mismatch（不是「记录已被删」）
    const otherSession = { ...scopeFor(projectDir), sessionId: 'session-2' }
    expect(gate.resolveSuiteRealEvidence(otherSession, [TARGET]).rejections[0]?.reason)
      .toBe('real-evidence-binding-mismatch')
  })

  test('Given 清理其他会话 When 判定 Then 不影响本会话记录', () => {
    registerAttested(projectDir)
    gate.cleanupEngineeringRealEvidence('session-other')
    expect(gate.resolveSuiteRealEvidence(scopeFor(projectDir), [TARGET]).rejections).toEqual([])
  })

  test('Given 已登记记录 When 合流边界码 Then 结构边界 + 记录边界齐全去重', () => {
    registerAttested(projectDir)
    const codes = gate.resolveCoverageBoundaryCodes(scopeFor(projectDir), [TARGET])
    expect(codes).toContain(ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent)
    expect(codes).toContain(ENGINEERING_REAL_BOUNDARY_CODES.hostObservationScope)
    // 去重（record 里也有 projectDriverNotIndependent）
    expect(new Set(codes).size).toBe(codes.length)
  })

  test('Given 观察期结果 When 检查 boundaryCodes Then 即便被拒也回传边界码（不静默丢弃）', () => {
    const result = gate.resolveSuiteRealEvidence(scopeFor(projectDir), [TARGET])
    expect(result.rejections.length).toBeGreaterThan(0)
    expect(result.boundaryCodes).toContain(ENGINEERING_REAL_BOUNDARY_CODES.hostObservationScope)
  })

  test('Given 宿主时钟实例 When 读取 Then 冻结且同源（registry 与门禁共用同一实例）', () => {
    expect(Object.isFrozen(gate.engineeringRealClock)).toBe(true)
    expect(typeof gate.engineeringRealClock.epochNow()).toBe('number')
    expect(typeof gate.engineeringRealClock.monotonicNow()).toBe('number')
    // 行为证明同源：登记→观察期判定通过（若门禁用另一套时钟，SKEW 容差会判 time-invalid）
    registerAttested(projectDir)
    expect(gate.resolveSuiteRealEvidence(scopeFor(projectDir), [TARGET]).rejections).toEqual([])
  })

  test('Given 窗口参数 When 检查 Then 全为正数常量（传 0 会触发协议层 TypeError）', () => {
    expect(gate.ENGINEERING_REAL_MAX_OBSERVATION_MS).toBeGreaterThan(0)
    expect(gate.ENGINEERING_REAL_MAX_EVIDENCE_AGE_MS).toBeGreaterThan(0)
    expect(gate.ENGINEERING_REAL_CLOCK_SKEW_TOLERANCE_MS).toBeGreaterThan(0)
  })

  test('Given 会话清理后 When 读取 ack 收据 Then 已移除（不跨会话复用）', () => {
    registerAttested(projectDir)
    gate.issueBoundaryAckAfterRealConfirmation(
      { projectId: 'p1', sessionId: 'session-1' },
      {
        requestId: 'permission-ack-1',
        allowed: true,
        displayedBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
        displayedObservationRunIds: ['run-1'],
      },
    )
    expect(gate.currentBoundaryAckReceipt('p1', 'session-1')).toBeDefined()
    gate.cleanupEngineeringRealEvidence('session-1')
    expect(gate.currentBoundaryAckReceipt('p1', 'session-1')).toBeUndefined()
  })
})

describe('W-I B-f｜收据签发入口边界（只搭结构，不虚构观察数据）', () => {
  test('Given allowed=true But requestId 空 When 签发 ack Then null（结构校验不放水）', () => {
    const receipt = gate.issueBoundaryAckAfterRealConfirmation(
      { projectId: 'p1', sessionId: 'session-1' },
      {
        requestId: '',
        allowed: true,
        displayedBoundaryCodes: [ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent],
        displayedObservationRunIds: ['run-1'],
      },
    )
    expect(receipt).toBeNull()
  })

  test('Given 见证签发 allowed=false When 调用 Then null（不签发）', () => {
    const receipt = gate.issueHumanWitnessAfterRealApproval('p1', {
      requestId: 'permission-witness-1',
      allowed: false,
      testId: 'acc-real',
      sessionId: 'session-1',
      pointId: 'linux.asr.semantic',
      storyId: 'US-01',
      assertion: '口述内容与转写一致',
    })
    expect(receipt).toBeNull()
  })

  test('Given 见证签发 allowed=true When 调用 Then 得到 opaque 收据（只有 kind 字段）', () => {
    const receipt = gate.issueHumanWitnessAfterRealApproval('p1', {
      requestId: 'permission-witness-1',
      allowed: true,
      testId: 'acc-real',
      sessionId: 'session-1',
      pointId: 'linux.asr.semantic',
      storyId: 'US-01',
      assertion: '口述内容与转写一致',
    })
    expect(receipt).not.toBeNull()
    expect(Object.keys(receipt as object)).toEqual(['kind'])
    expect((receipt as { kind: string }).kind).toBe('host-human-witness-receipt')
  })

  test('Given 项目目录被删除 When 观察期判定 Then 不抛异常、按拒绝返回（fail-closed）', () => {
    const dir = makeProjectDir('bf-rm-')
    rmSync(dir, { recursive: true, force: true })
    const result = gate.resolveSuiteRealEvidence(scopeFor(dir), [TARGET])
    expect(result.rejections[0]?.reason).toBe('requires-real-unattested')
  })
})

/* ------------------------------------------------------------------ */
/* 接线源断言：suite / execution / gwt-runner / orchestrator / 边界       */
/* ------------------------------------------------------------------ */

describe('W-I B-f｜接线源断言（门禁路由不越界、不虚构、不静默）', () => {
  const ROOT = join(import.meta.dir, '../../../..')
  const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')
  const slice = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = text.indexOf(to, start)
    expect(end).toBeGreaterThan(start)
    return text.slice(start, end)
  }

  test('Given suite 观察期 When 检查硬拦语义 Then 整片拦点已改逐项、原「尚未接入」兜底文案保留且绝不放行', () => {
    const suite = src('src/main/lib/nanju-engineering-suite.ts')
    // 1) 原「任意 requiresReal 一律拦」的单行写法必须消失（改为逐项门禁判定）
    expect(suite).not.toContain("if (contract.tests.some((test) => test.requiresReal)) return")
    // 2) 无 hook（宿主未接线）→ 保持原兜底文案（语义仍是「不能据此交付」）
    expect(suite).toContain('驱动检查已完成，但真实系统行为的独立验收证据尚未接入，不能据此交付。')
    expect(suite).toContain('const resolver = services.resolveRealEvidence')
    // 3) 逐项判定：available !== true / 有 rejection 都必须返回 reason（不 return pass）
    expect(suite).toContain('if (outcome?.available !== true) return')
    expect(suite).toContain("reason: '真实能力证据未齐备：'")
    // 4) 边界码合流（不静默丢弃）
    expect(suite).toContain('base.coverageUnverified = [...new Set([...base.coverageUnverified, ...(outcome?.boundaryCodes ?? [])])]')
    // 5) 结论仍只可能 pass（全部通过）或 blocked/reason（有任何拒绝）
    expect(suite).toContain("return { ...base, verdict: 'pass', reason: null }")
  })

  test('Given execution 服务契约 When 检查 Then resolveRealEvidence 为可选钩子（缺省=未接入）', () => {
    const exec = src('src/main/lib/nanju-engineering-execution.ts')
    expect(exec).toContain('resolveRealEvidence?: (request: EngineeringSuiteRealEvidenceRequest)')
    expect(exec).toContain('export interface EngineeringSuiteRealEvidenceOutcome')
  })

  test('Given gwt-runner When 检查观察期注入 Then 用 scope 绑定的 resolveSuiteRealEvidence（非协议直调）', () => {
    const runner = src('src/main/lib/nanju-gwt-runner.ts')
    expect(runner).toContain("import { commitDeliveryRealEvidence, resolveSuiteRealEvidence } from './nanju-engineering-real-gate'")
    expect(runner).toContain('resolveRealEvidence: (request) => resolveSuiteRealEvidence(')
    expect(runner).toContain('projectDir: request.projectDir')
    // 观察期走 completeness（不要求 ack、不消费）
    expect(runner).not.toContain('validateEngineeringRealEvidenceCompleteness')
  })

  test('Given gwt-runner 交付门 When 检查 Then 逐项消费、保持 engineering-evidence-missing 拦截、consume 前无 await', () => {
    const runner = src('src/main/lib/nanju-gwt-runner.ts')
    expect(runner).toContain('const consumed = commitDeliveryRealEvidence(gateScope, gateTargets)')
    expect(runner).toContain("return block('engineering-evidence-missing',")
    // 原子性：从 commit 调用到 rejection 判定之间不得出现 await（否则 validate/consume 之间有交错窗口）
    const atomic = slice(runner, 'const consumed = commitDeliveryRealEvidence(gateScope, gateTargets)', 'if (consumed.rejection) {')
    // 只查「真 await 语句」（注释里出现 await 字样不算）
    expect(/^\s*await\s/m.test(atomic)).toBe(false)
    // 无会话上下文 → 不放行（fail-closed），而不是跳过门禁
    expect(runner).toContain("if (!input.sessionId) {")
    // 持久化路径不再直接 consume 之外的单独调用（避免「validate 通过但未消费」的假交付）
    expect(runner).toContain('sessionId?: string')
  })

  test('Given gate 模块 When 检查 Then 观察期用 completeness、交付用 validate+consume（同一同步块、无 await）', () => {
    const gateSrc = src('src/main/lib/nanju-engineering-real-gate.ts')
    const observation = slice(gateSrc, 'export function resolveSuiteRealEvidence(', 'export function createSuiteRealEvidenceResolver(')
    expect(observation).toContain('validateEngineeringRealEvidenceCompleteness(input)')
    expect(observation).not.toContain('consumeEngineeringRealEvidence')
    expect(/^\s*await\s/m.test(observation)).toBe(false)
    const commit = slice(gateSrc, 'export function commitDeliveryRealEvidence(', '\n}\n')
    expect(commit).toContain('const rejection = validateEngineeringRealEvidence(input)')
    expect(commit).toContain('consumeEngineeringRealEvidence(input)')
    expect(/^\s*await\s/m.test(commit)).toBe(false)
    // 反向证据：交付函数确实同时含 validate 与 consume（不是「只 validate 忘了消费」）
    expect(commit).toContain('consumeEngineeringRealEvidence(input)')
    expect(commit.indexOf('validateEngineeringRealEvidence(input)')).toBeLessThan(commit.indexOf('consumeEngineeringRealEvidence(input)'))
  })

  test('Given 宿主时钟 When 检查 Then registry 与门禁共用同一冻结实例（INV-C1）', () => {
    const gateSrc = src('src/main/lib/nanju-engineering-real-gate.ts')
    expect(gateSrc).toContain('clock: engineeringRealClock')
    expect(gateSrc).toContain('clock: engineeringRealClock,')
    // 只有一处时钟定义（禁止第二套实现）
    expect(gateSrc.match(/export const engineeringRealClock/g)?.length).toBe(1)
    expect(gateSrc.match(/Date\.now\(\)/g)?.length).toBeGreaterThanOrEqual(1)
  })

  test('Given registry 引用 When 检查 Then 不经 IPC/不进 preload，也不进 services 项目可见路径', () => {
    expect(src('src/main/lib/nanju-ipc.ts')).not.toContain('real-gate')
    expect(src('src/preload/index.ts')).not.toContain('real-gate')
    expect(src('src/preload/index.ts')).not.toContain('RealEvidence')
    // 生产路径不得取 registry 引用（只有 __tests__ 可用 peek 钩子）
    expect(src('src/main/lib/nanju-gwt-runner.ts')).not.toContain('__peekEngineeringRealRegistryForTests')
    expect(src('src/main/lib/agent-orchestrator.ts')).not.toContain('__peekEngineeringRealRegistryForTests')
    // gate 模块自身不导出 registry 创建/类型（不给出「拿 registry」的口子）
    const gateSrc = src('src/main/lib/nanju-engineering-real-gate.ts')
    expect(gateSrc).not.toContain('export function createEngineeringRealEvidenceRegistry')
    expect(gateSrc).not.toContain('export type EngineeringRealEvidenceRegistry')
  })

  test('Given orchestrator 停止会话 When 检查 Then 清理该会话门禁残留（失败不阻断停止）', () => {
    const orch = src('src/main/lib/agent-orchestrator.ts')
    expect(orch).toContain('cleanupEngineeringRealEvidence(sessionId)')
    const around = slice(orch, 'cleanupEngineeringRealEvidence(sessionId)', 'console.log(`[Agent 编排] 已中止会话')
    expect(around).toContain('catch')
  })

  test('Given orchestrator 交付门 When 检查 Then 透传项目会话（缺省则 requiresReal 一律拒绝）', () => {
    const orch = src('src/main/lib/agent-orchestrator.ts')
    expect(orch).toContain('sessionId: deliveryInfo?.sessionId ?? undefined')
    expect(orch).toContain('const deliveryInfo = readProjectInfo(workspaceSlug, projectId)')
  })

  test('Given suite 门禁拒绝文案 When 检查 Then 逐项指出 testId（可定位到具体测试，不整片含糊）', () => {
    const suite = src('src/main/lib/nanju-engineering-suite.ts')
    expect(suite).toContain('（测试项 ')
    expect(suite).toContain('first.testId ?? realTests[0]!.id')
  })
})
