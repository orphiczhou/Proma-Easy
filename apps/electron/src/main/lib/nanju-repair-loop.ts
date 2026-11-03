/**
 * P1 E2：三次自修复闭环「纯策略」模块（PRD §6.3 / US-P02 / user-stories Q4）
 *
 * 职责边界（P1 计划 W-EF §3.1）：
 * - 本模块只做**纯决策 + 自身日志持久化**：失败分类、策略轮换、预算与熔断判定、文案与内部日志；
 * - **不触碰工程文件、不 fork 会话、不调用进程**：真正的文件回滚由 D 快照引擎承担，
 *   本模块只声明 `FileRollbackPort` 端口（不实现、不 import D 文件）；
 * - **不修改 orchestrator / gwt-runner / project / shared / renderer**：接线由 I 包完成。
 *
 * 三条「不烧预算」铁律（wave3 A + EF US-P02，接线方必须保持）：
 * 1. **首产失败不计修复**：首产失败不入库，`attemptsUsed` 从 0 起算；首产失败后允许修复 1/2/3 共三次；
 * 2. **blocked 不烧预算**：`isRepairEligibleVerdict('blocked')===false`，与
 *    `agent-orchestrator.ts:791-794` 的 blocked 早退同口径（该早退必须原样保留）；
 * 3. **环境类不烧预算**：磁盘/内存/端口/运行时缺失等归 `environment`，
 *    走 `notify-environment` 分支；`appendRepairAttempt` 会**拒绝**环境类写入（契约下沉为不变量）。
 *
 * 返工（独立审查 E-review S1–S4，2026-09-14 深夜）：
 * - S1：`readRepairLogState` 区分 `missing / valid / corrupt`；**损坏绝不等价于「无记录」**，
 *   `planNextRepair` 在 corrupt（或上次写失败）时 fail-closed 暂停自动修复，不从零重试；
 * - S2：`appendRepairAttempt` / `clearRepairAttempts` 返回结构化结果（`ok/reason/failureClass/
 *   requiresManualReset`），不吞写失败，供 I 侧 fail-closed 判定；
 * - S3：`FileRollbackPort` 对齐 D 最终 API——`snapshotId` 为 **UUID 字符串**，
 *   `rollback` 返回**结构化结果**（`ok / reason / compensated / preRestoreBackupDir`），不压 boolean；
 * - S4：`buildCircuitBreakMessage` 按**明确的 rollback 结论**（成功 / 失败 / 未尝试）措辞；
 *   `snapshotLabel` 只是标签，**本身不能证明已恢复**。
 *
 * 再返工（二次复核 R1/R2，2026-09-14 23:3x）：
 * - R1：**fail-closed 不再是 opt-in**。`RepairPlanState.logStatus` 改为**必填**，
 *   调用方无法靠「少传一个字段」绕过 S1 防护；同时**删除**会丢弃 corrupt 信号的
 *   `readRepairAttempts` 便利出口，改为提供 fail-closed by construction 的
 *   `planNextRepairForProject`（自行读盘，status 与 attempts 必同源）；
 * - R2：**`failClosed` 与 `exhausted` 语义分离**：预算真正用尽 → `exhausted=true, failClosed=false`；
 *   日志损坏 / 上次写失败 → `exhausted=false, failClosed=true`（不得误称「已用尽 3 次」）。
 *
 * 持久化：`_repair-log.json` 走 `safe-file.ts` 原子写 + 容错读，路径经既有
 * `config-paths.getWorkspaceFilesDir(slug)/project-<id>/`；不写 `_project-info.json`，
 * 不改 `phaseGuards`（熔断计数状态的唯一写入点仍是 `nanju-project.updatePhaseGuard`）。
 *
 * ⚠️ 跨包需求（S7，交 I / D 返工，本模块不越界改 D）：
 * `_repair-log.json` 与 `_project-info.json` 尚未进入 D 快照的 `CONTROL_FILE_NAMES`
 * （`nanju-file-snapshot.ts` 的排除清单），一旦快照以 project 目录为范围，恢复会连带回滚
 * 修复预算与 phaseGuard 状态。需把这两个控制文件纳入 D 排除清单。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { getWorkspaceFilesDir } from './config-paths'

// ===== 常量与类型 =====

/** PRD §6.3 / wave3 A：单个阶段最多 3 次自动修复（首产失败不计入） */
export const REPAIR_MAX_ATTEMPTS = 3

/**
 * 策略轮换顺序（user-stories Q4：3 次内至少 2 种不同策略，不重复同一手段）。
 * 顺序即优先级：先最小改动的直接修复 → 重读设计 → 换实现路径。
 */
export const REPAIR_STRATEGY_SEQUENCE = ['direct-fix', 're-read-design', 'alternate-approach'] as const

export type RepairStrategy = (typeof REPAIR_STRATEGY_SEQUENCE)[number]

/** 失败分类：环境类不进入修复循环；设计约束类提示换方向；未知类保守兜底 */
export type RepairFailureClass = 'code' | 'environment' | 'design-constraint' | 'unknown'

/** GWT 轮次裁决（与 nanju-gwt-runner 的 verdict 同域） */
export type RepairRoundVerdict = 'pass' | 'fail' | 'error' | 'blocked'

/** 一次「已入库」的修复尝试；attempt 从 1 起，1 代表第一次**修复**（非首产） */
export interface RepairAttempt {
  /** 修复序号，1 起；首产失败本身不写入 */
  attempt: number
  strategy: RepairStrategy
  failureClass: RepairFailureClass
  /** 归一化失败指纹（buildFailureSignature），用于「不重复同一手段」与日志取证 */
  failureSignature: string
  /** ISO 时间戳（调用方注入，便于测试确定性） */
  at: string
}

/** 修复日志读取状态（S1）：corrupt 必须与 missing 可区分，不得等价于空预算 */
export type RepairLogStatus = 'missing' | 'valid' | 'corrupt'

export interface RepairLogState {
  status: RepairLogStatus
  /** 可用的修复尝试（corrupt 时为「能抢救出的合法条目」，可能为空） */
  attempts: RepairAttempt[]
  /** 非 valid 时的可读原因（供 I fail-closed 时展示 / 记录） */
  reason: string
}

/** 修复日志写入结果（S2）：写失败必须可被调用方感知，不得只 warn 吞掉 */
export interface RepairLogWriteResult {
  ok: boolean
  /** 失败原因（ok=true 时缺省） */
  reason?: string
  /** 失败的可分类归因（复用 classifyRepairFailure；ok=true 时缺省） */
  failureClass?: RepairFailureClass
  /** true=需人工清理/确认后才能继续（如日志损坏、需显式重置） */
  requiresManualReset?: boolean
}

/** 回滚结论（S4）：只有 'succeeded' 才允许措辞为「已恢复到」 */
export type RollbackOutcome = 'succeeded' | 'failed' | 'not-attempted'

/**
 * 结构化回滚结果（S3）：与 D `RestoreResult` **结构兼容**，字段名对齐 D 现实现，
 * 使适配器可以是零字段映射的 async 薄壳：
 * - `ok`：D `RestoreSuccess.ok` / `RestoreFailure.ok`
 * - `reason`：D `RestoreFailure.reason`（`'locked' | 'restore-verify-failed' | ...`），原样透传
 * - `message`：D `RestoreFailure.message`
 * - `compensated`：D `RestoreFailure.compensated`（true=已回滚到恢复前状态，工程字节级安全）
 * - `preRestoreBackupDir`：D `RestoreSuccess.preRestoreBackupDir`（恢复前当前工程保留位置）
 */
export interface FileRollbackSuccess {
  ok: true
  /** D RestoreSuccess.txnId */
  txnId?: string
  /** D RestoreSuccess.restoredFiles */
  restoredFiles?: number
  /** D RestoreSuccess.preRestoreBackupDir：恢复前当前工程保留位置（不自动删除） */
  preRestoreBackupDir?: string
}

export interface FileRollbackFailure {
  ok: false
  /** D RestoreFailure.reason：语义码（'locked' 可稍后重试；'restore-verify-failed' 已补偿等） */
  reason: string
  /** D RestoreFailure.message：可读说明 */
  message?: string
  /** true=已成功补偿回恢复前状态 */
  compensated: boolean
  /** 若失败发生在备份之后，D 保留的前置备份目录（如可用） */
  preRestoreBackupDir?: string
}

export type FileRollbackResult = FileRollbackSuccess | FileRollbackFailure

/**
 * D 快照引擎端口（**仅声明**，E2 不实现文件复制/恢复）。
 *
 * ⚠️ 适配由 I 包完成（本模块不 import D 文件）：
 * - `capture(label) → { snapshotId: string }`：包 `captureFileSnapshot(projectDir, storageDir)`，
 *   返回 `manifest.snapshotId`（D 为 `randomUUID()` 字符串，**原样透传，不做数值派生**）；
 * - `rollback(snapshotId) → FileRollbackResult`：由 I 维护 `snapshotId → snapshotDir` 关联
 *   （如经 `nanju-snapshot.linkFileSnapshot`），再包 `restoreFileSnapshot(snapshotDir, projectDir, storageDir)`
 *   并**原样透传** `RestoreResult`（结构即本模块的 `FileRollbackResult`）；
 * - 端口不可用/`capture` 失败必须抛错或 `ok=false`，**不得静默成功**。
 */
export interface FileRollbackPort {
  capture(label: string): Promise<{ snapshotId: string }>
  rollback(snapshotId: string): Promise<FileRollbackResult>
}

export interface RepairPlan {
  action: 'repair' | 'circuit-break' | 'notify-environment'
  nextStrategy: RepairStrategy | null
  attemptsUsed: number
  /**
   * true=**修复预算真正用尽**（已用满 `REPAIR_MAX_ATTEMPTS`）。
   * 
   * ⚠️ 与 `failClosed` 正交（R2）：因日志状态不可信而暂停时 `exhausted === false`。
   * 调用方不得用 `exhausted` 描述「已用尽 3 次」，除非它确实为 true。
   */
  exhausted: boolean
  reason: string
  /**
   * true=因**状态不可信**（日志损坏 / 上次写失败）而 fail-closed 停止自动修复。
   * 此时**不代表预算用尽**（`exhausted` 为 false），也不得从零重试。
   */
  failClosed?: boolean
}

/**
 * 规划入参（R1）：`logStatus` **必填**。
 * `status` 只能来自 `readRepairLogState().status`——缺省/可选会让 S1 的损坏防护被
 * 「少传一个字段」静默绕过（二次复核 R1 的真实攻击面）。
 * 若不想承担配对义务，请用 `planNextRepairForProject`（自行读盘，二者必同源）。
 */
export interface RepairPlanState {
  /** 已入库的修复尝试（不含首产失败、不含 blocked、不含环境类记录） */
  attempts: RepairAttempt[]
  mode: 'quick' | 'iterative'
  /** **必填**：`readRepairLogState().status`；`corrupt` → fail-closed 暂停自动修复 */
  logStatus: RepairLogStatus
  /** 本次待处置失败的分类；缺省取 attempts 末条的 failureClass */
  failureClass?: RepairFailureClass
  /** 本次失败的归一化签名（用于「同一签名不重复同一策略」） */
  failureSignature?: string
  /**
   * D 文件快照端口是否可用（I 包接线时注入）。
   * 缺省或 false 一律按「不可用」处理（fail-closed）：熔断 reason 明确「未回滚代码」。
   */
  fileRollbackAvailable?: boolean
  /** 上一次 `appendRepairAttempt().ok === false` → true，禁止发起下一轮修复 */
  logWriteFailed?: boolean
}

/** 修复日志文件名（工作区 project-<id>/ 下） */
export const REPAIR_LOG_FILE_NAME = '_repair-log.json'

// ===== 失败分类 =====

/** 环境类 kind（宿主已判定，直接采信，不依赖文案） */
const ENVIRONMENT_KINDS: ReadonlySet<string> = new Set([
  'environment', 'env', 'infra', 'resource', 'resource-exhausted', 'runtime-missing', 'device', 'network',
])

/** 设计约束类 kind */
const DESIGN_KINDS: ReadonlySet<string> = new Set(['coverage', 'design', 'design-constraint', 'spec', 'prd'])

/** 产品代码类 kind */
const CODE_KINDS: ReadonlySet<string> = new Set([
  'behavior', 'code', 'assert', 'assertion', 'test', 'test-fail', 'unit', 'e2e', 'build', 'typecheck', 'lint', 'compile',
])

/**
 * 强环境证据：errno 码（词边界，避免子串误命中）。
 * 刻意**不含** ENOENT——「文件不存在」既可能是环境（运行时/工具缺失），
 * 也可能是产品缺陷（漏打包资源），只能配合运行时上下文才判环境。
 */
const ENVIRONMENT_ERRNO = /\b(ENOSPC|ENOMEM|EADDRINUSE|EMFILE|ENFILE|EACCES|EPERM|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|ENOTDIR|ERR_WORKER_OUT_OF_MEMORY)\b/i

/** ENOENT 只有在「运行时/工具缺失」语境下才算环境 */
const ENOENT_WITH_RUNTIME_CONTEXT = /\bENOENT\b/i
const RUNTIME_CONTEXT = /(spawn|运行时|runtime|python|node|docker|命令行|command|可执行|未找到)/i

/**
 * 强环境短语：只收「无歧义的环境事实」，**不收**裸「超时/失败/错误」等过宽词，
 * 避免把 selector 超时、断言失败这类产品/测试缺陷误判成环境问题而不修。
 */
const ENVIRONMENT_PHRASES: readonly RegExp[] = [
  /磁盘空间不足|磁盘已满|no space left|disk full/i,
  /内存不足|out of memory|memory limit exceeded/i,
  /端口[^，。;；\n]*被占用|端口占用|端口冲突|address already in use|port already in use/i,
  /运行时不可用|运行时缺失|未找到运行时|command not found|is not recognized as an internal or external command/i,
  /设备未连接|未检测到设备|no such device/i,
  /网络不可达|dns 解析失败|getaddrinfo/i,
  /permission denied|权限不足无法写入|read-only file system/i,
]

/** 强设计约束短语 */
const DESIGN_PHRASES: readonly RegExp[] = [
  /设计约束|与设计不符|与设计冲突|违反约束|超出原型范围|超出设计范围/i,
  /PRD (未定义|缺|没有)|需求(未定义|缺失)/i,
]

/** 强产品代码证据（仅在 kind 未给出结论时兜底） */
const CODE_TOKENS = /\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError)\b|assertion failed|构建失败|编译失败|断言失败|类型错误|test failed/i

function isRepairStrategy(value: unknown): value is RepairStrategy {
  return typeof value === 'string' && (REPAIR_STRATEGY_SEQUENCE as readonly string[]).includes(value)
}

function isFailureClass(value: unknown): value is RepairFailureClass {
  return value === 'code' || value === 'environment' || value === 'design-constraint' || value === 'unknown'
}

/** 命中环境类证据（errno / 强短语 / ENOENT+运行时语境） */
function hasEnvironmentEvidence(message: string): boolean {
  if (ENVIRONMENT_ERRNO.test(message)) return true
  if (ENOENT_WITH_RUNTIME_CONTEXT.test(message) && RUNTIME_CONTEXT.test(message)) return true
  return ENVIRONMENT_PHRASES.some((pattern) => pattern.test(message))
}

/**
 * 失败分类（纯函数）：环境类错误不进入修复循环（磁盘/内存/端口/运行时）。
 *
 * 判定优先级：显式环境 kind → 环境证据 → 设计约束 kind/短语 → 产品代码 kind/证据 → unknown。
 * 关键纪律：环境证据只收 errno 与无歧义短语，**不得**用「超时/失败」等过宽关键词
 * 把产品 bug 归成环境问题（否则会让真实缺陷永远不修）。
 */
export function classifyRepairFailure(input: { message: string; kind?: string }): RepairFailureClass {
  const message = input.message ?? ''
  const kind = (input.kind ?? '').trim().toLowerCase()

  if (kind.length > 0 && ENVIRONMENT_KINDS.has(kind)) return 'environment'
  if (hasEnvironmentEvidence(message)) return 'environment'

  if (kind.length > 0 && DESIGN_KINDS.has(kind)) return 'design-constraint'
  if (DESIGN_PHRASES.some((pattern) => pattern.test(message))) return 'design-constraint'

  if (kind.length > 0 && CODE_KINDS.has(kind)) return 'code'
  if (CODE_TOKENS.test(message)) return 'code'

  return 'unknown'
}

// ===== 失败签名 =====

/** 归一化时可剥离的易变片段（同一缺陷每次运行都不同，不能进指纹） */
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX_PATTERN = /\b0x[0-9a-f]+\b/gi
const NUMBER_PATTERN = /\b\d+\b/g

/**
 * 归一化失败签名（纯函数）：同一缺陷跨运行稳定，不同缺陷可区分。
 * 剥离 uuid / 路径 token / 十六进制 / 全部数字 / 连续空白，再按分类加前缀与截断。
 */
export function buildFailureSignature(input: { message: string; kind?: string }): string {
  const failureClass = classifyRepairFailure(input)
  let text = (input.message ?? '').trim().toLowerCase()
  text = text.replace(UUID_PATTERN, '<uuid>')
  // 含斜杠的整段 token 视作路径（含行号后缀），整体折叠，避免临时目录/文件名扰动指纹
  text = text
    .split(/\s+/)
    .map((token) => (token.includes('/') ? '<path>' : token))
    .join(' ')
  text = text.replace(HEX_PATTERN, '<hex>')
  text = text.replace(NUMBER_PATTERN, '<n>')
  text = text.replace(/\s+/g, ' ').trim()
  const truncated = text.length > 200 ? text.slice(0, 200) : text
  return `${failureClass}:${truncated}`
}

// ===== 修复资格 =====

/**
 * 是否具备进入修复循环的资格（纯函数）。
 * pass 无需修复；blocked 是环境/驱动阻塞，等真人处理，**不烧修复预算**
 * （与 `agent-orchestrator.ts:791` 早退同口径）；未知裁决保守拒绝。
 */
export function isRepairEligibleVerdict(verdict: RepairRoundVerdict | string): boolean {
  return verdict === 'fail' || verdict === 'error'
}

// ===== 策略与预算 =====

/** 已用策略（去重，保持轮换顺序） */
function distinctStrategies(attempts: RepairAttempt[]): RepairStrategy[] {
  const used = new Set<RepairStrategy>(attempts.map((a) => a.strategy))
  return REPAIR_STRATEGY_SEQUENCE.filter((strategy) => used.has(strategy))
}

/** 计费 attempt（环境类不计入预算；blocked/首产本来就不入库） */
function billableAttempts(attempts: RepairAttempt[]): RepairAttempt[] {
  return attempts.filter((attempt) => attempt.failureClass !== 'environment')
}

/**
 * 选取下一个未使用策略（user-stories Q4 + wave3 A：3 次内至少 2 种策略，不重复同一手段）。
 * 优先「全局未用过」的策略；三种都用过时，退化为「针对**本签名**未用过」的策略；
 * 仍无则返回最后一种（熔断由 planNextRepair 负责，这里不扩大枚举）。
 */
export function pickDistinctStrategy(attempts: RepairAttempt[], failureSignature?: string): RepairStrategy {
  const used = new Set<RepairStrategy>(attempts.map((a) => a.strategy))
  for (const strategy of REPAIR_STRATEGY_SEQUENCE) {
    if (!used.has(strategy)) return strategy
  }
  if (typeof failureSignature === 'string' && failureSignature.length > 0) {
    const usedForSignature = new Set(
      attempts.filter((a) => a.failureSignature === failureSignature).map((a) => a.strategy),
    )
    for (const strategy of REPAIR_STRATEGY_SEQUENCE) {
      if (!usedForSignature.has(strategy)) return strategy
    }
  }
  return 'alternate-approach'
}

/**
 * 纯函数：给定既有 attempts 与日志状态决策下一步（不触碰文件、不调用进程）。
 * 判定序：
 * 1. 日志损坏（`logStatus==='corrupt'`）或上次写失败 → `circuit-break` + `failClosed`
 *    （`exhausted=false`，因为**预算并未用尽**；绝**不**把损坏当成「无记录」而从零重试）；
 * 2. 环境类 → `notify-environment`（不消耗预算）；
 * 3. 计费次数达 3 → `circuit-break` + `exhausted=true` + `failClosed=false`
 *    （快照不可用时 reason 明写「未回滚代码」）；
 * 4. 否则 → `repair` + 未使用过的策略。
 */
export function planNextRepair(state: RepairPlanState): RepairPlan {
  const attempts = state.attempts ?? []
  const billable = billableAttempts(attempts)
  const attemptsUsed = billable.length
  const last = attempts.length > 0 ? attempts[attempts.length - 1] : undefined

  if (state.logStatus === 'corrupt') {
    return {
      action: 'circuit-break',
      nextStrategy: null,
      attemptsUsed,
      // R2：这是「状态不可信」而非「预算用尽」
      exhausted: false,
      failClosed: true,
      reason: `修复日志损坏（当前仅能抢救出 ${attemptsUsed} 条记录，不代表预算已用尽）：已暂停自动修复（fail-closed），请人工确认后再继续，不要从零重试。`,
    }
  }

  if (state.logWriteFailed === true) {
    return {
      action: 'circuit-break',
      nextStrategy: null,
      attemptsUsed,
      // R2：写失败只说明计数不可信，不代表用尽 3 次
      exhausted: false,
      failClosed: true,
      reason: '上一次修复记录未能落盘，预算计数不可信（不代表预算已用尽）：已暂停自动修复（fail-closed），请先恢复日志写入。',
    }
  }

  const effectiveClass: RepairFailureClass = state.failureClass ?? last?.failureClass ?? 'unknown'
  if (effectiveClass === 'environment') {
    return {
      action: 'notify-environment',
      nextStrategy: null,
      attemptsUsed,
      exhausted: false,
      reason: '环境类失败（磁盘/内存/端口/运行时等）不进入自动修复循环，等待处理环境后继续。',
    }
  }

  if (attemptsUsed >= REPAIR_MAX_ATTEMPTS) {
    const strategies = distinctStrategies(billable).join('、') || '无'
    const rollbackAvailable = state.fileRollbackAvailable === true
    const rollbackNote = rollbackAvailable
      ? ''
      : '；文件快照不可用，未回滚代码，仅暂停自动尝试'
    return {
      action: 'circuit-break',
      nextStrategy: null,
      attemptsUsed,
      // R2：真正用尽预算；与 fail-closed 语义分离
      exhausted: true,
      failClosed: false,
      reason: `已用完 ${REPAIR_MAX_ATTEMPTS} 次自动修复（已用策略：${strategies}）${rollbackNote}。`,
    }
  }

  const signature = state.failureSignature ?? last?.failureSignature
  return {
    action: 'repair',
    nextStrategy: pickDistinctStrategy(billable, signature),
    attemptsUsed,
    exhausted: false,
    reason: `进入第 ${attemptsUsed + 1} 次自动修复（预算 ${REPAIR_MAX_ATTEMPTS} 次）。`,
  }
}

/**
 * fail-closed by construction 的规划入口（R1 推荐用法）：
 * 自行调用 `readRepairLogState`，把 `attempts` 与 `logStatus` 从**同一次读取**中取出，
 * 调用方无法漏传或错配 `logStatus`，S1 的损坏防护不可能被绕过。
 *
 * I 接线应优先用本函数；只有在需要复用既有内存态 attempts 时才用 `planNextRepair`，
 * 且必须自 `readRepairLogState().status` 取 `logStatus`。
 */
export function planNextRepairForProject(
  workspaceSlug: string,
  projectId: string,
  request: Omit<RepairPlanState, 'attempts' | 'logStatus'>,
): RepairPlan {
  const state = readRepairLogState(workspaceSlug, projectId)
  return planNextRepair({ ...request, attempts: state.attempts, logStatus: state.status })
}

// ===== 回滚结论评估（S3/S4） =====

export interface RollbackAssessment {
  outcome: RollbackOutcome
  /** 失败的语义码（如 D 的 'locked' / 'restore-verify-failed'）；成功/未尝试为 null */
  reasonCode: string | null
  /** 可稍后重试（如快照恢复事务被占用 locked）——与「已补偿」是两种不同失败语义 */
  retriable: boolean
  /** 已补偿回恢复前状态（工程字节级安全） */
  compensated: boolean
  /** 恢复前当前工程保留目录（如有） */
  preRestoreBackupDir: string | null
}

/**
 * 把裸回滚结果归一为明确结论（纯函数）：`undefined/null` → `not-attempted`。
 * 未尝试与失败必须与成功严格区分——`snapshotLabel` 不参与判定。
 */
export function assessRollback(result?: FileRollbackResult | null): RollbackAssessment {
  if (!result) {
    return { outcome: 'not-attempted', reasonCode: null, retriable: false, compensated: false, preRestoreBackupDir: null }
  }
  if (result.ok) {
    return {
      outcome: 'succeeded',
      reasonCode: null,
      retriable: false,
      compensated: false,
      preRestoreBackupDir: result.preRestoreBackupDir ?? null,
    }
  }
  return {
    outcome: 'failed',
    reasonCode: result.reason,
    retriable: result.reason === 'locked',
    compensated: result.compensated === true,
    preRestoreBackupDir: result.preRestoreBackupDir ?? null,
  }
}

// ===== 用户文案（US-U07 安抚 / 熔断） =====

export interface CircuitBreakMessageInput {
  mode: 'quick' | 'iterative'
  attempts: RepairAttempt[]
  /** 同一阶段连续熔断次数（1 起）；≥3 走特化文案 + 简化版建议 */
  consecutiveCircuitCount: number
  /** 回滚结果（`FileRollbackPort.rollback` 原样传入；D RestoreResult 结构兼容） */
  rollback?: FileRollbackResult | null
  /** 显式回滚结论；优先于 `rollback` 推断（I 可直接传枚举） */
  rollbackOutcome?: RollbackOutcome
  /** 快照标签：**仅**在结论为「成功」时才表述为「已恢复到」 */
  snapshotLabel?: string
}

/**
 * 构建熔断安抚文案（纯函数）。
 * - 第 1/2 次沿用既有 `NANJU_GUARD_ALERT_MESSAGE` 口径；≥3 次特化并给简化版建议；
 * - quick / iterative 建议分支不同（快消=缩小范围；迭代=补设计约束/拆迭代）；
 * - **措辞严格由回滚结论决定**：只有 `succeeded` 才说「已恢复到」；
 *   `failed` 区分「锁占用可重试」与「已补偿/待人工确认」；`not-attempted` 一律「未回滚代码」。
 *
 * ⚠️ US-U07 存在「US 原文 vs spec/PRD §7.5」两套文案口径（wave3 B 已裁决分场景），
 * 本函数只保证语义与分支正确，逐字断言由 F2 固化。
 */
export function buildCircuitBreakMessage(input: CircuitBreakMessageInput): string {
  const { mode, attempts, consecutiveCircuitCount, snapshotLabel } = input
  const exhaustedTimes = consecutiveCircuitCount >= 3
  const assessment = assessRollback(input.rollback)
  const outcome: RollbackOutcome = input.rollbackOutcome ?? assessment.outcome
  const label = typeof snapshotLabel === 'string' && snapshotLabel.trim().length > 0 ? snapshotLabel : null

  const head = exhaustedTimes
    ? `这个阶段已经连续 ${consecutiveCircuitCount} 次触发熔断，自动修复暂时帮不上忙。你的项目文件都在，随时可以继续。`
    : '自动修复多次没有成功，我已暂停自动尝试。你的项目文件都在，随时可以继续。'

  const used = distinctStrategies(billableAttempts(attempts))
  const strategyLine = used.length > 0 ? `本轮已尝试策略：${used.join('、')}。` : ''

  // 回滚措辞：严格按结论；label 只是标签，永不能证明已恢复
  let rollbackLine: string
  if (outcome === 'succeeded') {
    rollbackLine = label ? `已恢复到快照「${label}」。` : '已恢复到本次任务开始前的健康快照。'
  } else if (outcome === 'failed') {
    const detail = assessment.retriable
      ? '快照恢复事务正被占用，稍后可重试'
      : (assessment.reasonCode ?? '未知原因')
    const safety = assessment.compensated
      ? '工程已补偿回恢复前状态'
      : '工程状态待人工确认'
    rollbackLine = label
      ? `回滚未成功（快照「${label}」，原因：${detail}；${safety}）：未回滚代码。`
      : `回滚未成功（原因：${detail}；${safety}）：未回滚代码。`
  } else {
    rollbackLine = label
      ? `尚未执行快照「${label}」的恢复：未回滚代码。`
      : '本次未回滚代码（无可用文件快照），工程文件保持现状。'
  }

  const advice = exhaustedTimes
    ? mode === 'quick'
      ? '建议先缩小这次要做的范围，从能跑通的最小版本继续。'
      : '建议先补充设计约束或拆小这一轮迭代的改动范围，再从最小改动的版本继续。'
    : mode === 'quick'
      ? '你可以先看测试报告，决定是否让我换个方向继续。'
      : '你可以先看测试报告，决定是否补充约束或调整方案后继续迭代。'

  return [head, strategyLine, rollbackLine, advice].filter((part) => part.length > 0).join('\n')
}

/**
 * 构建熔断内部日志（纯函数）：熔断原因 + 逐次策略/分类/签名，供 US-P02 取证追溯。
 */
export function buildCircuitBreakLog(input: { attempts: RepairAttempt[]; reason: string }): string {
  const lines = [`[南大自修复熔断] ${input.reason}`]
  if (input.attempts.length === 0) {
    lines.push('- 本轮无可记录的自动修复记录。')
    return lines.join('\n')
  }
  for (const attempt of input.attempts) {
    lines.push(
      `- 第 ${attempt.attempt} 次修复：策略=${attempt.strategy}，分类=${attempt.failureClass}，` +
      `签名=${attempt.failureSignature}（${attempt.at}）`,
    )
  }
  return lines.join('\n')
}

// ===== 持久化（safe-file 原子写） =====

function getRepairLogPath(workspaceSlug: string, projectId: string): string {
  return join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`, REPAIR_LOG_FILE_NAME)
}

function isRepairAttempt(value: unknown): value is RepairAttempt {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.attempt === 'number'
    && Number.isFinite(candidate.attempt)
    && isRepairStrategy(candidate.strategy)
    && isFailureClass(candidate.failureClass)
    && typeof candidate.failureSignature === 'string'
    && typeof candidate.at === 'string'
}

/** 日志（含 safe-file 的 .tmp/.bak 回退副本）是否存在——用于区分 missing 与 corrupt */
function repairLogExists(path: string): boolean {
  return existsSync(path) || existsSync(`${path}.tmp`) || existsSync(`${path}.bak`)
}

/**
 * 读取修复日志状态（S1，**预算规划的权威读取口**）：`missing` / `valid` / `corrupt` 三态可区分。
 * - `missing`：主文件与 .tmp/.bak 都不存在（真正的首次运行）；
 * - `valid`：解析成功且全部条目合法（含合法的空数组 = 被显式 clear 过）；
 * - `corrupt`：文件存在但不可解析/结构非法/含非法条目——**不得**当作空预算。
 *
 * 兼容两种落盘形态：裸数组（当前）与 `{ attempts: [...] }` 包装（历史/未来扩展）。
 *
 * ⚠️ R1：本模块**不再提供**只返回 `.attempts` 的便利访问器（旧 `readRepairAttempts` 已删除）——
 * 它会让调用方在规划时静默丢失 `corrupt` 信号。需要数组请显式取 `readRepairLogState().attempts`，
 * 或直接用 `planNextRepairForProject`。
 */
export function readRepairLogState(workspaceSlug: string, projectId: string): RepairLogState {
  const path = getRepairLogPath(workspaceSlug, projectId)
  if (!repairLogExists(path)) {
    return { status: 'missing', attempts: [], reason: '修复日志尚未创建' }
  }
  let raw: unknown = null
  try {
    raw = readJsonFileSafe<unknown>(path)
  } catch {
    raw = null
  }
  if (raw === null || raw === undefined) {
    return { status: 'corrupt', attempts: [], reason: '修复日志损坏（主文件与 .tmp/.bak 均不可用）' }
  }
  const list: unknown[] | null = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { attempts?: unknown }).attempts)
      ? ((raw as { attempts: unknown[] }).attempts)
      : null
  if (list === null) {
    return { status: 'corrupt', attempts: [], reason: '修复日志结构非法（既非数组也无 attempts 数组）' }
  }
  const valid = list.filter(isRepairAttempt)
  if (valid.length !== list.length) {
    return {
      status: 'corrupt',
      attempts: valid,
      reason: `修复日志含 ${list.length - valid.length} 条非法记录`,
    }
  }
  return { status: 'valid', attempts: valid, reason: '' }
}

/**
 * 追加一条修复尝试（safe-file 原子写）。
 * - **不吞失败**（S2）：返回 `{ ok:false, reason, failureClass }`，调用方据此 fail-closed，
 *   并应以内存内的 attempts 数组作为**会话内预算权威**、磁盘日志只作跨重启恢复；
 * - 幂等：同 attempt 号重复写入以最新一条覆盖，并按 attempt 排序写回（S6）；
 * - 守卫（S5）：非法条目与环境类失败**拒绝写入**（环境类不得烧修复预算）；
 * - 日志损坏时**拒绝写入**（避免用残缺数组覆盖历史），返回 `requiresManualReset: true`；
 * - 调用方必须先过 `isRepairEligibleVerdict`——blocked 不得调用本函数。
 */
export function appendRepairAttempt(
  workspaceSlug: string,
  projectId: string,
  attempt: RepairAttempt,
): RepairLogWriteResult {
  if (!isRepairAttempt(attempt)) {
    return { ok: false, reason: 'repair attempt 字段非法，拒绝写入', failureClass: 'unknown' }
  }
  if (attempt.failureClass === 'environment') {
    return { ok: false, reason: '环境类失败不进入修复预算，拒绝写入', failureClass: 'environment' }
  }

  let state: RepairLogState
  try {
    state = readRepairLogState(workspaceSlug, projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `修复日志读取失败：${message}`, failureClass: classifyRepairFailure({ message }) }
  }
  if (state.status === 'corrupt') {
    return {
      ok: false,
      reason: `修复日志损坏（${state.reason}），拒绝追加以免覆盖历史记录`,
      failureClass: 'unknown',
      requiresManualReset: true,
    }
  }

  const next = state.attempts.filter((item) => item.attempt !== attempt.attempt)
  next.push(attempt)
  next.sort((a, b) => a.attempt - b.attempt)

  try {
    const projectDir = join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`)
    if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })
    writeJsonFileAtomic(getRepairLogPath(workspaceSlug, projectId), next)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[南大自修复] 修复日志写入失败（调用方须 fail-closed）:', message)
    return { ok: false, reason: `修复日志写入失败：${message}`, failureClass: classifyRepairFailure({ message }) }
  }
}

/**
 * 清空修复日志（阶段推进/新任务开始，或 corrupt 需人工重置时调用）。
 * 返回结构化结果；写失败不上抛但**不吞**（调用方据此 fail-closed）。
 */
export function clearRepairAttempts(workspaceSlug: string, projectId: string): RepairLogWriteResult {
  try {
    const projectDir = join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`)
    if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })
    writeJsonFileAtomic(getRepairLogPath(workspaceSlug, projectId), [])
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[南大自修复] 修复日志清理失败（调用方须 fail-closed）:', message)
    return { ok: false, reason: `修复日志清理失败：${message}`, failureClass: classifyRepairFailure({ message }) }
  }
}
