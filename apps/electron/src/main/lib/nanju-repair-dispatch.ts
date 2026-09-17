/**
 * W-I B-d：修复环调度适配器 —— E 纯策略模块（`nanju-repair-loop`）与 orchestrator 之间
 * 的**唯一粘合点**。
 *
 * 为什么单独成模块：
 * - E 模块是纯策略（决策/文案/日志），不含调用序；orchestrator 是巨型类，无法单测其内联分支。
 *   把「决策 → 记账 → 回滚 → 文案」这段序列抽到此处，可用注入宿主做真 BDD（含失败注入）。
 * - 冻结裁决：#3 熔断文案必须**同时**读 `failClosed` 与 `exhausted`——该判断集中在本文件
 *   一处，避免散落在 orchestrator 各分支里被后续改动破坏。
 *
 * 边界：
 * - 本模块**不**读写文件、不启动进程（宿主注入 `plan/append/rollback`）；
 * - `blocked`/`pass` 一律 `skip`（`isRepairEligibleVerdict` 同口径，`:791-794` blocked 早退语义）；
 * - 环境类失败**不写 attempt**（E 的 `appendRepairAttempt` 亦二次拒绝，双保险）。
 */

import {
  buildCircuitBreakLog,
  buildCircuitBreakMessage,
  buildFailureSignature,
  classifyRepairFailure,
  isRepairEligibleVerdict,
} from './nanju-repair-loop'
import type {
  FileRollbackResult,
  RepairAttempt,
  RepairFailureClass,
  RepairPlan,
  RepairPlanState,
} from './nanju-repair-loop'

/** 宿主注入面（真实实现见 orchestrator；测试用假宿主） */
export interface RepairDispatchHost {
  /** 预算规划：**必须**同源读盘（`planNextRepairForProject`）——由宿主保证 */
  plan: (
    request: Pick<
      RepairPlanState,
      'mode' | 'failureClass' | 'failureSignature' | 'fileRollbackAvailable' | 'logWriteFailed'
    >,
  ) => RepairPlan
  /** 读取已入库的修复尝试（供熔断文案/日志取证） */
  readAttempts: () => RepairAttempt[]
  /** 追加一条修复尝试；`ok=false` 必须以内存态兜底并带入下一轮（fail-closed） */
  appendAttempt: (attempt: RepairAttempt) => { ok: boolean; reason?: string }
  /** 文件回滚（D 端口）；未尝试时必须返回 null（不得静默成功） */
  rollback: (snapshotId: string) => Promise<FileRollbackResult | null>
  /** 本轮回滚目标快照 id（无关联快照 → null） */
  resolveSnapshotId: () => string | null
}

export interface RepairDispatchRequest {
  mode: 'quick' | 'iterative'
  /** GWT 裁决（pass/blocked 会 skip） */
  verdict: string
  /** 失败构成（behavior/mapping/coverage…）；环境/driver 类 kind 交 E 分类器判定 */
  failureKind?: string | null
  /** verdict=error 时的异常原因（分类证据主来源） */
  errorReason?: string | null
  /** 同一阶段连续熔断次数（1 起） */
  consecutiveCircuitCount: number
  /** D 文件快照端口是否可用（有可用快照才调回滚） */
  fileRollbackAvailable: boolean
  /** 上一轮 append 失败 → fail-closed（不得从零重试） */
  logWriteFailed: boolean
  /** 熔断文案里的快照标签（仅成功回滚才表述为「已恢复到」） */
  snapshotLabel?: string
  /** 附加分类证据（如失败清单）；缺省只用 `errorReason` 与 `failureKind` */
  evidence?: string | null
  now?: Date
}

export type RepairDispatchOutcome =
  | { action: 'skip'; reason: string }
  | { action: 'notify-environment'; message: string; failureClass: RepairFailureClass }
  | {
      action: 'repair'
      attempt: RepairAttempt
      /** true = 本条未能落盘 → 调用方须以内存态兜底，并把 logWriteFailed 带入下一轮 */
      writeFailed: boolean
      writeReason?: string
    }
  | {
      action: 'circuit-break'
      /** 用户可见安抚文案（回滚措辞严格由结构化结果决定） */
      message: string
      /** 内部取证日志（逐次策略/分类/签名） */
      logText: string
      /** 预算真正用尽（3 次） */
      exhausted: boolean
      /** 状态不可信导致暂停（与 exhausted 正交：此时不得说「已用尽 3 次」） */
      failClosed: boolean
      /** 原样透传的回滚结果（null = 未尝试） */
      rollback: FileRollbackResult | null
    }

/** 环境类安抚文案（不烧预算、不自动回炉） */
function buildEnvironmentNotice(reason: string): string {
  return [
    `🔧 ${reason}`,
    '这类失败通常不在项目代码里（依赖/运行时/权限/磁盘/端口等），所以不计入自动修复次数。处理好环境后再说「继续测试」，我会重新跑一遍。',
  ].join('\n')
}

/**
 * 熔断文案尾部：把两个正交标志**都**说清楚（冻结裁决 #3）。
 * `failClosed` 优先——它是「不可信」而不是「用尽」；两者同时成立时说不可信。
 */
function buildCircuitBreakFlagLine(plan: RepairPlan): string {
  if (plan.failClosed) {
    return `\n\n⚠️ 本次暂停的原因是修复记录不可信（${plan.reason}）——这不是「已用尽 3 次自动修复」，请不要按预算耗尽处置；修好记录写入后再继续。`
  }
  if (plan.exhausted) {
    return `\n\n⛔ 自动修复预算已用尽 3 次（首次产出失败不计入自动修复）：${plan.reason}`
  }
  return `\n\n⛔ 已暂停自动修复：${plan.reason}`
}

/**
 * 单轮修复调度（唯一调用序实现）：
 * 1. 不具资格（pass/blocked/未知）→ `skip`（调用方保持既有分支）；
 * 2. 环境类 → `notify-environment`（**不**调 append）；
 * 3. 熔断（预算用尽 / fail-closed）→ 读盘取证 + 结构化回滚 + 双标志文案；
 * 4. 其余 → 按 E 规划的下一策略 `appendRepairAttempt`（失败则携带 writeFailed）。
 */
export async function dispatchRepairDecision(
  request: RepairDispatchRequest,
  host: RepairDispatchHost,
): Promise<RepairDispatchOutcome> {
  if (!isRepairEligibleVerdict(request.verdict)) {
    return { action: 'skip', reason: `裁决 ${request.verdict} 不进入修复循环（pass/blocked 不烧修复预算）` }
  }

  const evidence = [(request.errorReason ?? '').trim(), (request.evidence ?? '').trim()]
    .filter((part) => part.length > 0)
    .join('\n')
  const failureClass = classifyRepairFailure({ message: evidence, kind: request.failureKind ?? undefined })
  const failureSignature = buildFailureSignature({
    message: evidence,
    kind: request.failureKind ?? undefined,
  })

  const plan = host.plan({
    mode: request.mode,
    failureClass,
    failureSignature,
    fileRollbackAvailable: request.fileRollbackAvailable,
    logWriteFailed: request.logWriteFailed,
  })

  if (plan.action === 'notify-environment') {
    return { action: 'notify-environment', failureClass, message: buildEnvironmentNotice(plan.reason) }
  }

  if (plan.action === 'circuit-break') {
    const attempts = host.readAttempts()
    // 预算真正用尽才回滚：fail-closed 是「计数不可信」，此时对工程做破坏性动作不安全
    // （可能只修了 1 次就说日志坏了），因此一律不回滚，只暂停自动修复并交人处理。
    const snapshotId = plan.exhausted ? host.resolveSnapshotId() : null
    // 未尝试 → null（不得把 null 当成功；assessRollback 会归为 not-attempted）
    const rollback = snapshotId ? await host.rollback(snapshotId) : null
    const base = buildCircuitBreakMessage({
      mode: request.mode,
      attempts,
      consecutiveCircuitCount: request.consecutiveCircuitCount,
      rollback,
      snapshotLabel: request.snapshotLabel,
    })
    return {
      action: 'circuit-break',
      message: base + buildCircuitBreakFlagLine(plan),
      logText: buildCircuitBreakLog({ attempts, reason: plan.reason }),
      exhausted: plan.exhausted,
      failClosed: plan.failClosed === true,
      rollback,
    }
  }

  const attempt: RepairAttempt = {
    attempt: plan.attemptsUsed + 1,
    strategy: plan.nextStrategy ?? 'direct-fix',
    failureClass,
    failureSignature,
    at: (request.now ?? new Date()).toISOString(),
  }
  const write = host.appendAttempt(attempt)
  return {
    action: 'repair',
    attempt,
    writeFailed: write.ok !== true,
    writeReason: write.ok === true ? undefined : write.reason,
  }
}
