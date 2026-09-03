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
import { writeJsonFileAtomic, writeTextFileAtomic } from './safe-file'
import { getNanjuProjectDir } from './nanju-project'
import { recordTelemetry } from './nanju-telemetry'

// ===== steps.json schema =====

/** op 白名单（Sprint B；设计稿 Q4。v0.17.63 移除 eval：自由 JS 通道整体关闭） */
export type GwtOpType =
  | 'click' | 'fill' | 'press' | 'wait-selector'
  | 'assert-text' | 'assert-visible' | 'assert-count'

export interface GwtStepOp {
  type: GwtOpType
  /** data-ai-id 值（或完整 CSS selector 形态，归一后统一 [data-ai-id="..."]） */
  selector?: string
  /** fill 文本 / press 键名（Enter、Escape、Tab 等导航键或文本） */
  value?: string
  /** assert-text 期望包含文本 */
  contains?: string
  /** assert-count 期望元素数量 */
  count?: number
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
   * - assert：断言不满足（行为类，回 coding 改代码）
   * - channel：执行通道异常（CDP/标签级故障）
   */
  category?: 'selector-wait' | 'unmapped' | 'assert' | 'channel'
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
])

/**
 * selector 归一：接受 `data-ai-id=xxx` / `[data-ai-id="xxx"]` / `[data-ai-id='xxx']` 三种写法，
 * 统一为 CSS `[data-ai-id="xxx"]`。非法形态返回 null（预检阶段拦截，不臆造）。
 */
export function normalizeGwtSelector(raw: string): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  // 形态一：data-ai-id=xxx
  const bare = /^data-ai-id\s*=\s*(.+)$/.exec(trimmed)
  if (bare?.[1]) {
    const value = bare[1].trim()
    return DATA_AI_ID_VALUE.test(value) ? `[data-ai-id="${value}"]` : null
  }
  // 形态二：[data-ai-id="xxx"] / [data-ai-id='xxx']
  const bracketed = /^\[\s*data-ai-id\s*=\s*["']([^"']+)["']\s*\]$/.exec(trimmed)
  if (bracketed?.[1]) {
    const value = bracketed[1].trim()
    return DATA_AI_ID_VALUE.test(value) ? `[data-ai-id="${value}"]` : null
  }
  return null
}

/** 需要选择器的 op 类型 */
const SELECTOR_OPS: ReadonlySet<string> = new Set([
  'click', 'fill', 'wait-selector', 'assert-text', 'assert-visible', 'assert-count',
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
            errors.push(`${label}.op.selector 非法（只允许 data-ai-id=xxx 或 [data-ai-id="xxx"] 形态）`)
          }
        }
        if (op.type === 'fill' && typeof op.value !== 'string') errors.push(`${label}.op.type=fill 需要 value 文本`)
        if (op.type === 'press' && (typeof op.value !== 'string' || !op.value.trim())) errors.push(`${label}.op.type=press 需要 value 键名`)
        if (op.type === 'assert-text' && typeof op.contains !== 'string') errors.push(`${label}.op.type=assert-text 需要 contains 文本`)
        if (op.type === 'assert-count' && (typeof op.count !== 'number' || !Number.isInteger(op.count) || op.count < 0)) {
          errors.push(`${label}.op.type=assert-count 需要 count 非负整数`)
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

/** 从 PRD 内容提取用户故事 ID（US-xx，有序去重；兜底 US-1 两位化） */
export function parseUserStories(prdContent: string): string[] {
  const seen = new Set<string>()
  const stories: string[] = []
  for (const m of prdContent.matchAll(/\bUS-(\d+)\b/gi)) {
    const normalized = `US-${String(Number(m[1])).padStart(2, '0')}`
    if (!seen.has(normalized)) {
      seen.add(normalized)
      stories.push(normalized)
    }
  }
  return stories
}

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
  generatedAt: string
  verdict: 'pass' | 'fail' | 'error'
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
  scenarios: Array<{
    feature: string
    scenario: string
    status: GwtScenarioStatus
    reason: string | null
    failedStep: GwtScenarioResult['failedStep']
    screenshot: string | null
    durationMs: number
  }>
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
    : report.verdict === 'error'
      ? `⚠️ 执行异常${report.errorReason ? `（${report.errorReason}）` : ''}`
      : report.failed === 0
        ? '❌ 未通过（覆盖不全：有用户故事无可执行场景）'
        : '❌ 未通过'
  lines.push(`- 判定结果：${verdictLabel}`)
  lines.push(`- 场景统计：共 ${report.scenariosTotal} 个，通过 ${report.passed}，失败 ${report.failed}，跳过 ${report.skipped}`)
  lines.push(`- 用户故事覆盖：${report.coveredUs.length > 0 ? report.coveredUs.join('、') : '无'}${report.uncoveredUs.length > 0 ? `（未覆盖：${report.uncoveredUs.join('、')}）` : ''}`)
  if (report.prdUserStoriesMissing) lines.push('- ⚠ PRD 未提取到 US-xx 用户故事清单，覆盖性无法判定（请补充 PRD 后重跑）')
  lines.push(`- 重试轮次：${report.retryCount}`)
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
  createLocalFileTab(sessionId: string, filePath: string): Promise<{ tabId: string; previousActiveTabId?: string | null }>
  loadFileInTab(sessionId: string, tabId: string, filePath: string): Promise<void>
  evaluateInTab(sessionId: string, tabId: string, expression: string, signal?: AbortSignal): Promise<unknown>
  clickPointInTab(sessionId: string, tabId: string, x: number, y: number, signal?: AbortSignal): Promise<void>
  pressKeyInTab(sessionId: string, tabId: string, key: string, signal?: AbortSignal): Promise<void>
  screenshot(sessionId: string, tabId: string, signal?: AbortSignal): Promise<{ base64: string }>
  closeTab(sessionId: string, tabId: string): Promise<unknown>
  /** 测试结束后恢复用户原活动标签（v0.17.63 AC Z-004；可选实现，未实现时保持现状） */
  restoreDisplayTab?(sessionId: string, tabId: string): void
}

// ===== 执行器 =====

const DEFAULT_ASSERT_TIMEOUT_MS = 4_000
const DEFAULT_WAIT_SELECTOR_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 250
/** 每步执行后的 settle 延时（等异步渲染稳定） */
const STEP_SETTLE_MS = 150

/** 进度事件（IPC nanju:gwt-progress 载荷同型） */
export interface GwtProgressEvent {
  phase: 'start' | 'scenario-start' | 'scenario-end' | 'done'
  current: number
  total: number
  scenario?: string
  scenarioStatus?: GwtScenarioStatus
  passed: number
  failed: number
  skipped: number
}

export interface GwtSuiteOptions {
  sessionId: string
  entryHtmlPath: string
  scenarios: GwtScenarioFile[]
  controller: GwtBrowserAdapter
  screenshotDir: string | null
  onProgress?: (event: GwtProgressEvent) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** JSON 序列化注入（页面模板参数；\u2028/\u2029 转义防 JS 语法破坏） */
function pagePayload(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** selector 元素中心坐标（e2e-v59 center_of 同型；找不到返回 null） */
const CENTER_OF_EXPRESSION = (selector: string) =>
  `(() => { const el = document.querySelector(${pagePayload(selector)}); if (!el) return null; ` +
  `el.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = el.getBoundingClientRect(); ` +
  `return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`

/** 断言轮询模板：每轮求值一次，返回 { ok, actual } */
const ASSERT_EXPRESSION = (selector: string, op: GwtStepOp) => {
  const kind = op.type === 'assert-text' ? 'text' : op.type === 'assert-visible' ? 'visible' : op.type === 'assert-count' ? 'count' : 'selector'
  const expect = op.type === 'assert-text' ? op.contains : op.type === 'assert-count' ? op.count : null
  return `(() => { const sel = ${pagePayload(selector)}; const els = document.querySelectorAll(sel); ` +
    `if (els.length === 0) return { ok: false, actual: '元素不存在' }; ` +
    `if (${pagePayload(kind)} === 'selector') return { ok: true, actual: '元素存在' }; ` +
    `if (${pagePayload(kind)} === 'visible') { const el = els[0]; const visible = !!(el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)); ` +
    `return { ok: visible, actual: visible ? '元素可见' : '元素不可见' }; } ` +
    `if (${pagePayload(kind)} === 'count') { const n = els.length; return { ok: n === ${pagePayload(expect)}, actual: '数量 ' + n }; } ` +
    `const el = els[0]; const text = (el && (el.innerText || el.textContent)) || ''; const contains = text.includes(${pagePayload(expect)}); ` +
    `return { ok: contains, actual: JSON.stringify(text).slice(0, 120) }; })()`
}

/** fill 模板：原生 value setter + input/change 事件派发（BrowserDomAction 同型语义） */
const FILL_EXPRESSION = (selector: string, text: string) =>
  `(() => { const el = document.querySelector(${pagePayload(selector)}); if (!el) return { ok: false, error: '未找到元素' }; ` +
  `if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) return { ok: false, error: '目标不是可编辑元素' }; ` +
  `el.scrollIntoView({ block: 'center', inline: 'nearest' }); el.focus({ preventScroll: true }); ` +
  `if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { ` +
  `const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype; ` +
  `const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (setter) setter.call(el, ${pagePayload(text)}); else el.value = ${pagePayload(text)}; } ` +
  `else { el.textContent = ${pagePayload(text)}; } ` +
  `try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${pagePayload(text)} })); } ` +
  `catch { el.dispatchEvent(new Event('input', { bubbles: true })); } ` +
  `el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`

/** 执行单个场景；controller 异常上抛由调用方兜底为 fail */
async function executeScenario(
  options: GwtSuiteOptions,
  tabId: string,
  scenario: GwtScenarioFile,
): Promise<GwtScenarioResult> {
  const startedAt = Date.now()
  const { controller, sessionId, entryHtmlPath } = options
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

  // 场景隔离：每个场景重新 loadFile（同代码同结果，重试公平）。
  // v0.17.63（AC Z-001）：存储清理下沉到 BrowserController.loadFileInTab（重载前清
  // localStorage/sessionStorage，消除上一场景写入数据的串扰；indexedDB 清理归 Sprint C）。
  await controller.loadFileInTab(sessionId, tabId, entryHtmlPath)
  await sleep(300)

  // 逐步执行（v0.17.63 预检重构，AC Z-002/Z-003：不再做「初始 DOM 存在性」预检——
  // 2s 初始窗口对动态 UI（先点开弹屏/二级页再操作其中元素）是系统性误杀；
  // 改为 click/fill 执行期 8s 轮询等待目标出现，等不到才判 fail「等待超时未出现」。
  // 保留「不执行半截」语义：目标始终未出现时该步 fail，不动后续步骤。）
  for (let i = 0; i < scenario.steps.length; i++) {
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
      if (op.type === 'click' || op.type === 'fill' || op.type === 'press') {
        if (op.type === 'click') {
          const selector = normalizeGwtSelector(op.selector ?? '')
          if (!selector) throw new GwtStepError(i, step, 'selector 语法非法', op.selector ?? '', 'selector-wait')
          const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS
          const point = await waitForClickable(controller, sessionId, tabId, selector, timeoutMs)
          if (!point) {
            throw new GwtStepError(i, step, `等待 ${selector} 出现（${timeoutMs}ms 内）`, `${selector} 等待超时未出现`, 'selector-wait')
          }
          await controller.clickPointInTab(sessionId, tabId, point.x, point.y)
        } else if (op.type === 'fill') {
          const selector = normalizeGwtSelector(op.selector ?? '')
          if (!selector) throw new GwtStepError(i, step, 'selector 语法合法', op.selector ?? '', 'selector-wait')
          const timeoutMs = step.timeoutMs ?? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS
          const appeared = await waitForSelectorPresent(controller, sessionId, tabId, selector, timeoutMs)
          if (!appeared) {
            throw new GwtStepError(i, step, `等待 ${selector} 出现（${timeoutMs}ms 内）`, `${selector} 等待超时未出现`, 'selector-wait')
          }
          const filled = await controller.evaluateInTab(sessionId, tabId, FILL_EXPRESSION(selector, op.value ?? '')) as { ok?: boolean; error?: string } | null
          if (!filled || filled.ok !== true) {
            throw new GwtStepError(i, step, '输入成功', filled?.error ?? 'fill 失败', 'assert')
          }
        } else {
          await controller.pressKeyInTab(sessionId, tabId, op.value ?? 'Enter')
        }
      } else if (op.type === 'wait-selector' || op.type === 'assert-text' || op.type === 'assert-visible' || op.type === 'assert-count') {
        // 断言/等待：轮询窗口（禁严格时刻断言；窗口内重试）
        const selector = normalizeGwtSelector(op.selector ?? '')
        if (!selector) throw new GwtStepError(i, step, 'selector 语法合法', op.selector ?? '', 'assert')
        const isWait = op.type === 'wait-selector'
        const timeoutMs = step.timeoutMs ?? (isWait ? DEFAULT_WAIT_SELECTOR_TIMEOUT_MS : DEFAULT_ASSERT_TIMEOUT_MS)
        const expression = isWait
          ? `(() => !!document.querySelector(${pagePayload(selector)}))()`
          : ASSERT_EXPRESSION(selector, op)
        const waitStartedAt = Date.now()
        let lastActual = '未知'
        let matched = false
        while (Date.now() - waitStartedAt <= timeoutMs) {
          const result = await controller.evaluateInTab(sessionId, tabId, expression)
          if (isWait) {
            if (result === true) { matched = true; break }
            lastActual = `${selector} 在 ${timeoutMs}ms 内未出现`
          } else {
            const assertion = result as { ok?: boolean; actual?: string } | null
            if (assertion && assertion.ok === true) { matched = true; break }
            lastActual = assertion?.actual ?? '断言求值失败'
          }
          await sleep(POLL_INTERVAL_MS)
        }
        if (!matched) {
          const expected = isWait ? `等待 ${selector} 出现`
            : op.type === 'assert-text' ? `文本包含「${op.contains}」`
            : op.type === 'assert-visible' ? `${selector} 可见`
            : `${selector} 数量 = ${op.count}`
          throw new GwtStepError(i, step, expected, lastActual, 'assert')
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
          failedStep: { index: e.stepIndex, kind: e.step.kind, text: e.step.text, expected: e.expected, actual: e.actual, category: e.category },
          screenshot,
          durationMs: Date.now() - startedAt,
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
      }
    }
    await sleep(STEP_SETTLE_MS)
  }

  return { ...base, status: 'pass', reason: null, durationMs: Date.now() - startedAt }
}

/** 步骤失败（带期望/实际与回炉归类，供分流） */
class GwtStepError extends Error {
  constructor(
    public readonly stepIndex: number,
    public readonly step: GwtStep,
    public readonly expected: string,
    public readonly actual: string,
    public readonly category: NonNullable<GwtFailedStep['category']>,
  ) {
    super(`步骤 ${stepIndex + 1} 失败：期望「${expected}」实际「${actual}」`)
  }
}

/** click/fill 目标元素执行期轮询：窗口内等元素出现并返回中心坐标（等不到返回 null） */
async function waitForClickable(
  controller: GwtBrowserAdapter, sessionId: string, tabId: string, selector: string, timeoutMs: number,
): Promise<{ x: number; y: number } | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const center = await controller.evaluateInTab(sessionId, tabId, CENTER_OF_EXPRESSION(selector))
      const point = center as { x: number; y: number } | null
      if (point && typeof point.x === 'number' && typeof point.y === 'number') return point
    } catch { /* 求值异常按未出现重试，窗口耗尽后由调用方判 fail */ }
    await sleep(POLL_INTERVAL_MS)
  }
  return null
}

/** click/fill 目标元素执行期轮询：窗口内等元素存在（等不到返回 false） */
async function waitForSelectorPresent(
  controller: GwtBrowserAdapter, sessionId: string, tabId: string, selector: string, timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const exists = await controller.evaluateInTab(sessionId, tabId, `(() => !!document.querySelector(${pagePayload(selector)}))()`)
      if (exists === true) return true
    } catch { /* 求值异常按未出现重试，窗口耗尽后由调用方判 fail */ }
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

/** 执行全套场景（不判定；判定归 judgeGwtResult） */
export async function runGwtSuite(options: GwtSuiteOptions): Promise<GwtScenarioResult[]> {
  const { controller, sessionId, entryHtmlPath, scenarios, onProgress } = options
  const results: GwtScenarioResult[] = []
  const tab = await controller.createLocalFileTab(sessionId, entryHtmlPath)
  let passed = 0
  let failed = 0
  let skipped = 0
  try {
    onProgress?.({ phase: 'start', current: 0, total: scenarios.length, passed: 0, failed: 0, skipped: 0 })
    for (let i = 0; i < scenarios.length; i++) {
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
    try { await controller.closeTab(sessionId, tab.tabId) } catch { /* 标签清理失败不影响结果 */ }
    // 标签恢复（AC Z-004）：切回测试创建前的用户活动标签，不留在任意残留标签上
    if (tab.previousActiveTabId && tab.previousActiveTabId !== tab.tabId) {
      try { controller.restoreDisplayTab?.(sessionId, tab.previousActiveTabId) } catch { /* 恢复失败不影响结果 */ }
    }
    onProgress?.({ phase: 'done', current: scenarios.length, total: scenarios.length, passed, failed, skipped })
  }
}

// ===== 编排入口（orchestrator 调用；读文件→执行→判定→报告→埋点） =====

/** GWT 测试重试上限（PRD §9.3：快消型退回上限 2 次；与 PhaseNode.retryLimit 一致） */
export const GWT_RETRY_LIMIT = 2

/**
 * 失败构成（v0.17.63 回炉分流，AC L-001）：
 * - behavior：assert 行为类失败（断言不满足/通道异常）→ 回炉 coding 改代码
 * - mapping：selector 等待超时/未映射类失败 → 回炉 testing 重写 steps.json 映射（不烧 coding 预算）
 * - coverage：US 覆盖缺失（无可执行场景 / PRD 缺 US-xx 清单 fail-fast）→ 补场景或回 requirements
 */
export type GwtFailureKind = 'behavior' | 'mapping' | 'coverage'

/** 从场景结果归纳失败构成（纯函数；verdict=pass 时返回 null） */
export function classifyGwtFailure(results: Array<Pick<GwtScenarioResult, 'status' | 'failedStep'>>): GwtFailureKind | null {
  const failedResults = results.filter((r) => r.status === 'fail')
  if (failedResults.length === 0) return 'coverage'
  const isMapping = (r: (typeof failedResults)[number]) => r.failedStep?.category === 'selector-wait' || r.failedStep?.category === 'unmapped'
  // 混合失败时优先 behavior：真实缺陷修复后映射类失败常一并消失（元素本该存在），
  // 避免先重映射再发现代码坏了的两跳回炉
  return failedResults.some((r) => !isMapping(r)) ? 'behavior' : 'mapping'
}

export interface NanjuGwtOutcome {
  verdict: 'pass' | 'fail' | 'error'
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
  + '请向用户发起【交付验收】询问：用 AskUserQuestion 弹问，question「应用已完成并通过自动测试，可以交付使用。你用过了吗？」，'
  + 'options 两项：「满意交付」（可以交付使用）/「需要调整」（说明问题，回炉修复后重新测试）。'
  + '用户选满意交付或明确表达满意/确认交付 → 立即输出 <!-- PHASE_ADVANCE: delivered --> 完成交付'
  + '（交付门禁校验 verdict=pass 已满足，不要重新委派、不要重复产出、不要再询问）。'
  + '用户选需要调整或描述问题 → 按意见收集轮收集修改意见（可引导用户点选右侧预览元素精准定位，逐条确认理解、收齐后统一改），'
  + '收齐后 continue_delegation 委派「全栈开发」修复 08_APP/ 下的代码（不动 06_TESTS/ 与 01_PRD/），'
  + '修复完成后输出 <!-- PHASE_ADVANCE: testing --> 重跑自动测试（回炉预算 ≤2 次由系统计数，超限系统转人工）。'

export async function runNanjuGwtAcceptance(input: {
  workspaceSlug: string
  projectId: string
  projectName: string
  projectMode: 'quick' | 'iterative'
  sessionId: string
  controller: GwtBrowserAdapter
  onProgress?: (event: GwtProgressEvent) => void
}): Promise<NanjuGwtOutcome> {
  const projectDir = getNanjuProjectDir(input.workspaceSlug, input.projectId)
  const featuresDir = join(projectDir, '06_TESTS', 'features')
  const reportJsonPath = join(projectDir, '06_TESTS', 'report.json')

  // 1. 加载全部 steps.json（schema 校验；非法文件 → 记录为 skip 场景透明展示）
  const scenarios: GwtScenarioFile[] = []
  if (existsSync(featuresDir)) {
    for (const file of readdirSync(featuresDir).filter((f) => f.endsWith('.steps.json')).sort()) {
      try {
        const raw = readFileSync(join(featuresDir, file), 'utf-8')
        const { scenario, errors } = validateScenarioFileContent(raw)
        if (scenario && errors.length === 0) {
          scenarios.push(scenario)
        } else {
          scenarios.push({
            feature: file.replace(/\.steps\.json$/, ''),
            scenario: `（文件 ${file} 校验失败）`,
            skip: true,
            skipReason: `schema 校验失败：${errors.slice(0, 3).join('；')}`,
            steps: [],
          })
        }
      } catch (e) {
        scenarios.push({
          feature: file.replace(/\.steps\.json$/, ''),
          scenario: `（文件 ${file} 读取失败）`,
          skip: true,
          skipReason: `读取失败：${e instanceof Error ? e.message : String(e)}`,
          steps: [],
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
  if (existsSync(reportJsonPath)) {
    try {
      const prev = JSON.parse(readFileSync(reportJsonPath, 'utf-8')) as { retryCount?: number; errorCount?: number; verdict?: string }
      prevRetryCount = typeof prev.retryCount === 'number' ? prev.retryCount : 0
      prevErrorCount = typeof prev.errorCount === 'number' ? prev.errorCount : 0
      prevFailed = prev.verdict === 'fail' || prev.verdict === 'error'
    } catch { /* 损坏报告按首次处理 */ }
  }
  const retryCount = prevFailed ? prevRetryCount + 1 : 0

  // 4. 执行（三种确定态，均不向上抛异常：正常结果 / 覆盖性基准缺失 fail-fast / 执行异常 error）
  const entryHtmlPath = join(projectDir, '08_APP', 'index.html')
  const screenshotDir = join(projectDir, '06_TESTS', 'screenshots')
  let results: GwtScenarioResult[] = []
  let errorReason: string | null = null
  if (prdUserStoriesMissing) {
    // PRD 缺 US-xx 清单：覆盖性无法判定，不执行浏览器步骤（fail-fast，AC F-002）
  } else if (scenarios.length > 0 && existsSync(entryHtmlPath)) {
    try {
      results = await runGwtSuite({
        sessionId: input.sessionId,
        entryHtmlPath,
        scenarios,
        controller: input.controller,
        screenshotDir,
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

  // 5. 规则裁判 + 报告
  const judgement = judgeGwtResult(results, userStories)
  const failureKind = errorReason
    ? null
    : prdUserStoriesMissing
      ? 'coverage'
      : judgement.verdict === 'fail'
        ? classifyGwtFailure(results)
        : null
  const verdict: NanjuGwtOutcome['verdict'] = errorReason ? 'error' : judgement.verdict
  // 独立异常计数（#6）：仅 error 轮累计，pass 轮清零（与 retryCount 的非 pass 合计口径并存）
  const errorCount = verdict === 'pass'
    ? 0
    : verdict === 'error'
      ? (prevFailed ? prevErrorCount : 0) + 1
      : (prevFailed ? prevErrorCount : 0)
  const report: GwtReportJson = {
    generatedAt: new Date().toISOString(),
    verdict,
    failureKind,
    prdUserStoriesMissing: prdUserStoriesMissing || undefined,
    errorReason,
    entry: '08_APP/index.html',
    scenariosTotal: judgement.scenariosTotal,
    passed: judgement.passed,
    failed: judgement.failed,
    skipped: judgement.skipped,
    coveredUs: judgement.coveredUs,
    uncoveredUs: judgement.uncoveredUs,
    retryCount,
    errorCount,
    scenarios: results.map((r) => ({
      feature: r.feature, scenario: r.scenario, status: r.status, reason: r.reason,
      failedStep: r.failedStep, screenshot: r.screenshot, durationMs: r.durationMs,
    })),
  }
  writeJsonFileAtomic(reportJsonPath, report)
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stampText = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
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
      mapping_fail: results.filter((r) => r.failedStep?.category === 'selector-wait' || r.failedStep?.category === 'unmapped').length,
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
    const kindTag = fs?.category === 'selector-wait' || fs?.category === 'unmapped' ? '（映射类：目标元素未出现或未映射）' : ''
    failLines.push(`${i + 1}. [${r.feature}] ${r.scenario} — 步骤 ${(fs?.index ?? 0) + 1}（${fs?.kind ?? ''}：${fs?.text ?? ''}）：期望「${fs?.expected ?? ''}」实际「${fs?.actual ?? r.reason ?? ''}」${kindTag}${r.screenshot ? `（截图 ${r.screenshot}）` : ''}`)
  })
  if (!prdUserStoriesMissing && judgement.uncoveredUs.length > 0) {
    failLines.push(`用户故事 ${judgement.uncoveredUs.join('、')} 没有可执行场景（全部 skip），覆盖不完整。`)
  }
  if (errorReason) {
    failLines.push(`执行异常：${errorReason}`)
  }

  // 摘要口径（AC U-001/F-002）：PRD 缺 US 清单与执行异常用专用句式，不用普通 fail 文案
  const summaryText = errorReason
    ? `⚠️ 验收测试执行异常：${errorReason}。请检查 08_APP/index.html 与 06_TESTS/ 产物完整性后重跑。测试报告：${reportMdPath}`
    : prdUserStoriesMissing
      ? `❌ PRD 未提取到 US-xx 用户故事清单，覆盖性无法判定（验收硬约束要求每条用户故事有可执行场景）。请补充 PRD 用户故事清单后重跑。测试报告：${reportMdPath}`
      : buildSummaryText(judgement, reportMdPath)

  return {
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
