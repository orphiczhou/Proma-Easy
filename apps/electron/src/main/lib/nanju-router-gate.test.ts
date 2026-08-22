/**
 * 南大向导 v2 路由门禁：verifyPhaseOutput 单测（AC G-001，v0.17.60）
 *
 * 覆盖面（审计裁决指定）：正常相对引用通过 / 缺失资源拦截 / 带 query /
 * 带 hash+query / 百分号非法编码不抛（降级原始串）/ 根绝对路径跳过 /
 * 协议相对 //cdn 排除 / data: 排除 / mailto: 排除（通用 scheme）/ 单引号
 * 属性识别 / ../ 越界拦截 / 非 coding 阶段不做引用校验 / 文件<100B 存量回归。
 *
 * verifyPhaseOutput 依赖 config-paths.getWorkspaceFilesDir 定位项目目录——
 * 按本仓库既有测试模式（见 __tests__/nanju-ipc.test.ts）先 mock.module
 * 指向 tmpdir，再动态导入被测模块。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 当前 fixture 根目录（mock 的 getWorkspaceFilesDir 每次调用时读取） */
let fixtureRoot = ''

// partial mock：spread 真实模块后再覆盖路径函数（bun mock.module 全局生效，
// 全量替换会泄漏破坏 nanju-ipc 链路的 getChatToolsConfigPath 导入）
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const { verifyPhaseOutput } = await import('./nanju-router-gate')

const WORKSPACE_SLUG = 'test-ws'
const PROJECT_ID = 'p1'

/** 骨架 HTML（>100B 且过 coding/prototype 最低格式检查） */
function htmlDoc(body: string): string {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`
}

/**
 * 构造独立 tmpdir fixture：_nanju-projects.json 元数据 +
 * project-p1/{08_APP|02_UX_DESIGN} 产出文件 + 可选同目录资源文件。
 * 返回可直接喂给 verifyPhaseOutput 的 workspaceSlug。
 */
function setupFixture(opts: { stage: 'coding' | 'prototype' | 'testing'; html: string; files?: Record<string, string> }): string {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-gate-'))
  fixtureRoot = dir
  const outputDirName = opts.stage === 'coding' ? '08_APP' : opts.stage === 'testing' ? '06_TESTS/features' : '02_UX_DESIGN'
  const outputFileName = opts.stage === 'coding' ? 'index.html' : opts.stage === 'testing' ? 'index.feature' : 'prototype.html'
  mkdirSync(join(dir, `project-${PROJECT_ID}`, outputDirName), { recursive: true })
  writeFileSync(join(dir, `project-${PROJECT_ID}`, outputDirName, outputFileName), opts.html)
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    writeFileSync(join(dir, `project-${PROJECT_ID}`, outputDirName, name), content)
  }
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
    projectId: PROJECT_ID,
    name: '门禁测试项目',
    mode: 'quick',
    status: 'active',
    currentStage: opts.stage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: 'session-1',
  }]))
  return WORKSPACE_SLUG
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

describe('verifyPhaseOutput 引用校验（coding 阶段，AC Z-001/Z-002/Z-003）', () => {
  test('正常相对引用：资源存在 → 通过（null）', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<script src="app.js"></script><link rel="stylesheet" href="style.css">'),
      files: { 'app.js': 'console.log(1)', 'style.css': 'body{}' },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBeNull()
  })

  test('缺失资源拦截：引用 style.css 未落盘 → 报资源不存在', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<script src="app.js"></script><link rel="stylesheet" href="style.css">'),
      files: { 'app.js': 'console.log(1)' },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBe('入口文件引用的资源不存在：style.css')
  })

  test('带 query：src="app.js?v=2" → 剥 query 后校验，通过', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<script src="app.js?v=2"></script>'),
      files: { 'app.js': 'console.log(1)' },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBeNull()
  })

  test('带 hash+query：src="app.js?v=2#frag" → 先剥 hash 再剥 query，通过', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<script src="app.js?v=2#frag"></script>'),
      files: { 'app.js': 'console.log(1)' },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBeNull()
  })

  test('百分号非法编码不抛：src="%zz.js" 降级原始串后按缺失拦截（不 throw）', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<script src="%zz.js"></script>'),
    })
    // 直接调用：若 decodeURIComponent 抛 URIError 此行即失败，隐式覆盖「不抛」
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toContain('资源不存在')
  })

  test('根绝对路径跳过：src="/favicon.ico" 不存在也不拦截（加载失败由预览暴露）', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<link rel="icon" href="/favicon.ico">'),
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBeNull()
  })

  test('协议相对排除：src="//cdn.example.com/x.js" 不做本地校验', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<script src="//cdn.example.com/x.js"></script>'),
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBeNull()
  })

  test('data: URI 排除：内联 base64 图片不触发本地文件校验', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<img src="data:image/png;base64,iVBORw0KGgo=" alt="px">'),
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBeNull()
  })

  test('mailto: 排除（通用 scheme）：href="mailto:a@b.c" 不误拦截（修复前旧正则会拦）', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<a href="mailto:contact@example.com">联系</a>'),
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBeNull()
  })

  test('单引号属性识别：缺失的单引号引用同样被拦截', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc(`<script src='app2.js'></script>`),
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBe('入口文件引用的资源不存在：app2.js')
  })

  test('../ 越界拦截：引用越出 08_APP 目录即使目标文件存在也拦截', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: htmlDoc('<script src="../secret.js"></script>'),
      files: { '../secret.js': 'leak' },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBe('入口文件引用越出 08_APP 目录：../secret.js')
  })
})

describe('verifyPhaseOutput 分层边界（阶段与体积，AC F-002 存量回归）', () => {
  test('非 coding 阶段不做引用校验：prototype.html 引用缺失资源仍通过', () => {
    const ws = setupFixture({
      stage: 'prototype',
      html: htmlDoc('<script src="missing.js"></script>'),
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'prototype')).toBeNull()
  })

  test('文件<100B 存量回归：产出过小仍被体积检查拦截', () => {
    const ws = setupFixture({
      stage: 'coding',
      html: '<!DOCTYPE html><html><body>x</body></html>',
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toContain('产出文件过小')
  })
})

describe('verifyPhaseOutput testing 阶段（P1 Sprint B：Gherkin 汇总入口门禁）', () => {
  const featureDoc = (body: string): string =>
    `# 读书笔记验收场景\n${body}`

  test('合规汇总入口（Feature: + Scenario: 结构）通过；成对 steps.json 存在（v0.17.63 AC I-001）', () => {
    const ws = setupFixture({
      stage: 'testing',
      html: featureDoc('Feature: US-01 读书笔记\n  Scenario: US-01 添加笔记\n    Given 用户在列表页\n    When 输入书名\n    Then 列表显示'),
      files: { 'us-01.steps.json': '{"feature":"us-01","scenario":"US-01 添加笔记","skip":false,"skipReason":null,"steps":[]}' },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'testing')).toBeNull()
  })

  test('全目录无 Scenario: 拦截（v0.17.64 目录兑底：index 仅 Feature + 有 steps.json 但无任何含场景的 .feature）', () => {
    const ws = setupFixture({
      stage: 'testing',
      html: featureDoc('Feature: US-01 读书笔记\n（这里只有 Feature 没有任何场景定义，补充说明文本用于超过一百字节的最低体积门槛，确保体积检查不先行拦截本用例的格式断言。）'),
      files: { 'us-01.steps.json': '{}' },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'testing')).toContain('缺少可执行场景')
  })

  test('目录兑底通过（实证③「总览+分文件」结构：index.feature 纯索引无 Scenario + us-01.feature 含 Feature+Scenario + 成对 steps.json）', () => {
    const ws = setupFixture({
      stage: 'testing',
      // index.feature 为纯索引：只列清单不写场景（v0.17.64 前会被误拦）
      html: featureDoc('Feature: 读书笔记验收场景索引\n（索引文件：场景分布在各 us-XX.feature 分文件，补充说明文本用于超过一百字节的最低体积门槛，确保体积检查不先行拦截本用例。）'),
      files: {
        'us-01.feature': 'Feature: US-01 读书笔记\n  Scenario: US-01 添加笔记\n    Given 用户在列表页\n    When 输入书名\n    Then 列表显示',
        'us-01.steps.json': '{"feature":"us-01","scenario":"US-01 添加笔记","skip":false,"skipReason":null,"steps":[]}',
      },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'testing')).toBeNull()
  })

  test('目录兑底拦截变体：分文件存在但全部无 Scenario:（仅有 steps.json）→ 拦截', () => {
    const ws = setupFixture({
      stage: 'testing',
      html: featureDoc('Feature: 索引\n（纯索引说明文本，补齐最低体积门槛，避免体积检查先行拦截，确保断言落在目录兑底检查上。）'),
      files: {
        'us-01.feature': 'Feature: US-01 只有 Feature 头没有场景定义的非法分文件',
        'us-01.steps.json': '{}',
      },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'testing')).toContain('缺少可执行场景')
  })

  test('steps.json 存在性门禁（AC I-001）：只有汇总入口无任何 *.steps.json → 拦截', () => {
    const ws = setupFixture({
      stage: 'testing',
      html: featureDoc('Feature: US-01 读书笔记\n  Scenario: US-01 添加笔记\n    Given 用户在列表页'),
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'testing')).toContain('缺少可执行步骤映射')
  })

  test('steps.json 占位拦截（v0.17.65 AC I-1）：空 JSON / 缺 feature 或 scenario 的占位文件不算，需可解析且字段非空', () => {
    const base = featureDoc('Feature: US-01 读书笔记\n  Scenario: US-01 添加笔记\n    Given 用户在列表页\n    When 输入书名\n    Then 列表显示')
    // 空对象占位 → 拦截
    const empty = setupFixture({ stage: 'testing', html: base, files: { 'us-01.steps.json': '{}' } })
    expect(verifyPhaseOutput(empty, PROJECT_ID, 'testing')).toContain('缺少可执行步骤映射')
    // scenario 为空串 → 拦截
    const noScenario = setupFixture({ stage: 'testing', html: base, files: { 'us-01.steps.json': '{"feature":"us-01","scenario":""}' } })
    expect(verifyPhaseOutput(noScenario, PROJECT_ID, 'testing')).toContain('缺少可执行步骤映射')
    // 非法 JSON → 拦截
    const broken = setupFixture({ stage: 'testing', html: base, files: { 'us-01.steps.json': '{not json' } })
    expect(verifyPhaseOutput(broken, PROJECT_ID, 'testing')).toContain('缺少可执行步骤映射')
    // 多文件中只要有一个合法即可通过
    const mixed = setupFixture({
      stage: 'testing',
      html: base,
      files: {
        'us-00.steps.json': '{}',
        'us-01.steps.json': '{"feature":"us-01","scenario":"US-01 添加笔记","skip":false,"skipReason":null,"steps":[]}',
      },
    })
    expect(verifyPhaseOutput(mixed, PROJECT_ID, 'testing')).toBeNull()
  })

  test('汇总入口缺失拦截：index.feature 不存在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nanju-gate-'))
    fixtureRoot = dir
    mkdirSync(join(dir, `project-${PROJECT_ID}`, '06_TESTS'), { recursive: true })
    writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
      projectId: PROJECT_ID, name: 't', mode: 'quick', status: 'active',
      currentStage: 'testing', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionId: 'session-1',
    }]))
    expect(verifyPhaseOutput(WORKSPACE_SLUG, PROJECT_ID, 'testing')).toContain('产出文件不存在')
  })
})
