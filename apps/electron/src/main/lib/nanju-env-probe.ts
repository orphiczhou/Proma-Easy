/**
 * 南大向导 — 通用环境探测执行（L2-4 J2，2026-09-18，v0.17.127+；Task 10 扩展：新鲜度与品类探测）
 *
 * 三动作之一「探测执行」（B1 03 §1 J2 / 方案 §四 L2-4，ATK-F-005 裁决）：
 * 注入时点 = 架构师任务书生成时（环境事实先于架构师首次决策，非任务书存在前凭空注入）。
 *
 * 机制（getNanjuRouterPrompt 在 architecture 阶段调用 runEnvProbe）：
 * 1. 项目 03_ARCHITECTURE/env_probe.json 已存在 → 校验新鲜度
 *    - 新鲜 = probedAt + maxAgeMs 之内 **且** 探测在模板落地之后（template-manifest.json.copiedAt）
 *      → 直接读取沿用（幂等——首轮任务书产出的探测事实，后续轮次不重跑）；
 *    - 过期 / 早于模板 → 删除旧文件 + 重跑（产物无效则重测）；
 * 2. 不存在 / 已删 → 平台侧 spawn 执行项目 00_ENGINEERING_TEMPLATE/check_env.sh
 *    （随品类模板前移落位的脚本；bash，超时硬限 ENV_PROBE_TIMEOUT_MS；可选 CATEGORY 参数
 *    让脚本执行品类专用探测项），stdout 逐行 JSON 解析为组件清单，写 03_ARCHITECTURE/env_probe.json
 *    （平台侧写入与报告同通道，不经指挥官/Agent 会话——同 P0-2 通道口径）；
 * 3. 失败/超时/脚本未落位 → 不写文件（下轮 prompt 自然重试）、返回「探测失败」
 *    说明行——不阻断任务书生成（退化注入，任务书仍要求架构师自行探测）。
 *
 * 诚实边界：探测为跨品类通用集（node/python3/pip/display/rustc/cargo/pnpm 等），
 * 品类专用探测项由 check_env.sh 接受 CATEGORY 参数扩展（Task 10 修订：
 * 脚本内按品类 switch 添加 webkit2gtk/adb/ollama/playwright 等专项探测）。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { getNanjuProjectDir } from './nanju-project'

/** 探测执行超时硬限（毫秒）：规格定死 10s——探测命令均为秒级版本查询，超时即判失败 */
export const ENV_PROBE_TIMEOUT_MS = 10_000

/** 新鲜度默认窗口（24h）——同窗口内环境事实稳定，避免每轮重跑 */
export const ENV_PROBE_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

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
  /** 组件清单（通用集 + 品类扩展项逐项） */
  components: EnvProbeComponent[]
  /** 探测使用的 category 参数（universal = 仅通用集；否则记录品类） */
  category?: ProjectCategoryForProbe
}

/** 可注入的品类枚举（探测专用——避免 nanju-project 强耦合） */
export type ProjectCategoryForProbe =
  | 'web-fullstack' | 'api-backend' | 'mobile-app' | 'desktop-app' | 'cli-tool' | 'ai-application'
  | 'universal'

/** env_probe.json 落位路径（03_ARCHITECTURE/，与架构文档同目录） */
export function getEnvProbePath(workspaceSlug: string, projectId: string): string {
  return join(getNanjuProjectDir(workspaceSlug, projectId), '03_ARCHITECTURE', 'env_probe.json')
}

/** 项目内通用探测脚本路径（随品类模板前移落位，materializeEngineeringTemplate 同时机） */
export function getProjectCheckEnvScriptPath(workspaceSlug: string, projectId: string): string {
  return join(getNanjuProjectDir(workspaceSlug, projectId), '00_ENGINEERING_TEMPLATE', 'check_env.sh')
}

/** 模板落位时间锚点（项目 00_ENGINEERING_TEMPLATE/template-manifest.json.copiedAt） */
export function getTemplateCopiedAt(workspaceSlug: string, projectId: string): string | null {
  const path = join(getNanjuProjectDir(workspaceSlug, projectId), '00_ENGINEERING_TEMPLATE', 'template-manifest.json')
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as { copiedAt?: unknown }
    if (typeof data.copiedAt !== 'string') return null
    return data.copiedAt
  } catch {
    return null
  }
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
  const categoryLine = result.category && result.category !== 'universal'
    ? `探测品类：${result.category}`
    : '探测品类：universal（跨品类通用集）'
  return [
    `探测时间：${result.probedAt}`,
    categoryLine,
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
 * 新鲜度判定（Task 10 扩展）：
 * - within-age：probedAt + maxAgeMs 内（默认 24h）
 * - after-template：probedAt ≥ 模板落地时间（探测在最新模板之后）
 * - stale-age：超过 maxAgeMs
 * - before-template：probedAt 早于模板落地（模板升级但未重跑）
 * - category-mismatch（R3 审计 2026-09-23）：请求品类与落盘品类不一致
 *   （含旧文件无 category 字段、universal ↔ 具体品类互换）——品类改变意味着品类专用
 *   组件集不同，不得复用旧通用集冒充品类探测。
 *
 * 返回 fresh=false 时调用方应删除旧 env_probe.json 重跑。
 */
export interface EnvProbeFreshness {
  fresh: boolean
  reason: 'within-age' | 'after-template' | 'stale-age' | 'before-template' | 'unparseable-probed-at' | 'category-mismatch'
  /** 距今毫秒数（便于日志） */
  ageMs: number
  /** 相对模板时间差（模板缺失时为 null） */
  templateDeltaMs: number | null
}

export interface EnvProbeFreshnessOptions {
  /** 最大有效时长（ms）；默认 ENV_PROBE_DEFAULT_MAX_AGE_MS */
  maxAgeMs?: number
  /** 模板生成时间锚点（来自 template-manifest.json.copiedAt） */
  templateCopiedAt?: string | null
  /** 「现在」时间锚点（测试注入用；缺省 = Date.now） */
  nowMs?: number
  /** 本次请求的探测品类；与落盘 category 不一致即不新鲜（缺省不校验） */
  category?: ProjectCategoryForProbe
}

export function isEnvProbeFresh(result: EnvProbeResult, opts?: EnvProbeFreshnessOptions): EnvProbeFreshness {
  const probedAtMs = Date.parse(result.probedAt)
  if (Number.isNaN(probedAtMs)) {
    return { fresh: false, reason: 'unparseable-probed-at', ageMs: Number.NaN, templateDeltaMs: null }
  }
  const nowMs = opts?.nowMs ?? Date.now()
  const ageMs = nowMs - probedAtMs
  // 时钟倒退不能把未来生成的证据当成新鲜；保留负 age 供诊断，按零有效年龄但标记不新鲜。
  const clockSkewed = nowMs < probedAtMs
  const effectiveNowMs = nowMs
  const maxAgeMs = opts?.maxAgeMs ?? ENV_PROBE_DEFAULT_MAX_AGE_MS

  // 模板时间锚点缺失（项目内无 template-manifest.json）→ 仅按年龄判定
  const templateCopiedAt = opts?.templateCopiedAt ?? null
  let templateDeltaMs: number | null = null
  if (templateCopiedAt) {
    const tplMs = Date.parse(templateCopiedAt)
    if (Number.isNaN(tplMs)) {
      // 模板时间不可解析 → 仅按年龄判定
      templateDeltaMs = null
    } else {
      templateDeltaMs = probedAtMs - tplMs
      // 探测时间早于模板落地 → 必须重跑（环境探测在旧模板上做的，结论可能与新模板不匹配）
      if (templateDeltaMs < 0) {
        return { fresh: false, reason: 'before-template', ageMs, templateDeltaMs }
      }
    }
  }

  if (clockSkewed) return { fresh: false, reason: 'stale-age', ageMs, templateDeltaMs }
  // R3（2026-09-23）：品类不一致即不新鲜——品类专用组件集不同，不得复用旧通用集冒充品类探测。
  // 旧文件无 category 字段、universal ↔ 具体品类互换，均视为不一致。
  if (opts?.category !== undefined && (result.category ?? 'universal') !== opts.category) {
    return { fresh: false, reason: 'category-mismatch', ageMs, templateDeltaMs }
  }
  if (effectiveNowMs - probedAtMs > maxAgeMs) {
    return { fresh: false, reason: 'stale-age', ageMs: effectiveNowMs - probedAtMs, templateDeltaMs }
  }
  // 在年龄内 + （有模板锚点且探测在模板之后）→ fresh；纯年龄内也 fresh
  if (templateDeltaMs !== null && templateDeltaMs >= 0) {
    return { fresh: true, reason: 'after-template', ageMs, templateDeltaMs }
  }
  return { fresh: true, reason: 'within-age', ageMs, templateDeltaMs }
}

/**
 * 执行通用环境探测（幂等 + 新鲜度判定 + 退化）：
 * - env_probe.json 已存在 + 新鲜 → 直接读取沿用；
 * - 已存在但不新鲜 → 删除 + 重跑；
 * - 不存在 → 重跑；
 * - 失败/超时不写文件（下轮重试）、返回「探测失败」说明行。
 *
 * @param opts.scriptPath 显式脚本路径覆盖（测试注入用）
 * @param opts.timeoutMs  超时覆盖（测试注入用）
 * @param opts.category   探测品类（universal 或六品类枚举）；传递给 check_env.sh 扩展品类探测项
 * @param opts.freshnessOpts 新鲜度选项（maxAgeMs / templateCopiedAt / nowMs）
 * @param opts.forceRerun  强制重跑（忽略新鲜度判定；测试用）
 * @returns lines = 任务书注入行（成功=摘要 / 失败=说明），ok = 是否有探测事实
 */
export function runEnvProbe(
  workspaceSlug: string,
  projectId: string,
  opts?: {
    scriptPath?: string
    timeoutMs?: number
    category?: ProjectCategoryForProbe
    freshnessOpts?: EnvProbeFreshnessOptions
    forceRerun?: boolean
  },
): { ok: boolean; lines: string[] } {
  const envPath = getEnvProbePath(workspaceSlug, projectId)
  const category: ProjectCategoryForProbe = opts?.category ?? 'universal'

  // 1. 幂等沿用 + 新鲜度判定：fresh → 直接读取
  if (!opts?.forceRerun) {
    const existing = readEnvProbeFile(envPath)
    if (existing) {
      const tplCopiedAt = opts?.freshnessOpts?.templateCopiedAt ?? getTemplateCopiedAt(workspaceSlug, projectId)
      const freshness = isEnvProbeFresh(existing, {
        ...opts?.freshnessOpts,
        templateCopiedAt: tplCopiedAt,
        category,
      })
      if (freshness.fresh) {
        return { ok: true, lines: buildEnvProbeSummaryLines(existing) }
      }
      // 不新鲜：删除旧文件，下一步重跑
      try { unlinkSync(envPath) } catch { /* 文件不存在容忍 */ }
    }
  }

  // 2. 脚本未落位（旧项目/前移钩子失败）→ 退化说明
  const scriptPath = opts?.scriptPath ?? getProjectCheckEnvScriptPath(workspaceSlug, projectId)
  if (!existsSync(scriptPath)) {
    return { ok: false, lines: buildEnvProbeFailureLines('探测脚本未落位（00_ENGINEERING_TEMPLATE/check_env.sh 不存在）') }
  }

  // 3. 平台侧执行（bash，幂等只读脚本，超时硬限）；CATEGORY 作为 $1 传给脚本
  let raw = ''
  try {
    const args = category === 'universal' ? [scriptPath] : [scriptPath, category]
    const spawned = spawnSync('bash', args, {
      encoding: 'utf-8',
      timeout: opts?.timeoutMs ?? ENV_PROBE_TIMEOUT_MS,
      env: process.env, // 宿主环境透传（探测 DISPLAY 等环境事实需要）
    })
    if (spawned.error) {
      const isTimeout = (spawned.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      return { ok: false, lines: buildEnvProbeFailureLines(isTimeout ? `执行超时（>${opts?.timeoutMs ?? ENV_PROBE_TIMEOUT_MS}ms 硬限）` : `执行异常：${spawned.error.message}`) }
    }
    raw = spawned.stdout ?? ''
  } catch (e) {
    return { ok: false, lines: buildEnvProbeFailureLines(`执行异常：${e instanceof Error ? e.message : String(e)}`) }
  }

  // 4. 解析 JSON 行
  const components = parseEnvProbeLines(raw)
  if (components.length === 0) {
    return { ok: false, lines: buildEnvProbeFailureLines('脚本输出无可解析的组件 JSON 行') }
  }

  // 5. 写入 env_probe.json（含 category 字段，便于后续溯源）
  const result: EnvProbeResult = { probedAt: new Date().toISOString(), components, category }
  try {
    const dir = join(getNanjuProjectDir(workspaceSlug, projectId), '03_ARCHITECTURE')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeJsonFileAtomic(envPath, result)
  } catch {
    // 写盘失败不阻断：摘要仍注入任务书
  }
  return { ok: true, lines: buildEnvProbeSummaryLines(result) }
}
