import { createEngineeringBrowserFileDriver, createEngineeringBrowserUrlDriver } from './nanju-engineering-browser-driver'
import { startEngineeringService, createDefaultEngineeringServiceDeps, validateEngineeringServiceEnvironment } from './nanju-engineering-service'
import type { EngineeringServiceRuntimes, EngineeringServiceDeps } from './nanju-engineering-service'
import { detectEngineeringPython } from './nanju-engineering-runtime'
import { EngineeringExecutionBlocked } from './nanju-engineering-execution'
import { runEngineeringSuite } from './nanju-engineering-suite'
// W-I B-f：真实能力证据门禁宿主接线层（registry/单时钟/收据签发/交付原子消费）
import { commitDeliveryRealEvidence, resolveSuiteRealEvidence } from './nanju-engineering-real-gate'
import type { EngineeringRealEvidenceScope } from './nanju-engineering-real-gate'
import type { EngineeringSuiteResult } from './nanju-engineering-suite'
import type { EngineeringExecutionServices } from './nanju-engineering-execution'
/**
 * GWT 验收测试执行器（Harness，P1 Sprint B：v0.17.62）
 *
 * 职责边界（设计稿 Q3 Hybrid 架构）：
 * - L2 测试工程师负责「场景生成与步骤映射」（语义工作）→ 06_TESTS/features/*.feature + *.steps.json
 * - 本模块负责「浏览器执行与判定」（确定性工作）：加载 steps.json → 预检 → 逐场景执行
 *   → 规则裁判 → 写报告 → 埋点，全部零 token、可单测、可复现。
 *
 * 裁判是规则不是模型（PRD §4.5/§9.1）：
 * - pass 条件（硬约束）：① 每条 US-xx 至少 1 个非 skip 场景（覆盖性）；
 *   ② 全部非 skip 场景通过（通过性）。
 * - 失败 → orchestrator 注入 assistant 消息回炉 coding（≤2 次）→ 人工介入。
 *
 * 执行内核：BrowserController GWT 原语（loadFile 直载绕开 click-to-fix 注入 +
 * data-ai-id 选择器锚点 + CDP 真实输入序列）。时序断言一律轮询窗口（timeoutMs），
 * 禁严格时刻断言。
 *
 * 安全边界（v0.17.63，AC G-001/G-002）：op 白名单不含 eval——L2 产出的自由 JS
 * 不再进入页面上下文（assertBrowserScript 仅长度校验，无白名单约束力）；复杂状态
 * 断言暂不支持，用 assert-text 轮询读界面状态文本替代。
 *
 * 测试上下文边界声明（AC G-003/F-003）：file:// 测试上下文与 proma-file 预览存在
 * 注入差异（预览协议的 click-to-fix 注入与 token 门控不在测试覆盖内）——测试结论
 * 对交互语义负责、不验证 click-to-fix 注入。
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { PNG } from 'pngjs'
import { writeJsonFileAtomic, writeTextFileAtomic } from './safe-file'
import { getNanjuProjectDir } from './nanju-project'
import type { NanjuProjectInfoFile } from './nanju-project'
import { parseUserStories } from './nanju-user-stories'
import { prepareEngineeringBrowserRun } from './nanju-engineering-preflight'
import { captureEngineeringEvidence, ENGINEERING_CONTRACT_PATH, requiresEngineeringContract, parseEngineeringContract } from './nanju-engineering-contract'
import { summarizeDriverIo, buildDriverIoLogFile } from './nanju-engineering-driver-io'
import type { EngineeringEvidence } from './nanju-engineering-contract'
import { recordTelemetry } from './nanju-telemetry'
// L2-6（L2 批，2026-09-18）：坑库回填——强制复盘指令段（纯文本，无会话创建）
import { buildPitReflowDirective, shouldTriggerPitReflow } from './nanju-pit-reflow'
import { resolveProjectCategoryForCoding } from './nanju-engineering-template'

// ===== steps.json schema =====

/** steps.json schema 版本（W22 A1）：v2 = 新词表（check/uncheck/select/hover/scroll/focus/assert-screenshot + selector 二档）。校验失败（含未知 op/版本不匹配）计 fail 不再静默 skip */
export const GWT_STEPS_SCHEMA_VERSION = 2

/** op 白名单（Sprint B；设计稿 Q4。v0.17.63 移除 eval；W22 F2/F4 扩展 v2 词表；W22 收尾增 reload） */
export type GwtOpType =
  | 'click' | 'fill' | 'press' | 'wait-selector'
  | 'assert-text' | 'assert-visible' | 'assert-count'
  | 'check' | 'uncheck' | 'select' | 'hover' | 'scroll' | 'focus'
  | 'assert-screenshot'
  | 'reload'

/** selector 档位（W22 F3）：data-ai-id 主档不变；#id / aria-label 二档带唯一性校验 */
export type GwtSelectorTier = 'data-ai-id' | 'id' | 'aria-label'

/** 归一后的 selector 引用：css 为 null 时（aria-label 档）用属性相等匹配，不拼 CSS */
export interface GwtSelectorRef {
  tier: GwtSelectorTier
  /** CSS 查询形态（data-ai-id/#id 档）；aria-label 档为 null */
  css: string | null
  /** 档位值：data-ai-id 值 / id 值 / aria-label 原文 */
  value: string
}

export interface GwtStepOp {
  type: GwtOpType
  /** data-ai-id=xxx / #id / [aria-label="…"] 三档形态（归一后统一 GwtSelectorRef） */
  selector?: string
  /** fill 文本 / press 键名 / select 选项（value 优先，label 兼容匹配） */
  value?: string
  /** assert-text 期望包含文本 */
  contains?: string
  /** assert-count 期望元素数量 */
  count?: number
  /** scroll 滚动量（px，正向下/负向上） */
  deltaY?: number
  /** assert-screenshot 基线名（缺省用 feature+scenario slug） */
  name?: string
  /** assert-screenshot 差异阈值（差异像素占比，默认 0.02；warning-only 不影响 verdict） */
  threshold?: number
  /** op 级超时/轮询窗口（毫秒）——设计稿 schema 示例的写法，与步骤级 timeoutMs 等效（步骤级优先） */
  timeoutMs?: number
}

export interface GwtStep {
  kind: 'given' | 'when' | 'then'
  text: string
  op: GwtStepOp | null
  /** 无法映射到实际元素的步骤：op=null + unmapped=true，场景整体透明 skip */
  unmapped?: boolean
  /** 该步超时/轮询窗口（毫秒） */
  timeoutMs?: number
}

export interface GwtScenarioFile {
  feature: string
  scenario: string
  skip: boolean
  skipReason: string | null
  steps: GwtStep[]
}

export type GwtScenarioStatus = 'pass' | 'fail' | 'skip'

/** 失败步骤详情（回炉缺陷清单用） */
export interface GwtFailedStep {
  index: number
  kind: GwtStep['kind']
  text: string
  expected: string
  actual: string
  /**
   * 失败归类（v0.17.63 回炉分流依据，AC L-001）：
   * - selector-wait：click/fill 目标元素轮询窗口内未出现（映射类，回 testing 重映射）
   * - unmapped：步骤未映射但场景未声明 skip（映射类兜底）
   * - selector-ambiguous：#id / aria-label 档命中非唯一元素（映射类，W22 F3）
   * - schema-invalid：steps.json 校验失败/未知 op/版本不匹配（映射类，W22 A1——不再静默 skip）
   * - op-check/op-select/op-hover/op-scroll/op-focus：新 op 执行约束失败（映射类，W22 F2；
   *   如 select 遇非原生 select、radio uncheck 等测试侧可修复问题，回 testing 改 steps.json）
   * - assert：断言不满足（行为类，回 coding 改代码）
   * - channel：执行通道异常（CDP/标签级故障）
   */
  category?: 'selector-wait' | 'unmapped' | 'selector-ambiguous' | 'schema-invalid'
    | 'op-check' | 'op-select' | 'op-hover' | 'op-scroll' | 'op-focus'
    | 'assert' | 'channel'
  /** 失败步骤使用的 selector 档位（W22 F3 报告归因：区分「应用坏了」与「锚点漂了」） */
  selectorTier?: GwtSelectorTier | null
}

/** 单场景执行结果 */
export interface GwtScenarioResult {
  feature: string
  scenario: string
  status: GwtScenarioStatus
  /** skip 原因 / fail 首个失败步骤描述 */
  reason: string | null
  /** fail 时的失败步骤详情（回炉缺陷清单用） */
  failedStep: GwtFailedStep | null
  /** 失败截图相对路径（06_TESTS/ 内相对） */
  screenshot: string | null
  durationMs: number
  /** 非阻塞警告（W22 F4：assert-screenshot baseline-created/diff 等；不影响 verdict） */
  warnings?: string[]
}

/** 规则裁判判定 */
export interface GwtJudgement {
  verdict: 'pass' | 'fail'
  scenariosTotal: number
  passed: number
  failed: number
  skipped: number
  /** PRD 用户故事覆盖（有非 skip 场景的 US） */
  coveredUs: string[]
  /** 未覆盖的用户故事（无任何非 skip 场景） */
  uncoveredUs: string[]
}

// ===== 纯函数：selector 归一 / schema 校验 / US 提取 / 裁判 / 报告 =====

const DATA_AI_ID_VALUE = /^[A-Za-z][A-Za-z0-9_-]*$/
const VALID_OP_TYPES: ReadonlySet<string> = new Set([
  'click', 'fill', 'press', 'wait-selector', 'assert-text', 'assert-visible', 'assert-count',
  // W22 F2/F4 v2 词表
  'check', 'uncheck', 'select', 'hover', 'scroll', 'focus', 'assert-screenshot',
  // W22 收尾（E2E 闭环）：页面刷新/重载（US-09 类「保存后刷新验证持久化」场景）
  'reload',
])

/** fill.value 长度上限（W22 F1：evaluate 内联表达式有 20k 字符限制，超长会被误归 channel 类失败） */
export const GWT_FILL_VALUE_MAX_CHARS = 2_000

/** assert-screenshot 默认差异阈值（差异像素占比；warning-only 不影响 verdict） */
export const GWT_SCREENSHOT_DIFF_THRESHOLD_DEFAULT = 0.02

/** selector 归一档位识别阈值（W22 F3）：aria-label 属性值长度上限 */
const ARIA_LABEL_MAX_CHARS = 60

/**
 * selector 归一（W22 F3 三档）：
 * - 主档 data-ai-id 不变：`data-ai-id=xxx` / `[data-ai-id="xxx"]` / `[data-ai-id='xxx']`；
 * - 二档 #id：正则 ^[A-Za-z][A-Za-z0-9_-]*$（拒绝 React useId 的 `:r1:` 形态等非法 CSS 标识符），
 *   执行期唯一性校验（querySelectorAll !== 1 即 fail，绝不取第一个）；
 * - 二档 [aria-label="…"]：属性相等匹配（不拼 CSS，中文/引号/反斜杠安全），≤60 字符，
 *   同样唯一性校验。
 * 非法形态返回 null（预检阶段拦截，不臆造；不开放自由 CSS 的防脆弱设计保留）。
 */
export function normalizeGwtSelector(raw: string): GwtSelectorRef | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  // 形态一：data-ai-id=xxx
  const bare = /^data-ai-id\s*=\s*(.+)$/.exec(trimmed)
  if (bare?.[1]) {
    const value = bare[1].trim()
    return DATA_AI_ID_VALUE.test(value)
      ? { tier: 'data-ai-id', css: `[data-ai-id="${value}"]`, value }
      : null
  }
  // 形态二：[data-ai-id="xxx"] / [data-ai-id='xxx']
  const bracketed = /^\[\s*data-ai-id\s*=\s*["']([^"']+)["']\s*\]$/.exec(trimmed)
  if (bracketed?.[1]) {
    const value = bracketed[1].trim()
    return DATA_AI_ID_VALUE.test(value)
      ? { tier: 'data-ai-id', css: `[data-ai-id="${value}"]`, value }
      : null
  }
  // 形态三（W22 F3）：#id —— 正则收紧后直接拼 CSS（已拒绝 ：/空/数字开头等非法标识符）
  if (trimmed.startsWith('#')) {
    const value = trimmed.slice(1)
    return DATA_AI_ID_VALUE.test(value)
      ? { tier: 'id', css: `#${value}`, value }
      : null
  }
  // 形态四（W22 F3）：[aria-label="…"] —— 属性相等匹配，不拼 CSS 字符串
  const aria = /^\[\s*aria-label\s*=\s*"([^"]*)"\s*\]$/.exec(trimmed)
  if (aria) {
    const value = aria[1] ?? ''
    if (!value || value.length > ARIA_LABEL_MAX_CHARS || /[\r\n]/.test(value)) return null
    return { tier: 'aria-label', css: null, value }
  }
  return null
}

/** 二档 selector（#id / aria-label）执行期需要唯一性校验（data-ai-id 主档保持取首个的现状） */
function selectorNeedsUniqueCheck(ref: GwtSelectorRef): boolean {
  return ref.tier !== 'data-ai-id'
}

/** 页面内查找元素集合的 JS 片段（aria-label 档走属性相等匹配，不拼 CSS） */
function selectorFindFragment(ref: GwtSelectorRef): string {
  if (ref.css !== null) return `document.querySelectorAll(${pagePayload(ref.css)})`
  return `Array.from(document.querySelectorAll('[aria-label]')).filter(e => e.getAttribute('aria-label') === ${pagePayload(ref.value)})`
}

/** 需要选择器的 op 类型 */
const SELECTOR_OPS: ReadonlySet<string> = new Set([
  'click', 'fill', 'wait-selector', 'assert-text', 'assert-visible', 'assert-count',
  // W22 F2 新 op
  'check', 'uncheck', 'select', 'hover', 'focus',
  // scroll 的 selector 可选（缺省滚动整页）
])

/** 校验单个 steps.json 文件内容；返回错误清单（空=合法） */
export function validateScenarioFileContent(raw: string): { scenario: GwtScenarioFile | null; errors: string[] } {
  const errors: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { scenario: null, errors: [`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`] }
  }
  const obj = parsed as Record<string, unknown>
  if (!obj || typeof obj !== 'object') return { scenario: null, errors: ['顶层不是对象'] }
  // W22 A1：schemaVersion 存在时必须匹配当前词表版本（不匹配计 fail 并指引重新生成；
  // 缺失宽容处理为旧版文件——旧 op 全集仍受白名单校验约束，未知 op 不再静默 skip）
  if (obj.schemaVersion !== undefined && obj.schemaVersion !== GWT_STEPS_SCHEMA_VERSION) {
    errors.push(`schemaVersion 不匹配：文件声明 ${JSON.stringify(obj.schemaVersion)}，当前运行器支持 v${GWT_STEPS_SCHEMA_VERSION}。请用当前测试工程师词表重新生成 steps.json（不要手改版本号）`)
  }
  if (typeof obj.feature !== 'string' || !obj.feature.trim()) errors.push('feature 必须是非空字符串')
  if (typeof obj.scenario !== 'string' || !obj.scenario.trim()) errors.push('scenario 必须是非空字符串')
  if (typeof obj.skip !== 'boolean') errors.push('skip 必须是布尔值')
  if (obj.skipReason !== null && typeof obj.skipReason !== 'string') errors.push('skipReason 必须是字符串或 null')
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    errors.push('steps 必须是非空数组')
    return { scenario: null, errors }
  }
  const steps: GwtStep[] = []
  obj.steps.forEach((s, i) => {
    const step = s as Record<string, unknown>
    const label = `steps[${i}]`
    if (!step || typeof step !== 'object') { errors.push(`${label} 不是对象`); return }
    if (step.kind !== 'given' && step.kind !== 'when' && step.kind !== 'then') {
      errors.push(`${label}.kind 必须是 given/when/then`)
    }
    if (typeof step.text !== 'string' || !step.text.trim()) errors.push(`${label}.text 必须是非空字符串`)
    if (step.timeoutMs !== undefined && (typeof step.timeoutMs !== 'number' || !Number.isFinite(step.timeoutMs) || step.timeoutMs < 0)) {
      errors.push(`${label}.timeoutMs 必须是非负数字`)
    }
    if (step.op && typeof step.op === 'object' && 'timeoutMs' in (step.op as Record<string, unknown>)) {
      const opTimeout = (step.op as Record<string, unknown>).timeoutMs
      if (typeof opTimeout !== 'number' || !Number.isFinite(opTimeout) || opTimeout < 0) {
        errors.push(`${label}.op.timeoutMs 必须是非负数字`)
      }
    }
    if (step.op === null) {
      if (step.unmapped !== true) errors.push(`${label}.op=null 时必须显式声明 unmapped:true`)
    } else if (typeof step.op === 'object' && step.op !== null) {
      const op = step.op as Record<string, unknown>
      if (typeof op.type !== 'string' || !VALID_OP_TYPES.has(op.type)) {
        errors.push(`${label}.op.type 不在白名单（${[...VALID_OP_TYPES].join('/')}）`)
      } else {
        if (SELECTOR_OPS.has(op.type)) {
          if (typeof op.selector !== 'string') {
            errors.push(`${label}.op.type=${op.type} 需要 selector`)
          } else if (!normalizeGwtSelector(op.selector)) {
            errors.push(`${label}.op.selector 非法（只允许 data-ai-id=xxx / [data-ai-id="xxx"] / #id / [aria-label="…"] 四形态；回炉修映射优先补 data-ai-id，不得用 #id 规避标注纪律）`)
          }
        }
        if (op.type === 'scroll' && typeof op.selector !== 'undefined' && typeof op.selector !== 'string') {
          errors.push(`${label}.op.type=scroll 的 selector 可选，但必须是字符串`)
        }
        if (op.type === 'fill' && typeof op.value !== 'string') errors.push(`${label}.op.type=fill 需要 value 文本`)
        if (op.type === 'fill' && typeof op.value === 'string' && op.value.length > GWT_FILL_VALUE_MAX_CHARS) {
          errors.push(`${label}.op.type=fill 的 value 超过 ${GWT_FILL_VALUE_MAX_CHARS} 字符上限`)
        }
        if (op.type === 'press' && (typeof op.value !== 'string' || !op.value.trim())) errors.push(`${label}.op.type=press 需要 value 键名`)
        if (op.type === 'assert-text' && typeof op.contains !== 'string') errors.push(`${label}.op.type=assert-text 需要 contains 文本`)
        if (op.type === 'assert-count' && (typeof op.count !== 'number' || !Number.isInteger(op.count) || op.count < 0)) {
          errors.push(`${label}.op.type=assert-count 需要 count 非负整数`)
        }
        // W22 F2：select 需 selector + value（value 优先精确匹配 option.value，兼容匹配 option.label）
        if (op.type === 'select' && (typeof op.value !== 'string' || !op.value.trim())) errors.push(`${label}.op.type=select 需要 value（option 的 value 或 label）`)
        // W22 F2：scroll 需非零有限 deltaY
        if (op.type === 'scroll' && (typeof op.deltaY !== 'number' || !Number.isFinite(op.deltaY) || op.deltaY === 0)) {
          errors.push(`${label}.op.type=scroll 需要 deltaY 非零数字（正向下、负向上）`)
        }
        // W22 F4：assert-screenshot 可选字段约束
        if (op.type === 'assert-screenshot') {
          if (op.name !== undefined && (typeof op.name !== 'string' || !op.name.trim() || op.name.length > 60)) {
            errors.push(`${label}.op.type=assert-screenshot 的 name 必须是 1-60 字符`)
          }
          if (op.threshold !== undefined && (typeof op.threshold !== 'number' || !Number.isFinite(op.threshold) || op.threshold <= 0 || op.threshold > 1)) {
            errors.push(`${label}.op.type=assert-screenshot 的 threshold 必须是 (0,1] 内数字`)
          }
        }
      }
    } else {
      errors.push(`${label}.op 必须是对象或 null`)
    }
    steps.push({
      kind: (['given', 'when', 'then'] as const).includes(step.kind as 'given') ? (step.kind as GwtStep['kind']) : 'when',
      text: typeof step.text === 'string' ? step.text : '',
      op: (step.op && typeof step.op === 'object' ? (step.op as GwtStepOp) : null),
      unmapped: step.unmapped === true,
      timeoutMs: typeof step.timeoutMs === 'number'
        ? step.timeoutMs
        : (step.op && typeof step.op === 'object' && typeof (step.op as Record<string, unknown>).timeoutMs === 'number'
            ? ((step.op as Record<string, unknown>).timeoutMs as number)
            : undefined),
    })
  })
  if (errors.length > 0) return { scenario: null, errors }
  return {
    scenario: {
      feature: obj.feature as string,
      scenario: obj.scenario as string,
      skip: obj.skip as boolean,
      skipReason: (obj.skipReason ?? null) as string | null,
      steps,
    },
    errors: [],
  }
}

export { parseUserStories } from './nanju-user-stories'

/** 从场景标识提取用户故事 ID（feature 或 scenario 前缀匹配 US-xx） */
export function scenarioUserStory(scenario: { feature: string; scenario: string }): string | null {
  const m = /\bUS-(\d+)\b/i.exec(scenario.scenario) ?? /\bUS-(\d+)\b/i.exec(scenario.feature)
  return m ? `US-${String(Number(m[1])).padStart(2, '0')}` : null
}

/** 规则裁判：全场景通过 + 用户故事全覆盖 = pass（纯函数） */
export function judgeGwtResult(results: Array<Pick<GwtScenarioResult, 'feature' | 'scenario' | 'status'>>, userStories: string[]): GwtJudgement {
  let passed = 0
  let failed = 0
  let skipped = 0
  const covered = new Set<string>()
  for (const r of results) {
    if (r.status === 'pass') passed += 1
    else if (r.status === 'fail') failed += 1
    else skipped += 1
    if (r.status !== 'skip') {
      const us = scenarioUserStory(r)
      if (us) covered.add(us)
    }
  }
  const uncoveredUs = userStories.filter((us) => !covered.has(us))
  const verdict = failed === 0 && uncoveredUs.length === 0 && passed > 0 ? 'pass' : 'fail'
  return {
    verdict,
    scenariosTotal: results.length,
    passed,
    failed,
    skipped,
    coveredUs: [...covered],
    uncoveredUs,
  }
}

/** 机器可读报告（06_TESTS/report.json） */
export interface GwtReportJson {
  engineeringEvidence?: EngineeringEvidence
  blockedReason?: string
  /** 上一有效失败尚待一次修复重跑；blocked保留该事实，不增加轮次。 */
  retryPending?: boolean

  generatedAt: string
  verdict: 'pass' | 'fail' | 'error' | 'blocked'
  /**
   * 本次测试运行唯一标识（W18 Wave2，v0.17.83）：交付 ack 绑定用的运行事实。
   * 旧报告（v0.17.82 及以前）无此字段 → 交付门禁按旧版格式拦截。
   */
  runId?: string
  /**
   * 写盘时刻对 08_APP/index.html 实测指纹（W18 Wave2）：防「pass 后改应用仍拿旧报告交付」
   * 的陈旧错配。入口缺失（全 skip 降级路径）时缺省。注意：这不是 OS 沙箱——L2 有文件写
   * 权限可同时改入口与 report（含重算指纹），不宣称不可伪造。
   */
  entryFingerprint?: { sha256: string; size: number }
  /** 执行上下文声明（W18 Wave2）：file:// 直载（预览协议 token 门控/注入差异不在覆盖内） */
  executionContext?: 'file://' | 'project-driver'
  engineeringSuite?: EngineeringSuiteResult
  /** 覆盖口径外事项（W18 Wave2，SHOULD-3 收口）：机器不背书的三口径诚实声明 */
  coverageUnverified?: string[]
  /** 失败构成（回炉分流，v0.17.63 AC L-001）：behavior/mapping/coverage；pass 时为 null */
  failureKind: GwtFailureKind | null
  /** PRD 存在但未提取到 US-xx 清单（覆盖性基准缺失，fail-fast，v0.17.63 AC F-002） */
  prdUserStoriesMissing?: boolean
  /** verdict=error 时的异常原因（执行器抛异常但报告仍落盘，v0.17.63 AC Z-005） */
  errorReason?: string | null
  entry: string
  scenariosTotal: number
  passed: number
  failed: number
  skipped: number
  coveredUs: string[]
  uncoveredUs: string[]
  retryCount: number
  /** 执行异常独立计数（v0.17.64 #6，拆 Z-005 口径）：error 轮次累计，pass 轮清零；与 retryCount（非 pass 合计）并存。旧报告无此字段 */
  errorCount?: number
  /** 非阻塞警告汇总（W22 F4）：assert-screenshot baseline-created/diff 等，不影响 verdict；空数组省略 */
  warnings?: string[]
  /** P0-2（2026-09-18）：verdict=error 轮的驱动输出尾部与旁挂文件信息（无驱动环节的
   * error 轮缺省）。报告 md 嵌入尾部全文；errorReason 判定行内联 ≤1KB 自适应诊断摘要。 */
  driverIo?: {
    testId: string
    stdoutTail: string
    stderrTail: string
    logPath: string
  }
  scenarios: Array<{
    feature: string
    scenario: string
    status: GwtScenarioStatus
    reason: string | null
    failedStep: GwtScenarioResult['failedStep']
    /** 失败步骤的 selector 档位（W22 F3 回炉定位：data-ai-id/id/aria-label；非 fail 或无 selector 时缺省） */
    selectorTier?: GwtSelectorTier | null
    /** 失败步骤的失败归类（W22 报告归因字段：与 failedStep.category 同值，方便报告消费方直接读取） */
    failureCategory?: GwtFailedStep['category']
    screenshot: string | null
    durationMs: number
    /** 场景级非阻塞警告（W22 F4） */
    warnings?: string[]
  }>
}

// ===== W18 Wave2：交付事实字段（指纹实测 / schema 判定 / 门禁四道校验） =====

/** 覆盖口径外事项（报告 coverageUnverified 固定口径，SHOULD-3 收口） */
export const GWT_COVERAGE_UNVERIFIED: readonly string[] = [
  '预览协议 token 门控与 click-to-fix 注入不在 file:// 测试上下文覆盖内',
  '场景步骤与用户故事的语义等价由 L2 映射背书，机器只验证步骤执行结果',
  'PRD 未编号/未提及的需求不在覆盖性基准内',
]

/**
 * 入口文件指纹实测（纯函数，无副作用）：sha256 + 字节长度。文件缺失/读取异常返回 null
 * （报告侧缺省写 undefined；门禁侧按指纹不符拦截——入口被删也是「pass 后被修改」）。
 */
export function computeGwtEntryFingerprint(entryHtmlPath: string): { sha256: string; size: number } | null {
  try {
    if (!existsSync(entryHtmlPath)) return null
    const buf = readFileSync(entryHtmlPath)
    return { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.byteLength }
  } catch {
    return null
  }
}

/** 交付侧 schema 判定（纯函数）：runId/entryFingerprint/generatedAt 齐备（旧报告 false） */
export function hasGwtDeliverySchemaFields(report: {
  runId?: unknown
  entryFingerprint?: { sha256?: unknown; size?: unknown } | null
  generatedAt?: unknown
} | null | undefined): boolean {
  if (!report) return false
  return (
    typeof report.runId === 'string' && report.runId !== ''
    && typeof report.entryFingerprint?.sha256 === 'string' && report.entryFingerprint.sha256 !== ''
    && typeof report.entryFingerprint?.size === 'number'
    && typeof report.generatedAt === 'string' && report.generatedAt !== ''
  )
}

/** 门禁拦截归因（delivery.gate.blocked 埋点 reason 口径） */
export type GwtDeliveryBlockReason =
  | 'legacy-schema' | 'fingerprint-mismatch' | 'no-ack' | 'ack-run-mismatch' | 'ack-stale'
  // D8 A2′（R7-02）：auto on 交付门第二事实（main 实跑 provenance）两分支
  | 'no-main-run' | 'gwt-running' | 'engineering-evidence-missing' | 'engineering-changed'

export interface GwtDeliveryFactBlock {
  reason: GwtDeliveryBlockReason
  message: string
}

/**
 * G3a：宿主观察设备细化——进程内**按项目**记忆最近一次 GWT 轮次使用的值。
 *
 * 为什么需要它：协议层按 canonical **全等**比较 device，观察登记（host-observer）与交付门
 * 必须用同一份设备细化，否则交付期必然 `real-evidence-binding-mismatch`（结构性防线）。
 * 而交付门在**另一个时刻**被调用（用户声明交付时），调用方当时已拿不到验收轮次的入参，
 * 故把「本轮实际用过的细化」留在进程内，交付门读回同一份（单一来源，不允许两侧各拼一份）。
 *
 * 边界：只存宿主自己解析的设备字段（音源/加速器/靶应用/端点），不含密钥；
 * 重启即空（与 real-gate registry 同生命周期：hostRunId 变则旧登记本就失效）；
 * 新一轮不给细化即清空（不让上一轮的设备漏进新轮的交付门）；显式入参优先于记忆值。
 */
const engineeringDeviceDetailByProject = new Map<string, NonNullable<EngineeringRealEvidenceScope['deviceDetail']>>()

/** 记录本轮 GWT 使用的设备细化（`undefined`/空对象 = 清空记忆）。 */
export function recordEngineeringDeviceDetail(
  projectId: string,
  detail?: EngineeringRealEvidenceScope['deviceDetail'],
): void {
  if (!projectId) return
  if (!detail || Object.keys(detail).length === 0) {
    engineeringDeviceDetailByProject.delete(projectId)
    return
  }
  engineeringDeviceDetailByProject.set(projectId, { ...detail })
}

/** 读取本进程记录的设备细化（交付门 / 观察期共用；无则 undefined）。 */
export function peekEngineeringDeviceDetail(
  projectId: string,
): EngineeringRealEvidenceScope['deviceDetail'] | undefined {
  const detail = engineeringDeviceDetailByProject.get(projectId)
  return detail ? { ...detail } : undefined
}

/** 仅供测试：清空设备细化记忆（生产代码不得调用）。 */
export function __resetEngineeringDeviceDetailForTests(): void {
  engineeringDeviceDetailByProject.clear()
}

/**
 * 交付四道事实校验（W18 Wave2，工单 §1.3）：verdict=pass 之后追加——
 * a. 旧 schema（缺 runId/entryFingerprint/generatedAt）→ 旧版格式不可用，指引重跑；
 * b. entryFingerprint 与当前 08_APP/index.html 实测不符 → pass 后被修改，指引重跑；
 * c. ProjectInfo 无 deliveryAck → 指引 AskUserQuestion 发起交付验收；
 * d. ack.reportRunId ≠ report.runId → 确认对应运行已被替代，指引重新验收；
 *    冗余防御：ack.at ≤ report.generatedAt（同 runId 内）→ 确认已过期。
 * 拦截时记 delivery.gate.blocked 埋点（reason 归因；埋点失败不阻断门禁）。
 * 返回 null = 四道全过（放行交付）。
 */
export function checkGwtDeliveryFacts(input: {
  workspaceSlug: string
  projectId: string
  reportJsonPath: string
  projectDir: string
  info: Pick<NanjuProjectInfoFile, 'deliveryAck'> | null
  /** W-I B-f：工程真实能力证据门禁需要会话上下文（缺省时不放行 requiresReal 交付）。 */
  sessionId?: string
  /**
   * G3a：宿主观察设备细化（音源 / 加速器 / 靶应用 / 端点）。
   * 缺省取本进程最近一次 GWT 轮次记录的同一份细化（见 `engineeringDeviceDetailByProject`）；
   * 两侧不一致必然 `real-evidence-binding-mismatch`，故调用方**不要**自行拼一份近似值。
   */
  deviceDetail?: EngineeringRealEvidenceScope['deviceDetail']
}): GwtDeliveryFactBlock | null {
  let report: (Parameters<typeof hasGwtDeliverySchemaFields>[0] & {
    runId?: string
    entryFingerprint?: { sha256: string; size: number }
    generatedAt?: string
    engineeringEvidence?: EngineeringEvidence
    engineeringSuite?: EngineeringSuiteResult
    entry?: string
  }) | null
  try {
    report = JSON.parse(readFileSync(input.reportJsonPath, 'utf-8'))
  } catch {
    report = null
  }
  const block = (reason: GwtDeliveryBlockReason, message: string): GwtDeliveryFactBlock => {
    try {
      recordTelemetry(input.workspaceSlug, 'delivery.gate.blocked', {
        project_id: input.projectId,
        reason,
      }, input.projectId)
    } catch { /* 埋点失败不阻断门禁 */ }
    return { reason, message }
  }
  const hasEngineering = existsSync(join(input.projectDir, ENGINEERING_CONTRACT_PATH)) || requiresEngineeringContract(input.projectDir)
  let engineeringEntry: string | null = null
  if (hasEngineering) {
    const captured = captureEngineeringEvidence(input.projectDir)
    if (!captured.evidence || !report?.engineeringEvidence) {
      return block('engineering-evidence-missing', '缺少完整工程验收绑定：' + (captured.problems.join('；') || '请重新执行工程测试'))
    }
    const parsed = parseEngineeringContract(readFileSync(join(input.projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8')).contract
    if (!parsed) return block('engineering-evidence-missing', '工程契约不可用，请补全后重跑')
    const expectedEntry = '08_APP/' + parsed.target.entry
    if (captured.evidence.digest !== report.engineeringEvidence.digest || report.entry !== expectedEntry) {
      return block('engineering-changed', 'PRD、工程契约、测试对象或产物在通过后发生变化，请重跑验收。')
    }
    if (report.engineeringSuite) {
      if (report.engineeringSuite.verdict !== 'pass'
        || report.engineeringSuite.tests.length !== parsed.tests.length
        || parsed.tests.some((test) => !report!.engineeringSuite!.tests.some((result) => result.testId === test.id && result.target === test.target && result.status === 'pass' && result.evidenceDigest === captured.evidence!.digest))) {
        return block('engineering-evidence-missing', '工程测试或真实能力证据尚不完整，不能只凭项目驱动记录交付。')
      }
      // W-I B-f：`requiresReal` 从「一律硬拦」改为**逐项**走真实能力证据门禁。
      // 交付提交路径 = validate + consume（同一同步块，函数内无 await；前后不得插 await 写盘/发事件）。
      // 本波无真实 host-observer 登记 → 必为 requires-real-unattested，交付保持拒绝（能力未就绪，不是忘了接线）。
      const realTests = parsed.tests.filter((test) => test.requiresReal)
      if (realTests.length > 0) {
        if (!input.sessionId) {
          return block('engineering-evidence-missing', '缺少工程验收会话上下文，无法核验真实能力证据（不放行）。')
        }
        const gateScope = {
          workspaceSlug: input.workspaceSlug,
          projectId: input.projectId,
          sessionId: input.sessionId,
          projectDir: input.projectDir,
          // G3a：设备细化必须与观察登记同一份（缺省回落到本进程记录的轮次值）
          deviceDetail: input.deviceDetail ?? peekEngineeringDeviceDetail(input.projectId),
        }
        const gateTargets = realTests.map((test) => ({ testId: test.id, target: test.target, covers: test.covers }))
        const consumed = commitDeliveryRealEvidence(gateScope, gateTargets)
        if (consumed.rejection) {
          return block('engineering-evidence-missing',
            '真实能力证据未齐备，不能交付：' + consumed.rejection.message
            + '（测试项 ' + (consumed.rejection.testId ?? realTests[0]!.id) + '）')
        }
      }
    } else {
      const preflight = prepareEngineeringBrowserRun(input.projectDir)
      if (preflight.mode !== 'engineering-browser') return block('engineering-evidence-missing', '缺少可用的工程验收绑定：' + preflight.reason)
    }
    const provenance = report.runId ? lastGwtRunIds.get(input.projectId)?.get(report.runId) : null
    if (!provenance || provenance.verdict !== 'pass' || provenance.engineeringDigest !== captured.evidence.digest) {
      return block('no-main-run', '工程测试结果未经当前宿主实跑登记，请重跑验收。')
    }
    if (isGwtRunInProgress(input.projectId)) return block('gwt-running', '工程验收仍在运行，请等待本轮完成。')
    engineeringEntry = expectedEntry
  }
  // a. 旧版 schema
  if (!hasGwtDeliverySchemaFields(report)) {
    return block('legacy-schema',
      '测试报告为旧版格式（缺少运行标识/入口指纹），不可用于交付。请重跑测试（声明 <!-- PHASE_ADVANCE: testing -->）后重新交付验收。')
  }
  // schema 判定通过 → 收窄为非空新 schema 报告（后续四道校验基于此）
  const valid = report as NonNullable<Parameters<typeof hasGwtDeliverySchemaFields>[0]> & {
    runId: string
    entryFingerprint: { sha256: string; size: number }
    generatedAt: string
  }
  // b. 入口指纹（pass 后改应用）
  const currentFingerprint = computeGwtEntryFingerprint(join(input.projectDir, engineeringEntry ?? '08_APP/index.html'))
  if (!currentFingerprint
    || currentFingerprint.sha256 !== valid.entryFingerprint.sha256
    || currentFingerprint.size !== valid.entryFingerprint.size) {
    return block('fingerprint-mismatch',
      '应用在测试通过后被修改（08_APP/index.html 与测试报告记录的入口指纹不一致）。请重跑测试（声明 <!-- PHASE_ADVANCE: testing -->）后重新交付验收。')
  }
  // ── D8 A2′（R7-02）+ F1-1（§十方案 B）：auto on 项目的交付第二事实分叉 ──
  // 「用户满意交付确认」（W18 c/d）整体替换为 main 内存机器事实：report.runId∈
  // lastGwtRunIds 登记集 ∧ 登记轮 verdict==='pass' ∧ 登记指纹===当前入口实测
  // （不信任 report 文件自述）∧ GWT 当前不在运行中。注意：delivered 推进走
  // isDeliverFromTesting 特判（不经推进门第四形态）——testing 阶段的产出质量由本门
  // 上游的 GWT 裁判（verdict/schema/指纹校验）保证，第四形态不参与交付路径。
  // auto off（enabled≠true）路径逐字节保留 W18 c/d（D7 ack 机制不删）。
  if (!hasEngineering && isAutoConfirmDeliveryProject(input.workspaceSlug, input.projectId)) {
    if (!isGwtRunInProgress(input.projectId)) {
      // c'. main 实跑 provenance（§十方案 B）：runId∈登记集 ∧ 登记轮 verdict==='pass'
      // ∧ 登记指纹===当前入口实测——verdict 与指纹均以 main 内存登记为准，不读 report
      // 文件自述（fail 轮 runId 被改写成 pass 报告、或 pass 后文件被改，均拒）
      const record = lastGwtRunIds.get(input.projectId)?.get(valid.runId)
      if (!record) {
        return block('no-main-run',
          '测试报告不是本进程 GWT 实跑产物（runId 未经系统登记——伪造或外部写入不可用于自动交付）。'
          + '请声明 <!-- PHASE_ADVANCE: testing --> 触发系统自动验收测试，全部通过后系统自动交付。')
      }
      if (record.verdict !== 'pass') {
        return block('no-main-run',
          `测试报告对应的系统登记运行轮次结论为 ${record.verdict}（非 pass）——改写报告文件不改变系统登记事实。`
          + '请声明 <!-- PHASE_ADVANCE: testing --> 重跑自动验收测试，全部通过后系统自动交付。')
      }
      // d''. 登记指纹 vs 当前实测（文件自述可伪造，登记值不可）——与 b 道独立：
      // b 查 report 自述 vs 实测，d'' 查登记 vs 实测（同步改写文件两字段时 b 过 d'' 拦）
      const provenanceFingerprint = computeGwtEntryFingerprint(join(input.projectDir, engineeringEntry ?? '08_APP/index.html'))
      if (!provenanceFingerprint
        || provenanceFingerprint.sha256 !== record.fingerprintSha
        || provenanceFingerprint.size !== record.size) {
        return block('fingerprint-mismatch',
          '应用在登记的通过轮次之后被修改（当前入口指纹与系统登记的通过轮指纹不一致）。'
          + '请声明 <!-- PHASE_ADVANCE: testing --> 重跑自动验收测试后系统自动交付。')
      }
      return null
    }
    return block('gwt-running',
      '验收测试正在运行中，当前报告为上一轮产物。请等待本轮测试完成后系统自动交付。')
  }
  // c. 无交付确认（auto off：W18 原文）
  const ack = input.info?.deliveryAck
  if (!ack) {
    return block('no-ack',
      '尚未记录到用户满意交付确认。请先用 AskUserQuestion 发起交付验收（options 含「满意交付」），用户确认满意交付后再输出 delivered 标记。')
  }
  // d. 确认与运行不匹配（新报告替代旧确认）
  if (ack.reportRunId !== valid.runId) {
    return block('ack-run-mismatch',
      '交付确认对应的测试运行已被替代（确认绑定的运行与当前报告不一致）。请重新发起交付验收。')
  }
  // d'. 冗余防御：同 runId 内确认早于报告生成（时钟错乱/手工注入 ack）
  if (!(Date.parse(ack.at) > Date.parse(valid.generatedAt))) {
    return block('ack-stale',
      '交付确认已过期（确认时间不晚于报告生成时间）。请重新发起交付验收。')
  }
  return null
}

// ===== D8 A2′（R7-02）：main 实跑 provenance（进程内存，重启即空=安全缺省） =====

/** 本进程 GWT 实跑落盘登记的 runId（按项目累积；auto on 交付门 c' 消费） */
/**
 * D8 F1-1（§十方案 B）：main 实跑 provenance 登记——runId → 落盘轮次的 main 内存事实
 * （verdict + 入口指纹 sha/size + generatedAt）。指纹取 GWT 运行时实测（report 内存
 * 对象构造值），**不信任 report.json 文件自述**（L2 可改写文件，改不了本登记）。
 */
const lastGwtRunIds = new Map<string, Map<string, { verdict: string; fingerprintSha: string; size: number; generatedAt: string; engineeringDigest?: string }>>()

/** GWT 运行中项目（runNanjuGwtAcceptance 入口登记/finally 清除；auto on 交付门 d' 消费） */
const runningGwtProjectIds = new Set<string>()

/** 判定项目是否 auto on 交付适用（enabled ∧ quick ∧ testing——A1′ 前三条件在交付门的投影）。
 *  D8 F2-3：导出供 orchestrator 交付续接消息分发（resolveGwtDeliveryResumeMessage）消费 */
export function isAutoConfirmDeliveryProject(workspaceSlug: string, projectId: string): boolean {
  try {
    const { getNanjuProject } = require('./nanju-project') as typeof import('./nanju-project')
    const project = getNanjuProject(workspaceSlug, projectId)
    return project?.autoClarify?.enabled === true && project?.mode === 'quick' && project?.currentStage === 'testing'
      && !existsSync(join(getNanjuProjectDir(workspaceSlug, projectId), ENGINEERING_CONTRACT_PATH))
      && !requiresEngineeringContract(getNanjuProjectDir(workspaceSlug, projectId))
  } catch {
    return false
  }
}

/** GWT 是否运行中（projectId 维度） */
export function isGwtRunInProgress(projectId: string): boolean {
  return runningGwtProjectIds.has(projectId)
}

/** 登记一次 main 实跑（report 落盘点调用，facts=main 内存实测值；进程内存，重启即空） */
export function recordMainGwtRun(
  projectId: string,
  runId: string,
  facts: { verdict: string; fingerprintSha: string; size: number; generatedAt: string; engineeringDigest?: string },
): void {
  let map = lastGwtRunIds.get(projectId)
  if (!map) {
    map = new Map<string, { verdict: string; fingerprintSha: string; size: number; generatedAt: string; engineeringDigest?: string }>()
    lastGwtRunIds.set(projectId, map)
  }
  map.set(runId, facts)
}

/** 测试专用：清空 provenance 状态（防跨用例污染） */
export function __resetGwtProvenanceForTests(): void {
  lastGwtRunIds.clear()
  runningGwtProjectIds.clear()
}

/** 人读报告（06_TESTS/report-YYYYMMDD-HHmmss.md） */
export function buildReportMarkdown(report: GwtReportJson, projectName: string): string {
  const lines: string[] = []
  lines.push(`# 验收测试报告 — ${projectName}`)
  lines.push('')
  lines.push(`- 生成时间：${report.generatedAt}`)
  lines.push(`- 测试入口：\`${report.entry}\``)
  // 判定结果文案（AC U-001）：error/覆盖不全单独句式，不出现「0 个失败」与「未通过」并列的自相矛盾
  const verdictLabel = report.verdict === 'pass'
    ? '✅ 全部通过'
    : report.verdict === 'blocked'
      ? `⏸ 验收阻塞（${report.blockedReason ?? '所需执行能力不可用'}）`
    : report.verdict === 'error'
      ? `⚠️ 执行异常${report.errorReason ? `（${report.errorReason}）` : ''}`
      : report.failed === 0
        ? '❌ 未通过（覆盖不全：有用户故事无可执行场景）'
        : '❌ 未通过'
  lines.push(`- 判定结果：${verdictLabel}`)
  // P0-2：error 轮嵌入驱动输出尾部全文（截断管道后）+ 旁挂文件路径注明——回归 A 报告
  // P0 建议「stderr 尾部进验收报告」原意；dev 实例判定面板经 errorReason 内联摘要
  // 直接可见，此处全文随项目归档供回炉修复定位。
  if (report.verdict === 'error' && report.driverIo) {
    lines.push(`- 驱动输出旁挂：\`${report.driverIo.logPath}\`（testId：${report.driverIo.testId}）`)
    lines.push('')
    // AC 审计 Y-04：尾部内容中的 3+ 连续反引号压为 2 个，防提前闭合 ```text fence
    const fenceSafe = (text: string): string => text.replace(/`{3,}/g, '``')
    lines.push('### 驱动输出尾部（stderr）')
    lines.push('```text')
    lines.push(report.driverIo.stderrTail.length > 0 ? fenceSafe(report.driverIo.stderrTail) : '（空）')
    lines.push('```')
    lines.push('### 驱动输出尾部（stdout）')
    lines.push('```text')
    lines.push(report.driverIo.stdoutTail.length > 0 ? fenceSafe(report.driverIo.stdoutTail) : '（空）')
    lines.push('```')
  }
  lines.push(`- 场景统计：共 ${report.scenariosTotal} 个，通过 ${report.passed}，失败 ${report.failed}，跳过 ${report.skipped}`)
  lines.push(`- 用户故事覆盖：${report.coveredUs.length > 0 ? report.coveredUs.join('、') : '无'}${report.uncoveredUs.length > 0 ? `（未覆盖：${report.uncoveredUs.join('、')}）` : ''}`)
  if (report.prdUserStoriesMissing) lines.push('- ⚠ PRD 未提取到 US-xx 用户故事清单，覆盖性无法判定（请补充 PRD 后重跑）')
  lines.push(`- 重试轮次：${report.retryCount}`)
  if (report.engineeringSuite) {
    lines.push('## 工程驱动记录')
    for (const note of report.coverageUnverified ?? []) lines.push('- 证据边界：' + note)
    for (const test of report.engineeringSuite.tests) {
      lines.push(`- ${test.testId} → ${test.target}：${test.status}`)
      for (const check of test.checks) lines.push(`  - ${check.storyId ?? '辅助测试'} ${check.label}：期望「${check.expected}」/ 实际「${check.actual}」；证据：${check.evidence.join('；')}`)
    }
  }
  if (report.warnings && report.warnings.length > 0) {
    lines.push('- ⚠ 视觉观察项（不影响判定）：')
    report.warnings.forEach((w) => lines.push(`  - ${w.replace(/\|/g, '\\|')}`))
  }
  lines.push('')
  lines.push('## 场景明细')
  lines.push('')
  lines.push('| # | 场景 | 结果 | 说明 |')
  lines.push('| --- | --- | --- | --- |')
  report.scenarios.forEach((s, i) => {
    const icon = s.status === 'pass' ? '✅' : s.status === 'fail' ? '❌' : '⏭️'
    let note = s.reason ?? ''
    if (s.status === 'fail' && s.failedStep) {
      const fs = s.failedStep
      note = `步骤 ${fs.index + 1}（${fs.kind}：${fs.text}）期望「${fs.expected}」实际「${fs.actual}」`
      if (s.screenshot) note += `，截图 ${s.screenshot}`
    }
    lines.push(`| ${i + 1} | ${s.feature} / ${s.scenario} | ${icon} ${s.status} | ${note.replace(/\|/g, '\\|')} |`)
  })
  lines.push('')
  return lines.join('\n')
}

/** 自然语言摘要（注入 assistant 消息 / 进度卡片共用口径） */
export function buildSummaryText(judgement: GwtJudgement, reportPath: string): string {
  if (judgement.verdict === 'pass') {
    return `✅ 我们测试了 ${judgement.scenariosTotal} 个场景，全部通过（覆盖 ${judgement.coveredUs.length} 条用户故事）。测试报告：${reportPath}`
  }
  // 纯覆盖性失败（AC U-001）：单独句式，不输出「0 个失败」与「未通过」并列的自相矛盾
  if (judgement.failed === 0) {
    const parts: string[] = []
    parts.push(`❌ 验收未通过（覆盖不全）：${judgement.scenariosTotal} 个场景全部执行成功，但用户故事 ${judgement.uncoveredUs.join('、')} 没有可执行场景`)
    if (judgement.skipped > 0) parts.push(`${judgement.skipped} 个场景跳过`)
    parts.push(`测试报告：${reportPath}`)
    return parts.join('；')
  }
  const parts: string[] = []
  parts.push(`❌ 验收测试未通过：${judgement.scenariosTotal} 个场景中 ${judgement.failed} 个失败`)
  if (judgement.skipped > 0) parts.push(`${judgement.skipped} 个跳过`)
  if (judgement.uncoveredUs.length > 0) parts.push(`用户故事 ${judgement.uncoveredUs.join('、')} 无可执行场景`)
  parts.push(`测试报告：${reportPath}`)
  return parts.join('；')
}

// ===== 浏览器适配器（单测 mock 注入；生产实现为 browser-controller GWT 原语） =====

export interface GwtBrowserAdapter {
  /** 生产受管浏览器保留全局风险告知；隔离fixture可不提供。 */
  hasRiskDisclaimerAcknowledged?(): boolean
  createLocalFileTab(sessionId: string, filePath: string): Promise<{ tabId: string; previousActiveTabId?: string | null }>
  loadFileInTab(sessionId: string, tabId: string, filePath: string): Promise<void>
  evaluateInTab(sessionId: string, tabId: string, expression: string, signal?: AbortSignal): Promise<unknown>
  clickPointInTab(sessionId: string, tabId: string, x: number, y: number, signal?: AbortSignal): Promise<void>
  pressKeyInTab(sessionId: string, tabId: string, key: string, signal?: AbortSignal): Promise<void>
  /** W22 F1：CDP Input.insertText 文本直入（真实编辑管线，isTrusted=true，React/Vue 原生兼容） */
  insertTextInTab(sessionId: string, tabId: string, text: string, signal?: AbortSignal): Promise<void>
  /** W22 F2：真实悬停（mouseMoved 微抖动 + 停留 300ms） */
  hoverPointInTab(sessionId: string, tabId: string, x: number, y: number, signal?: AbortSignal): Promise<void>
  /** W22 F2：CDP mouseWheel 滚动（失败上抛由调用方走 JS scrollBy 回退） */
  wheelInTab(sessionId: string, tabId: string, deltaX: number, deltaY: number, signal?: AbortSignal): Promise<void>
  /** W22 F4：CDP Page.captureScreenshot 视口截图（含逻辑视口尺寸/DPR 元数据） */
  captureViewportPngInTab(sessionId: string, tabId: string, signal?: AbortSignal): Promise<{ base64: string; width: number; height: number; dpr: number }>
  screenshot(sessionId: string, tabId: string, signal?: AbortSignal): Promise<{ base64: string }>
  closeTab(sessionId: string, tabId: string): Promise<unknown>
  /** 测试结束后恢复用户原活动标签（v0.17.63 AC Z-004；可选实现，未实现时保持现状） */
  restoreDisplayTab?(sessionId: string, tabId: string): void
  /** W-C browser-url：打开专用 URL tab（仅宿主持有的 loopback 工程服务地址）。 */
  createUrlTab?(sessionId: string, url: string): Promise<{ tabId: string; url: string; previousActiveTabId?: string | null }>
  /** W-C browser-url：每场景重载专用 tab 到指定 URL（场景隔离，不复用 file 直载）。 */
  loadUrlInTab?(sessionId: string, tabId: string, url: string): Promise<void>
  /** W-C browser-url：校验测试 tab 实际 URL 仍在宿主持有 origin；出 origin 关闭并抛错（S9）。 */
  assertUrlTabOrigin?(sessionId: string, tabId: string): Promise<void>
}

// ===== 执行器 =====

const DEFAULT_ASSERT_TIMEOUT_MS = 4_000
const DEFAULT_WAIT_SELECTOR_TIMEOUT_MS = 8_000
/** W22 F2：check/uncheck 点击后勾选态回读轮询窗口（真实点击后状态更新有时延） */
const DEFAULT_CHECK_CONFIRM_TIMEOUT_MS = 2_000
const POLL_INTERVAL_MS = 250
/** 每步执行后的 settle 延时（等异步渲染稳定） */
const STEP_SETTLE_MS = 150

/** 进度事件（IPC nanju:gwt-progress 载荷同型） */
export type { NanjuGwtProgressEvent as GwtProgressEvent } from '@proma/shared'
import type { NanjuGwtProgressEvent as GwtProgressEvent } from '@proma/shared'

export interface GwtSuiteOptions {
  sessionId: string
  /** file:// 入口（与 entryUrl 二选一）；browser-file 通道使用。 */
  entryHtmlPath?: string
  /** served URL 入口（与 entryHtmlPath 二选一）；browser-url 通道使用。 */
  entryUrl?: string
  scenarios: GwtScenarioFile[]
  controller: GwtBrowserAdapter
  screenshotDir: string | null
  /** W22 F4：assert-screenshot 基线目录（06_TESTS/_screenshots/；null 时该 op 降级为 warning） */
  baselineDir?: string | null
  onProgress?: (event: GwtProgressEvent) => void
  signal?: AbortSignal
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** JSON 序列化注入（页面模板参数；\u2028/\u2029 转义防 JS 语法破坏） */
function pagePayload(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** selector 元素中心坐标（e2e-v59 center_of 同型；找不到返回 null；二档 selector 不唯一返回 { ambiguous } 快速失败） */
const CENTER_OF_EXPRESSION = (ref: GwtSelectorRef) => {
  const find = selectorFindFragment(ref)
  const uniqueCheck = selectorNeedsUniqueCheck(ref)
    ? `if (els.length !== 1) return { ambiguous: true, count: els.length }; `
    : ''
  return `(() => { const els = ${find}; if (els.length === 0) return null; ${uniqueCheck}` +
    `const el = els[0]; el.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); ` +
    `return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
}

/** 断言轮询模板：每轮求值一次，返回 { ok, actual }（二档 selector 命中非唯一时快速失败归因） */
const ASSERT_EXPRESSION = (ref: GwtSelectorRef, op: GwtStepOp) => {
  const kind = op.type === 'assert-text' ? 'text' : op.type === 'assert-visible' ? 'visible' : op.type === 'assert-count' ? 'count' : 'selector'
  const expect = op.type === 'assert-text' ? op.contains : op.type === 'assert-count' ? op.count : null
  const uniqueCheck = selectorNeedsUniqueCheck(ref)
    ? `if (els.length !== 1) return { ok: false, actual: '选择器命中 ' + els.length + ' 个元素（不唯一，禁止取首个）' }; `
    : ''
  return `(() => { const els = ${selectorFindFragment(ref)}; ` +
    `if (els.length === 0) return { ok: false, actual: '元素不存在' }; ${uniqueCheck}` +
    `if (${pagePayload(kind)} === 'selector') return { ok: true, actual: '元素存在' }; ` +
    `if (${pagePayload(kind)} === 'visible') { const el = els[0]; const visible = !!(el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)); ` +
    `return { ok: visible, actual: visible ? '元素可见' : '元素不可见' }; } ` +
    `if (${pagePayload(kind)} === 'count') { const n = els.length; return { ok: n === ${pagePayload(expect)}, actual: '数量 ' + n }; } ` +
    `const el = els[0]; const text = (el && (el.innerText || el.textContent)) || ''; const contains = text.includes(${pagePayload(expect)}); ` +
    `return { ok: contains, actual: JSON.stringify(text).slice(0, 120) }; })()`
}

/** W22 F1 fill 第 1 步：聚焦 + 全选（为 insertText 覆盖做准备；禁 native-setter 清空——避免 DOM值≠state 窗口导致追加） */
const FILL_FOCUS_SELECT_EXPRESSION = (ref: GwtSelectorRef) =>
  `(() => { const els = ${selectorFindFragment(ref)}; if (els.length === 0) return { code: 'missing' }; ` +
  (selectorNeedsUniqueCheck(ref) ? `if (els.length !== 1) return { code: 'ambiguous', count: els.length }; ` : '') +
  `const el = els[0]; ` +
  `if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return { code: 'not-editable' }; ` +
  `el.scrollIntoView({ block: 'center', inline: 'nearest' }); el.focus({ preventScroll: true }); ` +
  `if (document.activeElement !== el && !(el.contains && el.contains(document.activeElement))) return { code: 'focus-failed' }; ` +
  `if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.select(); return { code: 'ok', kind: 'value' }; } ` +
  `const range = document.createRange(); range.selectNodeContents(el); ` +
  `const selection = window.getSelection(); if (selection) { selection.removeAllRanges(); selection.addRange(range); } ` +
  `return { code: 'ok', kind: 'contenteditable' }; })()`

/** W22 F1 fill 第 3 步：回读当前值（input/textarea 读 value；contenteditable 读 textContent） */
const FILL_READ_VALUE_EXPRESSION = (ref: GwtSelectorRef) =>
  `(() => { const els = ${selectorFindFragment(ref)}; if (els.length === 0) return { value: null }; const el = els[0]; ` +
  `if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return { value: el.value }; ` +
  `return { value: el.textContent ?? '' }; })()`

/**
 * W22 F1 fill 回退链（单次重试）：native value setter + input/change 事件派发
 * （旧 FILL_EXPRESSION 同型语义——setter 绕过 tracker 后合成事件能触发 React onChange，
 * 与 React state 一致；仅作 insertText 主通道失败后的兑底，不再作为主通道）。
 */
const FILL_FALLBACK_EXPRESSION = (ref: GwtSelectorRef, text: string) =>
  `(() => { const els = ${selectorFindFragment(ref)}; if (els.length === 0) return { ok: false, error: '未找到元素' }; const el = els[0]; ` +
  `if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return { ok: false, error: '目标不是可编辑元素' }; ` +
  `el.scrollIntoView({ block: 'center', inline: 'nearest' }); el.focus({ preventScroll: true }); ` +
  `if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { ` +
  `const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype; ` +
  `const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (setter) setter.call(el, ${pagePayload(text)}); else el.value = ${pagePayload(text)}; } ` +
  `else { el.textContent = ${pagePayload(text)}; } ` +
  `try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${pagePayload(text)} })); } ` +
  `catch { el.dispatchEvent(new Event('input', { bubbles: true })); } ` +
  `el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`

/** W22 F2 check/uncheck：读 checkbox/radio 勾选态（非可勾选元素明确报错） */
const CHECK_STATE_EXPRESSION = (ref: GwtSelectorRef) =>
  `(() => { const els = ${selectorFindFragment(ref)}; if (els.length === 0) return { code: 'missing' }; ` +
  (selectorNeedsUniqueCheck(ref) ? `if (els.length !== 1) return { code: 'ambiguous', count: els.length }; ` : '') +
  `const el = els[0]; ` +
  `if (!(el instanceof HTMLInputElement) || (el.type !== 'checkbox' && el.type !== 'radio')) ` +
  `return { code: 'not-checkable' }; ` +
  `return { code: 'ok', checked: el.checked, type: el.type }; })()`

/** W22 F2 select：限原生 <select>——native setter 选 option + 派发 change + 回读校验（非原生给出 click 序列指引） */
const SELECT_EXPRESSION = (ref: GwtSelectorRef, value: string) =>
  `(() => { const els = ${selectorFindFragment(ref)}; if (els.length === 0) return { code: 'missing' }; ` +
  (selectorNeedsUniqueCheck(ref) ? `if (els.length !== 1) return { code: 'ambiguous', count: els.length }; ` : '') +
  `const el = els[0]; ` +
  `if (!(el instanceof HTMLSelectElement)) return { code: 'not-native-select', error: '目标不是原生 <select>（自定义下拉请改用 click 序列：先 click 展开，再 click 选项）' }; ` +
  `if (el.multiple || el.size > 1) return { code: 'unsupported-select', error: '暂不支持 multiple / size>1 的 select，请拆分场景或改用其他断言' }; ` +
  `const options = Array.from(el.options); ` +
  `const opt = options.find(o => o.value === ${pagePayload(value)}) || options.find(o => (o.label || o.textContent || '') === ${pagePayload(value)}); ` +
  `if (!opt) return { code: 'option-missing', error: '未找到匹配 option（按 value 与 label 均未命中）' }; ` +
  `const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set; ` +
  `if (setter) setter.call(el, opt.value); else el.value = opt.value; ` +
  `el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); ` +
  `return { code: 'ok', value: el.value }; })()`

/** W22 F2 focus：scrollIntoView + focus + activeElement 回读断言 */
const FOCUS_EXPRESSION = (ref: GwtSelectorRef) =>
  `(() => { const els = ${selectorFindFragment(ref)}; if (els.length === 0) return { code: 'missing' }; ` +
  (selectorNeedsUniqueCheck(ref) ? `if (els.length !== 1) return { code: 'ambiguous', count: els.length }; ` : '') +
  `const el = els[0]; ` +
  `el.scrollIntoView({ block: 'center', inline: 'nearest' }); el.focus({ preventScroll: true }); ` +
  `if (document.activeElement !== el && !(el.contains && el.contains(document.activeElement))) return { code: 'focus-failed' }; ` +
  `return { code: 'ok' }; })()`

/** W22 F2 scroll：JS 回退通道（wheel 失败后），真实触发 scroll 事件/IntersectionObserver */
const JS_SCROLL_EXPRESSION = (deltaY: number) =>
  `(() => { window.scrollBy(0, ${pagePayload(deltaY)}); return { ok: true }; })()`

/** 执行单个场景；controller 异常上抛由调用方兜底为 fail */
async function executeScenario(
  options: GwtSuiteOptions,
  tabId: string,
  scenario: GwtScenarioFile,
): Promise<GwtScenarioResult> {
  const startedAt = Date.now()
  const { controller, sessionId, entryHtmlPath, entryUrl } = options
  /** 场景级非阻塞警告（W22 F4：assert-screenshot 等 warning-only op 产出） */
  const stepWarnings: string[] = []
  const base: Omit<GwtScenarioResult, 'status' | 'reason'> = {
    feature: scenario.feature,
    scenario: scenario.scenario,
    failedStep: null,
    screenshot: null,
    durationMs: 0,
  }

  // 场景级 skip（L2 主动声明 / schema 校验后置标）：透明跳过，不执行半截
  if (scenario.skip || scenario.skipReason) {
    return {
      ...base,
      status: 'skip',
      reason: scenario.skipReason ?? '场景声明跳过',
      durationMs: 0,
    }
  }

  // 场景隔离：每个场景重新载入（file 直载或 URL 重载，二选一），同代码同结果、重试公平。
  // v0.17.63（AC Z-001）：存储清理下沉到 BrowserController.loadFileInTab（重载前清
  // localStorage/sessionStorage，消除上一场景写入数据的串扰；indexedDB 清理归 Sprint C）。
  // N1：URL 重载出 origin（或标签缺失）不整轮 error，映射为该场景 fail（产品行为失败），
  // 后续场景仍可重载回登记入口继续，本轮结束由 runGwtSuite 统一关标签。
  if (entryUrl) {
    try {
      await controller.loadUrlInTab!(sessionId, tabId, entryUrl)
    } catch (e) {
      if (options.signal?.aborted) throw new EngineeringExecutionBlocked('浏览器测试已取消')
      return {
        ...base,
        status: 'fail',
        reason: `场景页面载入失败：${e instanceof Error ? e.message : String(e)}`,
        failedStep: { index: 0, kind: 'given', text: '场景页面载入', expected: '载入本 session 登记的工程服务入口', actual: String(e instanceof Error ? e.message : e).slice(0, 200), category: 'channel' },
        screenshot: null,
        durationMs: Date.now() - startedAt,
      }
    }
  } else {
    await controller.loadFileInTab(sessionId, tabId, entryHtmlPath!)
  }
  await sleep(300)

  // 逐步执行（v0.17.63 预检重构，AC Z-002/Z-003：不再做「初始 DOM 存在性」预检——
  // 2s 初始窗口对动态 UI（先点开弹屏/二级页再操作其中元素）是系统性误杀；
  // 改为 click/fill 执行期 8s 轮询等待目标出现，等不到才判 fail「等待超时未出现」。
  // 保留「不执行半截」语义：目标始终未出现时该步 fail，不动后续步骤。）
  for (let i = 0; i < scenario.steps.length; i++) {
    if (options.signal?.aborted) throw new EngineeringExecutionBlocked('浏览器测试已取消')
    const step = scenario.steps[i]!
    const op = step.op
    if (!op) {
      // unmapped 步骤（schema 已要求显式声明）：场景半截执行到此，判 fail 不可续
      // ——正常情况下生成侧应在场景级标 skip；这里兜底 fail 透明化（映射类）。
      return {
        ...base,
        status: 'fail',
        reason: `步骤 ${i + 1} 未映射（unmapped）但场景未声明 skip`,
        failedStep: { index: i, kind: step.kind, text: step.text, expected: '可执行步骤', actual: 'op=null', category: 'unmapped' },
        durationMs: Date.now() - startedAt,
      }
    }

    try {
      if (op.type === 'click' || op.type === 'hover') {
        const ref = normalizeGwtSelector(op.selector ?? '')
        if (!ref) throw new GwtStepError(i, step, 'selector 语法合法（四档形态）', op.selector ?? '', 'selector-wait', null)
        const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS
        const point = await waitForClickable(controller, sessionId, tabId, ref, timeoutMs)
        if (point === 'ambiguous') {
          throw new GwtStepError(i, step, '选择器命中唯一元素', `${describeSelectorRef(ref)} 命中多个元素（不唯一，禁止取首个）`, 'selector-ambiguous', ref.tier)
        }
        if (!point) {
          throw new GwtStepError(i, step, `等待 ${describeSelectorRef(ref)} 出现（${timeoutMs}ms 内）`, `${describeSelectorRef(ref)} 等待超时未出现`, 'selector-wait', ref.tier)
        }
        if (op.type === 'click') {
          await controller.clickPointInTab(sessionId, tabId, point.x, point.y)
        } else {
          // W22 F2 hover：真实悬停序列（mouseMoved 微抖动 + 停留 300ms）；悬停后断言交给后续 wait-selector/assert-* 步骤
          await controller.hoverPointInTab(sessionId, tabId, point.x, point.y)
        }
      } else if (op.type === 'fill') {
        // W22 F1 fill 可信化执行序：focus → select/全选 → CDP insertText → 回读校验 →
        // 单次重试（native-setter+input 回退）→ 再失败终态 fail（category=assert）。
        // 清空走真实选区替换（禁 native-setter 清空——两步间 DOM值≠React state 的窗口会让
        // insertText 变追加，产出「旧值+新值」的难归因失败）。
        const ref = normalizeGwtSelector(op.selector ?? '')
        if (!ref) throw new GwtStepError(i, step, 'selector 语法合法（四档形态）', op.selector ?? '', 'selector-wait', null)
        const text = op.value ?? ''
        if (text.length > GWT_FILL_VALUE_MAX_CHARS) {
          throw new GwtStepError(i, step, `value ≤ ${GWT_FILL_VALUE_MAX_CHARS} 字符`, `value 长 ${text.length} 字符（超限）`, 'assert', ref.tier)
        }
        const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS
        const appeared = await waitForSelectorPresent(controller, sessionId, tabId, ref, timeoutMs)
        if (!appeared) {
          throw new GwtStepError(i, step, `等待 ${describeSelectorRef(ref)} 出现（${timeoutMs}ms 内）`, `${describeSelectorRef(ref)} 等待超时未出现`, 'selector-wait', ref.tier)
        }
        const prep = await controller.evaluateInTab(sessionId, tabId, FILL_FOCUS_SELECT_EXPRESSION(ref)) as { code?: string; count?: number; kind?: string } | null
        if (prep?.code === 'ambiguous') {
          throw new GwtStepError(i, step, '选择器命中唯一元素', `${describeSelectorRef(ref)} 命中 ${prep.count} 个元素（不唯一）`, 'selector-ambiguous', ref.tier)
        }
        if (prep?.code === 'missing') {
          throw new GwtStepError(i, step, `等待 ${describeSelectorRef(ref)} 出现`, '元素在预检后消失（页面重渲染？）', 'selector-wait', ref.tier)
        }
        if (prep?.code === 'not-editable') {
          throw new GwtStepError(i, step, '目标为可编辑元素（input/textarea/contenteditable）', '目标不是可编辑元素', 'assert', ref.tier)
        }
        if (prep?.code === 'focus-failed' || prep?.code !== 'ok') {
          throw new GwtStepError(i, step, '目标元素聚焦成功', `无法聚焦目标元素（${prep?.code ?? '未知响应'}）`, 'assert', ref.tier)
        }
        await controller.insertTextInTab(sessionId, tabId, text)
        let readBack = await controller.evaluateInTab(sessionId, tabId, FILL_READ_VALUE_EXPRESSION(ref)) as { value?: string | null } | null
        if (readBack?.value !== text) {
          // 单次重试：回退链（native-setter + input/change 合成事件，与 React state 一致）
          const fallback = await controller.evaluateInTab(sessionId, tabId, FILL_FALLBACK_EXPRESSION(ref, text)) as { ok?: boolean; error?: string } | null
          readBack = await controller.evaluateInTab(sessionId, tabId, FILL_READ_VALUE_EXPRESSION(ref)) as { value?: string | null } | null
          if (readBack?.value !== text) {
            const actualText = typeof readBack?.value === 'string' ? readBack.value.slice(0, 80) : '（无法回读）'
            throw new GwtStepError(i, step, `输入后回读等于「${text.slice(0, 40)}」`, `实际「${actualText}」${fallback?.ok === false ? `（回退通道：${fallback.error}）` : '（主+回退两通道均未生效）'}`, 'assert', ref.tier)
          }
        }
      } else if (op.type === 'press') {
        await controller.pressKeyInTab(sessionId, tabId, op.value ?? 'Enter')
      } else if (op.type === 'reload') {
        // W22 收尾：页面刷新——location.reload() 后固定沉降 + 可选 selector 等得（有则用其 timeoutMs）
        const reloaded = await controller.evaluateInTab(sessionId, tabId, '(() => { location.reload(); return true })()') as boolean | null
        if (reloaded !== true) {
          throw new GwtStepError(i, step, '刷新指令已执行', 'location.reload() 求值失败', 'assert')
        }
        const waitSel = op.selector ? normalizeGwtSelector(op.selector) : null
        if (waitSel) {
          const appeared = await waitForSelectorPresent(controller, sessionId, tabId, waitSel, step.timeoutMs ?? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS)
          if (!appeared) {
            throw new GwtStepError(i, step, `刷新后等待 ${describeSelectorRef(waitSel)} 出现`, `${describeSelectorRef(waitSel)} 刷新后未出现`, 'selector-wait', waitSel.tier)
          }
        } else {
          await sleep(800)
        }
      } else if (op.type === 'check' || op.type === 'uncheck') {
        // W22 F2：读态 → 按需点 → 回读（盲点在中断/重试后会反向）；radio 不可 uncheck
        const ref = normalizeGwtSelector(op.selector ?? '')
        if (!ref) throw new GwtStepError(i, step, 'selector 语法合法（四档形态）', op.selector ?? '', 'selector-wait', null)
        const wantChecked = op.type === 'check'
        const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS
        const state = await waitForCheckState(controller, sessionId, tabId, ref, timeoutMs)
        if (state === 'ambiguous') {
          throw new GwtStepError(i, step, '选择器命中唯一元素', `${describeSelectorRef(ref)} 命中多个元素（不唯一）`, 'selector-ambiguous', ref.tier)
        }
        if (!state) {
          throw new GwtStepError(i, step, `等待 ${describeSelectorRef(ref)} 出现（${timeoutMs}ms 内）`, `${describeSelectorRef(ref)} 等待超时未出现`, 'selector-wait', ref.tier)
        }
        if (state.code === 'not-checkable') {
          throw new GwtStepError(i, step, '目标为 checkbox/radio 输入框', '目标不是 checkbox/radio（check/uncheck 仅适用于输入框）', 'op-check', ref.tier)
        }
        if (state.type === 'radio' && !wantChecked) {
          throw new GwtStepError(i, step, '可取消勾选的目标', 'radio 不可取消勾选（浏览器语义：选中后只能选别的 radio，请改场景表述）', 'op-check', ref.tier)
        }
        if (state.checked !== wantChecked) {
          const point = await waitForClickable(controller, sessionId, tabId, ref, timeoutMs)
          if (point === 'ambiguous') {
            throw new GwtStepError(i, step, '选择器命中唯一元素', `${describeSelectorRef(ref)} 命中多个元素（不唯一）`, 'selector-ambiguous', ref.tier)
          }
          if (!point) {
            throw new GwtStepError(i, step, '勾选目标可点击', `${describeSelectorRef(ref)} 中心坐标不可得`, 'selector-wait', ref.tier)
          }
          await controller.clickPointInTab(sessionId, tabId, point.x, point.y)
          // 回读轮询（真实点击后勾选态更新有时延）
          const confirmTimeout = step.timeoutMs ?? DEFAULT_CHECK_CONFIRM_TIMEOUT_MS
          const confirmStartedAt = Date.now()
          let confirmed: CheckStateResult | 'ambiguous' | null = null
          while (Date.now() - confirmStartedAt <= confirmTimeout) {
            confirmed = await evaluateCheckState(controller, sessionId, tabId, ref)
            if (confirmed && confirmed !== 'ambiguous' && confirmed?.code === 'ok' && confirmed.checked === wantChecked) break
            await sleep(POLL_INTERVAL_MS)
          }
          const finalState: CheckStateResult | 'ambiguous' | null = confirmed === 'ambiguous'
            ? 'ambiguous'
            : ((confirmed && confirmed.code === 'ok' ? confirmed : await evaluateCheckState(controller, sessionId, tabId, ref)) as CheckStateResult | 'ambiguous' | null)
          const finalDescribe = !finalState
            ? '无法回读'
            : finalState === 'ambiguous'
              ? '选择器不唯一'
              : finalState.code === 'ok' ? `checked=${finalState.checked}` : finalState.code
          if (!finalState || finalState === 'ambiguous' || finalState.code !== 'ok' || finalState.checked !== wantChecked) {
            throw new GwtStepError(i, step, `点击后 ${wantChecked ? 'checked' : 'unchecked'}`, `回读勾选态不符（${finalDescribe}）`, 'op-check', ref.tier)
          }
        }
      } else if (op.type === 'select') {
        // W22 F2：限原生 <select>——native setter + change 派发 + 回读；非原生给出 click 序列指引
        const ref = normalizeGwtSelector(op.selector ?? '')
        if (!ref) throw new GwtStepError(i, step, 'selector 语法合法（四档形态）', op.selector ?? '', 'selector-wait', null)
        const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS
        const value = op.value ?? ''
        const selected = await waitForSelectResult(controller, sessionId, tabId, ref, value, timeoutMs)
        if (selected === 'ambiguous') {
          throw new GwtStepError(i, step, '选择器命中唯一元素', `${describeSelectorRef(ref)} 命中多个元素（不唯一）`, 'selector-ambiguous', ref.tier)
        }
        if (!selected) {
          throw new GwtStepError(i, step, `等待 ${describeSelectorRef(ref)} 出现（${timeoutMs}ms 内）`, `${describeSelectorRef(ref)} 等待超时未出现`, 'selector-wait', ref.tier)
        }
        if (selected.code === 'not-native-select') {
          throw new GwtStepError(i, step, '目标为原生 <select> 元素', selected.error ?? '目标不是原生 select（自定义下拉请改用 click 序列：先 click 展开，再 click 选项）', 'op-select', ref.tier)
        }
        if (selected.code !== 'ok') {
          throw new GwtStepError(i, step, `选中 option（value/label =「${value}」）`, selected.error ?? 'select 失败', 'op-select', ref.tier)
        }
      } else if (op.type === 'scroll') {
        // W22 F2：CDP mouseWheel 优先 + JS scrollBy 回退；不隐式等待（时序交给后续 wait-selector/assert）
        const deltaY = op.deltaY ?? 0
        if (op.selector) {
          const ref = normalizeGwtSelector(op.selector)
          if (!ref) throw new GwtStepError(i, step, 'selector 语法合法（四档形态）', op.selector, 'selector-wait', null)
          const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS
          const appeared = await waitForSelectorPresent(controller, sessionId, tabId, ref, timeoutMs)
          if (!appeared) {
            throw new GwtStepError(i, step, `等待 ${describeSelectorRef(ref)} 出现（${timeoutMs}ms 内）`, `${describeSelectorRef(ref)} 等待超时未出现`, 'selector-wait', ref.tier)
          }
          // 滚动目标进入视口（scroll chaining 由随后的 wheel/JS 通道完成）
          await controller.evaluateInTab(sessionId, tabId, `(() => { const els = ${selectorFindFragment(ref)}; if (els.length > 0) els[0].scrollIntoView({ block: 'center', inline: 'nearest' }); return true; })()`)
        }
        let scrolled = false
        let lastError = ''
        try {
          await controller.wheelInTab(sessionId, tabId, 0, deltaY)
          scrolled = true
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e)
        }
        if (!scrolled) {
          try {
            const jsResult = await controller.evaluateInTab(sessionId, tabId, JS_SCROLL_EXPRESSION(deltaY)) as { ok?: boolean } | null
            scrolled = jsResult?.ok === true
          } catch (e) {
            lastError += `；JS 回退也失败：${e instanceof Error ? e.message : String(e)}`
          }
        }
        if (!scrolled) {
          throw new GwtStepError(i, step, `页面滚动 deltaY=${deltaY}`, `wheel 与 JS scrollBy 均未生效（${lastError}）`, 'op-scroll', null)
        }
      } else if (op.type === 'focus') {
        // W22 F2：scrollIntoView + focus + activeElement 回读断言
        const ref = normalizeGwtSelector(op.selector ?? '')
        if (!ref) throw new GwtStepError(i, step, 'selector 语法合法（四档形态）', op.selector ?? '', 'selector-wait', null)
        const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS
        const focused = await waitForFocusResult(controller, sessionId, tabId, ref, timeoutMs)
        if (focused === 'ambiguous') {
          throw new GwtStepError(i, step, '选择器命中唯一元素', `${describeSelectorRef(ref)} 命中多个元素（不唯一）`, 'selector-ambiguous', ref.tier)
        }
        if (!focused) {
          throw new GwtStepError(i, step, `等待 ${describeSelectorRef(ref)} 出现（${timeoutMs}ms 内）`, `${describeSelectorRef(ref)} 等待超时未出现`, 'selector-wait', ref.tier)
        }
        if (focused.code === 'focus-failed') {
          throw new GwtStepError(i, step, '目标元素聚焦成功（activeElement 回读）', 'focus 后 activeElement 不是目标元素', 'op-focus', ref.tier)
        }
      } else if (op.type === 'assert-screenshot') {
        // W22 F4：warning-only 视觉断言——不进 verdict（像素 diff 噪声会烧回炉预算并触发熔断）；
        // 基线存 06_TESTS/_screenshots/（不进交付门内容口径——checkGwtDeliveryFacts 只读 report.json 与 08_APP/index.html）
        await runAssertScreenshotStep(options, tabId, scenario, op, stepWarnings)
      } else if (op.type === 'wait-selector' || op.type === 'assert-text' || op.type === 'assert-visible' || op.type === 'assert-count') {
        // 断言/等待：轮询窗口（禁严格时刻断言；窗口内重试）
        const ref = normalizeGwtSelector(op.selector ?? '')
        if (!ref) throw new GwtStepError(i, step, 'selector 语法合法（四档形态）', op.selector ?? '', 'assert', null)
        const isWait = op.type === 'wait-selector'
        const timeoutMs = step.timeoutMs ?? (isWait ? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS : DEFAULT_ASSERT_TIMEOUT_MS)
        const expression = isWait
          ? `(() => ${selectorFindFragment(ref)}.length > 0)()`
          : ASSERT_EXPRESSION(ref, op)
        const waitStartedAt = Date.now()
        let lastActual = '未知'
        let matched = false
        while (Date.now() - waitStartedAt <= timeoutMs) {
          const result = await controller.evaluateInTab(sessionId, tabId, expression)
          if (isWait) {
            if (result === true) { matched = true; break }
            lastActual = `${describeSelectorRef(ref)} 在 ${timeoutMs}ms 内未出现`
          } else {
            const assertion = result as { ok?: boolean; actual?: string } | null
            if (assertion && assertion.ok === true) { matched = true; break }
            lastActual = assertion?.actual ?? '断言求值失败'
          }
          await sleep(POLL_INTERVAL_MS)
        }
        if (!matched) {
          const expected = isWait ? `等待 ${describeSelectorRef(ref)} 出现`
            : op.type === 'assert-text' ? `文本包含「${op.contains}」`
            : op.type === 'assert-visible' ? `${describeSelectorRef(ref)} 可见`
            : `${describeSelectorRef(ref)} 数量 = ${op.count}`
          // 二档 selector 命中非唯一：归 selector-ambiguous（映射类）而非 assert（行为类）
          const ambiguous = lastActual.includes('不唯一')
          throw new GwtStepError(i, step, expected, lastActual, ambiguous ? 'selector-ambiguous' : 'assert', ref.tier)
        }
      }
    } catch (e) {
      if (e instanceof GwtStepError) {
        // 失败截图（仅失败场景；执行录像属后续裁剪项）
        let screenshot: string | null = null
        if (options.screenshotDir) {
          try {
            const shot = await controller.screenshot(sessionId, tabId)
            const name = `fail-${scenario.feature}-${Date.now()}.png`
            mkdirSync(options.screenshotDir, { recursive: true })
            writeFileSync(join(options.screenshotDir, name), Buffer.from(shot.base64, 'base64'))
            screenshot = `06_TESTS/screenshots/${name}`
          } catch { /* 截图失败不掩盖失败原因 */ }
        }
        return {
          ...base,
          status: 'fail',
          reason: `步骤 ${e.stepIndex + 1}（${e.step.kind}：${e.step.text}）期望「${e.expected}」实际「${e.actual}」`,
          failedStep: { index: e.stepIndex, kind: e.step.kind, text: e.step.text, expected: e.expected, actual: e.actual, category: e.category, selectorTier: e.selectorTier ?? null },
          screenshot,
          durationMs: Date.now() - startedAt,
          warnings: stepWarnings.length > 0 ? stepWarnings : undefined,
        }
      }
      // 通道级异常（CDP 失败/标签关闭等）：场景级 fail，透明记录
      return {
        ...base,
        status: 'fail',
        reason: `执行通道异常：${e instanceof Error ? e.message : String(e)}`,
        failedStep: { index: i, kind: step.kind, text: step.text, expected: '步骤正常执行', actual: String(e instanceof Error ? e.message : e).slice(0, 200), category: 'channel' },
        screenshot: null,
        durationMs: Date.now() - startedAt,
        warnings: stepWarnings.length > 0 ? stepWarnings : undefined,
      }
    }
    await sleep(STEP_SETTLE_MS)
  }

  // S9：场景执行后校验实际 URL 仍在宿主持有 origin（页面 JS 跳转/重定向出站），出 origin 立即失败关闭。
  if (entryUrl && controller.assertUrlTabOrigin) {
    try {
      await controller.assertUrlTabOrigin(sessionId, tabId)
    } catch (e) {
      return {
        ...base,
        status: 'fail',
        reason: `场景执行后测试页离开宿主服务 origin：${e instanceof Error ? e.message : String(e)}`,
        failedStep: { index: scenario.steps.length, kind: 'then', text: '页面停留于宿主服务', expected: '仍在本 session 登记的 loopback 地址', actual: String(e instanceof Error ? e.message : e).slice(0, 200), category: 'channel' },
        screenshot: null,
        durationMs: Date.now() - startedAt,
        warnings: stepWarnings.length > 0 ? stepWarnings : undefined,
      }
    }
  }

  return { ...base, status: 'pass', reason: null, durationMs: Date.now() - startedAt, warnings: stepWarnings.length > 0 ? stepWarnings : undefined }
}

/** 步骤失败（带期望/实际与回炉归类，供分流；W22 F3 附 selector 档位归因） */
class GwtStepError extends Error {
  constructor(
    public readonly stepIndex: number,
    public readonly step: GwtStep,
    public readonly expected: string,
    public readonly actual: string,
    public readonly category: NonNullable<GwtFailedStep['category']>,
    public readonly selectorTier?: GwtSelectorTier | null,
  ) {
    super(`步骤 ${stepIndex + 1} 失败：期望「${expected}」实际「${actual}」`)
  }
}

/** selector 展示形态（错误消息/报告用；aria-label 档展示属性形态） */
function describeSelectorRef(ref: GwtSelectorRef): string {
  return ref.css ?? `[aria-label="${ref.value}"]`
}

/** click/hover/fill 目标元素执行期轮询：窗口内等元素出现并返回中心坐标（等不到 null；二档不唯一 'ambiguous'） */
async function waitForClickable(
  controller: GwtBrowserAdapter, sessionId: string, tabId: string, ref: GwtSelectorRef, timeoutMs: number,
): Promise<{ x: number; y: number } | 'ambiguous' | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const center = await controller.evaluateInTab(sessionId, tabId, CENTER_OF_EXPRESSION(ref))
      if (center && typeof center === 'object' && 'ambiguous' in (center as Record<string, unknown>)) return 'ambiguous'
      const point = center as { x: number; y: number } | null
      if (point && typeof point.x === 'number' && typeof point.y === 'number') return point
    } catch { /* 求值异常按未出现重试，窗口耗尽后由调用方判 fail */ }
    await sleep(POLL_INTERVAL_MS)
  }
  return null
}

/** 目标元素执行期轮询：窗口内等元素存在（等不到返回 false） */
async function waitForSelectorPresent(
  controller: GwtBrowserAdapter, sessionId: string, tabId: string, ref: GwtSelectorRef, timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const exists = await controller.evaluateInTab(sessionId, tabId, `(() => ${selectorFindFragment(ref)}.length > 0)()`)
      if (exists === true) return true
    } catch { /* 求值异常按未出现重试，窗口耗尽后由调用方判 fail */ }
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

type CheckStateResult = { code: 'ok'; checked: boolean; type: string } | { code: 'not-checkable' } | null

/** W22 F4：基线文件名 slug（feature+scenario 安全化 + 8 位哈希防碰撞） */
function screenshotBaselineName(scenario: GwtScenarioFile, explicitName?: string): string {
  if (explicitName && explicitName.trim()) {
    return explicitName.trim().replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60)
  }
  const slug = `${scenario.feature}-${scenario.scenario}`
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 52)
  const hash = createHash('sha1').update(`${scenario.feature}|${scenario.scenario}`).digest('hex').slice(0, 8)
  return `${slug || 'scenario'}-${hash}`
}

/**
 * W22 F4：像素差异率（纯函数）——单像素 RGB 通道最大差 >10 才计入差异像素
 * （过滤字体抗锯齿/子像素渲染噪声），返回差异像素占比。不可比（解码失败/尺寸不符）返回 null。
 */
export function computeScreenshotDiffRatio(currentPng: Buffer, baselinePng: Buffer): number | null {
  let current: PNG
  let baseline: PNG
  try {
    current = PNG.sync.read(currentPng)
    baseline = PNG.sync.read(baselinePng)
  } catch {
    return null
  }
  if (current.width !== baseline.width || current.height !== baseline.height) return null
  const total = current.width * current.height
  if (total === 0) return null
  let diff = 0
  for (let p = 0; p < total; p++) {
    const a = p * 4
    const b = a + 1
    const c = a + 2
    const maxChannelDiff = Math.max(
      Math.abs(current.data[a]! - baseline.data[a]!),
      Math.abs(current.data[b]! - baseline.data[b]!),
      Math.abs(current.data[c]! - baseline.data[c]!),
    )
    if (maxChannelDiff > 10) diff += 1
  }
  return diff / total
}

interface ScreenshotBaselineMeta {
  width: number
  height: number
  dpr: number
  createdAt: string
}

/**
 * W22 F4 assert-screenshot（warning-only，不进 verdict）：
 * - 首跑无基线 → 落盘基线（06_TESTS/_screenshots/，不进交付门内容口径——checkGwtDeliveryFacts
 *   只读 report.json 与 08_APP/index.html 指纹）+ warning baseline-created；
 * - 有基线 → 尺寸/DPR 不符 warning 不可比（不判 fail）；可比则像素 diff，超阈值仅 warning；
 * - 任何异常（截图/解码/IO）降级为 warning（诚实降级，不 fail 不 error——不烧回炉预算）。
 */
async function runAssertScreenshotStep(
  options: GwtSuiteOptions,
  tabId: string,
  scenario: GwtScenarioFile,
  op: GwtStepOp,
  warnings: string[],
): Promise<void> {
  const name = screenshotBaselineName(scenario, op.name)
  const relPath = `06_TESTS/_screenshots/${name}.png`
  if (!options.baselineDir) {
    warnings.push(`screenshot-skipped:${name}（基线目录不可用）`)
    return
  }
  let shot: { base64: string; width: number; height: number; dpr: number }
  try {
    shot = await options.controller.captureViewportPngInTab(options.sessionId, tabId)
  } catch (e) {
    warnings.push(`screenshot-failed:${name}（${String(e instanceof Error ? e.message : e).slice(0, 120)}）`)
    return
  }
  const baselinePath = join(options.baselineDir, `${name}.png`)
  const metaPath = join(options.baselineDir, `${name}.meta.json`)
  const currentMeta: ScreenshotBaselineMeta = {
    width: shot.width, height: shot.height, dpr: shot.dpr, createdAt: new Date().toISOString(),
  }
  try {
    if (!existsSync(baselinePath)) {
      // 首跑建基线（仅记录，不作为验收证据——后续轮次以本轮截图为对照）
      mkdirSync(options.baselineDir, { recursive: true })
      writeFileSync(baselinePath, Buffer.from(shot.base64, 'base64'))
      writeJsonFileAtomic(metaPath, currentMeta)
      warnings.push(`baseline-created:${relPath}（viewport ${shot.width}x${shot.height}@${shot.dpr}x）`)
      return
    }
    // 有基线：先比尺寸/DPR 元数据（不符判不可比，不判 fail）
    let baselineMeta: ScreenshotBaselineMeta | null = null
    try {
      baselineMeta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ScreenshotBaselineMeta
    } catch { /* meta 缺失/损坏按不可比处理 */ }
    if (!baselineMeta
      || baselineMeta.width !== currentMeta.width || baselineMeta.height !== currentMeta.height
      || baselineMeta.dpr !== currentMeta.dpr) {
      const recorded = baselineMeta ? `${baselineMeta.width}x${baselineMeta.height}@${baselineMeta.dpr}x` : '元数据缺失'
      warnings.push(`screenshot-incomparable:${name}（当前 ${currentMeta.width}x${currentMeta.height}@${currentMeta.dpr}x，基线 ${recorded}——视口/DPR 变化，请人工确认或删基线重建）`)
      return
    }
    const ratio = computeScreenshotDiffRatio(Buffer.from(shot.base64, 'base64'), readFileSync(baselinePath))
    if (ratio === null) {
      warnings.push(`screenshot-incomparable:${name}（像素解码失败或尺寸不一致）`)
      return
    }
    const threshold = typeof op.threshold === 'number' && op.threshold > 0 && op.threshold <= 1
      ? op.threshold
      : GWT_SCREENSHOT_DIFF_THRESHOLD_DEFAULT
    if (ratio > threshold) {
      warnings.push(`screenshot-diff:${name}（差异像素占比 ${(ratio * 100).toFixed(2)}% 超过阈值 ${(threshold * 100).toFixed(1)}%——视觉回归观察项，不影响本次判定；请人工确认基线 06_TESTS/_screenshots/${name}.png）`)
    }
    // ratio ≤ threshold：无警告（视觉一致）
  } catch (e) {
    warnings.push(`screenshot-error:${name}（${String(e instanceof Error ? e.message : e).slice(0, 120)}）`)
  }
}

/** check/uncheck：单次读勾选态（missing 时返回 null 供轮询重试） */
async function evaluateCheckState(
  controller: GwtBrowserAdapter, sessionId: string, tabId: string, ref: GwtSelectorRef,
): Promise<CheckStateResult | 'ambiguous'> {
  try {
    const result = await controller.evaluateInTab(sessionId, tabId, CHECK_STATE_EXPRESSION(ref)) as
      | { code?: string; count?: number; checked?: boolean; type?: string } | null
    if (!result || result.code === 'missing') return null
    if (result.code === 'ambiguous') return 'ambiguous'
    if (result.code === 'not-checkable') return { code: 'not-checkable' }
    if (result.code === 'ok') return { code: 'ok', checked: result.checked === true, type: result.type ?? '' }
    return null
  } catch {
    return null
  }
}

/** check/uncheck：轮询等目标出现并读态（等不到 null；不唯一 'ambiguous'） */
async function waitForCheckState(
  controller: GwtBrowserAdapter, sessionId: string, tabId: string, ref: GwtSelectorRef, timeoutMs: number,
): Promise<CheckStateResult | 'ambiguous' | null> {
  const startedAt = Date.now()
  let last: CheckStateResult | 'ambiguous' | null = null
  while (Date.now() - startedAt <= timeoutMs) {
    last = await evaluateCheckState(controller, sessionId, tabId, ref)
    if (last !== null) return last
    await sleep(POLL_INTERVAL_MS)
  }
  return last
}

/** select：轮询执行选中（missing 重试；其余确定性结果立即返回） */
async function waitForSelectResult(
  controller: GwtBrowserAdapter, sessionId: string, tabId: string, ref: GwtSelectorRef, value: string, timeoutMs: number,
): Promise<{ code: string; error?: string; value?: string } | 'ambiguous' | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const result = await controller.evaluateInTab(sessionId, tabId, SELECT_EXPRESSION(ref, value)) as
        | { code?: string; count?: number; error?: string; value?: string } | null
      if (!result || result.code === 'missing') { await sleep(POLL_INTERVAL_MS); continue }
      if (result.code === 'ambiguous') return 'ambiguous'
      return { code: result.code ?? 'unknown', error: result.error, value: result.value }
    } catch { /* 求值异常按未出现重试 */ }
    await sleep(POLL_INTERVAL_MS)
  }
  return null
}

/** focus：轮询聚焦（missing 重试；其余确定性结果立即返回） */
async function waitForFocusResult(
  controller: GwtBrowserAdapter, sessionId: string, tabId: string, ref: GwtSelectorRef, timeoutMs: number,
): Promise<{ code: string } | 'ambiguous' | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const result = await controller.evaluateInTab(sessionId, tabId, FOCUS_EXPRESSION(ref)) as
        | { code?: string; count?: number } | null
      if (!result || result.code === 'missing') { await sleep(POLL_INTERVAL_MS); continue }
      if (result.code === 'ambiguous') return 'ambiguous'
      return { code: result.code ?? 'unknown' }
    } catch { /* 求值异常按未出现重试 */ }
    await sleep(POLL_INTERVAL_MS)
  }
  return null
}

/** 执行全套场景（不判定；判定归 judgeGwtResult） */
export async function runGwtSuite(options: GwtSuiteOptions): Promise<GwtScenarioResult[]> {
  const { controller, sessionId, entryHtmlPath, entryUrl, scenarios, onProgress } = options
  const results: GwtScenarioResult[] = []
  if (options.signal?.aborted) throw new EngineeringExecutionBlocked('浏览器测试已取消')
  const hasEntryUrl = typeof entryUrl === 'string' && entryUrl.length > 0
  const hasEntryHtmlPath = typeof entryHtmlPath === 'string' && entryHtmlPath.length > 0
  if (hasEntryUrl === hasEntryHtmlPath) throw new Error('entryUrl 与 entryHtmlPath 必须且只能指定其一作为唯一测试入口')
  let tab: { tabId: string; previousActiveTabId?: string | null }
  if (hasEntryUrl) {
    if (typeof controller.createUrlTab !== 'function' || typeof controller.loadUrlInTab !== 'function') {
      throw new Error('浏览器控制器未接入URL通道（createUrlTab/loadUrlInTab），不能执行 entryUrl 测试')
    }
    tab = await controller.createUrlTab(sessionId, entryUrl!)
  } else {
    tab = await controller.createLocalFileTab(sessionId, entryHtmlPath!)
  }
  const cancel = (): void => { void controller.closeTab(sessionId, tab.tabId).catch(() => {}) }
  options.signal?.addEventListener('abort', cancel, { once: true })
  let passed = 0
  let failed = 0
  let skipped = 0
  try {
    if (options.signal?.aborted) throw new EngineeringExecutionBlocked('浏览器测试已取消')
    onProgress?.({ phase: 'start', current: 0, total: scenarios.length, passed: 0, failed: 0, skipped: 0 })
    for (let i = 0; i < scenarios.length; i++) {
      if (options.signal?.aborted) throw new EngineeringExecutionBlocked('浏览器测试已取消')
      const scenario = scenarios[i]!
      onProgress?.({ phase: 'scenario-start', current: i + 1, total: scenarios.length, scenario: scenario.scenario, passed, failed, skipped })
      const result = await executeScenario(options, tab.tabId, scenario)
      results.push(result)
      if (result.status === 'pass') passed += 1
      else if (result.status === 'fail') failed += 1
      else skipped += 1
      onProgress?.({ phase: 'scenario-end', current: i + 1, total: scenarios.length, scenario: scenario.scenario, scenarioStatus: result.status, passed, failed, skipped })
    }
    return results
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    try { await controller.closeTab(sessionId, tab.tabId) } catch { /* 标签清理失败不影响结果 */ }
    // 标签恢复（AC Z-004）：切回测试创建前的用户活动标签，不留在任意残留标签上
    if (tab.previousActiveTabId && tab.previousActiveTabId !== tab.tabId) {
      try { controller.restoreDisplayTab?.(sessionId, tab.previousActiveTabId) } catch { /* 恢复失败不影响结果 */ }
    }
    onProgress?.({ phase: 'done', current: scenarios.length, total: scenarios.length, passed, failed, skipped })
  }
}

/**
 * L2-6：品类解析（architecture.md > prd.md 优先序，同 coding 推进口径）。
 * 读取失败或无标记返回 null——指令段内按 web-fullstack 兜底并提示补标，不阻断测试主流程。
 */
function resolveGwtProjectCategory(workspaceSlug: string, projectId: string): string | null {
  try {
    return resolveProjectCategoryForCoding(workspaceSlug, projectId)?.category ?? null
  } catch {
    return null
  }
}

// ===== 编排入口（orchestrator 调用；读文件→执行→判定→报告→埋点） =====

/** GWT 测试重试上限（PRD §9.3：快消型退回上限 2 次；与 PhaseNode.retryLimit 一致） */
export const GWT_RETRY_LIMIT = 2

/**
 * 失败构成（v0.17.63 回炉分流，AC L-001；W22 F2/F3/A1 扩展映射类集合）：
 * - behavior：assert 行为类失败（断言不满足/通道异常）→ 回炉 coding 改代码
 * - mapping：selector 等待超时/未映射/二档不唯一/新 op 执行约束/schema 非法 → 回炉 testing
 *   重写 steps.json 映射（不烧 coding 预算）
 * - coverage：US 覆盖缺失（无可执行场景 / PRD 缺 US-xx 清单 fail-fast）→ 补场景或回 requirements
 */
export type GwtFailureKind = 'behavior' | 'mapping' | 'coverage'

/** 映射类失败 category 集合（回 testing 重映射，不烧 coding 修复预算；W22 扩展） */
const MAPPING_FAILURE_CATEGORIES: ReadonlySet<NonNullable<GwtFailedStep['category']>> = new Set([
  'selector-wait', 'unmapped', 'selector-ambiguous', 'schema-invalid',
  'op-check', 'op-select', 'op-hover', 'op-scroll', 'op-focus',
])

/** 判定单场景失败是否映射类（W22：新 op 约束/selector 二档不唯一/schema 非法均归 mapping） */
export function isGwtMappingFailureCategory(category: GwtFailedStep['category'] | undefined): boolean {
  return category !== undefined && MAPPING_FAILURE_CATEGORIES.has(category)
}

/** 从场景结果归纳失败构成（纯函数；verdict=pass 时返回 null） */
export function classifyGwtFailure(results: Array<Pick<GwtScenarioResult, 'status' | 'failedStep'>>): GwtFailureKind | null {
  const failedResults = results.filter((r) => r.status === 'fail')
  if (failedResults.length === 0) return 'coverage'
  const isMapping = (r: (typeof failedResults)[number]) => isGwtMappingFailureCategory(r.failedStep?.category)
  // 混合失败时优先 behavior：真实缺陷修复后映射类失败常一并消失（元素本该存在），
  // 避免先重映射再发现代码坏了的两跳回炉
  return failedResults.some((r) => !isMapping(r)) ? 'behavior' : 'mapping'
}

export interface NanjuGwtOutcome {
  blockedReason?: string

  verdict: 'pass' | 'fail' | 'error' | 'blocked'
  judgement: GwtJudgement
  reportJsonPath: string
  reportMdPath: string
  /** 本轮重试编号（首次执行=0；非 pass 轮次含 error 后每回炉重跑 +1，合计 ≤ GWT_RETRY_LIMIT） */
  retryCount: number
  /** 执行异常累计轮次（v0.17.64 #6 独立计数：仅 verdict=error 轮次 +1，pass 轮清零；接熔断状态机 errorCount） */
  errorCount: number
  retryLimitReached: boolean
  summaryText: string
  /** 失败清单（回炉缺陷/映射修复描述） */
  failListText: string
  /** 失败构成（回炉分流依据）：behavior/mapping/coverage；pass 时为 null */
  failureKind: GwtFailureKind | null
  /** PRD 存在但未提取到 US-xx 清单（coverage 子类：需先补 PRD） */
  prdUserStoriesMissing: boolean
  /** verdict=error 时的异常原因 */
  errorReason: string | null
  results: GwtScenarioResult[]
}

// ===== W12 交付验收（GWT-pass 后两段，用户 2026-09-03 23:39 裁决） =====

/**
 * GWT-pass 后注入的交付验收消息（可见化 assistant 消息）。
 *
 * 语义边界（与工单 §1 流程一致）：故事覆盖与场景通过性由机器裁判背书（上文 summaryText），
 * 交付决定权交还用户——「应用是否可以交付使用」是人责判断，不再由机器直接 delivered。
 */
export function buildGwtDeliveryAcceptanceMessage(summaryText: string): string {
  return summaryText
    + '\n\n📦 应用已完成并通过自动测试（全部场景通过 + 用户故事全覆盖），可以交付使用。你用过了吗？\n'
    + '即将请你确认交付：满意交付 / 需要调整（说明问题，回炉修复后重新测试）。'
}

/**
 * GWT-pass 后续接 L1 的交付验收指令（runRegisteredHeadlessAgent 的 userMessage）。
 *
 * 分流：满意交付 → PHASE_ADVANCE: delivered（既有 isDeliverFromTesting + GWT 交付门禁，
 * verdict=pass 已满足）；需要调整 → 意见收集 → 回炉修复 08_APP/ → PHASE_ADVANCE: testing
 * 重跑 GWT（回炉预算 ≤2 次既有约束不变，GWT_RETRY_LIMIT 未动）。
 */
export const GWT_DELIVERY_ACCEPTANCE_RESUME_MESSAGE =
  '自动验收测试全部通过（GWT-pass：全场景通过 + 用户故事全覆盖，测试报告 verdict=pass）。'
  + '请向用户发起【交付验收】询问：用 AskUserQuestion 弹问（header「确认·满意交付」），question「应用已完成并通过自动测试，可以交付使用。你用过了吗？」，'
  + 'options 两项：「满意交付」（可以交付使用）/「需要调整」（说明问题，回炉修复后重新测试）。'
  + '用户选满意交付 → 立即输出 <!-- PHASE_ADVANCE: delivered --> 完成交付'
  + '（交付门禁校验 verdict=pass 且系统已记录用户满意交付确认已满足——用户经上方 AskUserQuestion 选择「满意交付」后系统自动登记，不要重新委派、不要重复产出、不要再询问）。'
  + '用户选需要调整或描述问题 → 按意见收集轮收集修改意见（可引导用户点选右侧预览元素精准定位，逐条确认理解、收齐后统一改），'
  + '收齐后 continue_delegation 委派「全栈开发」修复 08_APP/ 下的代码（不动 06_TESTS/ 与 01_PRD/），'
  + '修复完成后输出 <!-- PHASE_ADVANCE: testing --> 重跑自动测试（回炉预算 ≤2 次由系统计数，超限系统转人工）。'
  + '覆盖边界：自动测试在 file:// 上下文执行，预览协议 token 门控与注入差异不在覆盖内；场景语义等价与 PRD 遗漏项不由机器背书。'

/**
 * D8 §九 C′：auto 开启（快消型+autoClarify）交付验收续接指令——不再发起 AskUser，
 * GWT-pass 后直接输出 delivered 标记（A2′ 交付门：verdict=pass + main 实跑 runId）。
 * 与 router-prompt testing step5 自动交付分支双话术源同步（口径一致防漂移）。
 */
export const GWT_DELIVERY_ACCEPTANCE_AUTO_RESUME_MESSAGE =
  '自动验收测试全部通过（GWT-pass：全场景通过 + 用户故事全覆盖，测试报告 verdict=pass）。'
  + '本项目已开启自动审核（auto-clarify）：【自动交付】请立即输出 <!-- PHASE_ADVANCE: delivered --> 完成交付，'
  + '不发起交付验收 AskUser、不询问用户——交付门禁 = verdict=pass + main 实跑 runId，系统自动确认。'
  + '不要重新委派、不要重复产出、不要再询问；项目交付后无需再创建新阶段 Todo。'
  + '用户如主动发消息要求调整，仍按意见收集轮处理并回炉重跑（回炉预算 ≤2 次由系统计数）。'

/** 交付验收续接指令分发（D8）：auto on → 自动交付版；off → 既有真人验收版（逐字节不变） */
export function resolveGwtDeliveryResumeMessage(autoClarifyEnabled: boolean): string {
  return autoClarifyEnabled ? GWT_DELIVERY_ACCEPTANCE_AUTO_RESUME_MESSAGE : GWT_DELIVERY_ACCEPTANCE_RESUME_MESSAGE
}

/** 工程执行通道的宿主注入（W-C）：浏览器/CLI 驱动 + 可选服务运行时与依赖。 */
export interface EngineeringGwtExecutionOptions {
  services: EngineeringExecutionServices
  signal: AbortSignal
  /** browser-url 服务启动的运行时可探测结果；缺省时宿主自动探测 Node/Python3。 */
  serviceRuntimes?: EngineeringServiceRuntimes
  /** browser-url 服务启动依赖；缺省时用生产真实 spawn/探测；测试注入 fixture。 */
  serviceDeps?: EngineeringServiceDeps
  /**
   * G3a：本轮观察使用的宿主设备细化（音源 / 加速器 / 靶应用 / 端点）。
   * 传入即记入本进程（按项目），交付门 `checkGwtDeliveryFacts` 读回**同一份**；
   * 缺省不写入（并清空上一轮记忆），行为与 G3a 之前一致。
   */
  deviceDetail?: EngineeringRealEvidenceScope['deviceDetail']
}

/** 缺省宿主服务运行时探测（W-C）：不读取项目 command，不在项目目录搜解释器。 */
async function resolveDefaultEngineeringServiceRuntimes(): Promise<EngineeringServiceRuntimes> {
  // node-detector 经 windows-env 引入 electron.app，惰性加载避免把主进程依赖拖进纯 Bun 测试。
  const { detectNodeRuntime } = await import('./node-detector')
  const node = await detectNodeRuntime()
  const pythonPath = await detectEngineeringPython()
  return { nodePath: node.available ? node.path ?? undefined : undefined, pythonPath }
}

export async function runNanjuGwtAcceptance(input: {
  workspaceSlug: string
  projectId: string
  projectName: string
  projectMode: 'quick' | 'iterative'
  sessionId: string
  controller: GwtBrowserAdapter
  onProgress?: (event: GwtProgressEvent) => void
  engineeringExecution?: EngineeringGwtExecutionOptions
}): Promise<NanjuGwtOutcome> {
  // G3a：本轮使用的设备细化落进本进程（交付门读回同一份；缺省即清空上一轮记忆）
  recordEngineeringDeviceDetail(input.projectId, input.engineeringExecution?.deviceDetail)
  // D8 A2′：GWT 运行中标记薄壳（交付门 d' 消费；finally 兜底清除——异常/提前 return
  // 路径不残留，防「running 残留 → auto 交付门永拦」死锁）
  runningGwtProjectIds.add(input.projectId)
  try {
    return await runNanjuGwtAcceptanceInner(input)
  } finally {
    runningGwtProjectIds.delete(input.projectId)
  }
}

async function runNanjuGwtAcceptanceInner(input: {
  workspaceSlug: string
  projectId: string
  projectName: string
  projectMode: 'quick' | 'iterative'
  sessionId: string
  controller: GwtBrowserAdapter
  onProgress?: (event: GwtProgressEvent) => void
  engineeringExecution?: EngineeringGwtExecutionOptions
}): Promise<NanjuGwtOutcome> {
  const projectDir = getNanjuProjectDir(input.workspaceSlug, input.projectId)
  const featuresDir = join(projectDir, '06_TESTS', 'features')
  const reportJsonPath = join(projectDir, '06_TESTS', 'report.json')

  // 1. 加载全部 steps.json（schema 校验）。W22 A1：校验失败（含未知 op/版本不匹配）不再
  //    静默降级为 skip——计 fail（category=schema-invalid，归 mapping 回 testing 重新生成），
  //    消除「旧运行器遇新 op 静默 skip、其余场景全过仍判 pass」的交付门放行风险。
  const scenarios: GwtScenarioFile[] = []
  const schemaInvalidResults: GwtScenarioResult[] = []
  if (existsSync(featuresDir)) {
    for (const file of readdirSync(featuresDir).filter((f) => f.endsWith('.steps.json')).sort()) {
      try {
        const raw = readFileSync(join(featuresDir, file), 'utf-8')
        const { scenario, errors } = validateScenarioFileContent(raw)
        if (scenario && errors.length === 0) {
          scenarios.push(scenario)
        } else {
          schemaInvalidResults.push({
            feature: file.replace(/\.steps\.json$/, ''),
            scenario: `（文件 ${file} 校验失败）`,
            status: 'fail',
            reason: `schema 校验失败：${errors.slice(0, 3).join('；')}`,
            failedStep: {
              index: 0, kind: 'given', text: `文件 ${file} 加载`,
              expected: 'steps.json 符合当前词表 schema（含 schemaVersion）',
              actual: errors.slice(0, 3).join('；'),
              category: 'schema-invalid',
              selectorTier: null,
            },
            screenshot: null,
            durationMs: 0,
          })
        }
      } catch (e) {
        schemaInvalidResults.push({
          feature: file.replace(/\.steps\.json$/, ''),
          scenario: `（文件 ${file} 读取失败）`,
          status: 'fail',
          reason: `读取失败：${e instanceof Error ? e.message : String(e)}`,
          failedStep: {
            index: 0, kind: 'given', text: `文件 ${file} 读取`,
            expected: 'steps.json 可读',
            actual: e instanceof Error ? e.message : String(e),
            category: 'schema-invalid',
            selectorTier: null,
          },
          screenshot: null,
          durationMs: 0,
        })
      }
    }
  }

  // 2. PRD 用户故事清单（覆盖性判定的对照基准）。v0.17.63（AC F-002）：
  //    PRD 存在但提取不到任何 US-xx → 覆盖性基准缺失，fail-fast（不静默退化为纯通过性判定）
  let userStories: string[] = []
  let prdUserStoriesMissing = false
  const prdPath = join(projectDir, '01_PRD', 'prd.md')
  if (existsSync(prdPath)) {
    userStories = parseUserStories(readFileSync(prdPath, 'utf-8'))
    prdUserStoriesMissing = userStories.length === 0
  }

  // 3. 上轮重试编号（report.json 持久化，跨轮次累计）。
  //    v0.17.63（AC Z-005）：error 轮次同样计入重试（非 pass 即累计），
  //    避免「持续异常不写报告 → retryCount 永远 0 → 永不触发人工介入」。
  //    回炉预算语义：testing 侧重映射与 coding 修复合计 ≤ 2 次（择简口径，不改既有计数结构）。
  //    v0.17.64（#6）：errorCount 独立拆出（仅 error 轮累计，pass 清零），接熔断状态机——
  //    fail（产出缺陷）与 error（执行异常）成因不同，熔断阈值与修复通道均不同。
  let prevRetryCount = 0
  let prevErrorCount = 0
  let prevFailed = false
  let retryPending = false
  if (existsSync(reportJsonPath)) {
    try {
      const prev = JSON.parse(readFileSync(reportJsonPath, 'utf-8')) as { retryCount?: number; errorCount?: number; verdict?: string; retryPending?: boolean }
      prevRetryCount = typeof prev.retryCount === 'number' ? prev.retryCount : 0
      prevErrorCount = typeof prev.errorCount === 'number' ? prev.errorCount : 0
      prevFailed = prev.verdict === 'fail' || prev.verdict === 'error'
      if (prev.verdict === 'pass') prevRetryCount = 0
      retryPending = prevFailed || (prev.verdict === 'blocked' && prev.retryPending === true)
    } catch { /* 损坏报告按首次处理 */ }
  }
  const engineering = prepareEngineeringBrowserRun(projectDir)
  let blockedReason = engineering.reason
  let engineeringSuite: EngineeringSuiteResult | null = null
  // 仅接收本轮宿主浏览器执行返回值，不从项目驱动的evidence字符串反序列化权威结果。
  const browserResultsByTest = new Map<string, GwtScenarioResult[]>()
  if (input.engineeringExecution && engineering.mode === 'blocked' && existsSync(join(projectDir, ENGINEERING_CONTRACT_PATH))) {
    // S5：惰性解析服务运行时（仅契约含 browser-url 测试时探测），供预检校验与执行共用，避免双探测。
    const declaredContract = parseEngineeringContract(readFileSync(join(projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8')).contract
    const needsBrowserUrl = declaredContract?.tests.some((test) => test.adapter === 'browser-url') ?? false
    const serviceRuntimes: EngineeringServiceRuntimes | undefined = needsBrowserUrl
      ? (input.engineeringExecution.serviceRuntimes ?? await resolveDefaultEngineeringServiceRuntimes())
      : undefined
    const browserDriver = createEngineeringBrowserFileDriver({
      validate: validateScenarioFileContent,
      browserPrerequisite: () => input.controller.hasRiskDisclaimerAcknowledged?.() === false
        ? '尚未确认平台账号风险告知，请到浏览器面板阅读并确认后重跑；工程单次批准不能替代该告知。' : null,
      run: async (execution, selectedScenarios) => {
        const browserResults = await runGwtSuite({
        sessionId: input.sessionId, entryHtmlPath: join(projectDir, '08_APP', execution.test.target),
        scenarios: selectedScenarios, controller: input.controller,
        screenshotDir: join(projectDir, '06_TESTS', 'screenshots'), baselineDir: join(projectDir, '06_TESTS', '_screenshots'),
        signal: execution.signal,
        })
        browserResultsByTest.set(execution.test.id, browserResults)
        return browserResults
      },
    })
    const browserUrlDriver = createEngineeringBrowserUrlDriver({
      validate: validateScenarioFileContent,
      browserPrerequisite: () => input.controller.hasRiskDisclaimerAcknowledged?.() === false
        ? '尚未确认平台账号风险告知，请到浏览器面板阅读并确认后重跑；工程单次批准不能替代该告知。' : null,
      serviceEnvironment: (execution) => {
        if (!serviceRuntimes) return '宿主未提供可用的服务运行时，browser-url 测试无法预检'
        return validateEngineeringServiceEnvironment(execution, serviceRuntimes, process.platform)
      },
      startService: async (execution) => {
        const runtimes = serviceRuntimes ?? input.engineeringExecution!.serviceRuntimes ?? await resolveDefaultEngineeringServiceRuntimes()
        const deps = input.engineeringExecution!.serviceDeps ?? createDefaultEngineeringServiceDeps()
        return startEngineeringService(execution, runtimes, deps, input.sessionId)
      },
      run: async (execution, selectedScenarios, url) => {
        const browserResults = await runGwtSuite({
          sessionId: input.sessionId, entryUrl: url,
          scenarios: selectedScenarios, controller: input.controller,
          screenshotDir: join(projectDir, '06_TESTS', 'screenshots'), baselineDir: join(projectDir, '06_TESTS', '_screenshots'),
          signal: execution.signal,
        })
        browserResultsByTest.set(execution.test.id, browserResults)
        return browserResults
      },
    })
    const emitEngineeringProgress = (event: GwtProgressEvent): void => {
      try { input.onProgress?.({ ...event, scope: 'engineering' }) } catch { /* 展示失败不改变执行事实 */ }
    }
    const progressCounts = { current: 0, total: 0, passed: 0, failed: 0, skipped: 0 }
    emitEngineeringProgress({ phase: 'start', ...progressCounts })
    engineeringSuite = await runEngineeringSuite(projectDir, {
      ...input.engineeringExecution.services,
      // W-I B-f：真实能力证据观察期门禁（宿主接线层；scope 绑定本次验收）。
      // 未登记任何观察轮次时逐项返回 requires-real-unattested → suite 保持 blocked（不变相放行）。
      resolveRealEvidence: (request) => resolveSuiteRealEvidence(
        {
          workspaceSlug: input.workspaceSlug,
          projectId: input.projectId,
          sessionId: input.sessionId,
          projectDir: request.projectDir,
          // G3a：与交付门同一份设备细化（同一来源，不免两套拼法）
          deviceDetail: peekEngineeringDeviceDetail(input.projectId),
        },
        request.tests,
      ),
      approve: async (execution) => {
        emitEngineeringProgress({ phase: 'approval', ...progressCounts, scenario: execution.test.id })
        const approved = await input.engineeringExecution!.services.approve(execution)
        if (approved) emitEngineeringProgress({ phase: 'scenario-start', ...progressCounts, scenario: execution.test.id })
        return approved
      },
      drivers: [...input.engineeringExecution.services.drivers, browserDriver, browserUrlDriver],
    }, input.engineeringExecution.signal, (progress) => {
      Object.assign(progressCounts, progress)
      emitEngineeringProgress({ phase: 'scenario-end', ...progressCounts })
    })
    blockedReason = engineeringSuite.verdict === 'blocked' ? engineeringSuite.reason : null
  }

  // 4. 执行（三种确定态，均不向上抛异常：正常结果 / 覆盖性基准缺失 fail-fast / 执行异常 error）
  let suiteContract: ReturnType<typeof parseEngineeringContract>['contract'] = null
  if (engineeringSuite?.evidence) {
    try { suiteContract = parseEngineeringContract(readFileSync(join(projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8')).contract }
    catch { blockedReason = '测试后工程契约不可读，本轮结果无法用于交付。' }
  }
  const entryRelativePath = suiteContract ? '08_APP/' + suiteContract.target.entry : engineering.entry || '08_APP/index.html'
  const entryHtmlPath = join(projectDir, entryRelativePath)
  const screenshotDir = join(projectDir, '06_TESTS', 'screenshots')
  // W22 F4：截图基线目录（06_TESTS/_screenshots/；不进交付门内容口径——
  // checkGwtDeliveryFacts 只读 report.json 与 08_APP/index.html，不枚举本目录）
  const baselineDir = join(projectDir, '06_TESTS', '_screenshots')
  let results: GwtScenarioResult[] = []
  let errorReason: string | null = null
  if (engineeringSuite) {
    errorReason = engineeringSuite.verdict === 'error' ? engineeringSuite.reason : null
    results = engineeringSuite.tests.flatMap((test): GwtScenarioResult[] => {
      const browserResults = browserResultsByTest.get(test.testId)
      if (browserResults) return browserResults
      return test.checks.map((check) => ({
        feature: test.testId, scenario: `${check.storyId ?? '辅助测试'} ${check.label}`,
        status: check.passed && test.status === 'pass' ? 'pass' as const : 'fail' as const,
        reason: !check.passed ? `期望「${check.expected}」实际「${check.actual}」` : test.status !== 'pass' ? test.reason : null,
        failedStep: null, screenshot: null, durationMs: 0,
      }))
    })
  } else if (blockedReason) {
    // 不执行、不降级mock，不消耗代码修复预算。
  } else if (prdUserStoriesMissing) {
    // PRD 缺 US-xx 清单：覆盖性无法判定，不执行浏览器步骤（fail-fast，AC F-002）
  } else if (scenarios.length > 0 && existsSync(entryHtmlPath)) {
    try {
      results = await runGwtSuite({
        sessionId: input.sessionId,
        entryHtmlPath,
        scenarios,
        controller: input.controller,
        screenshotDir,
        baselineDir,
        onProgress: input.onProgress,
      })
    } catch (e) {
      // 执行器异常（CDP/标签级故障等）：同样写报告（verdict=error）+ 计入重试，
      // 不再裸抛断链（AC Z-005/L-003：后续轮次可触发超限人工介入）
      errorReason = e instanceof Error ? e.message : String(e)
    }
  } else {
    results = scenarios.map((s) => ({
      feature: s.feature,
      scenario: s.scenario,
      status: 'skip' as const,
      reason: existsSync(entryHtmlPath) ? '无场景文件' : '08_APP/index.html 不存在，无法执行',
      failedStep: null,
      screenshot: null,
      durationMs: 0,
    }))
  }
  // W22 A1：schema 非法文件计 fail（不再静默 skip），与执行结果合并进裁判
  if (!engineeringSuite && !blockedReason && schemaInvalidResults.length > 0) {
    results = [...results, ...schemaInvalidResults]
  }

  // P0-2（L1，2026-09-18）error 透传：驱动 stdout/stderr 尾部 → 自适应诊断摘要内联
  // errorReason + 旁挂落盘 06_TESTS/driver-io-<轮次时间戳>.log（平台侧写入，与既有
  // 06_TESTS/report-*.md 同通道同权限，不经指挥官/Agent 会话——ATK-L-004）。
  // 消除 G3b 式盲修轮（5 轮 error_reason 固定句、stderr 诊断全丢）。
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stampText = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
  let driverIoReport: GwtReportJson['driverIo'] | undefined
  if (errorReason && engineeringSuite) {
    const ioTest = engineeringSuite.tests.find((t) => t.status === 'error' && t.driverIo)
    if (ioTest?.driverIo) {
      const diag = summarizeDriverIo(ioTest.driverIo.stdoutTail, ioTest.driverIo.stderrTail)
      const relLogPath = `06_TESTS/driver-io-${stampText}.log`
      try {
        writeTextFileAtomic(join(projectDir, relLogPath), buildDriverIoLogFile(ioTest.driverIo, { testId: ioTest.testId, generatedAt: stamp.toISOString() }))
      } catch { /* 旁挂落盘失败不影响主报告（尾部已内联报告 error 段） */ }
      driverIoReport = { testId: ioTest.testId, stdoutTail: ioTest.driverIo.stdoutTail, stderrTail: ioTest.driverIo.stderrTail, logPath: relLogPath }
      errorReason = errorReason
        + (diag ? '\n驱动诊断（stderr 尾部自适应摘要）：' + diag : '')
        + '\n（驱动输出旁挂：' + relLogPath + '）'
    }
  }

  // 非 suite 的工程浏览器路径（engineering-browser 模式，无逐项 scenarioFiles 的 browser-file 契约）：
  // 测试期间产物变化 → blocked。suite 路径（engineering.mode === 'blocked'）的等价 digest 重校由
  // nanju-engineering-suite.ts 提供（彼时 prepareEngineeringBrowserRun 返回 evidence=null，本分支不进入）。
  if (engineering.evidence) {
    const after = captureEngineeringEvidence(projectDir)
    if (after.evidence?.digest !== engineering.evidence.digest) {
      blockedReason = '测试期间PRD、工程契约或产物发生变化，结果无法绑定当前版本，请停止修改后重新验收。'
    }
  }

  // 执行后也可能因版本变化而阻塞；只有最终有效的一轮才消耗修复预算。
  const retryCount = blockedReason ? prevRetryCount : retryPending ? prevRetryCount + 1 : prevRetryCount
  // 5. 规则裁判 + 报告
  const judgement = judgeGwtResult(results, userStories)
  if (engineeringSuite) {
    judgement.coveredUs = engineeringSuite.coveredUs
    judgement.uncoveredUs = engineeringSuite.uncoveredUs
    // 工程结果包含辅助测试与执行状态，不能仅由映射后的checks数量重建结论。
    judgement.verdict = engineeringSuite.verdict === 'pass' ? 'pass' : 'fail'
  }
  const failureKind = blockedReason || errorReason
    ? null
    : prdUserStoriesMissing
      ? 'coverage'
      : judgement.verdict === 'fail'
        ? classifyGwtFailure(results)
        : null
  const verdict: NanjuGwtOutcome['verdict'] = blockedReason ? 'blocked' : errorReason ? 'error' : engineeringSuite?.verdict ?? judgement.verdict
  // 独立异常计数（#6）：仅 error 轮累计，pass 轮清零（与 retryCount 的非 pass 合计口径并存）
  const errorCount = blockedReason ? prevErrorCount : verdict === 'pass'
    ? 0
    : verdict === 'error'
      ? (retryPending ? prevErrorCount : 0) + 1
      : (retryPending ? prevErrorCount : 0)
  // P0-2：报告对象携带驱动 IO 信息（md 报告嵌入尾部全文用）
  const report: GwtReportJson = {
    ...(driverIoReport ? { driverIo: driverIoReport } : {}),
    engineeringEvidence: engineeringSuite?.evidence ?? engineering.evidence ?? undefined,
    engineeringSuite: engineeringSuite ?? undefined,
    blockedReason: blockedReason ?? undefined,
    retryPending: blockedReason ? retryPending : verdict === 'fail' || verdict === 'error',
    generatedAt: new Date().toISOString(),
    // W18 Wave2：交付事实字段（runId 每次运行新发；指纹为写盘时刻对入口实测；
    // 入口缺失的降级路径缺省指纹——门禁按旧版格式/指纹不符拦截，verdict 亦非 pass）
    runId: randomUUID(),
    entryFingerprint: computeGwtEntryFingerprint(entryHtmlPath) ?? undefined,
    executionContext: engineeringSuite ? 'project-driver' : 'file://',
    coverageUnverified: engineeringSuite?.coverageUnverified ?? [...GWT_COVERAGE_UNVERIFIED],
    verdict,
    failureKind,
    prdUserStoriesMissing: prdUserStoriesMissing || undefined,
    errorReason,
    entry: engineeringSuite ? entryRelativePath : engineering.entry || '（真实执行器未就绪）',
    scenariosTotal: judgement.scenariosTotal,
    passed: judgement.passed,
    failed: judgement.failed,
    skipped: judgement.skipped,
    coveredUs: judgement.coveredUs,
    uncoveredUs: judgement.uncoveredUs,
    retryCount,
    errorCount,
    // W22 F4：非阻塞警告汇总（不影响 verdict）
    warnings: results.some((r) => r.warnings && r.warnings.length > 0)
      ? results.flatMap((r) => (r.warnings ?? []).map((w) => `[${r.scenario}] ${w}`))
      : undefined,
    scenarios: results.map((r) => ({
      feature: r.feature, scenario: r.scenario, status: r.status, reason: r.reason,
      failedStep: r.failedStep,
      // W22 F3/F2 报告归因字段：失败步骤的 selector 档位与失败归类（回炉定位直接可读）
      selectorTier: r.failedStep?.selectorTier ?? null,
      failureCategory: r.failedStep?.category,
      screenshot: r.screenshot, durationMs: r.durationMs,
      warnings: r.warnings,
    })),
  }
  writeJsonFileAtomic(reportJsonPath, report)
  // D8 A2′（R7-02）：main 实跑 provenance 登记（auto on 交付门 c' 消费；runId 每次
  // 运行新发——伪造 report 无登记值即拒）。D8 S4′：report 落盘 = 测试执行+裁判完成
  // → 向导图写 TEST_JUDGE（testing 序列末位；归因+outputPath 匹配见 tryAdvanceGuideSubStage）
  try {
    if (typeof report.runId === 'string' && report.runId !== ''
      && typeof report.entryFingerprint?.sha256 === 'string' && typeof report.entryFingerprint?.size === 'number') {
      // F1-1：登记 main 内存实测（GWT 运行时实测入口指纹 + 本轮 verdict）
      recordMainGwtRun(input.projectId, report.runId, {
        engineeringDigest: report.engineeringEvidence?.digest,
        verdict: report.verdict,
        fingerprintSha: report.entryFingerprint.sha256,
        size: report.entryFingerprint.size,
        generatedAt: report.generatedAt,
      })
    }
    const { tryAdvanceGuideSubStage } = require('./nanju-project') as typeof import('./nanju-project')
    tryAdvanceGuideSubStage(input.workspaceSlug, input.projectId, 'TEST_JUDGE')
  } catch { /* provenance/向导图写入失败不影响测试主流程 */ }
  const reportMdPath = join(projectDir, '06_TESTS', `report-${stampText}.md`)
  writeTextFileAtomic(reportMdPath, buildReportMarkdown(report, input.projectName))

  // 6. judge.verdict 埋点（推进即事实口径：fail/error 轮次也记，供漏斗分析）
  try {
    recordTelemetry(input.workspaceSlug, 'judge.verdict', {
      project_id: input.projectId,
      mode: input.projectMode,
      scenarios_total: judgement.scenariosTotal,
      passed: judgement.passed,
      failed: judgement.failed,
      skipped: judgement.skipped,
      mapping_fail: results.filter((r) => isGwtMappingFailureCategory(r.failedStep?.category)).length,
      coverage_us: judgement.uncoveredUs.length === 0 ? judgement.coveredUs.join(',') : `缺失:${judgement.uncoveredUs.join(',')}`,
      prd_us_missing: prdUserStoriesMissing || undefined,
      verdict,
      failure_kind: failureKind ?? undefined,
      error_reason: errorReason ?? undefined,
      duration_ms: results.reduce((sum, r) => sum + r.durationMs, 0),
      retry_round: retryCount,
      error_round: errorCount,
    }, input.projectId)
  } catch { /* 埋点失败不影响主流程 */ }

  // 7. 回炉缺陷清单（失败场景 + 期望 vs 实际 + 截图路径；v0.17.63 按失败构成分组描述）
  const failLines: string[] = []
  if (prdUserStoriesMissing) {
    failLines.push('PRD 未提取到 US-xx 用户故事清单，覆盖性无法判定。请先补充 PRD（用户故事用「US-01 / US-02 …」编号命名）后再重跑测试。')
  }
  results.filter((r) => r.status === 'fail').forEach((r, i) => {
    const fs = r.failedStep
    const kindTag = isGwtMappingFailureCategory(fs?.category) ? `（映射类：${fs?.category}——回 testing 修 steps.json，不改应用代码）` : ''
    const tierTag = fs?.selectorTier ? `［selector 档位 ${fs.selectorTier}］` : ''
    failLines.push(`${i + 1}. [${r.feature}] ${r.scenario} — 步骤 ${(fs?.index ?? 0) + 1}（${fs?.kind ?? ''}：${fs?.text ?? ''}）：期望「${fs?.expected ?? ''}」实际「${fs?.actual ?? r.reason ?? ''}」${kindTag}${tierTag}${r.screenshot ? `（截图 ${r.screenshot}）` : ''}`)
  })
  if (!prdUserStoriesMissing && judgement.uncoveredUs.length > 0) {
    failLines.push(`用户故事 ${judgement.uncoveredUs.join('、')} 没有可执行场景（全部 skip），覆盖不完整。`)
  }
  if (errorReason) {
    failLines.push(`执行异常：${errorReason}`)
  }
  // W22 F4：非阻塞警告（assert-screenshot baseline/diff 等）附在缺陷清单后，供人工复核
  const scenarioWarnings = results.flatMap((r) => (r.warnings ?? []).map((w) => `[${r.scenario}] ${w}`))
  if (scenarioWarnings.length > 0) {
    failLines.push('视觉观察项（不影响判定）：')
    scenarioWarnings.forEach((w) => failLines.push(`- ${w}`))
  }

  // 摘要口径（AC U-001/F-002）：PRD 缺 US 清单与执行异常用专用句式，不用普通 fail 文案
  // L2-6（2026-09-18）坑库回填触发：验收收敛 >3 轮（retryCount>3，对照 G3b 基线 8 轮）
  // 且本轮非 pass → 「强制复盘」指令段注入 summaryText 尾部。
  // 注入位置选 summaryText（而非 failListText）的理由：summaryText 是 outcome 中被
  // orchestrator 非 pass 分支（error 熔断 / retryLimit 转人工 / coverage / mapping /
  // behavior 回炉续接）与 pass 分支（交付验收消息）共同携带的字段——G3b 的 5 轮盲修
  // 正是 error 轮（只走 summaryText 分支）；审计 RED-1 后触发口径=总轮次≥4（retryCount≥3
  // 含 pass 轮，随交付验收消息注入）且 notify-environment/circuit-break 两早退分支已由
  // orchestrator 补接 summaryText。blocked 轮不触发：blocked 摘要显式声明「本轮不计入
  // 修复次数」，注入强制复盘段与该声明自相矛盾（shouldTriggerPitReflow 内排除）。
  const pitReflowText = shouldTriggerPitReflow(verdict, retryCount, Boolean(blockedReason))
    ? buildPitReflowDirective(resolveGwtProjectCategory(input.workspaceSlug, input.projectId), { retryCount, errorCount })
    : null
  const summaryText = (blockedReason
    ? `⏸ 验收测试已阻塞：${blockedReason} 本轮结果不用于交付，也不计入代码缺陷修复次数。测试报告：${reportMdPath}`
    : errorReason
    ? `⚠️ 验收测试执行异常：${errorReason}。请检查 08_APP/index.html 与 06_TESTS/ 产物完整性后重跑。测试报告：${reportMdPath}`
    : prdUserStoriesMissing
      ? `❌ PRD 未提取到 US-xx 用户故事清单，覆盖性无法判定（验收硬约束要求每条用户故事有可执行场景）。请补充 PRD 用户故事清单后重跑。测试报告：${reportMdPath}`
      : buildSummaryText(judgement, reportMdPath) + (engineeringSuite ? '\n证据边界：' + engineeringSuite.coverageUnverified.join('；') : ''))
    + (pitReflowText ? '\n\n' + pitReflowText : '')

  if (engineeringSuite) {
    try {
      input.onProgress?.({ phase: 'done', scope: 'engineering', verdict, reason: blockedReason ?? errorReason ?? engineeringSuite.reason ?? undefined,
        current: engineeringSuite.tests.length, total: suiteContract?.tests.length ?? 0,
        passed: engineeringSuite.tests.filter((test) => test.status === 'pass').length,
        failed: engineeringSuite.tests.filter((test) => test.status === 'fail' || test.status === 'error').length,
        skipped: engineeringSuite.tests.filter((test) => test.status === 'blocked').length })
    } catch { /* 展示失败不改变报告裁决 */ }
  }
  return {
    blockedReason: blockedReason ?? undefined,
    verdict,
    judgement,
    reportJsonPath,
    reportMdPath,
    retryCount,
    errorCount,
    retryLimitReached: retryCount >= GWT_RETRY_LIMIT,
    summaryText,
    failListText: failLines.join('\n'),
    failureKind,
    prdUserStoriesMissing,
    errorReason,
    results,
  }
}
