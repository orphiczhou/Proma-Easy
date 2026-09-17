/**
 * P1 E2：三次自修复 / 熔断 / 环境类分流 纯策略模块 单测
 *
 * 覆盖面（EF §3.1 九条 + 边界扩展）：
 * - classifyRepairFailure：环境类（磁盘/内存/端口/运行时缺失）识别；防「过宽关键词」把产品 bug
 *   （selector 超时、断言失败）误判为环境问题；设计约束类；未知类兜底
 * - planNextRepair：首产失败不计修复预算；三次内策略不重复（≥2 种手段）；
 *   三次耗尽 → circuit-break + exhausted；环境类 → notify-environment 且不消耗预算；
 *   文件快照端口不可用/缺省 → 熔断 reason 明确「未回滚代码」（fail-closed，不假称已回滚）
 * - blocked / pass / fail / error 的修复资格判定（blocked 不烧预算，与 agent-orchestrator:791 同口径）
 * - 失败签名归一化（不重复同一手段的判定基础）
 * - buildCircuitBreakMessage：quick / iterative 分支；同一阶段第 1 次 vs 第 3 次熔断文案不同；
 *   简化版建议；快照标签诚实（未提供时明确未回滚）
 * - buildCircuitBreakLog：逐次策略 / 分类 / 签名 + 熔断原因
 * - 持久化：_repair-log.json 经 safe-file 原子写；往返一致；重复 attempt 号幂等；损坏 JSON 容错；clear
 *
 * fixture 模式与 nanju-guide-progress.test.ts / nanju-delegate-guard.test.ts 同型：
 * mock.module config-paths 指向 tmpdir 后动态导入被测模块；写盘只落在临时目录。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 当前 fixture 根目录（mock 的 getWorkspaceFilesDir 每次调用时读取） */
let fixtureRoot = ''

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const repairLoopModule = await import('./nanju-repair-loop')
const {
  REPAIR_MAX_ATTEMPTS,
  REPAIR_LOG_FILE_NAME,
  REPAIR_STRATEGY_SEQUENCE,
  classifyRepairFailure,
  buildFailureSignature,
  isRepairEligibleVerdict,
  pickDistinctStrategy,
  planNextRepair,
  planNextRepairForProject,
  buildCircuitBreakMessage,
  buildCircuitBreakLog,
  readRepairLogState,
  appendRepairAttempt,
  clearRepairAttempts,
  assessRollback,
} = repairLoopModule

import type {
  FileRollbackPort,
  FileRollbackResult,
  RepairAttempt,
  RepairFailureClass,
  RepairStrategy,
} from './nanju-repair-loop'

const WORKSPACE_SLUG = 'test-ws'
const PROJECT_ID = 'p1'

/** 构造隔离 fixture：<tmp>/project-p1/（_repair-log.json 由被测模块自行创建） */
function setupFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-repair-loop-'))
  fixtureRoot = dir
  mkdirSync(join(dir, `project-${PROJECT_ID}`), { recursive: true })
  return WORKSPACE_SLUG
}

/**
 * 构造「写入必失败」fixture：用普通文件占据 project-<id> 目录路径。
 * append/clear 的写入走 `<file>/_repair-log.json.tmp` → 真实 fs 报 ENOTDIR，
 * 不需要 mock node:fs（与本仓既有失败注入口径一致：真实文件系统故障）。
 */
function setupOccupiedFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-repair-loop-occupied-'))
  fixtureRoot = dir
  writeFileSync(join(dir, `project-${PROJECT_ID}`), 'occupied-by-file', 'utf-8')
  return WORKSPACE_SLUG
}

function repairLogPath(): string {
  return join(fixtureRoot, `project-${PROJECT_ID}`, REPAIR_LOG_FILE_NAME)
}

function makeAttempt(
  attempt: number,
  strategy: RepairStrategy,
  failureClass: RepairFailureClass = 'code',
  failureSignature = `sig-${attempt}`,
): RepairAttempt {
  return { attempt, strategy, failureClass, failureSignature, at: '2026-09-14T00:00:00.000Z' }
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

// ===== classifyRepairFailure =====

describe('classifyRepairFailure（环境类识别与防误判）', () => {
  test('Given 错误为「磁盘空间不足」 When 分类 Then failureClass=environment', () => {
    expect(classifyRepairFailure({ message: 'ENOSPC: no space left on device, write' })).toBe('environment')
    expect(classifyRepairFailure({ message: '写入失败：磁盘空间不足' })).toBe('environment')
    expect(classifyRepairFailure({ message: '内存不足，进程被终止' })).toBe('environment')
    expect(classifyRepairFailure({ message: 'listen EADDRINUSE: address already in use :::5173' })).toBe('environment')
    expect(classifyRepairFailure({ message: '端口 5173 被占用' })).toBe('environment')
    expect(classifyRepairFailure({ message: 'ENOENT: 未找到运行时 python3' })).toBe('environment')
  })

  test('Given 分类字段已由宿主判定为环境类 When 分类 Then 直接采用 kind，不依赖文案', () => {
    expect(classifyRepairFailure({ message: '任意文案', kind: 'environment' })).toBe('environment')
    expect(classifyRepairFailure({ message: '任意文案', kind: 'resource' })).toBe('environment')
  })

  test('Given 产品 bug（selector 超时 / 断言失败 / 一般 timeout 文案）When 分类 Then 不得误判为 environment', () => {
    // GWT 映射类：Timeout 30000ms exceeded waiting for selector —— 测试侧映射问题，不是环境问题
    expect(classifyRepairFailure({ message: 'Timeout 30000ms exceeded waiting for selector [data-ai-id=save]', kind: 'mapping' })).not.toBe('environment')
    // 行为类断言失败 → 产品代码缺陷
    expect(classifyRepairFailure({ message: 'AssertionError: expected 3 to be 4', kind: 'behavior' })).toBe('code')
    // 只说「超时」而不含 errno/端口/磁盘等环境事实 → 不得归环境
    expect(classifyRepairFailure({ message: '操作超时，请稍后重试', kind: 'behavior' })).not.toBe('environment')
    // 组件渲染报错里出现 room/oom 子串也不得误判（词边界保护）
    expect(classifyRepairFailure({ message: 'Cannot read properties of undefined (reading "room")', kind: 'behavior' })).toBe('code')
  })

  test('Given 覆盖缺失/设计约束类失败 When 分类 Then design-constraint', () => {
    expect(classifyRepairFailure({ message: 'PRD 缺 US-07 清单，无可执行场景', kind: 'coverage' })).toBe('design-constraint')
    expect(classifyRepairFailure({ message: '实现与设计约束冲突：超出原型范围', kind: 'design' })).toBe('design-constraint')
  })

  test('Given 无分类信息且文案无明确线索 When 分类 Then unknown（保守兜底，不猜环境）', () => {
    expect(classifyRepairFailure({ message: '测试用例执行结束' })).toBe('unknown')
    expect(classifyRepairFailure({ message: '' })).toBe('unknown')
  })
})

// ===== planNextRepair：预算与策略轮换 =====

describe('planNextRepair（三次预算与策略轮换）', () => {
  test('Given 首产构建失败 When 规划第一次修复 Then action=repair 且 attemptsUsed=0（首产不计修复预算）', () => {
    const plan = planNextRepair({ attempts: [], mode: 'quick', logStatus: 'missing' })
    expect(plan.action).toBe('repair')
    expect(plan.attemptsUsed).toBe(0)
    expect(plan.exhausted).toBe(false)
    expect(plan.failClosed).not.toBe(true)
    expect(plan.nextStrategy).toBe(REPAIR_STRATEGY_SEQUENCE[0])
  })

  test('Given 已用 direct-fix 失败 When 规划第二次修复 Then nextStrategy 与首次不同（Q4 不重复同一手段）', () => {
    const plan = planNextRepair({ attempts: [makeAttempt(1, 'direct-fix')], mode: 'quick', logStatus: 'valid' })
    expect(plan.action).toBe('repair')
    expect(plan.attemptsUsed).toBe(1)
    expect(plan.nextStrategy).not.toBe('direct-fix')
  })

  test('Given 已用两种策略均失败 When 规划第三次修复 Then nextStrategy=alternate-approach 且 attemptsUsed=2', () => {
    const plan = planNextRepair({
      attempts: [makeAttempt(1, 'direct-fix'), makeAttempt(2, 're-read-design')],
      mode: 'iterative',
      logStatus: 'valid',
    })
    expect(plan.action).toBe('repair')
    expect(plan.nextStrategy).toBe('alternate-approach')
    expect(plan.attemptsUsed).toBe(2)
  })

  test('Given 三次修复全部失败 When 规划下一步 Then action=circuit-break 且 exhausted=true', () => {
    const plan = planNextRepair({
      attempts: [makeAttempt(1, 'direct-fix'), makeAttempt(2, 're-read-design'), makeAttempt(3, 'alternate-approach')],
      mode: 'quick',
      logStatus: 'valid',
    })
    expect(plan.action).toBe('circuit-break')
    expect(plan.exhausted).toBe(true)
    expect(plan.failClosed).toBe(false)
    expect(plan.nextStrategy).toBeNull()
    expect(plan.attemptsUsed).toBe(REPAIR_MAX_ATTEMPTS)
  })

  test('Given 三次用满且文件快照可用 When 规划熔断 Then reason 给出策略汇总且不出现「未回滚」', () => {
    const plan = planNextRepair({
      attempts: [makeAttempt(1, 'direct-fix'), makeAttempt(2, 're-read-design'), makeAttempt(3, 'alternate-approach')],
      mode: 'quick',
      logStatus: 'valid',
      fileRollbackAvailable: true,
    })
    expect(plan.action).toBe('circuit-break')
    expect(plan.reason).toContain('direct-fix')
    expect(plan.reason).not.toContain('未回滚')
  })

  test('Given 文件快照端口不可用或未声明 When 规划熔断 Then 不声称已回滚（reason 含「未回滚」）', () => {
    const attempts = [makeAttempt(1, 'direct-fix'), makeAttempt(2, 're-read-design'), makeAttempt(3, 'alternate-approach')]
    const missing = planNextRepair({ attempts, mode: 'quick', logStatus: 'valid' })
    expect(missing.action).toBe('circuit-break')
    expect(missing.reason).toContain('未回滚')
    expect(missing.reason).toContain('文件快照')

    const unavailable = planNextRepair({ attempts, mode: 'quick', logStatus: 'valid', fileRollbackAvailable: false })
    expect(unavailable.reason).toContain('未回滚')
  })
})

// ===== 环境类与 blocked 不烧预算 =====

describe('环境类与 blocked 不烧修复预算', () => {
  test('Given 错误为「磁盘空间不足」When 规划下一步 Then action=notify-environment 且 attemptsUsed=0（不消耗预算）', () => {
    const plan = planNextRepair({
      attempts: [makeAttempt(1, 'direct-fix', 'environment', 'sig-env')],
      mode: 'quick',
      logStatus: 'valid',
      failureClass: 'environment',
    })
    expect(plan.action).toBe('notify-environment')
    expect(plan.attemptsUsed).toBe(0)
    expect(plan.nextStrategy).toBeNull()
    expect(plan.exhausted).toBe(false)
  })

  test('Given 历史里混有环境类记录 When 规划 Then 环境类不计入 attemptsUsed', () => {
    const plan = planNextRepair({
      attempts: [
        makeAttempt(1, 'direct-fix', 'environment', 'sig-env'),
        makeAttempt(1, 'direct-fix'),
        makeAttempt(2, 're-read-design'),
      ],
      mode: 'iterative',
      logStatus: 'valid',
    })
    expect(plan.attemptsUsed).toBe(2)
    expect(plan.action).toBe('repair')
  })

  test('Given 本轮 verdict=blocked When 记录 Then 不新增 attempt（blocked 不烧预算）', () => {
    const slug = setupFixture()
    expect(isRepairEligibleVerdict('blocked')).toBe(false)
    // 与 agent-orchestrator.ts:791 同口径：blocked 早退，不进入记录/规划路径
    if (isRepairEligibleVerdict('blocked')) {
      appendRepairAttempt(slug, PROJECT_ID, makeAttempt(1, 'direct-fix'))
    }
    const state = readRepairLogState(slug, PROJECT_ID)
    expect(state.attempts).toHaveLength(0)
    const plan = planNextRepair({ attempts: state.attempts, mode: 'quick', logStatus: state.status })
    expect(plan.attemptsUsed).toBe(0)
    expect(plan.action).toBe('repair')
  })

  test('Given 四种 verdict When 判断修复资格 Then 仅 fail/error 可进入修复循环', () => {
    expect(isRepairEligibleVerdict('pass')).toBe(false)
    expect(isRepairEligibleVerdict('blocked')).toBe(false)
    expect(isRepairEligibleVerdict('fail')).toBe(true)
    expect(isRepairEligibleVerdict('error')).toBe(true)
    // 未知字符串保守拒绝（不擅自开修复）
    expect(isRepairEligibleVerdict('weird')).toBe(false)
  })
})

// ===== 签名与策略不重复 =====

describe('失败签名归一化与策略不重复', () => {
  test('Given 同一缺陷重复出现（数字/路径/uuid/耗时不同）When 生成签名 Then 归一化后相等', () => {
    const a = buildFailureSignature({
      message: 'AssertionError: expected 3 to be 4 at /tmp/run-8f3a/uuid-4f2c9d1e-1111-2222-3333-444455556666.spec.ts:42:7',
      kind: 'behavior',
    })
    const b = buildFailureSignature({
      message: 'AssertionError:   expected 7 to be 9 at /tmp/run-9b1c/uuid-aaaa9999-1111-2222-3333-444455556666.spec.ts:108:12',
      kind: 'behavior',
    })
    expect(a).toBe(b)
  })

  test('Given 不同缺陷 When 生成签名 Then 签名不同', () => {
    const a = buildFailureSignature({ message: 'AssertionError: expected 3 to be 4', kind: 'behavior' })
    const b = buildFailureSignature({ message: 'TypeError: cannot read properties of undefined', kind: 'behavior' })
    expect(a).not.toBe(b)
  })

  test('Given 历史异常（两次都已用 direct-fix）When 选下一次策略 Then 仍返回未用过的策略（3 次内至少两种）', () => {
    expect(pickDistinctStrategy([makeAttempt(1, 'direct-fix'), makeAttempt(2, 'direct-fix')])).toBe('re-read-design')
    expect(pickDistinctStrategy([makeAttempt(1, 'direct-fix'), makeAttempt(2, 're-read-design')])).toBe('alternate-approach')
    // 三种用尽后仍返回合法策略（不再扩展枚举，由 planNextRepair 负责熔断）
    expect(pickDistinctStrategy([
      makeAttempt(1, 'direct-fix'), makeAttempt(2, 're-read-design'), makeAttempt(3, 'alternate-approach'),
    ])).toBe('alternate-approach')
  })
})

// ===== buildCircuitBreakMessage =====

describe('buildCircuitBreakMessage（US-U07 边界与模式分支）', () => {
  const attempts = [makeAttempt(1, 'direct-fix'), makeAttempt(2, 're-read-design'), makeAttempt(3, 'alternate-approach')]

  test('Given 同一阶段第 3 次熔断 When 构建安抚 Then 文案与第 1 次不同且含简化版建议', () => {
    const first = buildCircuitBreakMessage({ mode: 'quick', attempts: [], consecutiveCircuitCount: 1 })
    const third = buildCircuitBreakMessage({ mode: 'quick', attempts, consecutiveCircuitCount: 3 })
    expect(third).not.toBe(first)
    expect(third).toContain('缩小')
    expect(first).not.toContain('缩小')
  })

  test('Given quick 与 iterative When 构建安抚 Then 建议分支不同且各自模式可读', () => {
    const quick = buildCircuitBreakMessage({ mode: 'quick', attempts, consecutiveCircuitCount: 3 })
    const iterative = buildCircuitBreakMessage({ mode: 'iterative', attempts, consecutiveCircuitCount: 3 })
    expect(quick).not.toBe(iterative)
    expect(quick).toContain('最小版本')
    expect(iterative).toContain('设计约束')
  })

  test('Given 提供健康快照标签 When 构建安抚 Then 明确已回到该快照', () => {
    const withSnapshot = buildCircuitBreakMessage({
      mode: 'quick', attempts, snapshotLabel: 'coding-前', consecutiveCircuitCount: 2,
    })
    expect(withSnapshot).toContain('coding-前')
    expect(withSnapshot).toContain('快照')
  })

  test('Given 无快照可用 When 构建安抚 Then 明确未回滚代码（不假称已恢复）', () => {
    const message = buildCircuitBreakMessage({ mode: 'quick', attempts, consecutiveCircuitCount: 2 })
    expect(message).toContain('未回滚')
    expect(message).not.toContain('已恢复')
  })

  test('Given 已尝试两种策略 When 构建安抚 Then 文案含已用策略（可追溯）', () => {
    const message = buildCircuitBreakMessage({ mode: 'iterative', attempts, consecutiveCircuitCount: 1 })
    expect(message).toContain('direct-fix')
    expect(message).toContain('re-read-design')
  })
})

// ===== buildCircuitBreakLog =====

describe('buildCircuitBreakLog（内部日志）', () => {
  test('Given 3 条 attempt When 构建日志 Then 含每条策略/分类/签名与熔断原因', () => {
    const attempts = [
      makeAttempt(1, 'direct-fix', 'code', 'behavior:assertionerror'),
      makeAttempt(2, 're-read-design', 'design-constraint', 'coverage:missing-us'),
      makeAttempt(3, 'alternate-approach', 'unknown', 'unknown:opaque'),
    ]
    const log = buildCircuitBreakLog({ attempts, reason: '已用完 3 次自动修复' })
    expect(log).toContain('已用完 3 次自动修复')
    for (const a of attempts) {
      expect(log).toContain(a.strategy)
      expect(log).toContain(a.failureClass)
      expect(log).toContain(a.failureSignature)
    }
    expect(log).toContain('第 1 次')
    expect(log).toContain('第 3 次')
  })

  test('Given 无 attempt When 构建日志 Then 不抛错且保留熔断原因', () => {
    const log = buildCircuitBreakLog({ attempts: [], reason: '环境异常' })
    expect(log).toContain('环境异常')
  })
})

// ===== 持久化 =====

describe('修复日志持久化（safe-file 原子写）', () => {
  test('Given 已写 3 条 attempt When 读取 Then 顺序与字段往返一致', () => {
    const slug = setupFixture()
    const attempts = [
      makeAttempt(1, 'direct-fix', 'code', 'sig-1'),
      makeAttempt(2, 're-read-design', 'design-constraint', 'sig-2'),
      makeAttempt(3, 'alternate-approach', 'unknown', 'sig-3'),
    ]
    for (const a of attempts) appendRepairAttempt(slug, PROJECT_ID, a)
    expect(readRepairLogState(slug, PROJECT_ID).status).toBe('valid')
    expect(readRepairLogState(slug, PROJECT_ID).attempts).toEqual(attempts)
  })

  test('Given 重复写同一 attempt 号 When 读取 Then 幂等（不产生重复条目，后写覆盖）', () => {
    const slug = setupFixture()
    appendRepairAttempt(slug, PROJECT_ID, makeAttempt(1, 'direct-fix', 'code', 'sig-old'))
    appendRepairAttempt(slug, PROJECT_ID, makeAttempt(1, 're-read-design', 'code', 'sig-new'))
    const read = readRepairLogState(slug, PROJECT_ID).attempts
    expect(read).toHaveLength(1)
    expect(read[0]?.strategy).toBe('re-read-design')
    expect(read[0]?.failureSignature).toBe('sig-new')
  })

  test('Given 日志文件损坏 When 读取 Then 返回空数组（safe-file 容错，不上抛）', () => {
    const slug = setupFixture()
    writeFileSync(repairLogPath(), '{ 不是合法 JSON', 'utf-8')
    // S1 返工：损坏不再等价于「无记录」——状态必须可区分为 corrupt，attempts 仍为空
    expect(readRepairLogState(slug, PROJECT_ID).status).toBe('corrupt')
    expect(readRepairLogState(slug, PROJECT_ID).attempts).toEqual([])
  })

  test('Given 从未写过日志 When 读取 Then 返回空数组且不抛错', () => {
    const slug = setupFixture()
    expect(readRepairLogState(slug, PROJECT_ID).status).toBe('missing')
    expect(readRepairLogState(slug, PROJECT_ID).attempts).toEqual([])
  })

  test('Given 已写 attempt When clear Then 读取为空且文件仍可继续追加', () => {
    const slug = setupFixture()
    appendRepairAttempt(slug, PROJECT_ID, makeAttempt(1, 'direct-fix'))
    clearRepairAttempts(slug, PROJECT_ID)
    expect(readRepairLogState(slug, PROJECT_ID).attempts).toEqual([])
    appendRepairAttempt(slug, PROJECT_ID, makeAttempt(1, 're-read-design'))
    expect(readRepairLogState(slug, PROJECT_ID).attempts).toHaveLength(1)
  })
})

// ===== S1（E-review）：损坏日志 fail-closed，不得从零重试 =====

describe('S1 日志损坏 fail-closed（损坏 ≠ 无记录 ≠ 预算归零）', () => {
  test('Given 日志损坏且无回退副本 When 读取状态 Then corrupt，与 missing 严格可区分', () => {
    const corruptSlug = setupFixture()
    writeFileSync(repairLogPath(), '{ 不是合法 JSON', 'utf-8')
    const corrupt = readRepairLogState(corruptSlug, PROJECT_ID)
    expect(corrupt.status).toBe('corrupt')
    expect(corrupt.reason).toContain('损坏')

    const freshSlug = setupFixture()
    const fresh = readRepairLogState(freshSlug, PROJECT_ID)
    expect(fresh.status).toBe('missing')
    expect(fresh.status).not.toBe(corrupt.status)
  })

  test('Given 日志损坏 When 规划下一步 Then circuit-break + failClosed（不得返回 repair）', () => {
    const slug = setupFixture()
    writeFileSync(repairLogPath(), 'not-json-at-all', 'utf-8')
    const state = readRepairLogState(slug, PROJECT_ID)
    const plan = planNextRepair({ attempts: state.attempts, mode: 'quick', logStatus: state.status })
    expect(plan.action).toBe('circuit-break')
    expect(plan.failClosed).toBe(true)
    expect(plan.nextStrategy).toBeNull()
    // R2：fail-closed ≠ 预算用尽（不得误称「已用尽 3 次」）
    expect(plan.exhausted).toBe(false)
    expect(plan.reason).toContain('不代表预算已用尽')
    // 对照：真正无记录（missing）时才是正常的第一次修复
    const freshSlug = setupFixture()
    const fresh = readRepairLogState(freshSlug, PROJECT_ID)
    expect(planNextRepair({ attempts: fresh.attempts, mode: 'quick', logStatus: fresh.status }).action).toBe('repair')
  })

  test('Given 日志含非法条目（部分可抢救）When 读取 Then corrupt 且保留合法条目（不丢历史）', () => {
    const slug = setupFixture()
    const good = makeAttempt(1, 'direct-fix')
    writeFileSync(repairLogPath(), JSON.stringify([good, { attempt: 'x' }]), 'utf-8')
    const state = readRepairLogState(slug, PROJECT_ID)
    expect(state.status).toBe('corrupt')
    expect(state.attempts).toEqual([good])
  })

  test('Given 日志损坏 When append Then 拒绝写入 + requiresManualReset，且不覆盖历史文件', () => {
    const slug = setupFixture()
    writeFileSync(repairLogPath(), 'broken-payload', 'utf-8')
    const result = appendRepairAttempt(slug, PROJECT_ID, makeAttempt(2, 're-read-design'))
    expect(result.ok).toBe(false)
    expect(result.requiresManualReset).toBe(true)
    expect(result.reason).toContain('损坏')
    // 未被覆盖：仍为原始损坏内容（避免用残缺数组覆盖历史）
    expect(readRepairLogState(slug, PROJECT_ID).status).toBe('corrupt')
  })
})

// ===== S2（E-review）：写失败必须可被调用方感知 =====

describe('S2 写失败可供 I fail-closed（不吞错）', () => {
  test('Given 写入目标不可用 When append Then 返回 ok=false 且带可分类归因', () => {
    const slug = setupOccupiedFixture()
    const result = appendRepairAttempt(slug, PROJECT_ID, makeAttempt(1, 'direct-fix'))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('写入失败')
    // ENOTDIR 属环境类：I 可据此走「环境不烧预算」分支
    expect(result.failureClass).toBe('environment')
  })

  test('Given 写入目标不可用 When clear Then 返回 ok=false（不吞错）', () => {
    const slug = setupOccupiedFixture()
    const result = clearRepairAttempts(slug, PROJECT_ID)
    expect(result.ok).toBe(false)
    expect(result.failureClass).toBe('environment')
  })

  test('Given 上一次日志写失败 When 规划下一步 Then circuit-break + failClosed（不得发起下一轮）', () => {
    const plan = planNextRepair({ attempts: [makeAttempt(1, 'direct-fix')], mode: 'quick', logStatus: 'valid', logWriteFailed: true })
    expect(plan.action).toBe('circuit-break')
    expect(plan.failClosed).toBe(true)
    // R2：写失败只说明计数不可信，不代表预算用尽
    expect(plan.exhausted).toBe(false)
    expect(plan.reason).toContain('未能落盘')
  })

  test('Given 环境类 attempt When append Then 守卫拒绝写入且日志不新增（铁律下沉为不变量）', () => {
    const slug = setupFixture()
    const result = appendRepairAttempt(slug, PROJECT_ID, makeAttempt(1, 'direct-fix', 'environment', 'sig-env'))
    expect(result.ok).toBe(false)
    expect(result.failureClass).toBe('environment')
    expect(readRepairLogState(slug, PROJECT_ID).status).toBe('missing')
  })

  test('Given 非法 attempt 字段 When append Then 拒绝写入（不做部分写入）', () => {
    const slug = setupFixture()
    const result = appendRepairAttempt(slug, PROJECT_ID, { attempt: 1 } as unknown as RepairAttempt)
    expect(result.ok).toBe(false)
    expect(result.failureClass).toBe('unknown')
    expect(readRepairLogState(slug, PROJECT_ID).status).toBe('missing')
  })
})

// ===== S3（E-review）：端口对齐 D 最终 API（UUID string + 结构化 RestoreResult） =====

describe('S3 FileRollbackPort 对齐 D 最终 API', () => {
  /** D RestoreSuccess 形状（字段名与 nanju-file-snapshot.ts 一致，此处本地复刻以锁定结构契约） */
  const dSuccessLike = {
    ok: true as const,
    txnId: 'txn-1',
    restoredFiles: 12,
    preRestoreBackupDir: '/tmp/_pre-restore-backups/txn-1',
    carriedOverExcluded: ['.env'],
  }
  /** D RestoreFailure 形状（locked：可稍后重试） */
  const dLockedLike = {
    ok: false as const,
    reason: 'locked',
    message: '另一个恢复事务正在进行',
    compensated: false,
  }
  /** D RestoreFailure 形状（restore-verify-failed：已补偿，工程字节级安全） */
  const dCompensatedLike = {
    ok: false as const,
    reason: 'restore-verify-failed',
    message: '落位校验失败',
    compensated: true,
  }

  test('Given D 结果对象 When 作为端口返回值 Then 结构兼容（UUID string 与增删字段均不需改名）', async () => {
    const port: FileRollbackPort = {
      capture: async () => ({ snapshotId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }),
      rollback: async () => dSuccessLike,
    }
    const captured = await port.capture('coding-前')
    expect(typeof captured.snapshotId).toBe('string')
    expect(captured.snapshotId).toContain('-') // UUID 原样透传，不做数值派生
    expect(await port.rollback(captured.snapshotId)).toBe(dSuccessLike)
  })

  test('Given D 成功结果 When 归一 Then succeeded 且携带 preRestoreBackupDir', () => {
    const assessment = assessRollback(dSuccessLike as FileRollbackResult)
    expect(assessment.outcome).toBe('succeeded')
    expect(assessment.preRestoreBackupDir).toBe('/tmp/_pre-restore-backups/txn-1')
    expect(assessment.compensated).toBe(false)
  })

  test('Given locked 与 compensated 两种失败 When 归一 Then 语义不同（可重试 vs 已补偿）', () => {
    const locked = assessRollback(dLockedLike as FileRollbackResult)
    const compensated = assessRollback(dCompensatedLike as FileRollbackResult)
    expect(locked.outcome).toBe('failed')
    expect(compensated.outcome).toBe('failed')
    expect(locked.retriable).toBe(true)
    expect(locked.compensated).toBe(false)
    expect(compensated.retriable).toBe(false)
    expect(compensated.compensated).toBe(true)
    expect(assessRollback(null).outcome).toBe('not-attempted')
  })
})

// ===== S4（E-review）：文案严格按明确回滚结论 =====

describe('S4 熔断文案按回滚结论（label 不证明已恢复）', () => {
  const attempts = [makeAttempt(1, 'direct-fix'), makeAttempt(2, 're-read-design'), makeAttempt(3, 'alternate-approach')]
  const failed: FileRollbackResult = { ok: false, reason: 'restore-verify-failed', message: '落位校验失败', compensated: true }
  const locked: FileRollbackResult = { ok: false, reason: 'locked', message: '恢复事务占用中', compensated: false }

  test('Given 有快照标签但回滚失败 When 构建文案 Then 不说「已恢复」（含未回滚 + 标签）', () => {
    const message = buildCircuitBreakMessage({
      mode: 'quick', attempts, consecutiveCircuitCount: 2, snapshotLabel: 'coding-前', rollback: failed,
    })
    expect(message).not.toContain('已恢复')
    expect(message).toContain('未回滚')
    expect(message).toContain('coding-前')
    expect(message).toContain('已补偿回恢复前状态')
  })

  test('Given 未提供回滚结论（未尝试）When 构建文案 Then 声明未回滚（label 本身不证明恢复）', () => {
    const message = buildCircuitBreakMessage({
      mode: 'iterative', attempts, consecutiveCircuitCount: 2, snapshotLabel: 'coding-前',
    })
    expect(message).not.toContain('已恢复')
    expect(message).toContain('未回滚')
    expect(message).toContain('尚未执行')
  })

  test('Given 回滚成功 When 构建文案 Then 才允许出现「已恢复到」', () => {
    const message = buildCircuitBreakMessage({
      mode: 'quick', attempts, consecutiveCircuitCount: 2, snapshotLabel: 'coding-前', rollbackOutcome: 'succeeded',
    })
    expect(message).toContain('已恢复到快照「coding-前」')
  })

  test('Given locked 与 compensated When 构建文案 Then 两种措辞不同（可重试 vs 已补偿）', () => {
    const lockedMsg = buildCircuitBreakMessage({
      mode: 'quick', attempts, consecutiveCircuitCount: 2, snapshotLabel: 'coding-前', rollback: locked,
    })
    const compensatedMsg = buildCircuitBreakMessage({
      mode: 'quick', attempts, consecutiveCircuitCount: 2, snapshotLabel: 'coding-前', rollback: failed,
    })
    expect(lockedMsg).not.toBe(compensatedMsg)
    expect(lockedMsg).toContain('可重试')
    expect(compensatedMsg).toContain('已补偿')
    expect(lockedMsg).not.toContain('已恢复')
    expect(compensatedMsg).not.toContain('已恢复')
  })

  test('Given 显式 rollbackOutcome=succeeded 但 rollback 结果失败 When 构建 Then 以显式结论为准', () => {
    const message = buildCircuitBreakMessage({
      mode: 'quick', attempts, consecutiveCircuitCount: 2, snapshotLabel: 'coding-前',
      rollback: locked, rollbackOutcome: 'succeeded',
    })
    expect(message).toContain('已恢复到快照「coding-前」')
  })
})

// ===== wave3 A：相同失败签名不重复同一策略 =====

describe('wave3 A：同一失败签名不得重复同一策略', () => {
  test('Given 同一签名已用 direct-fix When 规划下一次 Then nextStrategy 不是 direct-fix', () => {
    const signature = 'behavior:assertionerror'
    const plan = planNextRepair({
      attempts: [makeAttempt(1, 'direct-fix', 'code', signature)],
      mode: 'quick',
      logStatus: 'valid',
      failureSignature: signature,
    })
    expect(plan.action).toBe('repair')
    expect(plan.nextStrategy).not.toBe('direct-fix')
  })

  test('Given 三种策略都被用过（异常历史）且本次签名仅出现在 direct-fix 上 When 选策略 Then 避开该签名的旧策略', () => {
    const attempts = [
      makeAttempt(1, 'direct-fix', 'code', 'sig-a'),
      makeAttempt(2, 're-read-design', 'code', 'sig-b'),
      makeAttempt(3, 'alternate-approach', 'code', 'sig-c'),
    ]
    // 全局都用了 → 退化到「针对本签名未用过」：sig-a 只用过 direct-fix
    expect(pickDistinctStrategy(attempts, 'sig-a')).toBe('re-read-design')
    // 无签名信息时保持原语义（返回最后一种，熔断由 planNextRepair 负责）
    expect(pickDistinctStrategy(attempts)).toBe('alternate-approach')
  })
})

// ===== R1（二次复核）：fail-closed 不是 opt-in =====

describe('R1 损坏防护不可被「少传字段」绕过', () => {
  test('Given 模块导出 When 检查 Then 已移除会丢弃状态的三态盲访问器 readRepairAttempts', () => {
    const exported = repairLoopModule as Record<string, unknown>
    // 旧便利出口只返回 .attempts，会让规划静默丢失 corrupt 信号；已删除，不得复活
    expect('readRepairAttempts' in exported).toBe(false)
    // 权威读取口仍导出，且带 status
    expect('readRepairLogState' in exported).toBe(true)
  })

  test('Given 日志损坏但能抢救出 1 条合法条目 When 规划 Then circuit-break + failClosed（R1 真实攻击面）', () => {
    const slug = setupFixture()
    // 攻击场景：抢救出的 [attempt1] 若被当作完整预算 → attemptsUsed=1 → 继续 repair 重新烧预算
    writeFileSync(repairLogPath(), JSON.stringify([makeAttempt(1, 'direct-fix'), { attempt: 'x' }]), 'utf-8')
    const state = readRepairLogState(slug, PROJECT_ID)
    expect(state.status).toBe('corrupt')
    expect(state.attempts).toHaveLength(1)
    // 只要带上 status，就绝不允许继续 repair
    const plan = planNextRepair({ attempts: state.attempts, mode: 'quick', logStatus: state.status })
    expect(plan.action).toBe('circuit-break')
    expect(plan.failClosed).toBe(true)
    expect(plan.exhausted).toBe(false)
    expect(plan.nextStrategy).toBeNull()
  })

  test('Given planNextRepairForProject 入口 When 日志损坏 Then 自行读盘并 fail-closed（status 与 attempts 必同源）', () => {
    const slug = setupFixture()
    writeFileSync(repairLogPath(), JSON.stringify([makeAttempt(1, 'direct-fix'), { attempt: 'x' }]), 'utf-8')
    const plan = planNextRepairForProject(slug, PROJECT_ID, { mode: 'quick' })
    expect(plan.action).toBe('circuit-break')
    expect(plan.failClosed).toBe(true)
    expect(plan.exhausted).toBe(false)
  })

  test('Given planNextRepairForProject 入口 When 从未写过日志 Then 正常进入第一次修复', () => {
    const slug = setupFixture()
    const plan = planNextRepairForProject(slug, PROJECT_ID, { mode: 'quick' })
    expect(plan.action).toBe('repair')
    expect(plan.attemptsUsed).toBe(0)
    expect(plan.failClosed).not.toBe(true)
  })

  test('Given planNextRepairForProject 入口 When 已写两条后规划 Then attemptsUsed 与 status 同样来自磁盘', () => {
    const slug = setupFixture()
    appendRepairAttempt(slug, PROJECT_ID, makeAttempt(1, 'direct-fix'))
    appendRepairAttempt(slug, PROJECT_ID, makeAttempt(2, 're-read-design'))
    const plan = planNextRepairForProject(slug, PROJECT_ID, { mode: 'iterative' })
    expect(plan.attemptsUsed).toBe(2)
    expect(plan.action).toBe('repair')
    expect(plan.nextStrategy).toBe('alternate-approach')
  })
})

// ===== R2（二次复核）：failClosed 与 exhausted 语义分离 =====

describe('R2 exhausted（预算用尽）与 failClosed（状态不可信）正交', () => {
  const budgetExhausted = [
    makeAttempt(1, 'direct-fix'),
    makeAttempt(2, 're-read-design'),
    makeAttempt(3, 'alternate-approach'),
  ]

  test('Given 预算真正用尽 When 规划 Then exhausted=true 且 failClosed=false', () => {
    const plan = planNextRepair({ attempts: budgetExhausted, mode: 'quick', logStatus: 'valid' })
    expect(plan.exhausted).toBe(true)
    expect(plan.failClosed).toBe(false)
    expect(plan.reason).toContain('已用完 3 次自动修复')
  })

  test('Given 日志损坏 When 规划 Then exhausted=false 且 failClosed=true（不得误称用尽 3 次）', () => {
    const plan = planNextRepair({ attempts: budgetExhausted, mode: 'quick', logStatus: 'corrupt' })
    expect(plan.failClosed).toBe(true)
    expect(plan.exhausted).toBe(false)
    expect(plan.reason).not.toContain('已用完')
  })

  test('Given 上一次写失败 When 规划 Then exhausted=false 且 failClosed=true（含三条历史记录也不行）', () => {
    const plan = planNextRepair({
      attempts: budgetExhausted, mode: 'quick', logStatus: 'valid', logWriteFailed: true,
    })
    expect(plan.failClosed).toBe(true)
    expect(plan.exhausted).toBe(false)
    expect(plan.reason).not.toContain('已用完')
  })

  test('Given 环境类 When 规划 Then exhausted=false 且 failClosed 不为 true（不烧预算也不 fail-closed）', () => {
    const plan = planNextRepair({
      attempts: [], mode: 'quick', logStatus: 'valid', failureClass: 'environment',
    })
    expect(plan.exhausted).toBe(false)
    expect(plan.failClosed).not.toBe(true)
  })

  test('Given 正常修复中 When 规划 Then exhausted=false 且 failClosed 不为 true', () => {
    const plan = planNextRepair({ attempts: [makeAttempt(1, 'direct-fix')], mode: 'quick', logStatus: 'valid' })
    expect(plan.exhausted).toBe(false)
    expect(plan.failClosed).not.toBe(true)
  })
})

// ===== 编译期契约锁（R1/R2）=====
// 以下函数永不执行，仅用于让 tsc 校验契约：
// - 若把 logStatus 改回可选，第 1/2 条 @ts-expect-error 会因未报错而报
//   "Unused '@ts-expect-error' directive"，迫使返工者正视 R1；
// - 若把 exhaust 语义再混回 fail-closed，由上面的运行时断言拦截。
function typeContractLockR1(): void {
  // @ts-expect-error R1：logStatus 必填，禁止漏传后从零重试
  planNextRepair({ attempts: [], mode: 'quick' })
  // @ts-expect-error R1：仅 attempts+mode+failureClass 不足以规划
  planNextRepair({ attempts: [], mode: 'iterative', failureClass: 'code' })
  // @ts-expect-error R1：旧便利访问器已删除，不得复活
  repairLoopModule.readRepairAttempts
}
void typeContractLockR1
