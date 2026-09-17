/**
 * GWT 验收测试执行器单测（P1 Sprint B：v0.17.62）
 *
 * 覆盖面：
 * - 纯函数：selector 归一 / steps.json schema 校验 / PRD US 提取 / 规则裁判 / 报告生成
 * - 执行器（mock BrowserController）：全 op 类型执行 / 断言超时 fail / click 等待超时 selector-wait /
 *   动态 UI 轮询等待 / 场景声明 skip / 场景隔离重载 / 失败截图 / 标签恢复 / 进度事件序列
 * - 编排入口（runNanjuGwtAcceptance）：报告 schema（report.json）/ retryCount 累计 /
 *   judge.verdict 埋点落盘 / 入口缺失降级
 *
 * config-paths 按 nanju-router-gate.test.ts 既有模式 mock.module 指向 tmpdir。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** 当前 fixture 根目录（mock 的 getWorkspaceFilesDir 每次调用时读取） */
let fixtureRoot = ''

// partial mock：spread 真实模块后再覆盖路径函数。
// bun 的 mock.module 全局生效（跨测试文件），全量替换会让后续加载的
// nanju-ipc 链路（chat-tools-watcher → getChatToolsConfigPath）炸掉——
// 只覆盖需要的两个导出，其余保持真实实现。
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const {
  normalizeGwtSelector,
  validateScenarioFileContent,
  parseUserStories,
  scenarioUserStory,
  judgeGwtResult,
  buildReportMarkdown,
  buildSummaryText,
  buildGwtDeliveryAcceptanceMessage,
  GWT_DELIVERY_ACCEPTANCE_RESUME_MESSAGE,
  runGwtSuite,
  runNanjuGwtAcceptance,
  GWT_RETRY_LIMIT,
  GWT_STEPS_SCHEMA_VERSION,
  GWT_FILL_VALUE_MAX_CHARS,
  computeScreenshotDiffRatio,
} = await import('./nanju-gwt-runner')
import type { GwtBrowserAdapter, GwtScenarioFile, GwtProgressEvent, NanjuGwtOutcome } from './nanju-gwt-runner'

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

// ===== FakePage：按模板表达式特征模拟 DOM 状态 =====
// W22：支持 selector 三档（css / #id / aria-label 属性匹配）、新 op 表达式特征、
// 可信输入链路（insertTextInTab 写值 / strictTrust 受控组件拒绝合成事件）。

interface FakeElement {
  visible: boolean
  text: string
  /** 坐标（CENTER_OF mock 返回；同一坐标的 click 会 toggle checkbox/radio） */
  x?: number
  y?: number
  /** input/textarea/select 类型标记（check/checkable、select 原生性判定用） */
  tag?: 'input-checkbox' | 'input-radio' | 'input-text' | 'select' | 'div' | 'textarea' | 'contenteditable'
  /** select 的 option 列表（value/label 对） */
  options?: Array<{ value: string; label: string }>
}

class FakePage {
  elements = new Map<string, FakeElement>()
  /** 二档 selector 命中多元素的场景（querySelectorAll !== 1 → ambiguous） */
  ambiguousSelectors = new Set<string>()
  /** 元素当前值（fill 链路读写 / select 回读） */
  values = new Map<string, string>()
  /** 勾选态（checkbox/radio） */
  checked = new Map<string, boolean>()
  /** 可信输入记录：insertTextInTab 调用（模拟真实编辑管线写入） */
  insertTexts: Array<{ key: string; text: string }> = []
  /** 受控组件模式：合成事件通道（FILL_FALLBACK）被拒绝，仅 insertText 可写（旧实现必挂范式） */
  strictTrust = new Set<string>()
  clicks: Array<{ x: number; y: number }> = []
  hovers: Array<{ x: number; y: number }> = []
  wheels: Array<{ deltaX: number; deltaY: number }> = []
  jsScrolls: number[] = []
  keys: string[] = []
  fills: Array<{ selector: string; text: string }> = []
  /** loadFileInTab 调用计数（场景隔离验证） */
  reloads = 0
  /** 视口截图 mock（W22 F4）：返回固定 PNG buffer；设为 'throw' 模拟截图失败 */
  viewportPng: Buffer | 'throw' = makeSolidPng(2, 2, [200, 200, 200])
  viewportMeta = { width: 375, height: 667, dpr: 2 }

  private strings(expr: string): string[] {
    const out: string[] = []
    for (const m of expr.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      try { out.push(JSON.parse(`"${m[1]}"`)) } catch { /* 非法 JSON 串跳过 */ }
    }
    return out
  }

  /** 从表达式提取元素 key：aria-label 档用属性值形态（find 片段在模板最前，label 恒为首个 JSON 串），其余用首个 JSON 字符串（css/#id） */
  private keyOf(expr: string): string {
    const strings = this.strings(expr)
    if (expr.includes("getAttribute('aria-label')")) {
      return `[aria-label="${strings[0] ?? ''}"]`
    }
    return strings[0] ?? ''
  }

  eval(expr: string): unknown {
    const key = this.keyOf(expr)
    const el = this.elements.get(key)
    const exists = !!el || this.ambiguousSelectors.has(key)
    const ambiguous = this.ambiguousSelectors.has(key)

    // ---- W22 新模板特征 ----
    // fill 聚焦+全选（FILL_FOCUS_SELECT）
    if (expr.includes('selectNodeContents') || (expr.includes('el.select()') && expr.includes('focus('))) {
      if (!exists) return { code: 'missing' }
      if (ambiguous) return { code: 'ambiguous', count: 2 }
      if (el?.tag === 'div') return { code: 'not-editable' }
      this.values.set('focused', key) // 记录当前聚焦元素（insertTextInTab mock 消费）
      return { code: 'ok', kind: el?.tag === 'contenteditable' ? 'contenteditable' : 'value' }
    }
    // fill 回读（FILL_READ_VALUE；特征收紧避免吞 select 模板的 el.value setter/回读）
    if (expr.includes('return { value: el.value }') || expr.includes("el.textContent ?? ''}")) {
      if (!exists) return { value: null }
      return { value: this.values.get(key) ?? '' }
    }
    // fill 回退链（FILL_FALLBACK：旧 native-setter+合成事件通道；InputEvent 为模板独有特征，区别于 select 的 Event 派发）
    if (expr.includes('new InputEvent')) {
      this.fills.push({ selector: key, text: this.strings(expr)[this.strings(expr).length - 1] ?? '' })
      if (!exists) return { ok: false, error: '未找到元素' }
      if (el?.tag === 'div') return { ok: false, error: '目标不是可编辑元素' }
      if (this.strictTrust.has(key)) return { ok: false, error: 'isTrusted=false 合成事件被受控组件拒绝（模拟）' }
      this.values.set(key, this.fills[this.fills.length - 1]!.text)
      return { ok: true }
    }
    // check/uncheck 读态（CHECK_STATE）
    if (expr.includes("el.type !== 'checkbox'")) {
      if (!exists) return { code: 'missing' }
      if (ambiguous) return { code: 'ambiguous', count: 2 }
      if (el?.tag !== 'input-checkbox' && el?.tag !== 'input-radio') return { code: 'not-checkable' }
      return { code: 'ok', checked: this.checked.get(key) === true, type: el.tag === 'input-radio' ? 'radio' : 'checkbox' }
    }
    // select（SELECT_EXPRESSION）
    if (expr.includes('HTMLSelectElement')) {
      if (!exists) return { code: 'missing' }
      if (ambiguous) return { code: 'ambiguous', count: 2 }
      if (el?.tag !== 'select') return { code: 'not-native-select', error: '目标不是原生 <select>（自定义下拉请改用 click 序列：先 click 展开，再 click 选项）' }
      const value = this.strings(expr)[this.strings(expr).length - 1] ?? ''
      const opt = el.options?.find((o) => o.value === value) ?? el.options?.find((o) => o.label === value)
      if (!opt) return { code: 'option-missing', error: '未找到匹配 option（按 value 与 label 均未命中）' }
      this.values.set(key, opt.value)
      return { code: 'ok', value: opt.value }
    }
    // focus op（FOCUS_EXPRESSION；排除 FILL_FOCUS 模板同有的 focus-failed 字样）
    if (expr.includes('focus-failed') && !expr.includes('el.select()') && !expr.includes('selectNodeContents')) {
      if (!exists) return { code: 'missing' }
      if (ambiguous) return { code: 'ambiguous', count: 2 }
      if (el?.tag === 'div' && el.text === 'unfocusable') return { code: 'focus-failed' }
      return { code: 'ok' }
    }
    // JS 滚动回退（JS_SCROLL_EXPRESSION）
    if (expr.includes('scrollBy')) {
      this.jsScrolls.push(Number(/scrollBy\(0, (-?\d+(?:\.\d+)?)\)/.exec(expr)?.[1] ?? 0))
      return { ok: true }
    }

    // ---- 旧有模板特征 ----
    if (expr.includes('getBoundingClientRect')) {
      if (!exists) return null
      if (ambiguous) return { ambiguous: true, count: 2 }
      const x = el?.x ?? 8
      const y = el?.y ?? 16
      return { x, y }
    }
    if (expr.startsWith('(() =>') && expr.trim().endsWith('.length > 0)()')) {
      return exists
    }
    // 完整断言模板（特征：els.length === 0 分支；strings = [selector, kind, contains?]）
    if (expr.includes('els.length === 0')) {
      const strings = this.strings(expr)
      const kind = strings[1] ?? ''
      if (!exists) return { ok: false, actual: '元素不存在' }
      if (ambiguous) return { ok: false, actual: '选择器命中 2 个元素（不唯一，禁止取首个）' }
      if (kind === 'selector') return { ok: true, actual: '元素存在' }
      if (kind === 'visible') {
        const visible = el?.visible === true
        return { ok: visible, actual: visible ? '元素可见' : '元素不可见' }
      }
      if (kind === 'count') {
        const n = 1
        const expectMatch = /n === (\d+)/.exec(expr)
        const expect = expectMatch ? Number(expectMatch[1]) : 0
        return { ok: n === expect, actual: `数量 ${n}` }
      }
      // contains 取模板最后一个 JSON 字符串（text 分支的 expect；kind 字符串会出现多次）
      const contains = strings[strings.length - 1] ?? ''
      const text = el?.text ?? ''
      const ok = text.includes(contains)
      return { ok, actual: JSON.stringify(text).slice(0, 120) }
    }
    return undefined
  }
}

/** 生成纯色小 PNG（W22 F4 像素比对测试用） */
function makeSolidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const { PNG } = require('pngjs') as typeof import('pngjs')
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0]
    png.data[i * 4 + 1] = rgb[1]
    png.data[i * 4 + 2] = rgb[2]
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

function makeMockController(page: FakePage): GwtBrowserAdapter {
  return {
    createLocalFileTab: async () => ({ tabId: 'tab-gwt-1' }),
    loadFileInTab: async () => { page.reloads += 1 },
    evaluateInTab: async (_sessionId, _tabId, expr) => page.eval(expr),
    clickPointInTab: async (_sessionId, _tabId, x, y) => {
      page.clicks.push({ x, y })
      // 可信点击语义：坐标命中 checkbox/radio 时切换勾选态（真实浏览器行为模拟）
      for (const [key, el] of page.elements) {
      if (((el.x ?? 8) === x && (el.y ?? 16) === y) && (el.tag === 'input-checkbox' || el.tag === 'input-radio')) {
        page.checked.set(key, !(page.checked.get(key) === true))
      }
      }
    },
    pressKeyInTab: async (_sessionId, _tabId, key) => { page.keys.push(key) },
    insertTextInTab: async (_sessionId, _tabId, text) => {
      // 模拟 insertText 未生效（页面被遮挡/非聚焦等），触发回退链
      if (page.values.get('insert-text-broken') === 'yes') return
      // 真实编辑管线模拟：写入当前聚焦元素（FILL_FOCUS_SELECT mock 记录的 focused）
      const key = page.values.get('focused') ?? ''
      if (key) {
        page.insertTexts.push({ key, text })
        page.values.set(key, text) // 全选后 insertText 覆盖写（非追加）
      }
    },
    hoverPointInTab: async (_sessionId, _tabId, x, y) => { page.hovers.push({ x, y }) },
    wheelInTab: async (_sessionId, _tabId, deltaX, deltaY) => {
      if (page.values.get('wheel-throws') === 'yes') throw new Error('mouseWheel 不可用（模拟）')
      page.wheels.push({ deltaX, deltaY })
    },
    captureViewportPngInTab: async () => {
      if (page.viewportPng === 'throw') throw new Error('Page.captureScreenshot 失败（模拟）')
      return { base64: page.viewportPng.toString('base64'), ...page.viewportMeta }
    },
    screenshot: async () => ({ base64: Buffer.from('fake-png-bytes').toString('base64') }),
    closeTab: async () => null,
  }
}

/** 标准读书笔记场景（全 op 类型） */
function noteScenario(overrides: Partial<GwtScenarioFile> = {}): GwtScenarioFile {
  return {
    feature: 'us-01',
    scenario: 'US-01 成功添加一条读书笔记',
    skip: false,
    skipReason: null,
    steps: [
      { kind: 'given', text: '用户在笔记列表页面', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } },
      { kind: 'when', text: '用户输入书名「百年孤独」', op: { type: 'fill', selector: 'data-ai-id=input-title', value: '百年孤独' } },
      { kind: 'when', text: '用户点击「保存」按钮', op: { type: 'click', selector: 'data-ai-id=btn-save' } },
      { kind: 'when', text: '用户按回车确认', op: { type: 'press', value: 'Enter' } },
      { kind: 'when', text: '等待列表刷新', op: { type: 'wait-selector', selector: 'data-ai-id=view-note-list', timeoutMs: 2000 } },
      { kind: 'then', text: '笔记列表中显示「百年孤独」', op: { type: 'assert-text', selector: 'data-ai-id=view-note-list', contains: '百年孤独', timeoutMs: 300 } },
    ],
    ...overrides,
  }
}

// ===== selector 归一 =====

describe('normalizeGwtSelector（W22 F3 三档）', () => {
  test('data-ai-id 主档三种写法统一归一（含宽松空格形态）', () => {
    expect(normalizeGwtSelector('data-ai-id=btn-save')).toEqual({ tier: 'data-ai-id', css: '[data-ai-id="btn-save"]', value: 'btn-save' })
    expect(normalizeGwtSelector('[data-ai-id="btn-save"]')).toEqual({ tier: 'data-ai-id', css: '[data-ai-id="btn-save"]', value: 'btn-save' })
    expect(normalizeGwtSelector("[data-ai-id='btn-save']")).toEqual({ tier: 'data-ai-id', css: '[data-ai-id="btn-save"]', value: 'btn-save' })
    expect(normalizeGwtSelector('  data-ai-id = input-title  ')).toEqual({ tier: 'data-ai-id', css: '[data-ai-id="input-title"]', value: 'input-title' })
  })

  test('#id 二档：合法标识符接受；React useId 的 :r1: / 数字开头 / 含空格拒绝', () => {
    expect(normalizeGwtSelector('#main-input')).toEqual({ tier: 'id', css: '#main-input', value: 'main-input' })
    expect(normalizeGwtSelector('#save_btn-1')).toEqual({ tier: 'id', css: '#save_btn-1', value: 'save_btn-1' })
    expect(normalizeGwtSelector('#:r1:')).toBeNull()      // React useId 非法 CSS 标识符
    expect(normalizeGwtSelector('#1abc')).toBeNull()      // 数字开头
    expect(normalizeGwtSelector('#a b')).toBeNull()       // 含空格
  })

  test('[aria-label="…"] 二档：属性相等匹配不拼 CSS（css=null），≤60 字符，空值/换行拒绝', () => {
    expect(normalizeGwtSelector('[aria-label="提交表单"]')).toEqual({ tier: 'aria-label', css: null, value: '提交表单' })
    expect(normalizeGwtSelector('[aria-label=""]')).toBeNull()
    expect(normalizeGwtSelector(`[aria-label="${'长'.repeat(61)}"]`)).toBeNull()
  })

  test('非法形态返回 null（不开放自由 CSS 的防脆弱设计保留）', () => {
    expect(normalizeGwtSelector('#main .btn')).toBeNull()
    expect(normalizeGwtSelector('data-ai-id=1abc')).toBeNull()          // 首字符非字母
    expect(normalizeGwtSelector('data-ai-id=a b')).toBeNull()           // 含空格
    expect(normalizeGwtSelector('[data-ai-id="ok"] .child')).toBeNull() // 复合选择器
    expect(normalizeGwtSelector('.btn')).toBeNull()
    expect(normalizeGwtSelector('')).toBeNull()
  })
})

// ===== steps.json schema 校验 =====

describe('validateScenarioFileContent', () => {
  test('合法文件通过校验', () => {
    const { scenario, errors } = validateScenarioFileContent(JSON.stringify(noteScenario()))
    expect(errors).toEqual([])
    expect(scenario?.feature).toBe('us-01')
    expect(scenario?.steps.length).toBe(6)
  })

  test('JSON 损坏返回解析错误', () => {
    const { scenario, errors } = validateScenarioFileContent('{broken')
    expect(scenario).toBeNull()
    expect(errors[0]).toContain('JSON 解析失败')
  })

  test('op.type 白名单外拒绝', () => {
    const raw = JSON.stringify({ ...noteScenario(), steps: [{ kind: 'when', text: 'x', op: { type: 'navigate', selector: 'data-ai-id=a' } }] })
    const { errors } = validateScenarioFileContent(raw)
    expect(errors.some((e) => e.includes('白名单'))).toBe(true)
  })

  test('click 缺 selector 拒绝；selector 非法（任意 CSS）拒绝', () => {
    const noSel = JSON.stringify({ ...noteScenario(), steps: [{ kind: 'when', text: 'x', op: { type: 'click' } }] })
    expect(validateScenarioFileContent(noSel).errors.some((e) => e.includes('selector'))).toBe(true)
    const badSel = JSON.stringify({ ...noteScenario(), steps: [{ kind: 'when', text: 'x', op: { type: 'click', selector: '#main .btn' } }] })
    expect(validateScenarioFileContent(badSel).errors.some((e) => e.includes('非法'))).toBe(true)
  })

  test('op=null 必须显式 unmapped:true', () => {
    const raw = JSON.stringify({ ...noteScenario(), steps: [{ kind: 'given', text: 'x', op: null }] })
    expect(validateScenarioFileContent(raw).errors.some((e) => e.includes('unmapped'))).toBe(true)
  })

  test('op.type=eval 已移出白名单：含 expression 的 eval op 直接拒绝（安全通道关闭）', () => {
    const raw = JSON.stringify({ ...noteScenario(), steps: [{ kind: 'then', text: 'x', op: { type: 'eval', expression: 'true' } }] })
    const { errors } = validateScenarioFileContent(raw)
    expect(errors.some((e) => e.includes('白名单'))).toBe(true)
  })

  test('assert-count 需要 count 非负整数', () => {
    const bad = JSON.stringify({ ...noteScenario(), steps: [{ kind: 'then', text: 'x', op: { type: 'assert-count', selector: 'data-ai-id=a', count: -1 } }] })
    expect(validateScenarioFileContent(bad).errors.length).toBeGreaterThan(0)
  })

  test('steps 空数组拒绝', () => {
    const raw = JSON.stringify({ feature: 'us-01', scenario: 's', skip: false, skipReason: null, steps: [] })
    expect(validateScenarioFileContent(raw).errors[0]).toContain('非空数组')
  })
})

// ===== PRD 用户故事提取 =====

describe('parseUserStories / scenarioUserStory', () => {
  test('提取 US-xx 并两位化去重保序', () => {
    expect(parseUserStories('## US-1 添加笔记\n### US-02 删除\n再看 US-1')).toEqual(['US-01', 'US-02'])
    expect(parseUserStories('没有故事')).toEqual([])
  })

  test('场景标识优先从 scenario 匹配，兜底 feature', () => {
    expect(scenarioUserStory({ feature: 'us-01', scenario: 'US-02 保存场景' })).toBe('US-02')
    expect(scenarioUserStory({ feature: 'us-03', scenario: '边界场景' })).toBe('US-03')
    expect(scenarioUserStory({ feature: 'misc', scenario: '无标识' })).toBeNull()
  })
})

// ===== 规则裁判 =====

describe('judgeGwtResult（裁判=规则非模型）', () => {
  const us = ['US-01', 'US-02']
  const r = (feature: string, scenario: string, status: 'pass' | 'fail' | 'skip') => ({ feature, scenario, status })

  test('全场景通过 + US 全覆盖 = pass', () => {
    const j = judgeGwtResult([r('us-01', 'US-01 添加', 'pass'), r('us-02', 'US-02 删除', 'pass')], us)
    expect(j.verdict).toBe('pass')
    expect(j.passed).toBe(2)
    expect(j.uncoveredUs).toEqual([])
  })

  test('任一场景失败 = fail', () => {
    const j = judgeGwtResult([r('us-01', 'US-01 添加', 'pass'), r('us-02', 'US-02 删除', 'fail')], us)
    expect(j.verdict).toBe('fail')
    expect(j.failed).toBe(1)
  })

  test('用户故事无覆盖（全 skip）= fail（覆盖性硬约束）', () => {
    const j = judgeGwtResult([r('us-01', 'US-01 添加', 'skip'), r('us-02', 'US-02 删除', 'pass')], us)
    expect(j.verdict).toBe('fail')
    expect(j.uncoveredUs).toEqual(['US-01'])
    expect(j.coveredUs).toEqual(['US-02'])
  })

  test('零场景 = fail（空报告不允许交付）', () => {
    expect(judgeGwtResult([], us).verdict).toBe('fail')
  })

  test('skip 场景不计入通过性但保持透明统计', () => {
    const j = judgeGwtResult([r('us-01', 'US-01 a', 'pass'), r('us-01', 'US-01 b', 'skip')], ['US-01'])
    expect(j.verdict).toBe('pass')
    expect(j.skipped).toBe(1)
  })
})

// ===== 报告生成 =====

describe('buildReportMarkdown / buildSummaryText', () => {
  test('pass 摘要自然语言口径', () => {
    const j = judgeGwtResult([{ feature: 'us-01', scenario: 'US-01 a', status: 'pass' }], ['US-01'])
    expect(buildSummaryText(j, '06_TESTS/report-x.md')).toContain('我们测试了 1 个场景，全部通过')
    expect(buildSummaryText(j, '06_TESTS/report-x.md')).toContain('覆盖 1 条用户故事')
  })

  test('fail 摘要含失败数与未覆盖清单', () => {
    const j = judgeGwtResult([
      { feature: 'us-01', scenario: 'US-01 a', status: 'pass' },
      { feature: 'us-01', scenario: 'US-01 b', status: 'fail' },
    ], ['US-01', 'US-02'])
    const s = buildSummaryText(j, 'r.md')
    expect(s).toContain('2 个场景中 1 个失败')
    expect(s).toContain('US-02 无可执行场景')
  })

  test('报告 md 含判定/统计/明细表；纯覆盖性失败用覆盖不全句式（AC U-001）', () => {
    const j = judgeGwtResult([{ feature: 'us-01', scenario: 'US-01 a', status: 'pass' }], ['US-01'])
    const md = buildReportMarkdown({
      generatedAt: '2026-08-22T00:00:00.000Z',
      verdict: j.verdict, failureKind: null, entry: '08_APP/index.html',
      scenariosTotal: j.scenariosTotal, passed: j.passed, failed: j.failed, skipped: j.skipped,
      coveredUs: j.coveredUs, uncoveredUs: j.uncoveredUs, retryCount: 0,
      scenarios: [{ feature: 'us-01', scenario: 'US-01 a', status: 'pass', reason: null, failedStep: null, screenshot: null, durationMs: 10 }],
    }, '测试项目')
    expect(md).toContain('# 验收测试报告 — 测试项目')
    expect(md).toContain('✅ 全部通过')
    expect(md).toContain('| 1 | us-01 / US-01 a | ✅ pass |')
    // 覆盖性失败单独句式：不输出与「0 个失败」并列的裸「未通过」
    const cov = judgeGwtResult([{ feature: 'us-01', scenario: 'US-01 a', status: 'pass' }], ['US-01', 'US-02'])
    const covMd = buildReportMarkdown({
      generatedAt: '2026-08-22T00:00:00.000Z',
      verdict: cov.verdict, failureKind: 'coverage', entry: '08_APP/index.html',
      scenariosTotal: cov.scenariosTotal, passed: cov.passed, failed: cov.failed, skipped: cov.skipped,
      coveredUs: cov.coveredUs, uncoveredUs: cov.uncoveredUs, retryCount: 0,
      scenarios: [{ feature: 'us-01', scenario: 'US-01 a', status: 'pass', reason: null, failedStep: null, screenshot: null, durationMs: 10 }],
    }, '测试项目')
    expect(covMd).toContain('❌ 未通过（覆盖不全：有用户故事无可执行场景）')
    // error 报告句式
    const errMd = buildReportMarkdown({
      generatedAt: '2026-08-22T00:00:00.000Z',
      verdict: 'error', failureKind: null, errorReason: 'CDP 断连', entry: '08_APP/index.html',
      scenariosTotal: 0, passed: 0, failed: 0, skipped: 0, coveredUs: [], uncoveredUs: [], retryCount: 0,
      scenarios: [],
    }, '测试项目')
    expect(errMd).toContain('⚠️ 执行异常（CDP 断连）')
  })

  test('纯覆盖性失败摘要单独句式，不输出「0 个失败」自相矛盾（AC U-001）', () => {
    const j = judgeGwtResult([{ feature: 'us-01', scenario: 'US-01 a', status: 'pass' }], ['US-01', 'US-02'])
    const s = buildSummaryText(j, 'r.md')
    expect(s).toContain('覆盖不全')
    expect(s).toContain('US-02 没有可执行场景')
    expect(s.includes('0 个失败')).toBe(false)
  })
})

// ===== 执行器（mock controller） =====

describe('runGwtSuite（mock BrowserController）', () => {
  test('全 op 类型执行：click/fill/press/wait-selector/assert 均触达，场景 pass', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="view-note-list"]', { visible: true, text: '百年孤独' })
    page.elements.set('[data-ai-id="input-title"]', { visible: true, text: '', tag: 'input-text' })
    page.elements.set('[data-ai-id="btn-save"]', { visible: true, text: '保存' })
    const events: GwtProgressEvent[] = []
    const results = await runGwtSuite({
      sessionId: 's1',
      entryHtmlPath: '/tmp/app/index.html',
      scenarios: [noteScenario()],
      controller: makeMockController(page),
      screenshotDir: null,
      onProgress: (e) => events.push(e),
    })
    expect(results[0]?.status).toBe('pass')
    // W22 F1：fill 走可信链路 insertTextInTab（覆盖写）；旧合成事件通道未被触发
    expect(page.insertTexts).toEqual([{ key: '[data-ai-id="input-title"]', text: '百年孤独' }])
    expect(page.fills).toEqual([])
    expect(page.clicks.length).toBe(1)
    expect(page.keys).toEqual(['Enter'])
    // 进度事件序列：start → scenario-start → scenario-end → done
    expect(events.map((e) => e.phase)).toEqual(['start', 'scenario-start', 'scenario-end', 'done'])
    expect(events[2]?.scenarioStatus).toBe('pass')
  })

  test('断言超时：窗口内不满足 → fail + failedStep 期望/实际', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="view-note-list"]', { visible: true, text: '（空列表）' })
    const results = await runGwtSuite({
      sessionId: 's1',
      entryHtmlPath: '/tmp/app/index.html',
      scenarios: [noteScenario({ steps: [{ kind: 'then', text: '显示「百年孤独」', op: { type: 'assert-text', selector: 'data-ai-id=view-note-list', contains: '百年孤独', timeoutMs: 60 } }] })],
      controller: makeMockController(page),
      screenshotDir: null,
    })
    const r = results[0]!
    expect(r.status).toBe('fail')
    expect(r.failedStep?.expected).toContain('百年孤独')
    expect(r.failedStep?.actual).toContain('（空列表）')
    expect(r.reason).toContain('期望')
  })

  test('click 目标等待超时：8s 轮询窗口内未出现 → fail「等待超时未出现」（selector-wait，映射类）', async () => {
    const page = new FakePage()
    // btn-missing 未注册 → 执行期轮询窗口耗尽后判 fail（不再预检 unmapped-skip）
    const results = await runGwtSuite({
      sessionId: 's1',
      entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 添加', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '点击保存', op: { type: 'click', selector: 'data-ai-id=btn-missing' }, timeoutMs: 80 }],
      }],
      controller: makeMockController(page),
      screenshotDir: null,
    })
    const r = results[0]!
    expect(r.status).toBe('fail')
    expect(r.failedStep?.actual).toContain('等待超时未出现')
    expect(r.failedStep?.category).toBe('selector-wait')
    expect(page.clicks.length).toBe(0) // 未执行任何 click（不执行半截）
  })

  test('动态 UI：click 目标延迟出现 → 执行期轮询等待成功（预检语义已移除，AC Z-002）', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="btn-late"]', { visible: true, text: '保存' })
    // btn-late 前两次探测不存在（模拟先点开弹层/二级页再操作其中元素的渐进式 UI）
    let probes = 0
    const base = makeMockController(page)
    const controller: GwtBrowserAdapter = {
      ...base,
      evaluateInTab: async (s, t, expr) => {
        if (expr.includes('btn-late') && !expr.includes('dispatchEvent')) {
          probes += 1
          if (probes <= 2) return expr.includes('getBoundingClientRect') ? null : false
        }
        return base.evaluateInTab(s, t, expr)
      },
    }
    const results = await runGwtSuite({
      sessionId: 's1',
      entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 动态弹层', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '点击弹层内按钮', op: { type: 'click', selector: 'data-ai-id=btn-late' }, timeoutMs: 3_000 }],
      }],
      controller,
      screenshotDir: null,
    })
    expect(probes).toBeGreaterThanOrEqual(3) // 至少重试探测到出现
    expect(results[0]?.status).toBe('pass')
    expect(page.clicks.length).toBe(1)
  })

  test('fill 目标等待超时 → fail selector-wait；fill 到非可编辑元素 → fail assert', async () => {
    const page = new FakePage()
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 输入', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '输入书名', op: { type: 'fill', selector: 'data-ai-id=input-missing', value: 'x' }, timeoutMs: 80 }],
      }],
      controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('fail')
    expect(results[0]?.failedStep?.category).toBe('selector-wait')
  })

  test('场景声明 skip：透明跳过不执行', async () => {
    const page = new FakePage()
    const results = await runGwtSuite({
      sessionId: 's1',
      entryHtmlPath: '/tmp/app/index.html',
      scenarios: [noteScenario({ skip: true, skipReason: '涉及后端接口，Sprint B 范围外' })],
      controller: makeMockController(page),
      screenshotDir: null,
    })
    expect(results[0]?.status).toBe('skip')
    expect(results[0]?.reason).toContain('范围外')
    expect(page.reloads).toBe(0)
  })

  test('场景隔离：每个场景 loadFileInTab 重载一次', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="btn-save"]', { visible: true, text: '保存' })
    const mk = (): GwtScenarioFile => ({
      feature: 'us-01', scenario: 'US-01 场景A', skip: false, skipReason: null,
      steps: [{ kind: 'when', text: '点击保存', op: { type: 'click', selector: 'data-ai-id=btn-save' } }],
    })
    await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [mk(), mk()],
      controller: makeMockController(page), screenshotDir: null,
    })
    expect(page.reloads).toBe(2)
    expect(page.clicks.length).toBe(2)
  })

  test('失败截图：fail 场景落 screenshots 目录并在结果中记录相对路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gwt-shot-'))
    try {
      const page = new FakePage()
      page.elements.set('[data-ai-id="view-note-list"]', { visible: true, text: '别的' })
      const results = await runGwtSuite({
        sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
        scenarios: [noteScenario({ steps: [{ kind: 'then', text: 'x', op: { type: 'assert-text', selector: 'data-ai-id=view-note-list', contains: '百年孤独', timeoutMs: 60 } }] })],
        controller: makeMockController(page),
        screenshotDir: dir,
      })
      const r = results[0]!
      expect(r.status).toBe('fail')
      expect(r.screenshot).toMatch(/^06_TESTS\/screenshots\/fail-us-01-\d+\.png$/)
      expect(existsSync(join(dir, (r.screenshot ?? '').split('/').pop()!))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unmapped 兑底：步骤 op=null 但场景未声明 skip → fail（映射类）', async () => {
    const page = new FakePage()
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 x', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '未映射步骤', op: null, unmapped: true }],
      }],
      controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('fail')
    expect(results[0]?.failedStep?.category).toBe('unmapped')
  })

  test('标签恢复（AC Z-004）：测试结束后切回创建前的用户活动标签', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="view-note-list"]', { visible: true, text: '百年孤独' })
    const restored: string[] = []
    const base = makeMockController(page)
    const controller: GwtBrowserAdapter = {
      ...base,
      createLocalFileTab: async () => ({ tabId: 'tab-gwt-1', previousActiveTabId: 'tab-user' }),
      restoreDisplayTab: (s, tabId) => { restored.push(`${s}:${tabId}`) },
    }
    await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [noteScenario({ steps: [{ kind: 'then', text: 'x', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list', timeoutMs: 300 } }] })],
      controller, screenshotDir: null,
    })
    expect(restored).toEqual(['s1:tab-user'])
  })

  test('assert-count / assert-visible 语义', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="badge"]', { visible: false, text: '' })
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 可见性', skip: false, skipReason: null,
        steps: [{ kind: 'then', text: '徽标可见', op: { type: 'assert-visible', selector: 'data-ai-id=badge', timeoutMs: 60 } }],
      }],
      controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('fail')
    expect(results[0]?.failedStep?.actual).toBe('元素不可见')
  })
})

// ===== 编排入口（runNanjuGwtAcceptance：报告 schema + retry + 埋点） =====

function setupProjectFixture(opts: {
  stepsFiles?: Record<string, string>
  prd?: string
  appHtml?: string
  prevReport?: Record<string, unknown>
}): void {
  const dir = mkdtempSync(join(tmpdir(), 'gwt-accept-'))
  fixtureRoot = dir
  const projectDir = join(dir, 'project-p1')
  mkdirSync(join(projectDir, '06_TESTS', 'features'), { recursive: true })
  mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
  mkdirSync(join(projectDir, '08_APP'), { recursive: true })
  writeFileSync(join(projectDir, '01_PRD', 'prd.md'), opts.prd ?? '# PRD\n## US-01 添加读书笔记\n## US-02 删除读书笔记\n')
  writeFileSync(join(projectDir, '08_APP', 'index.html'), opts.appHtml ?? '<!DOCTYPE html><html><body><div data-ai-id="view-note-list"></div></body></html>')
  for (const [name, content] of Object.entries(opts.stepsFiles ?? {})) {
    writeFileSync(join(projectDir, '06_TESTS', 'features', name), content)
  }
  if (opts.prevReport) {
    writeFileSync(join(projectDir, '06_TESTS', 'report.json'), JSON.stringify(opts.prevReport))
  }
}

const PASSING_STEPS = JSON.stringify({
  feature: 'us-01',
  scenario: 'US-01 添加读书笔记',
  skip: false,
  skipReason: null,
  steps: [
    { kind: 'given', text: '在列表页', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } },
    { kind: 'then', text: '列表可见', op: { type: 'assert-count', selector: 'data-ai-id=view-note-list', count: 1 } },
  ],
})

const FAILING_STEPS = JSON.stringify({
  feature: 'us-01',
  scenario: 'US-01 添加读书笔记',
  skip: false,
  skipReason: null,
  steps: [
    { kind: 'then', text: '列表含目标文本', op: { type: 'assert-text', selector: 'data-ai-id=view-note-list', contains: '不存在的文本', timeoutMs: 60 } },
  ],
})

function fullPassPage(): FakePage {
  const page = new FakePage()
  page.elements.set('[data-ai-id="view-note-list"]', { visible: true, text: '百年孤独' })
  return page
}

/** 执行通道异常 mock（createLocalFileTab 即抛，模拟 CDP attach 失败） */
function makeThrowingController(): GwtBrowserAdapter {
  const base = makeMockController(new FakePage())
  return { ...base, createLocalFileTab: async () => { throw new Error('CDP attach 失败（模拟）') } }
}

describe('runNanjuGwtAcceptance', () => {
  test('全通过：report.json schema 完整 + verdict=pass + retryCount=0 + 埋点落盘', async () => {
    const coveringBothUs = JSON.stringify({
      feature: 'us-01', scenario: 'US-01 添加读书笔记', skip: false, skipReason: null,
      steps: [
        { kind: 'given', text: '在列表页', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } },
        { kind: 'then', text: '列表可见', op: { type: 'assert-count', selector: 'data-ai-id=view-note-list', count: 1 } },
      ],
    })
    setupProjectFixture({
      stepsFiles: {
        'us-01.steps.json': coveringBothUs,
        'us-02.steps.json': coveringBothUs.replace(/US-01/g, 'US-02').replace(/us-01/g, 'us-02'),
      },
    })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(fullPassPage()),
    })
    expect(outcome.verdict).toBe('pass')
    expect(outcome.retryCount).toBe(0)
    expect(outcome.retryLimitReached).toBe(false)
    expect(outcome.failureKind).toBeNull()
    expect(outcome.prdUserStoriesMissing).toBe(false)
    expect(outcome.summaryText).toContain('全部通过')

    // report.json schema 校验
    const report = JSON.parse(readFileSync(join(fixtureRoot, 'project-p1', '06_TESTS', 'report.json'), 'utf-8'))
    expect(report.verdict).toBe('pass')
    expect(report.scenariosTotal).toBe(2)
    expect(report.passed).toBe(2)
    expect(report.failed).toBe(0)
    expect(report.coveredUs.sort()).toEqual(['US-01', 'US-02'])
    expect(report.uncoveredUs).toEqual([])
    expect(Array.isArray(report.scenarios)).toBe(true)
    expect(report.scenarios[0]).toMatchObject({ feature: 'us-01', status: 'pass' })

    // W18（v0.17.83）：交付事实字段——runId（本次运行唯一标识）+ entryFingerprint（写盘时刻
    // 对 08_APP/index.html 实测 sha256/size）+ executionContext + coverageUnverified 三口径
    expect(typeof report.runId).toBe('string')
    expect(report.runId.length).toBeGreaterThan(0)
    const entryBytes = readFileSync(join(fixtureRoot, 'project-p1', '08_APP', 'index.html'))
    expect(report.entryFingerprint).toEqual({
      sha256: createHash('sha256').update(entryBytes).digest('hex'),
      size: entryBytes.byteLength,
    })
    expect(report.executionContext).toBe('file://')
    expect(report.coverageUnverified.length).toBe(3)
    expect(report.coverageUnverified.some((s: string) => s.includes('file://'))).toBe(true)

    // judge.verdict 埋点落盘（推进即事实口径）
    const telemetryDir = join(fixtureRoot, '_telemetry')
    expect(existsSync(telemetryDir)).toBe(true)
    const files = readdirSync(telemetryDir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBe(1)
    const events = readFileSync(join(telemetryDir, files[0]!), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(events.length).toBe(1)
    expect(events[0]?.eventType).toBe('judge.verdict')
    expect(events[0]?.payload.verdict).toBe('pass')
    expect(events[0]?.payload.scenarios_total).toBe(2)
  })

  test('覆盖性：US 未全覆盖时 verdict=fail（report.json 以裁判为准）', async () => {
    setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS } })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(fullPassPage()),
    })
    expect(outcome.verdict).toBe('fail') // US-02 无场景 → 覆盖性失败
    expect(outcome.failureKind).toBe('coverage') // 纯覆盖性失败分流（AC L-001）
    expect(outcome.prdUserStoriesMissing).toBe(false)
    expect(outcome.judgement.uncoveredUs).toEqual(['US-02'])
    expect(outcome.failListText).toContain('US-02')
    expect(outcome.summaryText).toContain('覆盖不全') // AC U-001：不输出「0 个失败」自相矛盾
    expect(outcome.summaryText.includes('0 个失败')).toBe(false)
  })

  test('PRD 存在但无 US-xx 清单 → fail-fast：coverage + prdUserStoriesMissing + 专用摘要（AC F-002）', async () => {
    setupProjectFixture({
      stepsFiles: { 'us-01.steps.json': PASSING_STEPS },
      prd: '# 需求文档\n\n本工具用于管理阅读清单，未使用用户故事编号。\n\n功能：添加、删除、查看笔记。\n',
    })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(fullPassPage()),
    })
    expect(outcome.verdict).toBe('fail')
    expect(outcome.failureKind).toBe('coverage')
    expect(outcome.prdUserStoriesMissing).toBe(true)
    expect(outcome.results.length).toBe(0) // 覆盖性基准缺失 → 不执行浏览器步骤（fail-fast）
    expect(outcome.summaryText).toContain('PRD 未提取到 US-xx 用户故事清单')
    expect(outcome.failListText).toContain('US-01 / US-02')
    const report = JSON.parse(readFileSync(join(fixtureRoot, 'project-p1', '06_TESTS', 'report.json'), 'utf-8'))
    expect(report.verdict).toBe('fail')
    expect(report.prdUserStoriesMissing).toBe(true)
    expect(report.failureKind).toBe('coverage')
  })

  test('映射类失败分流：click 等待超时 → failureKind=mapping（AC L-001）', async () => {
    const steps = JSON.stringify({
      feature: 'us-01', scenario: 'US-01 添加读书笔记', skip: false, skipReason: null,
      steps: [{ kind: 'when', text: '点击保存', op: { type: 'click', selector: 'data-ai-id=btn-missing' }, timeoutMs: 60 }],
    })
    setupProjectFixture({
      stepsFiles: {
        'us-01.steps.json': steps,
        'us-02.steps.json': steps.replace(/US-01/g, 'US-02').replace(/us-01/g, 'us-02'),
      },
    })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(fullPassPage()),
    })
    expect(outcome.verdict).toBe('fail')
    expect(outcome.failureKind).toBe('mapping') // selector 等待超时 → 回 testing 重映射
    expect(outcome.failListText).toContain('映射类')
  })

  test('执行异常：controller 抛异常 → verdict=error 报告落盘 + error 轮次计入 retryCount（AC Z-005）+ errorCount 独立计数（v0.17.64 #6）', async () => {
    setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS } })
    const run = (): Promise<NanjuGwtOutcome> => runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeThrowingController(),
    })
    const first = await run()
    expect(first.verdict).toBe('error')
    expect(first.errorReason).toContain('CDP attach 失败')
    expect(first.failureKind).toBeNull()
    expect(first.retryCount).toBe(0)
    expect(first.retryLimitReached).toBe(false)
    expect(first.summaryText).toContain('执行异常')
    // 独立异常计数（#6 拆 Z-005 口径）：首轮 error → errorCount=1（retryCount 仍 0 起）
    expect(first.errorCount).toBe(1)
    // error 报告落盘（不再裸抛断链）
    const report = JSON.parse(readFileSync(join(fixtureRoot, 'project-p1', '06_TESTS', 'report.json'), 'utf-8'))
    expect(report.verdict).toBe('error')
    expect(report.errorReason).toContain('CDP attach 失败')
    expect(report.errorCount).toBe(1)
    // error 轮次计入重试：重跑仍异常 → retryCount=1，errorCount 独立累计到 2
    const second = await run()
    expect(second.verdict).toBe('error')
    expect(second.retryCount).toBe(1)
    expect(second.errorCount).toBe(2)
  })

  test('失败与重试累计：首轮 fail retryCount=0 → 重跑 fail retryCount=1 → 再跑 retryLimitReached', async () => {
    setupProjectFixture({ stepsFiles: { 'us-01.steps.json': FAILING_STEPS } })
    const run = (): Promise<NanjuGwtOutcome> => runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(fullPassPage()),
    })
    expect(GWT_RETRY_LIMIT).toBe(2)
    const first = await run()
    expect(first.verdict).toBe('fail')
    expect(first.retryCount).toBe(0)
    expect(first.errorCount).toBe(0) // fail 轮不计异常（v0.17.64 #6 拆分）
    expect(first.retryLimitReached).toBe(false)
    expect(first.failureKind).toBe('behavior') // assert 断言失败 → 回炉 coding（AC L-001）
    const second = await run()
    expect(second.retryCount).toBe(1)
    expect(second.errorCount).toBe(0)
    expect(second.retryLimitReached).toBe(false)
    const third = await run()
    expect(third.retryCount).toBe(2)
    expect(third.errorCount).toBe(0)
    expect(third.retryLimitReached).toBe(true)
    // 埋点三轮均落盘（fail 轮次也记，漏斗分析口径）
    const telemetryFile = join(fixtureRoot, '_telemetry')
    const files = existsSync(telemetryFile)
      ? readdirSync(telemetryFile).filter((f) => f.endsWith('.jsonl'))
      : []
    expect(files.length).toBe(1)
    const lines = readFileSync(join(telemetryFile, files[0]!), 'utf-8').trim().split('\n')
    expect(lines.length).toBe(3)
    const events = lines.map((l) => JSON.parse(l))
    expect(events.every((e) => e.eventType === 'judge.verdict')).toBe(true)
    expect(events.map((e) => e.payload.retry_round)).toEqual([0, 1, 2])
    expect(events.every((e) => e.payload.verdict === 'fail')).toBe(true)
  })

  test('重试计数语义：上轮 fail 后重跑通过 → retryCount 继承（第 2 次重跑）；pass 后再跑 → 归零', async () => {
    const bothUs = (us: string): string => JSON.stringify({
      feature: us.toLowerCase(), scenario: `${us} 场景`, skip: false, skipReason: null,
      steps: [{ kind: 'then', text: '列表可见', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } }],
    })
    setupProjectFixture({
      stepsFiles: { 'us-01.steps.json': FAILING_STEPS },
      prevReport: { verdict: 'fail', retryCount: 1 },
    })
    // 换成会通过的版本（覆盖两条 US）
    writeFileSync(join(fixtureRoot, 'project-p1', '06_TESTS', 'features', 'us-01.steps.json'), bothUs('US-01'))
    writeFileSync(join(fixtureRoot, 'project-p1', '06_TESTS', 'features', 'us-02.steps.json'), bothUs('US-02'))
    const run = (): Promise<NanjuGwtOutcome> => runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(fullPassPage()),
    })
    const first = await run()
    expect(first.verdict).toBe('pass')
    expect(first.retryCount).toBe(2) // 上轮 fail(retryCount=1) 后的第二次重跑
    const second = await run()
    expect(second.verdict).toBe('pass')
    expect(second.retryCount).toBe(0) // 上轮已 pass → 归零
  })

  test('schema 非法文件（W22 A1）：计 fail 不再静默 skip——消除「其余场景全过仍判 pass」的交付门放行风险', async () => {
    setupProjectFixture({ stepsFiles: { 'bad.steps.json': '{"feature":"us-01","scenario":1}' } })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(new FakePage()),
    })
    expect(outcome.verdict).toBe('fail')
    const schemaFail = outcome.results.find((r) => r.status === 'fail')!
    expect(schemaFail.reason).toContain('schema 校验失败')
    expect(schemaFail.failedStep?.category).toBe('schema-invalid')
    expect(outcome.failureKind).toBe('mapping')
  })

  test('入口缺失：08_APP/index.html 不存在 → 全场景降级 skip + fail', async () => {
    setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS } })
    rmSync(join(fixtureRoot, 'project-p1', '08_APP', 'index.html'))
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(new FakePage()),
    })
    expect(outcome.verdict).toBe('fail')
    expect(outcome.results[0]?.reason).toContain('08_APP/index.html 不存在')
  })

  test('人读报告归档：06_TESTS/report-*.md 落盘', async () => {
    setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS } })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(fullPassPage()),
    })
    expect(existsSync(outcome.reportMdPath)).toBe(true)
    expect(outcome.reportMdPath).toMatch(/06_TESTS\/report-\d{8}-\d{6}\.md$/)
    expect(readFileSync(outcome.reportMdPath, 'utf-8')).toContain('# 验收测试报告')
  })
})

// ═══════════════ W12：GWT-pass 后两段交付验收（用户 2026-09-03 23:39 裁决） ═══════════════

describe('W12：GWT-pass 交付验收两段化（不直接 delivered）', () => {
  test('注入消息 = 测试摘要 + 交付验收邀请（满意交付/需要调整两选项语义），不含交付完成富语', () => {
    const msg = buildGwtDeliveryAcceptanceMessage('✅ 我们测试了 6 个场景，全部通过（覆盖 3 条用户故事）。测试报告：/tmp/report.md')
    // 测试摘要原文保留（机器裁判结论完整可见）
    expect(msg).toContain('✅ 我们测试了 6 个场景，全部通过（覆盖 3 条用户故事）')
    expect(msg).toContain('/tmp/report.md')
    // 交付验收语义（工单 §1 话术）
    expect(msg).toContain('应用已完成并通过自动测试')
    expect(msg).toContain('可以交付使用。你用过了吗？')
    expect(msg).toContain('满意交付')
    expect(msg).toContain('需要调整')
    expect(msg).toContain('回炉修复后重新测试')
    // 旧「直接交付」富语不再出现在 pass 消息（交付改由用户确认后的标准路径承载）
    expect(msg).not.toContain('项目已全部完成交付')
  })

  test('续接指令：弹 AskUserQuestion 两选项 + 满意交付→PHASE_ADVANCE: delivered + 需要调整→回炉重跑 testing', () => {
    const instruction = GWT_DELIVERY_ACCEPTANCE_RESUME_MESSAGE
    expect(instruction).toContain('AskUserQuestion')
    expect(instruction).toContain('应用已完成并通过自动测试，可以交付使用。你用过了吗？')
    expect(instruction).toContain('满意交付')
    expect(instruction).toContain('需要调整')
    // 满意交付 → 既有 isDeliverFromTesting 路径（W18：门禁双事实——verdict=pass 且系统已记录用户满意交付确认）
    expect(instruction).toContain('<!-- PHASE_ADVANCE: delivered -->')
    expect(instruction).toContain('交付门禁校验 verdict=pass 且系统已记录用户满意交付确认')
    // 需要调整 → 意见收集 → 修复 08_APP/ → testing 重跑（不动测试与需求产物）
    expect(instruction).toContain('<!-- PHASE_ADVANCE: testing -->')
    expect(instruction).toContain('修复 08_APP/ 下的代码')
    expect(instruction).toContain('不动 06_TESTS/ 与 01_PRD/')
    // 回炉预算 ≤2 既有约束交代（系统计数，L1 不自作主张超限）
    expect(instruction).toContain('回炉预算 ≤2 次')
    // W18：话术尾注覆盖边界一行（file:// 上下文诚实声明——预览协议差异不在机器背书内）
    expect(instruction).toContain('覆盖边界')
    expect(instruction).toContain('file://')
  })

  test('回炉预算未动：GWT_RETRY_LIMIT 仍为 2（交付验收不烧回炉次数）', () => {
    expect(GWT_RETRY_LIMIT).toBe(2)
  })

  // ══ v2.4（自动补完需求）：交付验收问句补 header「确认·满意交付」══
  // Defender #8：交付话术单一来源——RESUME_MESSAGE 与 router-prompt :643 两处同时带
  // header「确认」指令（口径一致防漂移）；auto 开启时六确认 header 前缀是路由放行依据。
  test('v2.4：交付验收 AskUser 问句带 header「确认·满意交付」（router-gate 路由豁免依据）', () => {
    expect(GWT_DELIVERY_ACCEPTANCE_RESUME_MESSAGE).toContain('header「确认·满意交付」')
  })

  test('v2.4：注入消息与续接指令的交付验收语义一致（都含满意交付两选项，无旧无 header 话术）', () => {
    const msg = buildGwtDeliveryAcceptanceMessage('摘要')
    expect(msg).toContain('满意交付 / 需要调整')
    // 旧形态反断言：续接指令中不存在缺 header 说明的交付弹问话术
    expect(GWT_DELIVERY_ACCEPTANCE_RESUME_MESSAGE).not.toMatch(/弹问，question「应用已完成/)
  })
})

// ═══════════════ W22：F1 fill 可信化 / F2 词表扩展 / F3 selector 二档 / F4 截图断言 / A1 schema 版本 ═══════════════

describe('W22 F1：fill 可信化执行序', () => {
  const fillScenario = (selector = 'data-ai-id=input-title'): GwtScenarioFile => ({
    feature: 'us-01', scenario: 'US-01 输入', skip: false, skipReason: null,
    steps: [{ kind: 'when', text: '输入书名', op: { type: 'fill', selector, value: '百年孤独' } }],
  })

  test('覆盖写而非追加：select 全选后 insertText 替换旧值（清空顺序不产生「旧值+新值」）', async () => {
    const page = new FakePage()
    const key = '[data-ai-id="input-title"]'
    page.elements.set(key, { visible: true, text: '', tag: 'input-text' })
    page.values.set(key, '旧的书名') // 初始非空：验证覆盖语义
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [fillScenario()], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(page.values.get(key)).toBe('百年孤独') // 覆盖，非「旧的书名百年孤独」
  })

  test('红测范式：isTrusted 敏感受控组件——insertText 未生效且合成事件被拒 → 终态 fail（assert 类）', async () => {
    const page = new FakePage()
    const key = '[data-ai-id="input-title"]'
    page.elements.set(key, { visible: true, text: '', tag: 'input-text' })
    page.strictTrust.add(key)                       // 受控组件拒绝合成事件（旧实现唯一通道，必挂）
    page.values.set('insert-text-broken', 'yes')    // 模拟 insertText 未生效
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [fillScenario()], controller: makeMockController(page), screenshotDir: null,
    })
    const r = results[0]!
    expect(r.status).toBe('fail')
    expect(r.failedStep?.category).toBe('assert')
    expect(r.reason).toContain('回读')
    expect(page.fills.length).toBe(1) // 回退链被尝试恰一次（单次重试）
  })

  test('单次重试成功：insertText 未生效但回退链（native-setter+input）生效 → pass', async () => {
    const page = new FakePage()
    const key = '[data-ai-id="input-title"]'
    page.elements.set(key, { visible: true, text: '', tag: 'input-text' })
    page.values.set('insert-text-broken', 'yes') // 主通道失效；非 strictTrust → 回退可写
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [fillScenario()], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(page.fills.length).toBe(1)
    expect(page.values.get(key)).toBe('百年孤独')
  })

  test('value ≤2000 字符预检（schema 层拒绝超长）', () => {
    expect(GWT_FILL_VALUE_MAX_CHARS).toBe(2000)
    const raw = JSON.stringify({
      feature: 'us-01', scenario: 'US-01 输入', skip: false, skipReason: null,
      steps: [{ kind: 'when', text: '超长输入', op: { type: 'fill', selector: 'data-ai-id=input-title', value: 'x'.repeat(2001) } }],
    })
    const { errors } = validateScenarioFileContent(raw)
    expect(errors.some((e) => e.includes('2000'))).toBe(true)
  })
})

describe('W22 F2：词表扩展（check/uncheck/select/hover/scroll/focus）', () => {
  test('check：读态→按需点击→回读；可信点击切换 checkbox 勾选态', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="agree"]', { visible: true, text: '', tag: 'input-checkbox', x: 5, y: 5 })
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 勾选', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '勾选同意', op: { type: 'check', selector: 'data-ai-id=agree' }, timeoutMs: 300 }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(page.clicks.length).toBe(1)
    expect(page.checked.get('[data-ai-id="agree"]')).toBe(true)
  })

  test('check 幂等：已勾选则不再点击（防中断/重试后反向）', async () => {
    const page = new FakePage()
    const key = '[data-ai-id="agree"]'
    page.elements.set(key, { visible: true, text: '', tag: 'input-checkbox', x: 5, y: 5 })
    page.checked.set(key, true)
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 幂等', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '勾选', op: { type: 'check', selector: 'data-ai-id=agree' }, timeoutMs: 300 }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(page.clicks.length).toBe(0)
  })

  test('uncheck radio → fail op-check（radio 不可取消，归 mapping 类）', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="opt-a"]', { visible: true, text: '', tag: 'input-radio', x: 5, y: 5 })
    page.checked.set('[data-ai-id="opt-a"]', true)
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 取消radio', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '取消', op: { type: 'uncheck', selector: 'data-ai-id=opt-a' }, timeoutMs: 300 }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('fail')
    expect(results[0]?.failedStep?.category).toBe('op-check')
    expect(results[0]?.failedStep?.actual).toContain('radio')
  })

  test('check 非 checkbox/radio 目标 → fail op-check（独立失败 category）', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="btn"]', { visible: true, text: '按钮', tag: 'div' })
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 误用', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '勾选按钮', op: { type: 'check', selector: 'data-ai-id=btn' }, timeoutMs: 300 }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('fail')
    expect(results[0]?.failedStep?.category).toBe('op-check')
  })

  test('select：原生 select 按 label 匹配 option + setter 写值 + 回读校验', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="genre"]', {
      visible: true, text: '', tag: 'select',
      options: [{ value: 'scifi', label: '科幻' }, { value: 'novel', label: '小说' }],
    })
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 下拉', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '选择科幻', op: { type: 'select', selector: 'data-ai-id=genre', value: '科幻' }, timeoutMs: 300 }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(page.values.get('[data-ai-id="genre"]')).toBe('scifi')
  })

  test('select 非原生下拉 → fail op-select + 文案指引用 click 序列（归 mapping）', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="custom-dd"]', { visible: true, text: '自定义', tag: 'div' })
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 自定义下拉', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '选择', op: { type: 'select', selector: 'data-ai-id=custom-dd', value: 'x' }, timeoutMs: 300 }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('fail')
    expect(results[0]?.failedStep?.category).toBe('op-select')
    expect(results[0]?.failedStep?.actual).toContain('click 序列')
  })

  test('hover：真实悬停通道（hoverPointInTab 微抖动+停留）', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="menu"]', { visible: true, text: '菜单' })
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 悬停', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '悬停菜单', op: { type: 'hover', selector: 'data-ai-id=menu' }, timeoutMs: 300 }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(page.hovers.length).toBe(1)
  })

  test('scroll：CDP mouseWheel 优先；wheel 不可用时 JS scrollBy 回退', async () => {
    const page = new FakePage()
    const mkScenario = (): GwtScenarioFile => ({
      feature: 'us-01', scenario: 'US-01 滚动', skip: false, skipReason: null,
      steps: [{ kind: 'when', text: '向下滚动', op: { type: 'scroll', deltaY: 600 } }],
    })
    const first = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [mkScenario()], controller: makeMockController(page), screenshotDir: null,
    })
    expect(first[0]?.status).toBe('pass')
    expect(page.wheels).toEqual([{ deltaX: 0, deltaY: 600 }])
    // wheel 抛错 → JS 回退生效
    page.values.set('wheel-throws', 'yes')
    const second = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [mkScenario()], controller: makeMockController(page), screenshotDir: null,
    })
    expect(second[0]?.status).toBe('pass')
    expect(page.jsScrolls).toEqual([600])
  })

  test('focus：聚焦成功 pass；focus 失败 → fail op-focus', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="search"]', { visible: true, text: '', tag: 'input-text' })
    page.elements.set('[data-ai-id="dead"]', { visible: true, text: 'unfocusable', tag: 'div' })
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [
        {
          feature: 'us-01', scenario: 'US-01 聚焦ok', skip: false, skipReason: null,
          steps: [{ kind: 'when', text: '聚焦搜索框', op: { type: 'focus', selector: 'data-ai-id=search' }, timeoutMs: 300 }],
        },
        {
          feature: 'us-02', scenario: 'US-02 聚焦fail', skip: false, skipReason: null,
          steps: [{ kind: 'when', text: '聚焦死元素', op: { type: 'focus', selector: 'data-ai-id=dead' }, timeoutMs: 300 }],
        },
      ], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(results[1]?.status).toBe('fail')
    expect(results[1]?.failedStep?.category).toBe('op-focus')
  })

  test('schema：新 op 必填字段校验（select 缺 value / scroll 缺 deltaY / deltaY=0 拒绝）', () => {
    const mk = (op: Record<string, unknown>): string => JSON.stringify({
      feature: 'us-01', scenario: 'US-01 x', skip: false, skipReason: null, schemaVersion: 2,
      steps: [{ kind: 'when', text: 't', op }],
    })
    expect(validateScenarioFileContent(mk({ type: 'select', selector: 'data-ai-id=a' })).errors.some((e) => e.includes('select'))).toBe(true)
    expect(validateScenarioFileContent(mk({ type: 'scroll' })).errors.some((e) => e.includes('deltaY'))).toBe(true)
    expect(validateScenarioFileContent(mk({ type: 'scroll', deltaY: 0 })).errors.some((e) => e.includes('deltaY'))).toBe(true)
  })
})

describe('W22 F3：selector 二档（#id / aria-label）执行期唯一性', () => {
  test('#id 档命中多元素 → fail selector-ambiguous（绝不取首个），tier 记录进失败步骤', async () => {
    const page = new FakePage()
    page.elements.set('#dup-id', { visible: true, text: '第一个' })
    page.ambiguousSelectors.add('#dup-id') // 同 id 多元素（HTML 不校验唯一）
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 id 漂移', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '点击', op: { type: 'click', selector: '#dup-id' }, timeoutMs: 300 }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    const r = results[0]!
    expect(r.status).toBe('fail')
    expect(r.failedStep?.category).toBe('selector-ambiguous')
    expect(r.failedStep?.selectorTier).toBe('id')
    expect(page.clicks.length).toBe(0)
  })

  test('aria-label 档：属性相等匹配执行成功（中文值不拼 CSS）', async () => {
    const page = new FakePage()
    page.elements.set('[aria-label="提交表单"]', { visible: true, text: '提交' })
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 aria', skip: false, skipReason: null,
        steps: [
          { kind: 'when', text: '点击提交', op: { type: 'click', selector: '[aria-label="提交表单"]', timeoutMs: 300 } },
          { kind: 'then', text: '可见', op: { type: 'assert-visible', selector: '[aria-label="提交表单"]', timeoutMs: 300 } },
        ],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(page.clicks.length).toBe(1)
  })

  test('aria-label 档多元素 → fail selector-ambiguous + tier=aria-label；归 mapping 类', async () => {
    const page = new FakePage()
    page.ambiguousSelectors.add('[aria-label="提交"]')
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 aria 漂移', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '点击', op: { type: 'click', selector: '[aria-label="提交"]', timeoutMs: 300 } }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.failedStep?.category).toBe('selector-ambiguous')
    expect(results[0]?.failedStep?.selectorTier).toBe('aria-label')
  })

  test('#id 档唯一 → 正常执行；data-ai-id 主档行为不变（不强制唯一）', async () => {
    const page = new FakePage()
    page.elements.set('#save-btn', { visible: true, text: '保存' })
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-01', scenario: 'US-01 id ok', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '点击保存', op: { type: 'click', selector: '#save-btn' }, timeoutMs: 300 }],
      }], controller: makeMockController(page), screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(page.clicks.length).toBe(1)
  })
})

describe('W22 F4：assert-screenshot（warning-only）', () => {
  test('computeScreenshotDiffRatio 纯函数：同图=0；通道差≤10 不计；>10 计入；尺寸不符=null', () => {
    const gray = makeSolidPng(2, 2, [200, 200, 200])
    expect(computeScreenshotDiffRatio(gray, makeSolidPng(2, 2, [200, 200, 200]))).toBe(0)
    expect(computeScreenshotDiffRatio(gray, makeSolidPng(2, 2, [210, 205, 200]))).toBe(0)     // ≤10 噪声不计
    expect(computeScreenshotDiffRatio(gray, makeSolidPng(2, 2, [220, 200, 200]))).toBe(1)    // 20>10 全部计入
    expect(computeScreenshotDiffRatio(gray, makeSolidPng(3, 2, [200, 200, 200]))).toBeNull() // 尺寸不符
  })

  test('首跑建基线：baseline-created warning + 落盘 _screenshots/ + 场景 pass（不影响 verdict）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gwt-base-'))
    try {
      const page = new FakePage()
      const results = await runGwtSuite({
        sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
        scenarios: [{
          feature: 'us-01', scenario: 'US-01 视觉', skip: false, skipReason: null,
          steps: [{ kind: 'then', text: '界面视觉一致', op: { type: 'assert-screenshot', name: 'us01-visual' } }],
        }], controller: makeMockController(page), screenshotDir: null, baselineDir: dir,
      })
      const r = results[0]!
      expect(r.status).toBe('pass')
      expect(r.warnings?.some((w) => w.startsWith('baseline-created:'))).toBe(true)
      expect(r.warnings?.[0]).toContain('375x667@2x') // 尺寸+DPR 记录
      expect(existsSync(join(dir, 'us01-visual.png'))).toBe(true)
      expect(existsSync(join(dir, 'us01-visual.meta.json'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('基线一致 → 无新警告；视觉变化超阈 → screenshot-diff warning 但场景仍 pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gwt-base-'))
    try {
      const page = new FakePage()
      const mkScenario = (): GwtScenarioFile => ({
        feature: 'us-01', scenario: 'US-01 视觉', skip: false, skipReason: null,
        steps: [{ kind: 'then', text: '视觉一致', op: { type: 'assert-screenshot', name: 'us01-visual' } }],
      })
      await runGwtSuite({ sessionId: 's1', entryHtmlPath: '/tmp/x.html', scenarios: [mkScenario()], controller: makeMockController(page), screenshotDir: null, baselineDir: dir })
      // 二跑同图：无 diff 警告
      const second = await runGwtSuite({ sessionId: 's1', entryHtmlPath: '/tmp/x.html', scenarios: [mkScenario()], controller: makeMockController(page), screenshotDir: null, baselineDir: dir })
      expect(second[0]?.status).toBe('pass')
      expect(second[0]?.warnings ?? []).toEqual([])
      // 三跑换图（全像素通道差 20>10 → 100% > 2% 阈值）：warning 但不 fail
      page.viewportPng = makeSolidPng(2, 2, [220, 200, 200])
      const third = await runGwtSuite({ sessionId: 's1', entryHtmlPath: '/tmp/x.html', scenarios: [mkScenario()], controller: makeMockController(page), screenshotDir: null, baselineDir: dir })
      expect(third[0]?.status).toBe('pass')
      expect(third[0]?.warnings?.some((w) => w.startsWith('screenshot-diff:'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('视口/DPR 元数据不符 → screenshot-incomparable（不判 fail）；截图通道失败 → screenshot-failed 降级', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gwt-base-'))
    try {
      const page = new FakePage()
      const mkScenario = (): GwtScenarioFile => ({
        feature: 'us-01', scenario: 'US-01 视觉', skip: false, skipReason: null,
        steps: [{ kind: 'then', text: '视觉一致', op: { type: 'assert-screenshot', name: 'us01-visual' } }],
      })
      await runGwtSuite({ sessionId: 's1', entryHtmlPath: '/tmp/x.html', scenarios: [mkScenario()], controller: makeMockController(page), screenshotDir: null, baselineDir: dir })
      page.viewportMeta = { width: 800, height: 600, dpr: 1 } // 视口变化
      const resized = await runGwtSuite({ sessionId: 's1', entryHtmlPath: '/tmp/x.html', scenarios: [mkScenario()], controller: makeMockController(page), screenshotDir: null, baselineDir: dir })
      expect(resized[0]?.status).toBe('pass')
      expect(resized[0]?.warnings?.some((w) => w.startsWith('screenshot-incomparable:'))).toBe(true)
      // 截图通道整体失败：诚实降级为 warning，不 fail 不 error
      page.viewportPng = 'throw'
      const broken = await runGwtSuite({ sessionId: 's1', entryHtmlPath: '/tmp/x.html', scenarios: [mkScenario()], controller: makeMockController(page), screenshotDir: null, baselineDir: dir })
      expect(broken[0]?.status).toBe('pass')
      expect(broken[0]?.warnings?.some((w) => w.startsWith('screenshot-failed:'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('W22 A1：schemaVersion + 未知 op 计 fail（不再静默 skip）', () => {
  test('未知 op（旧运行器场景）→ verdict=fail + category=schema-invalid + failureKind=mapping + 文案指引重新生成', async () => {
    const bad = JSON.stringify({
      feature: 'us-01', scenario: 'US-01 未来词表', skip: false, skipReason: null,
      steps: [{ kind: 'when', text: 'x', op: { type: 'navigate', selector: 'data-ai-id=a' } }],
    })
    const bothUs = JSON.stringify({
      feature: 'us-01', scenario: 'US-01 添加读书笔记', skip: false, skipReason: null,
      steps: [{ kind: 'then', text: '列表可见', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } }],
    })
    setupProjectFixture({
      stepsFiles: {
        'us-01.steps.json': bad,
        'us-02.steps.json': bothUs.replace(/US-01/g, 'US-02').replace(/us-01/g, 'us-02'),
      },
    })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(fullPassPage()),
    })
    expect(outcome.verdict).toBe('fail') // 不再静默 skip 放行交付门
    const schemaFail = outcome.results.find((r) => r.status === 'fail')!
    expect(schemaFail.failedStep?.category).toBe('schema-invalid')
    expect(schemaFail.reason).toContain('白名单')
    expect(outcome.failureKind).toBe('mapping') // 回 testing 重新生成 steps.json
    // 报告归因字段（W22：selectorTier/failureCategory 直接可读）
    const report = JSON.parse(readFileSync(join(fixtureRoot, 'project-p1', '06_TESTS', 'report.json'), 'utf-8'))
    const failEntry = report.scenarios.find((s: { status: string }) => s.status === 'fail')
    expect(failEntry.failureCategory).toBe('schema-invalid')
    expect(failEntry.selectorTier).toBeNull()
  })

  test('schemaVersion 不匹配（声明 99）→ fail + 指引重新生成', async () => {
    setupProjectFixture({
      stepsFiles: {
        'us-01.steps.json': JSON.stringify({
          feature: 'us-01', scenario: 'US-01 添加读书笔记', schemaVersion: 99, skip: false, skipReason: null,
          steps: [{ kind: 'then', text: 'x', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } }],
        }),
        'us-02.steps.json': JSON.stringify({
          feature: 'us-02', scenario: 'US-02 删除读书笔记', skip: false, skipReason: null,
          steps: [{ kind: 'then', text: 'x', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } }],
        }),
      },
    })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(fullPassPage()),
    })
    expect(outcome.verdict).toBe('fail')
    const schemaFail = outcome.results.find((r) => r.status === 'fail')!
    expect(schemaFail.reason).toContain('schemaVersion 不匹配')
    expect(schemaFail.reason).toContain('重新生成')
    expect(GWT_STEPS_SCHEMA_VERSION).toBe(2)
  })

  test('schemaVersion=2 + 新 op 正常执行；旧文件（无 schemaVersion + 旧 op）保持兼容执行', async () => {
    const v2File = JSON.stringify({
      feature: 'us-01', scenario: 'US-01 勾选场景', schemaVersion: 2, skip: false, skipReason: null,
      steps: [{ kind: 'when', text: '勾选', op: { type: 'check', selector: 'data-ai-id=agree', timeoutMs: 300 } }],
    })
    const legacyFile = JSON.stringify({
      feature: 'us-02', scenario: 'US-02 删除读书笔记', skip: false, skipReason: null,
      steps: [{ kind: 'then', text: '列表可见', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } }],
    })
    setupProjectFixture({ stepsFiles: { 'us-01.steps.json': v2File, 'us-02.steps.json': legacyFile } })
    const page = fullPassPage()
    page.elements.set('[data-ai-id="agree"]', { visible: true, text: '', tag: 'input-checkbox', x: 5, y: 5 })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(page),
    })
    expect(outcome.verdict).toBe('pass') // v2 新 op + 无版本旧文件均正常执行
  })
})

describe('W22 报告归因字段与警告汇总', () => {
  test('fail 场景报告含 selectorTier + failureCategory；assert-screenshot 警告进顶层 warnings 且不影响 verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gwt-report-'))
    try {
      fixtureRoot = dir
      const projectDir = join(dir, 'project-p1')
      mkdirSync(join(projectDir, '06_TESTS', 'features'), { recursive: true })
      mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
      mkdirSync(join(projectDir, '08_APP'), { recursive: true })
      writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n## US-01 添加读书笔记\n## US-02 删除读书笔记\n')
      writeFileSync(join(projectDir, '08_APP', 'index.html'), '<!DOCTYPE html><html><body></body></html>')
      writeFileSync(join(projectDir, '06_TESTS', 'features', 'us-01.steps.json'), JSON.stringify({
        feature: 'us-01', scenario: 'US-01 id 唯一性', schemaVersion: 2, skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '点击', op: { type: 'click', selector: '#dup', timeoutMs: 200 } }],
      }))
      writeFileSync(join(projectDir, '06_TESTS', 'features', 'us-02.steps.json'), JSON.stringify({
        feature: 'us-02', scenario: 'US-02 视觉', schemaVersion: 2, skip: false, skipReason: null,
        steps: [{ kind: 'then', text: '视觉', op: { type: 'assert-screenshot', name: 'us02-shot' } }],
      }))
      const page = new FakePage()
      page.elements.set('#dup', { visible: true, text: 'x' })
      page.ambiguousSelectors.add('#dup')
      const outcome = await runNanjuGwtAcceptance({
        workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
        sessionId: 's1', controller: makeMockController(page),
      })
      expect(outcome.verdict).toBe('fail') // US-01 fail（selector-ambiguous）
      expect(outcome.failureKind).toBe('mapping')
      const report = JSON.parse(readFileSync(join(projectDir, '06_TESTS', 'report.json'), 'utf-8'))
      const failEntry = report.scenarios.find((s: { status: string }) => s.status === 'fail')
      expect(failEntry.selectorTier).toBe('id')
      expect(failEntry.failureCategory).toBe('selector-ambiguous')
      // assert-screenshot 的 baseline-created 是 warning：进顶层 warnings，pass 场景不受影响
      const passEntry = report.scenarios.find((s: { status: string }) => s.status === 'pass')
      expect(passEntry.status).toBe('pass')
      expect(passEntry.warnings?.some((w: string) => w.startsWith('baseline-created:'))).toBe(true)
      expect(report.warnings?.some((w: string) => w.includes('baseline-created:'))).toBe(true)
      // 人读报告 md 同步输出视觉观察项
      const md = readFileSync(outcome.reportMdPath, 'utf-8')
      expect(md).toContain('视觉观察项')
      // 回炉缺陷清单带 selector 档位归因
      expect(outcome.failListText).toContain('selector 档位 id')
      expect(outcome.failListText).toContain('映射类')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ===== W22 收尾：reload op（E2E 闭环 US-09 数据持久化场景）=====
describe('W22 收尾：reload op', () => {
  test('schema：reload 在白名单且无需 value/selector（经 validate 间接断言：无错误即已入白名单）', async () => {
    // 反例对照：同形态未知 op 必报错
    const bad = validateScenarioFileContent(JSON.stringify({
      schemaVersion: 2, feature: 'us-t', scenario: 'st', steps: [
        { kind: 'when', text: 'x', op: { type: 'reload-x' } },
      ],
    }))
    expect(bad.errors.length).toBeGreaterThan(0)
    const result = validateScenarioFileContent(JSON.stringify({
      schemaVersion: 2, feature: 'us-t', scenario: 'st', skip: false, skipReason: null, steps: [
        { kind: 'when', text: '刷新页面', op: { type: 'reload' } },
      ],
    }))
    expect(result.errors).toEqual([])
  })

  test('执行：location.reload() 被调用（带 selector 等待出现）', async () => {
    const page = new FakePage()
    page.elements.set('[data-ai-id="list"]', { visible: true, text: '列表', tag: 'div', x: 1, y: 1 })
    const reloadCalls: string[] = []
    const base = makeMockController(page)
    const controller = { ...base, evaluateInTab: async (s: string, t: string, expr: string) => {
      if (expr.includes('location.reload')) { reloadCalls.push(expr); return true }
      return base.evaluateInTab(s, t, expr)
    } }
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-t', scenario: 'US-T 刷新', skip: false, skipReason: null,
        steps: [
          { kind: 'when', text: '刷新', op: { type: 'reload' }, timeoutMs: 300 },
          { kind: 'when', text: '刷新并等列表', op: { type: 'reload', selector: 'data-ai-id=list' }, timeoutMs: 300 },
        ],
      }], controller, screenshotDir: null,
    })
    expect(results[0]?.status).toBe('pass')
    expect(reloadCalls.length).toBe(2)
  })

  test('执行失败：reload 求值返回 null → fail 归 assert', async () => {
    const page = new FakePage()
    const base = makeMockController(page)
    const controller = { ...base, evaluateInTab: async () => null }
    const results = await runGwtSuite({
      sessionId: 's1', entryHtmlPath: '/tmp/app/index.html',
      scenarios: [{
        feature: 'us-t', scenario: 'US-T 刷新失败', skip: false, skipReason: null,
        steps: [{ kind: 'when', text: '刷新', op: { type: 'reload' }, timeoutMs: 300 }],
      }], controller, screenshotDir: null,
    })
    expect(results[0]?.status).toBe('fail')
  })
})

describe('Given 工程契约要求真实驱动，When 当前仅注册浏览器，Then 诚实阻塞', () => {
  test('Then 不触发浏览器，不消耗已有修复次数，并写blocked报告', async () => {
    setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS }, prevReport: { verdict: 'fail', retryCount: 1, errorCount: 0 } })
    const root = join(fixtureRoot, 'project-p1')
    mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
    writeFileSync(join(root, '08_APP/native-bin'), '真实产物fixture，仅用于宿主单测')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
      schemaVersion: 1, target: { platform: 'Linux', kind: 'desktop', entry: 'native-bin' }, artifacts: ['native-bin'],
      build: '按桌面工具链构建', run: '双击native-bin',
      tests: [{ id: 'native', layer: 'acceptance', adapter: 'native-driver', target: 'native-bin', command: '真实桌面驱动', covers: ['US-01'], requiresReal: true }],
    }))
    let opened = 0
    const controller = { ...makeMockController(fullPassPage()), createLocalFileTab: async () => { opened++; throw Error('不应启动浏览器') } }
    const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '原生测试', projectMode: 'quick', sessionId: 's1', controller })
    expect(outcome.verdict as string).toBe('blocked')
    expect(opened).toBe(0)
    expect(outcome.retryCount).toBe(1)
    expect(outcome.errorCount).toBe(0)
    expect(outcome.summaryText).toContain('native-driver')
    const report = JSON.parse(readFileSync(join(root, '06_TESTS/report.json'), 'utf-8'))
    expect(report.verdict).toBe('blocked')
    // 重复blocked不增加轮次；恢复后只计算原失败对应的一次修复重跑。
    await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '原生测试', projectMode: 'quick', sessionId: 's1', controller })
    const repeated = JSON.parse(readFileSync(join(root, '06_TESTS/report.json'), 'utf-8'))
    expect(repeated.retryCount).toBe(1)
    expect(repeated.retryPending).toBe(true)
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
      schemaVersion: 1, target: { platform: 'Browser', kind: 'web', entry: 'index.html' }, artifacts: ['index.html'], build: '静态页面无需构建', run: '打开index.html',
      tests: [{ id: 'ui', layer: 'acceptance', adapter: 'browser-file', target: 'index.html', command: '宿主GWT', covers: ['US-01'], requiresReal: false }],
    }))
    // fixture改变PRD/契约只是模拟恢复条件，不会修改用户项目或擅自降级真实需求。
    writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 添加读书笔记')
    const resumed = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '恢复条件fixture', projectMode: 'quick', sessionId: 's1', controller: makeMockController(fullPassPage()) })
    expect(resumed.retryCount).toBe(2)
    expect(resumed.verdict).toBe('pass')
  })
})

describe('Given 静态Web工程契约，When 宿主完成测试，Then 交付绑定全产物及真人确认', () => {
  test('Then 不强制index.html，其他资源变化要求重跑', async () => {
    setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS }, prd: '# PRD\nUS-01 添加读书笔记' })
    const root = join(fixtureRoot, 'project-p1')
    mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
    writeFileSync(join(root, '08_APP/app.html'), '<html><body>web fixture</body></html>')
    writeFileSync(join(root, '08_APP/style.css'), 'body{color:black}')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
      schemaVersion: 1, target: { platform: 'Browser', kind: 'web', entry: 'app.html' }, artifacts: ['app.html', 'style.css'], build: '静态页面无需构建', run: '打开app.html',
      tests: [{ id: 'ui', layer: 'acceptance', adapter: 'browser-file', target: 'app.html', command: '宿主GWT映射', covers: ['US-01'], requiresReal: false }],
    }))
    rmSync(join(root, '08_APP/index.html'))
    const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: 'Web工程', projectMode: 'quick', sessionId: 's1', controller: makeMockController(fullPassPage()) })
    expect(outcome.verdict).toBe('pass')
    const report = JSON.parse(readFileSync(join(root, '06_TESTS/report.json'), 'utf-8'))
    expect(report.entry).toBe('08_APP/app.html')
    expect(report.engineeringEvidence.artifacts.length).toBe(2)
    const { checkGwtDeliveryFacts } = await import('./nanju-gwt-runner')
    const base = { workspaceSlug: 'ws', projectId: 'p1', reportJsonPath: outcome.reportJsonPath, projectDir: root }
    expect(checkGwtDeliveryFacts({ ...base, info: null })?.reason).toBe('no-ack')
    const info = { deliveryAck: { reportRunId: report.runId, at: new Date(Date.parse(report.generatedAt) + 1000).toISOString() } }
    expect(checkGwtDeliveryFacts({ ...base, info })).toBeNull()
    writeFileSync(join(root, '08_APP/style.css'), 'body{color:blue}')
    expect(checkGwtDeliveryFacts({ ...base, info })?.reason).toBe('engineering-changed')
  })
})


describe('Given 正在重试的工程测试，When 测试期间产物更新，Then 丢弃本轮计数', () => {
  test('Then 变更导致blocked仍保留原修复次数和待修复事实', async () => {
    setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS }, prd: '# PRD\nUS-01 添加读书笔记', prevReport: { verdict: 'fail', retryCount: 1, errorCount: 0 } })
    const root = join(fixtureRoot, 'project-p1')
    mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
      schemaVersion: 1, target: { platform: 'Browser', kind: 'web', entry: 'index.html' }, artifacts: ['index.html'], build: '无需构建', run: '打开index.html',
      tests: [{ id: 'ui', layer: 'acceptance', adapter: 'browser-file', target: 'index.html', command: '宿主GWT', covers: ['US-01'], requiresReal: false }],
    }))
    const base = makeMockController(fullPassPage())
    const controller: GwtBrowserAdapter = { ...base, createLocalFileTab: async (...args) => {
      writeFileSync(join(root, '08_APP/index.html'), '<html><body>编辑后的fixture</body></html>')
      return base.createLocalFileTab(...args)
    } }
    const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '产物变更fixture', projectMode: 'quick', sessionId: 's1', controller })
    expect(outcome.verdict).toBe('blocked')
    expect(outcome.retryCount).toBe(1)
    const report = JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8'))
    expect(report.retryPending).toBe(true)
    expect(report.blockedReason).toContain('测试期间')
  })
})

describe('Given 工程驱动服务已注入，When 实际检查完成，Then 记录证据范围而非借HTML通过', () => {
  test('Then 原生驱动自报通过仍blocked，报告保留检查与原修复次数', async () => {
    setupProjectFixture({ stepsFiles: {}, prd: '# PRD\nUS-01 真实能力', prevReport: { verdict: 'fail', retryCount: 1, errorCount: 0 } })
    const root = join(fixtureRoot, 'project-p1')
    mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
    writeFileSync(join(root, '08_APP/program'), '原生程序fixture，不是产品验收')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
      schemaVersion: 1, target: { platform: 'Linux', kind: 'desktop', entry: 'program' }, artifacts: ['program'], build: 'fixture', run: 'fixture',
      tests: [{ id: 'native-check', layer: 'acceptance', adapter: 'native-driver', target: 'program', command: 'fixture', covers: ['US-01'], requiresReal: true }],
    }))
    let approved = 0
    const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '驱动记录fixture', projectMode: 'quick', sessionId: 's1', controller: { ...makeMockController(fullPassPage()), createLocalFileTab: async () => { throw Error('工程分支不能开浏览器') } },
      engineeringExecution: { signal: new AbortController().signal, services: { approve: async () => { approved++; return true }, drivers: [{ adapter: 'native-driver', execute: async () => ({ testId: 'native-check', target: 'program', exitCode: 0, checks: [{ storyId: 'US-01', label: '驱动记录', expected: 'observed', actual: 'observed', evidence: ['fixture自报'] }] }) }] } },
    })
    expect(approved).toBe(1)
    expect(outcome.verdict).toBe('blocked')
    expect(outcome.retryCount).toBe(1)
    const report = JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8'))
    expect(report.entry).toBe('08_APP/program')
    expect(report.executionContext).toBe('project-driver')
    expect(report.engineeringSuite.tests[0].checks.length).toBe(1)
    expect(report.coverageUnverified[0]).toContain('独立')
    expect(readFileSync(outcome.reportMdPath, 'utf-8')).toContain('工程驱动记录')
  })
})

test('Given 普通工程行为检查已通过 When 真人确认交付 Then 全产物与宿主执行记录一致才放行', async () => {
  setupProjectFixture({ stepsFiles: {}, prd: '# PRD\nUS-01 文件行为' })
  const root = join(fixtureRoot, 'project-p1')
  mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(root, '08_APP/program'), '隔离fixture')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 1, target: { platform: 'Linux', kind: 'cli', entry: 'program' }, artifacts: ['program'], build: 'fixture', run: 'fixture', tests: [{ id: 'check', layer: 'acceptance', adapter: 'cli-driver', target: 'program', command: 'fixture', covers: ['US-01'], requiresReal: false }] }))
  const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '行为fixture', projectMode: 'quick', sessionId: 's1', controller: makeMockController(fullPassPage()), engineeringExecution: { signal: new AbortController().signal, services: { approve: async () => true, drivers: [{ adapter: 'cli-driver', execute: async () => ({ testId: 'check', target: 'program', exitCode: 0, checks: [{ storyId: 'US-01', label: '文件检查', expected: '1', actual: '1', evidence: ['fixture结果'] }] }) }] } } })
  expect(outcome.verdict).toBe('pass')
  const report = JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8'))
  const { checkGwtDeliveryFacts } = await import('./nanju-gwt-runner')
  const input = { workspaceSlug: 'ws', projectId: 'p1', projectDir: root, reportJsonPath: outcome.reportJsonPath }
  expect(checkGwtDeliveryFacts({ ...input, info: null })?.reason).toBe('no-ack')
  expect(checkGwtDeliveryFacts({ ...input, info: { deliveryAck: { reportRunId: report.runId, at: new Date(Date.parse(report.generatedAt) + 1000).toISOString() } } })).toBeNull()
})

function setupMixedEngineeringFixture(): string {
  setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS }, prd: '# PRD\nUS-01 添加读书笔记' })
  const root = join(fixtureRoot, 'project-p1')
  mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(root, '08_APP/app.html'), '<html><body>fixture</body></html>')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 1, target: { kind: 'web', platform: 'Browser', entry: 'app.html' }, artifacts: ['app.html'], build: '静态', run: '打开app.html', tests: [
    { id: 'unit', layer: 'unit', adapter: 'cli-driver', target: 'app.html', command: '辅助检查', covers: [], requiresReal: false },
    { id: 'ui', layer: 'acceptance', adapter: 'browser-file', target: 'app.html', command: '浏览器行为', covers: ['US-01'], requiresReal: false, scenarioFiles: ['features/us-01.steps.json'] },
  ] }))
  return root
}

test('Given 浏览器验收与CLI辅助测试混合 When 宿主运行 Then 两项都批准执行且场景修改使交付证据失效', async () => {
  const root = setupMixedEngineeringFixture()
  const approvals: string[] = []
  const progress: GwtProgressEvent[] = []
  const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', onProgress: (event) => progress.push(event), projectName: '混合工程', projectMode: 'quick', sessionId: 's1', controller: makeMockController(fullPassPage()), engineeringExecution: { signal: new AbortController().signal, services: {
    approve: async ({ test }) => { approvals.push(test.id); return true },
    drivers: [{ adapter: 'cli-driver', execute: async ({ test }) => ({ testId: test.id, target: test.target, exitCode: 0, checks: [{ storyId: null, label: '辅助检查', expected: 'ok', actual: 'ok', evidence: ['fixture'] }] }) }],
  } } })
  expect(outcome.verdict).toBe('pass')
  expect(progress.filter((event) => event.phase === 'done')).toHaveLength(1)
  expect(progress.at(-1)?.verdict).toBe('pass')
  expect(progress.at(-1)?.total).toBe(2)
  expect(approvals).toEqual(['unit', 'ui'])
  const report = JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8'))
  expect(report.engineeringSuite.tests.map((test: { testId: string }) => test.testId)).toEqual(['unit', 'ui'])
  expect(report.engineeringSuite.tests[0].coveredUs).toEqual([])
  expect(report.engineeringEvidence.scenarios.length).toBe(1)
  const { checkGwtDeliveryFacts } = await import('./nanju-gwt-runner')
  const input = { workspaceSlug: 'ws', projectId: 'p1', projectDir: root, reportJsonPath: outcome.reportJsonPath, info: { deliveryAck: { reportRunId: report.runId, at: new Date(Date.parse(report.generatedAt) + 1000).toISOString() } } }
  expect(checkGwtDeliveryFacts(input)).toBeNull()
  writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), PASSING_STEPS + '\n ')
  expect(checkGwtDeliveryFacts(input)?.reason).toBe('engineering-changed')
})

test('Given 混合测试取消发生在浏览器场景中 When 停止会话 Then 关闭标签且不执行后续交互', async () => {
  const abort = new AbortController()
  let loads = 0
  let closed = 0
  let clicks = 0
  const controller = makeMockController(fullPassPage())
  controller.loadFileInTab = async () => { loads++; abort.abort() }
  controller.closeTab = async () => { closed++ }
  controller.clickPointInTab = async () => { clicks++ }
  const scenario = validateScenarioFileContent(PASSING_STEPS).scenario!
  await expect(runGwtSuite({ sessionId: 'cancel-fixture', entryHtmlPath: '/fixture/app.html', scenarios: [scenario], controller, screenshotDir: null, signal: abort.signal })).rejects.toThrow('取消')
  expect(loads).toBe(1)
  expect(closed).toBeGreaterThan(0)
  expect(clicks).toBe(0)
})

test('Given 未确认浏览器平台风险 When 混合工程整体预检 Then 不先执行辅助项或打开网页并落blocked报告', async () => {
  setupMixedEngineeringFixture()
  let approvals = 0
  let executions = 0
  const controller = makeMockController(fullPassPage())
  controller.hasRiskDisclaimerAcknowledged = () => false
  controller.createLocalFileTab = async () => { executions++; return { tabId: 'unexpected' } }
  const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '混合工程', projectMode: 'quick', sessionId: 's1', controller, engineeringExecution: { signal: new AbortController().signal, services: {
    approve: async () => { approvals++; return true }, drivers: [{ adapter: 'cli-driver', execute: async () => { executions++; return {} } }],
  } } })
  expect(outcome.verdict).toBe('blocked')
  expect(outcome.blockedReason).toContain('平台账号风险告知')
  expect(approvals).toBe(0)
  expect(executions).toBe(0)
  expect(JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8')).verdict).toBe('blocked')
})

test('Given 辅助项已执行而第二项批准被拒 When 汇总混合工程 Then 保留已执行事实但不交付不消耗修复预算', async () => {
  const root = setupMixedEngineeringFixture()
  writeFileSync(join(root, '06_TESTS/report.json'), JSON.stringify({ verdict: 'fail', retryCount: 1 }))
  const controller = makeMockController(fullPassPage())
  let opened = 0
  controller.createLocalFileTab = async () => { opened++; return { tabId: 'unexpected' } }
  const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '混合工程', projectMode: 'quick', sessionId: 's1', controller, engineeringExecution: { signal: new AbortController().signal, services: {
    approve: async ({ test }) => test.id === 'unit', drivers: [{ adapter: 'cli-driver', execute: async ({ test }) => ({ testId: test.id, target: test.target, exitCode: 0, checks: [{ storyId: null, label: '辅助', expected: 'ok', actual: 'ok', evidence: ['fixture'] }] }) }],
  } } })
  expect(outcome.verdict).toBe('blocked')
  expect(outcome.retryCount).toBe(1)
  expect(opened).toBe(0)
  const report = JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8'))
  expect(report.engineeringSuite.tests.map((entry: { status: string }) => entry.status)).toEqual(['pass', 'blocked'])
  expect(report.retryPending).toBe(true)
})

test('Given 混合工程浏览器选择器映射失败 When 汇总并分流 Then 保留宿主失败步骤并回testing而非coding', async () => {
  const root = setupMixedEngineeringFixture()
  writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), JSON.stringify({ feature: 'US-01 笔记', scenario: '保存笔记', skip: false, skipReason: null, steps: [
    { kind: 'when', text: '点击保存', timeoutMs: 60, op: { type: 'click', selector: 'data-ai-id=missing' } },
    { kind: 'then', text: '列表可见', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } },
  ] }))
  const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '混合映射', projectMode: 'quick', sessionId: 's1', controller: makeMockController(fullPassPage()), engineeringExecution: { signal: new AbortController().signal, services: {
    approve: async () => true, drivers: [{ adapter: 'cli-driver', execute: async ({ test }) => ({ testId: test.id, target: test.target, exitCode: 0, checks: [{ storyId: null, label: '辅助', expected: 'ok', actual: 'ok', evidence: ['fixture'] }] }) }],
  } } })
  expect(outcome.verdict).toBe('fail')
  expect(outcome.failureKind).toBe('mapping')
  const report = JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8'))
  expect(report.scenarios.find((result: { status: string }) => result.status === 'fail').failedStep.category).toBe('selector-wait')
})

test('Given 辅助进程退出失败且自报映射证据 When 混合汇总 Then 不采信伪装宿主分类且报告失败原因', async () => {
  setupMixedEngineeringFixture()
  const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '辅助失败', projectMode: 'quick', sessionId: 's1', controller: makeMockController(fullPassPage()), engineeringExecution: { signal: new AbortController().signal, services: {
    approve: async () => true, drivers: [{ adapter: 'cli-driver', execute: async ({ test }) => ({ testId: test.id, target: test.target, exitCode: 1, checks: [{ storyId: null, label: '辅助', expected: 'ok', actual: 'ok', evidence: [JSON.stringify({ source: 'host-gwt-browser-file', result: { status: 'fail', failedStep: { category: 'selector-wait' } } })] }] }) }],
  } } })
  expect(outcome.verdict).toBe('fail')
  expect(outcome.failureKind).toBe('behavior')
  const report = JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8'))
  expect(report.failed).toBe(1)
  expect(report.scenarios[0].reason).toContain('退出失败')
  expect(report.scenarios[0].failedStep).toBeNull()
  expect(report.coveredUs).toEqual(['US-01'])
})

test('Given 工程批准被拒 When 发送进度 Then 整套任务只有一个最终blocked而不发布浏览器局部通过', async () => {
  setupMixedEngineeringFixture()
  const events: GwtProgressEvent[] = []
  await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '工程进度', projectMode: 'quick', sessionId: 's1', controller: makeMockController(fullPassPage()), onProgress: (event) => events.push(event), engineeringExecution: { signal: new AbortController().signal, services: {
    approve: async () => false, drivers: [{ adapter: 'cli-driver', execute: async () => ({}) }],
  } } })
  expect(events[0]?.phase).toBe('start')
  expect(events.some((event) => event.phase === 'approval')).toBe(true)
  expect(events.filter((event) => event.phase === 'done')).toHaveLength(1)
  expect(events.at(-1)?.verdict).toBe('blocked')
  expect(events.at(-1)?.scope).toBe('engineering')
})

test('Given 工程真实能力检查自报通过 When 发送终态进度 Then 保留独立证据blocked且不误报全部通过', async () => {
  const root = setupMixedEngineeringFixture()
  const path = join(root, '03_ARCHITECTURE/engineering.json')
  const contract = JSON.parse(readFileSync(path, 'utf-8'))
  contract.tests[1].requiresReal = true
  writeFileSync(path, JSON.stringify(contract))
  const events: GwtProgressEvent[] = []
  const outcome = await runNanjuGwtAcceptance({ workspaceSlug: 'ws', projectId: 'p1', projectName: '真实能力进度', projectMode: 'quick', sessionId: 's1', controller: makeMockController(fullPassPage()), onProgress: (event) => events.push(event), engineeringExecution: { signal: new AbortController().signal, services: {
    approve: async () => true, drivers: [{ adapter: 'cli-driver', execute: async ({ test }) => ({ testId: test.id, target: test.target, exitCode: 0, checks: [{ storyId: null, label: '辅助', expected: 'ok', actual: 'ok', evidence: ['fixture'] }] }) }],
  } } })
  expect(outcome.verdict).toBe('blocked')
  expect(events.filter((event) => event.phase === 'done')).toHaveLength(1)
  expect(events.at(-1)?.verdict).toBe('blocked')
  expect(events.at(-1)?.passed).toBe(2)
  expect(events.at(-1)?.reason).toContain('独立')
})

// ===== W-C：served URL（browser-url）执行通道 =====

describe('runGwtSuite entryUrl 模式（专用tab + 场景级URL重载）', () => {
  function urlController(page: FakePage, record: { urls: string[]; opened: number; closed: number }): GwtBrowserAdapter {
    const base = makeMockController(page)
    return {
      ...base,
      createUrlTab: async () => { record.opened++; return { tabId: 'tab-url-1', url: 'http://127.0.0.1:18742/index.html', previousActiveTabId: 'tab-user' } },
      loadUrlInTab: async (_s, _t, url) => { record.urls.push(url); base.loadFileInTab(_s, _t, 'x') },
      closeTab: async () => { record.closed++ },
    }
  }
  const urlScenario = (): GwtScenarioFile => validateScenarioFileContent(JSON.stringify({
    feature: 'us-01', scenario: 'US-01 添加读书笔记', skip: false, skipReason: null,
    steps: [{ kind: 'then', text: '列表可见', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list', timeoutMs: 300 } }],
  }))!.scenario!

  test('entryUrl：经createUrlTab打开专用标签，每场景loadUrlInTab重载，结束关闭', async () => {
    const record = { urls: [] as string[], opened: 0, closed: 0 }
    const results = await runGwtSuite({ sessionId: 's1', entryUrl: 'http://127.0.0.1:18742/index.html', scenarios: [urlScenario(), urlScenario()], controller: urlController(fullPassPage(), record), screenshotDir: null })
    expect(results.map((r) => r.status)).toEqual(['pass', 'pass'])
    expect(record.opened).toBe(1)
    expect(record.urls).toHaveLength(2)
    expect(record.urls[0]).toBe('http://127.0.0.1:18742/index.html')
    expect(record.closed).toBeGreaterThan(0)
  })
  test('适配器未接入URL通道时明确失败而不是回落file直载', async () => {
    const base = makeMockController(fullPassPage())
    let fileLoads = 0
    base.loadFileInTab = async () => { fileLoads++ }
    await expect(runGwtSuite({ sessionId: 's1', entryUrl: 'http://127.0.0.1:18742/index.html', scenarios: [urlScenario()], controller: base, screenshotDir: null })).rejects.toThrow('URL')
    expect(fileLoads).toBe(0)
  })
  test('entryUrl与entryHtmlPath必须二选一', async () => {
    const base = makeMockController(fullPassPage())
    await expect(runGwtSuite({ sessionId: 's1' as never, scenarios: [urlScenario()], controller: base, screenshotDir: null } as never)).rejects.toThrow('入口')
  })
  test('场景后校验实际URL出origin → 场景fail且标签关闭（S9）', async () => {
    const record = { urls: [] as string[], opened: 0, closed: 0 }
    let asserted = 0
    const controller = {
      ...urlController(fullPassPage(), record),
      assertUrlTabOrigin: async () => { asserted++; throw new Error('已离开宿主loopback地址') },
    }
    const results = await runGwtSuite({ sessionId: 's1', entryUrl: 'http://127.0.0.1:18742/index.html', scenarios: [urlScenario()], controller, screenshotDir: null })
    expect(asserted).toBeGreaterThan(0)
    expect(results[0]?.status).toBe('fail')
    expect(record.closed).toBeGreaterThan(0)
  })
})

/** 服务fixture子进程：不真实启动进程或监听端口 */
class FakeServiceChild {
  pid = 4242
  killed = 0
  exited = false
  killGroup(): void { this.killed += 1 }
  hasExited(): boolean { return this.exited }
  exitCode(): number | null { return this.exited ? 0 : null }
}
function fakeServiceDeps(child: FakeServiceChild, occupied: { port: boolean } = { port: false }) {
  return {
    spawnService: () => child,
    probeLoopbackPort: async () => occupied.port,
    requestReady: async () => ({ status: 200, nonceMatch: true }),
    now: () => Date.now(),
    sleep: async () => {},
  }
}

test('Given 混合CLI辅助与browser-url验收 When 宿主运行 Then 服务批准后启动、专用tab一次done、结束必停服务', async () => {
  setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS }, prd: '# PRD\nUS-01 添加读书笔记' })
  const root = join(fixtureRoot, 'project-p1')
  mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(root, '08_APP/server.cjs'), '// 服务fixture，不真实启动')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
    schemaVersion: 1, target: { kind: 'web', platform: 'Browser', entry: 'index.html' }, artifacts: ['index.html', 'server.cjs'], build: '无需构建', run: '宿主启动服务后经loopback访问',
    tests: [
      { id: 'unit', layer: 'unit', adapter: 'cli-driver', target: 'index.html', command: '辅助检查', covers: [], requiresReal: false },
      { id: 'served', layer: 'acceptance', adapter: 'browser-url', target: 'index.html', command: '经服务入口验证', covers: ['US-01'], requiresReal: false, scenarioFiles: ['features/us-01.steps.json'], service: { runtime: 'node', path: 'server.cjs', args: [], port: 18742, readyPath: '/', readyTimeoutMs: 500 } },
    ],
  }))
  const approvals: string[] = []
  const events: GwtProgressEvent[] = []
  const openedUrls: string[] = []
  const child = new FakeServiceChild()
  const page = fullPassPage()
  const base = makeMockController(page)
  const controller: GwtBrowserAdapter = { ...base, createUrlTab: async (_s, url) => { openedUrls.push(url); return { tabId: 'tab-url-1', url } }, loadUrlInTab: async () => {} }
  const { isRegisteredEngineeringServiceUrl } = await import('./nanju-engineering-service')
  const outcome = await runNanjuGwtAcceptance({
    workspaceSlug: 'ws', projectId: 'p1', projectName: '服务工程', projectMode: 'quick', sessionId: 's1', controller,
    onProgress: (event) => events.push(event),
    engineeringExecution: {
      signal: new AbortController().signal,
      serviceRuntimes: { nodePath: process.execPath },
      serviceDeps: fakeServiceDeps(child),
      services: {
        approve: async ({ test }) => { approvals.push(test.id); return true },
        drivers: [{ adapter: 'cli-driver', execute: async ({ test }) => ({ testId: test.id, target: test.target, exitCode: 0, checks: [{ storyId: null, label: '辅助检查', expected: 'ok', actual: 'ok', evidence: ['fixture'] }] }) }],
      },
    },
  })
  expect(outcome.verdict).toBe('pass')
  expect(approvals).toEqual(['unit', 'served'])
  expect(openedUrls).toEqual(['http://127.0.0.1:18742/index.html'])
  expect(events.filter((event) => event.phase === 'done')).toHaveLength(1)
  expect(events.at(-1)?.scope).toBe('engineering')
  expect(child.killed).toBeGreaterThan(0)
  expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/index.html')).toBe(false)
  const report = JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8'))
  expect(report.entry).toBe('08_APP/index.html')
  expect(report.executionContext).toBe('project-driver')
  expect(report.engineeringEvidence.scenarios.length).toBe(1)
  const scenarioEntry = report.scenarios.find((s: { feature: string }) => s.feature === 'us-01')
  expect(scenarioEntry.status).toBe('pass')
  // 场景变更失效：场景文件改动使交付证据失配
  const { checkGwtDeliveryFacts } = await import('./nanju-gwt-runner')
  const info = { deliveryAck: { reportRunId: report.runId, at: new Date(Date.parse(report.generatedAt) + 1000).toISOString() } }
  const gateInput = { workspaceSlug: 'ws', projectId: 'p1', projectDir: root, reportJsonPath: outcome.reportJsonPath, info }
  expect(checkGwtDeliveryFacts(gateInput)).toBeNull()
  writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), PASSING_STEPS + '\n')
  expect(checkGwtDeliveryFacts(gateInput)?.reason).toBe('engineering-changed')
})

test('Given 服务端口被占 When browser-url执行 Then 拒绝接管且不开浏览器不泄漏句柄', async () => {
  setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS }, prd: '# PRD\nUS-01 添加读书笔记' })
  const root = join(fixtureRoot, 'project-p1')
  mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(root, '08_APP/server.cjs'), '// 服务fixture')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
    schemaVersion: 1, target: { kind: 'web', platform: 'Browser', entry: 'index.html' }, artifacts: ['index.html', 'server.cjs'], build: '无需构建', run: '宿主启动服务',
    tests: [{ id: 'served', layer: 'acceptance', adapter: 'browser-url', target: 'index.html', command: '经服务入口验证', covers: ['US-01'], requiresReal: false, scenarioFiles: ['features/us-01.steps.json'], service: { runtime: 'node', path: 'server.cjs', args: [], port: 18742, readyPath: '/', readyTimeoutMs: 500 } }],
  }))
  const child = new FakeServiceChild()
  let urlTabs = 0
  const base = makeMockController(fullPassPage())
  const controller: GwtBrowserAdapter = { ...base, createUrlTab: async () => { urlTabs++; throw Error('不应打开URL标签') } }
  const outcome = await runNanjuGwtAcceptance({
    workspaceSlug: 'ws', projectId: 'p1', projectName: '端口占用', projectMode: 'quick', sessionId: 's1', controller,
    engineeringExecution: {
      signal: new AbortController().signal, serviceRuntimes: { nodePath: process.execPath },
      serviceDeps: fakeServiceDeps(child, { port: true }),
      services: { approve: async () => true, drivers: [] },
    },
  })
  expect(outcome.verdict).toBe('blocked')
  expect(outcome.blockedReason).toContain('端口已被占用')
  expect(urlTabs).toBe(0)
  expect(child.killed).toBe(0)
})

test('Given browser-url多场景中途出origin When 宿主运行 Then verdict fail不烧error计数（N1）', async () => {
  const stepsB = JSON.stringify({
    feature: 'us-01', scenario: 'US-01 读书笔记列表二次展示', skip: false, skipReason: null,
    steps: [{ kind: 'then', text: '列表可见', op: { type: 'assert-count', selector: 'data-ai-id=view-note-list', count: 1 } }],
  })
  setupProjectFixture({ stepsFiles: { 'us-01.steps.json': PASSING_STEPS, 'us-01b.steps.json': stepsB }, prd: '# PRD\nUS-01 添加读书笔记' })
  const root = join(fixtureRoot, 'project-p1')
  mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(root, '08_APP/server.cjs'), '// 服务fixture，不真实启动')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
    schemaVersion: 1, target: { kind: 'web', platform: 'Browser', entry: 'index.html' }, artifacts: ['index.html', 'server.cjs'], build: '无需构建', run: '宿主启动服务后经loopback访问',
    tests: [{ id: 'served', layer: 'acceptance', adapter: 'browser-url', target: 'index.html', command: '经服务入口验证', covers: ['US-01'], requiresReal: false, scenarioFiles: ['features/us-01.steps.json', 'features/us-01b.steps.json'], service: { runtime: 'node', path: 'server.cjs', args: [], port: 18742, readyPath: '/', readyTimeoutMs: 500 } }],
  }))
  const child = new FakeServiceChild()
  const base = makeMockController(fullPassPage())
  let originChecks = 0
  const controller: GwtBrowserAdapter = {
    ...base,
    createUrlTab: async (_s, url) => ({ tabId: 'tab-url-1', url }),
    loadUrlInTab: async () => {},
    // 第一次场景后校验出 origin（页面 JS 跳转外站），后续场景恢复在册 origin。
    assertUrlTabOrigin: async () => { originChecks++; if (originChecks === 1) throw new Error('已离开宿主loopback地址') },
  }
  const outcome = await runNanjuGwtAcceptance({
    workspaceSlug: 'ws', projectId: 'p1', projectName: '出origin', projectMode: 'quick', sessionId: 's1', controller,
    engineeringExecution: {
      signal: new AbortController().signal, serviceRuntimes: { nodePath: process.execPath },
      serviceDeps: fakeServiceDeps(child),
      services: { approve: async () => true, drivers: [] },
    },
  })
  expect(outcome.verdict).toBe('fail')
  expect(outcome.errorCount).toBe(0)
  const report = JSON.parse(readFileSync(outcome.reportJsonPath, 'utf-8'))
  expect(report.scenarios.map((s: { status: string }) => s.status)).toEqual(['fail', 'pass'])
  expect(child.killed).toBeGreaterThan(0)
})
