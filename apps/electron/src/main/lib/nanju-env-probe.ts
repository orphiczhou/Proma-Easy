/**
 * 南大向导 — 通用环境探测执行（L2-4 J2，2026-09-18，v0.17.127+）
 *
 * 三动作之一「探测执行」（B1 03 §1 J2 / 方案 §四 L2-4，ATK-F-005 裁决）：
 * 注入时点 = 架构师任务书生成时（环境事实先于架构师首次决策，非任务书存在前凭空注入）。
 *
 * 机制（getNanjuRouterPrompt 在 architecture 阶段调用 runEnvProbe）：
 * 1. 项目 03_ARCHITECTURE/env_probe.json 已存在 → 直接读取沿用（幂等——首轮任务书
 *    产出的探测事实，后续轮次不重跑；探测命令幂等只读，重跑无信息增量）；
 * 2. 不存在 → 平台侧 spawn 执行项目 00_ENGINEERING_TEMPLATE/check_env.sh
 *    （随品类模板前移落位的通用脚本；bash，超时硬限 ENV_PROBE_TIMEOUT_MS），
 *    stdout 逐行 JSON 解析为组件清单，写 03_ARCHITECTURE/env_probe.json
 *    （平台侧写入与报告同通道，不经指挥官/Agent 会话——同 P0-2 通道口径）；
 * 3. 失败/超时/脚本未落位 → 不写文件（下轮 prompt 自然重试）、返回「探测失败」
 *    说明行——不阻断任务书生成（退化注入，任务书仍要求架构师自行探测）。
 *
 * 诚实边界：探测为跨品类通用集（node/python3/pip/display/rustc/cargo/pnpm 等），
 * 品类专用探测项由架构师按品类模版 §2.3 自行补测（任务书注入段明示）。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { getNanjuProjectDir } from './nanju-project'

/** 探测执行超时硬限（毫秒）：规格定死 10s——探测命令均为秒级版本查询，超时即判失败 */
export const ENV_PROBE_TIMEOUT_MS = 10_000

/** 单组件探测结果（check_env.sh JSON 行同构） */
export interface EnvProbeComponent {
  component: string
  status: 'ok' | 'fail'
  version?: string
  detail?: string
}

/** env_probe.json 文件结构（03_ARCHITECTURE/env_probe.json） */
export interface EnvProbeResult {
  /** 探测执行时间（ISO） */
  probedAt: string
  /** 组件清单（通用集逐项） */
  components: EnvProbeComponent[]
}

/** env_probe.json 落位路径（03_ARCHITECTURE/，与架构文档同目录） */
export function getEnvProbePath(workspaceSlug: string, projectId: string): string {
  return join(getNanjuProjectDir(workspaceSlug, projectId), '03_ARCHITECTURE', 'env_probe.json')
}

/** 项目内通用探测脚本路径（随品类模板前移落位，materializeEngineeringTemplate 同时机） */
export function getProjectCheckEnvScriptPath(workspaceSlug: string, projectId: string): string {
  return join(getNanjuProjectDir(workspaceSlug, projectId), '00_ENGINEERING_TEMPLATE', 'check_env.sh')
}

/**
 * 解析脚本 stdout 的 JSON 行（纯函数）：每行一个组件对象
 * （{"component","status":"ok"|"fail","version","detail"}）。非 { 开头的行与
 * 畸形 JSON 跳过（stderr 混入/警告行容错）；字段异常的行丢弃（宁缺勿错）。
 */
export function parseEnvProbeLines(raw: string): EnvProbeComponent[] {
  const out: EnvProbeComponent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as {
        component?: unknown; status?: unknown; version?: unknown; detail?: unknown
      }
      if (typeof parsed.component !== 'string' || parsed.component === '') continue
      if (parsed.status !== 'ok' && parsed.status !== 'fail') continue
      out.push({
        component: parsed.component,
        status: parsed.status,
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
        detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
      })
    } catch {
      // 畸形 JSON 行跳过（部分输出仍可用）
    }
  }
  return out
}

/** 单组件摘要行（任务书「已知环境事实」段主体） */
function componentSummaryLine(c: EnvProbeComponent): string {
  if (c.status === 'ok') {
    const version = c.version && c.version !== '' ? c.version : '可用'
    return `- ${c.component}：可用（${version}）`
  }
  const reason = c.detail && c.detail !== ''
    ? c.detail.slice(0, 80)
    : '缺失或不可用'
  return `- ${c.component}：缺失/不可用（${reason}）`
}

/**
 * 探测结果 → 任务书「已知环境事实」段行集（纯函数；探测时间头 + 组件逐行）。
 */
export function buildEnvProbeSummaryLines(result: EnvProbeResult): string[] {
  return [
    `探测时间：${result.probedAt}`,
    ...result.components.map(componentSummaryLine),
  ]
}

/** 探测失败说明行（runEnvProbe 失败/超时/脚本未落位时的退化注入；不阻断任务书生成） */
export function buildEnvProbeFailureLines(reason: string): string[] {
  return [
    `探测失败（${reason}）：无平台侧环境事实可注入。`,
    '请架构师在「## 环境配置」环节自行逐组件探测，不得因本段缺失跳过探测。',
  ]
}

/** 读取既有 env_probe.json（不存在/损坏返回 null） */
function readEnvProbeFile(path: string): EnvProbeResult | null {
  try {
    if (!existsSync(path)) return null
    const parsed = readJsonFileSafe<EnvProbeResult>(path)
    if (!parsed || !Array.isArray(parsed.components)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 执行通用环境探测（幂等）：env_probe.json 已存在 → 直接读取沿用（不重跑）；
 * 否则 spawn 执行项目内 check_env.sh，解析 JSON 行写盘。失败/超时不写文件
 * （下轮重试）、返回「探测失败」说明行。
 *
 * @param opts.scriptPath 显式脚本路径覆盖（测试注入用；缺省 = 项目内 check_env.sh）
 * @param opts.timeoutMs  超时覆盖（测试注入用；缺省 = ENV_PROBE_TIMEOUT_MS）
 * @returns lines = 任务书注入行（成功=摘要 / 失败=说明），ok = 是否有探测事实
 */
export function runEnvProbe(
  workspaceSlug: string,
  projectId: string,
  opts?: { scriptPath?: string; timeoutMs?: number },
): { ok: boolean; lines: string[] } {
  const envPath = getEnvProbePath(workspaceSlug, projectId)

  // 1. 幂等沿用：已有探测事实 → 直接读取（环境事实先于架构师首次决策后保持稳定）
  const existing = readEnvProbeFile(envPath)
  if (existing) return { ok: true, lines: buildEnvProbeSummaryLines(existing) }

  // 2. 脚本未落位（旧项目/前移钩子失败）→ 退化说明（无子进程开销，快速返回）
  const scriptPath = opts?.scriptPath ?? getProjectCheckEnvScriptPath(workspaceSlug, projectId)
  if (!existsSync(scriptPath)) {
    return { ok: false, lines: buildEnvProbeFailureLines('探测脚本未落位（00_ENGINEERING_TEMPLATE/check_env.sh 不存在）') }
  }

  // 3. 平台侧执行（bash，幂等只读脚本，超时硬限）
  let raw = ''
  try {
    const spawned = spawnSync('bash', [scriptPath], {
      encoding: 'utf-8',
      timeout: opts?.timeoutMs ?? ENV_PROBE_TIMEOUT_MS,
      env: process.env, // 宿主环境透传（探测 DISPLAY 等环境事实需要）
    })
    if (spawned.error) {
      const isTimeout = (spawned.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      return { ok: false, lines: buildEnvProbeFailureLines(isTimeout ? `执行超时（>${opts?.timeoutMs ?? ENV_PROBE_TIMEOUT_MS}ms 硬限）` : `执行异常：${spawned.error.message}`) }
    }
    // 脚本设计为探测失败不中断（整体 exit 0）；非 0 退出仍尝试解析部分输出，全空才判失败
    raw = spawned.stdout ?? ''
  } catch (e) {
    return { ok: false, lines: buildEnvProbeFailureLines(`执行异常：${e instanceof Error ? e.message : String(e)}`) }
  }

  // 4. 解析 JSON 行（≥1 个有效组件即认有效；全空 = 输出不可判读）
  const components = parseEnvProbeLines(raw)
  if (components.length === 0) {
    return { ok: false, lines: buildEnvProbeFailureLines('脚本输出无可解析的组件 JSON 行') }
  }

  // 5. 写入 env_probe.json（平台侧写入与报告同通道；目录缺失兜底创建）
  const result: EnvProbeResult = { probedAt: new Date().toISOString(), components }
  try {
    const dir = join(getNanjuProjectDir(workspaceSlug, projectId), '03_ARCHITECTURE')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeJsonFileAtomic(envPath, result)
  } catch {
    // 写盘失败不阻断：摘要仍注入任务书（事实先于决策的语义保住），下轮重试落盘
  }
  return { ok: true, lines: buildEnvProbeSummaryLines(result) }
}
