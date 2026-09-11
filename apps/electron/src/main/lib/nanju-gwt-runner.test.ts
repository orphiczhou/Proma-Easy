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
} = await import('./nanju-gwt-runner')
import type { GwtBrowserAdapter, GwtScenarioFile, GwtProgressEvent, NanjuGwtOutcome } from './nanju-gwt-runner'

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

// ===== FakePage：按模板表达式特征模拟 DOM 状态（selector/kind 从 JSON 字符串参数提取） =====

class FakePage {
  elements = new Map<string, { visible: boolean; text: string }>()
  clicks: Array<{ x: number; y: number }> = []
  keys: string[] = []
  fills: Array<{ selector: string; text: string }> = []
  /** loadFileInTab 调用计数（场景隔离验证） */
  reloads = 0

  private strings(expr: string): string[] {
    const out: string[] = []
    for (const m of expr.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      try { out.push(JSON.parse(`"${m[1]}"`)) } catch { /* 非法 JSON 串跳过 */ }
    }
    return out
  }

  eval(expr: string): unknown {
    const strings = this.strings(expr)
    const sel = strings[0] ?? ''
    if (expr.includes('dispatchEvent')) {
      this.fills.push({ selector: sel, text: strings[1] ?? '' })
      return { ok: true }
    }
    if (expr.includes('getBoundingClientRect')) {
      return this.elements.has(sel) ? { x: 8, y: 16 } : null
    }
    if (expr.startsWith('(() => !!document.querySelector')) {
      return this.elements.has(sel)
    }
    // 完整断言模板（特征：els.length === 0 分支；strings = [selector, kind, contains?]）
    if (expr.includes('els.length === 0')) {
      const kind = strings[1] ?? ''
      if (!this.elements.has(sel)) return { ok: false, actual: '元素不存在' }
      if (kind === 'selector') return { ok: true, actual: '元素存在' }
      if (kind === 'visible') {
        const visible = this.elements.get(sel)?.visible === true
        return { ok: visible, actual: visible ? '元素可见' : '元素不可见' }
      }
      if (kind === 'count') {
        const n = this.elements.has(sel) ? 1 : 0
        const expectMatch = /n === (\d+)/.exec(expr)
        const expect = expectMatch ? Number(expectMatch[1]) : 0
        return { ok: n === expect, actual: `数量 ${n}` }
      }
      // contains 取模板最后一个 JSON 字符串（text 分支的 expect；kind 字符串会出现多次）
      const contains = strings[strings.length - 1] ?? ''
      const text = this.elements.get(sel)?.text ?? ''
      const ok = text.includes(contains)
      return { ok, actual: JSON.stringify(text).slice(0, 120) }
    }
    return undefined
  }
}

function makeMockController(page: FakePage): GwtBrowserAdapter {
  return {
    createLocalFileTab: async () => ({ tabId: 'tab-gwt-1' }),
    loadFileInTab: async () => { page.reloads += 1 },
    evaluateInTab: async (_sessionId, _tabId, expr) => page.eval(expr),
    clickPointInTab: async (_sessionId, _tabId, x, y) => { page.clicks.push({ x, y }) },
    pressKeyInTab: async (_sessionId, _tabId, key) => { page.keys.push(key) },
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

describe('normalizeGwtSelector', () => {
  test('三种合法形态统一归一为 [data-ai-id="xxx"]', () => {
    expect(normalizeGwtSelector('data-ai-id=btn-save')).toBe('[data-ai-id="btn-save"]')
    expect(normalizeGwtSelector('[data-ai-id="btn-save"]')).toBe('[data-ai-id="btn-save"]')
    expect(normalizeGwtSelector("[data-ai-id='btn-save']")).toBe('[data-ai-id="btn-save"]')
    expect(normalizeGwtSelector('  data-ai-id = input-title  ')).toBe('[data-ai-id="input-title"]')
  })

  test('非法形态返回 null（不允许臆造任意 CSS）', () => {
    expect(normalizeGwtSelector('#main .btn')).toBeNull()
    expect(normalizeGwtSelector('data-ai-id=1abc')).toBeNull()          // 首字符非字母
    expect(normalizeGwtSelector('data-ai-id=a b')).toBeNull()           // 含空格
    expect(normalizeGwtSelector('[data-ai-id="ok"] .child')).toBeNull() // 复合选择器
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
    const badSel = JSON.stringify({ ...noteScenario(), steps: [{ kind: 'when', text: 'x', op: { type: 'click', selector: '#main' } }] })
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
    page.elements.set('[data-ai-id="input-title"]', { visible: true, text: '' })
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
    expect(page.fills).toEqual([{ selector: '[data-ai-id="input-title"]', text: '百年孤独' }])
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

  test('schema 非法文件：降级为 skip 场景透明记录，不执行', async () => {
    setupProjectFixture({ stepsFiles: { 'bad.steps.json': '{"feature":"us-01","scenario":1}' } })
    const outcome = await runNanjuGwtAcceptance({
      workspaceSlug: 'ws', projectId: 'p1', projectName: '读书笔记', projectMode: 'quick',
      sessionId: 's1', controller: makeMockController(new FakePage()),
    })
    expect(outcome.verdict).toBe('fail')
    expect(outcome.judgement.skipped).toBe(1)
    expect(outcome.results[0]?.reason).toContain('schema 校验失败')
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
