/**
 * NEXT-01（Phase 2，缺陷 P1-3）：交付验收**双阶段见证时钟**纯逻辑模块。
 *
 * 为什么需要它（P1-3 根因）：
 * 既有交付门禁用「距见证登记 ≤ 10 分钟」的静态窗口判定新鲜度，但真实交付链路是
 * 「重跑 GWT（1~4min）→ Agent 汇总并注入交付确认询问（1~2min）→ 人类阅读报告并应答
 * （5~30min+）」三段串行。把人类阅读耗时计入机器倒计时，用户点击确认时必然超窗，
 * 触发「过期 → 重跑 → 再询问 → 再过期」死循环（番茄工程实测连续 3 轮超窗）。
 *
 * 目标架构（蓝图 §2.2，Digest-Pinned Two-Phase Witness）：
 * 新鲜度的本质不是「距离上次跑测过了多少分钟」，而是「从上次 GWT 验收通过到现在，
 * 工作区代码与交付产物是否发生过任何篡改」。因此：
 * - **阶段一（execution_active，机器窗口 15min）**：GWT 验收通过时锚定
 *   `witnessedAt` 与产物指纹 `artifactDigest`；此阶段内 Agent 自由推进（重跑、汇总）。
 * - **阶段二（awaiting_human_confirm，人类租约 24h）**：Agent 发起交付确认询问时
 *   调用 `freezeWitnessForHumanConfirmation` 冻结倒计时——只要产物指纹未被改动，
 *   人类可以在 24 小时内从容确认。
 * - **交付门校验（verifyWitnessFreshness）**：第一优先级是**指纹篡改判定**
 *   （哪怕只过了 10 秒，产物被改即 STALE，必须重跑 GWT）；指纹一致时按所处阶段
 *   分别适用 24h 租约或 15min 机器窗口。
 *
 * 本模块刻意保持**纯函数**（时钟经 `now` 参数注入、状态经返回值传递、无进程单例），
 * 进程内 per-scope 状态管理与门禁接线由 `nanju-engineering-real-gate.ts` 负责。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 机器自动推进阶段（execution_active）的新鲜度窗口：由原 10 分钟放宽至 15 分钟。 */
export const MACHINE_WITNESS_TTL_MS = 15 * 60_000
/** 人类确认挂起期（awaiting_human_confirm）的最大有效租约：24 小时（指纹未变即有效）。 */
export const HUMAN_HOLD_LEASE_MS = 24 * 60 * 60_000

/** 见证时钟阶段。 */
export type WitnessClockPhase = 'execution_active' | 'awaiting_human_confirm'

/**
 * 双阶段见证时钟记录（蓝图 §2.3 的 WitnessRecord 落地）。
 *
 * `witnessedAt` 锚定**GWT 验收通过时刻**（蓝图 §2.2 状态图起点），不是人证登记时刻：
 * 真实链路「人证登记 → GWT 重跑 → Agent 续接轮」本身可能耗时数分钟，若锚定人证时刻，
 * 一旦链路超 15min 将出现「冻结永久失败 → 重跑更旧 → 再冻结再失败」的死循环。
 */
export interface WitnessClockRecord {
  projectId: string
  sessionId: string
  /** GWT 验收通过时刻（epoch ms）——阶段一的时钟锚点。 */
  witnessedAt: number
  /** 锚定时刻的项目产物指纹（防篡改核心锚点）。 */
  artifactDigest: string
  /** 当前时钟阶段。 */
  clockPhase: WitnessClockPhase
  /** 进入人类确认挂起期的时刻（epoch ms）；仅 awaiting_human_confirm 阶段存在。 */
  holdStartedAt?: number
  /**
   * 冻结失败原因码（A-4）：发起交付询问时冻结被拒（指纹已脏/超机器窗）的记录。保留
   * execution_active 语义（交付门仍按 15 分钟机器窗判定），但交付拒绝时把该原因带进
   * message，供用户/Agent 观测「为什么没进入 24h 租约」，不再只有 console.warn。
   */
  freezeFailedReason?: string
}

/** freezeWitnessForHumanConfirmation 的结果。 */
export interface FreezeWitnessResult {
  ok: boolean
  /** 失败原因码（E_WITNESS_*）+ 中文说明。 */
  reason?: string
  /** 成功时返回转入 awaiting_human_confirm 的新记录（调用方负责写回）。 */
  updated?: WitnessClockRecord
}

/** verifyWitnessFreshness 的结果。 */
export interface WitnessFreshnessResult {
  valid: boolean
  /** 失败原因码（E_WITNESS_*）。 */
  code?: string
  message?: string
}

/**
 * 项目产物指纹的排除规则（运行期高频写入、不代表交付产物的文件/目录）：
 * - 隐藏文件/目录（`.` 前缀）与 `node_modules`；
 * - 构建产物/依赖目录（A-6）：`dist` / `build` / `venv` / `target` / `__pycache__`——
 *   非隐藏目录但可能含数万文件（如 Python venv），计入会卡主进程且不代表源产物；
 * - `_snapshots.json` / `_telemetry*`（蓝图排除项——快照与埋点落盘）；
 * - `_project-info.json`（适配真实源码：南大向导把项目元数据放在项目目录内，交付确认
 *   登记 ack/challenge、阶段推进都会原子写此文件；若计入指纹，人类确认动作本身就会
 *   篡改指纹导致交付被拒——这是对蓝图排除清单的必要扩充）。
 */
const ARTIFACT_DIGEST_EXCLUDED_FILES = new Set([
  '_snapshots.json',
  '_project-info.json',
  'node_modules',
  'dist',
  'build',
  'venv',
  'target',
  '__pycache__',
])

function isArtifactDigestExcluded(name: string): boolean {
  return name.startsWith('.')
    || name.startsWith('_telemetry')
    || ARTIFACT_DIGEST_EXCLUDED_FILES.has(name)
}

/** 指纹遍历的最大目录深度（蓝图 §2.3：depth ≤ 5，防深目录爆炸/符号链接环路放大）。 */
const ARTIFACT_DIGEST_MAX_DEPTH = 5

/**
 * 计算项目交付产物的轻量级确定性指纹（蓝图 §2.3）：
 * 遍历项目目录下非隐藏、非 node_modules、非运行期产物的文件，按
 * `相对路径:size:floor(mtimeMs)` 逐行拼接后取 SHA256。
 *
 * 特性：目录不存在返回空目录的哈希（不抛错——门禁侧按「指纹不匹配」处理）；
 * 单文件读取失败静默跳过（遍历期间的瞬态文件不产生假告警）。
 */
export function computeProjectArtifactDigest(projectDir: string): string {
  const hash = createHash('sha256')
  if (!existsSync(projectDir)) return hash.digest('hex')

  const entries: string[] = []
  const walk = (currentDir: string, depth: number): void => {
    if (depth > ARTIFACT_DIGEST_MAX_DEPTH) return
    let names: string[] = []
    try {
      names = readdirSync(currentDir).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (isArtifactDigestExcluded(name)) continue
      const fullPath = join(currentDir, name)
      try {
        const st = statSync(fullPath)
        if (st.isDirectory()) {
          walk(fullPath, depth + 1)
        } else if (st.isFile()) {
          const rel = relative(projectDir, fullPath).replace(/\\/g, '/')
          entries.push(`${rel}:${st.size}:${Math.floor(st.mtimeMs)}`)
        }
      } catch {
        /* 瞬态文件（正在原子写的临时文件等）：跳过，不产生假篡改 */
      }
    }
  }

  walk(projectDir, 0)
  hash.update(entries.join('\n'))
  return hash.digest('hex')
}

/**
 * Agent 发起交付确认询问（满意交付/需要调整）时调用：冻结倒计时，转入人类租约期。
 *
 * 前置校验（任一失败即拒绝冻结，交付门退回 15 分钟机器窗口语义）：
 * 1. 当前指纹必须与锚定指纹一致（GWT 通过后产物被改 → E_WITNESS_ARTIFACT_DIRTY）；
 * 2. 距 `witnessedAt`（GWT 通过时刻）不得超过 15 分钟机器窗口（E_WITNESS_EXPIRED_BEFORE_ASK）。
 *
 * 幂等性：对已处于 awaiting_human_confirm 的记录重复调用视为成功（保持原 holdStartedAt，
 * 不重复起租——重复注入询问不应刷新租约）。
 */
export function freezeWitnessForHumanConfirmation(
  record: WitnessClockRecord,
  projectDir: string,
  now: number = Date.now(),
): FreezeWitnessResult {
  if (record.clockPhase === 'awaiting_human_confirm' && typeof record.holdStartedAt === 'number') {
    return { ok: true, updated: record } // 已冻结：幂等，维持既有租约
  }
  const currentDigest = computeProjectArtifactDigest(projectDir)
  if (currentDigest !== record.artifactDigest) {
    return {
      ok: false,
      reason: 'E_WITNESS_ARTIFACT_DIRTY',
    }
  }
  if (now - record.witnessedAt > MACHINE_WITNESS_TTL_MS) {
    return {
      ok: false,
      reason: 'E_WITNESS_EXPIRED_BEFORE_ASK',
    }
  }
  return {
    ok: true,
    updated: {
      ...record,
      clockPhase: 'awaiting_human_confirm',
      holdStartedAt: now,
    },
  }
}

/**
 * 交付门禁（delivered 前的最终校验）核心判定：
 * 1. **第一优先级——指纹篡改硬门禁**：产物在锚定后被改（哪怕只过了 10 秒）立即失效；
 * 2. 已冻结（awaiting_human_confirm）且租约未超 24h → PASS（人类挂起期不计机器倒计时）；
 * 3. 未冻结（execution_active）且距 GWT 通过 ≤ 15min → PASS。
 */
export function verifyWitnessFreshness(
  record: WitnessClockRecord,
  projectDir: string,
  now: number = Date.now(),
): WitnessFreshnessResult {
  // 1. 指纹篡改判定（最高优先级，先于一切时钟判定）
  const currentDigest = computeProjectArtifactDigest(projectDir)
  if (currentDigest !== record.artifactDigest) {
    return {
      valid: false,
      code: 'E_WITNESS_DIGEST_MISMATCH',
      message: 'E_WITNESS_DIGEST_MISMATCH：交付产物在验收锚定后发生了变更（含文档编辑；请重跑 GWT 验收后重新发起交付确认）。',
    }
  }

  // 2. 人类确认挂起期：24 小时租约
  if (record.clockPhase === 'awaiting_human_confirm' && typeof record.holdStartedAt === 'number') {
    if (now - record.holdStartedAt <= HUMAN_HOLD_LEASE_MS) {
      return { valid: true }
    }
    return {
      valid: false,
      code: 'E_WITNESS_HUMAN_LEASE_EXPIRED',
      message: 'E_WITNESS_HUMAN_LEASE_EXPIRED：人类确认挂起已超过 24 小时租约，请重新运行一次快速验收。',
    }
  }

  // 3. 机器执行窗口：15 分钟
  if (now - record.witnessedAt <= MACHINE_WITNESS_TTL_MS) {
    return { valid: true }
  }
  return {
    valid: false,
    code: 'E_WITNESS_MACHINE_TTL_EXPIRED',
    message: `E_WITNESS_MACHINE_TTL_EXPIRED：见证已超过 15 分钟机器窗口（已过去 ${Math.round((now - record.witnessedAt) / 1000)}s），请重跑 GWT 验收或在发起交付询问时冻结见证时钟。`,
  }
}
