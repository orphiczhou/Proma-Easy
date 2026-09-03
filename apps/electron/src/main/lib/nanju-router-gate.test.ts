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

const { verifyPhaseOutput, validateAdvanceTarget } = await import('./nanju-router-gate')

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
function setupFixture(opts: {
  stage: 'coding' | 'prototype' | 'testing' | 'architecture'
  html: string
  files?: Record<string, string>
  mode?: 'quick' | 'iterative'
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-gate-'))
  fixtureRoot = dir
  const outputDirName = opts.stage === 'coding' ? '08_APP' : opts.stage === 'testing' ? '06_TESTS/features' : opts.stage === 'architecture' ? '03_ARCHITECTURE' : '02_UX_DESIGN'
  const outputFileName = opts.stage === 'coding' ? 'index.html' : opts.stage === 'testing' ? 'index.feature' : opts.stage === 'architecture' ? 'architecture.md' : 'prototype.html'
  mkdirSync(join(dir, `project-${PROJECT_ID}`, outputDirName), { recursive: true })
  writeFileSync(join(dir, `project-${PROJECT_ID}`, outputDirName, outputFileName), opts.html)
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    writeFileSync(join(dir, `project-${PROJECT_ID}`, outputDirName, name), content)
  }
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
    projectId: PROJECT_ID,
    name: '门禁测试项目',
    mode: opts.mode ?? 'quick',
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

// ===== W7 环境门禁（v0.17.69）：verifyPhaseOutput architecture 分支扩展 =====

describe('verifyPhaseOutput 环境门禁（W7 B4：envReady 拦截 + 降级规则 + R2 规则校验）', () => {
  /** 合法架构文档（desktop-app 品类 + 环境清单 + ready 标记行） */
  const validArchDoc = (category: string, envLine: string, components: string): string =>
    `# 架构文档\n\n## 技术选型\n\nTauri v2 桌面程序。\n\nprojectCategory: ${category}\n\n## 环境配置\n\n| 组件 | 版本 | 用途 | 探测结果 | 备注 |\n| --- | --- | --- | --- | --- |\n${components}\n\n${envLine}\n`

  const { setProjectCategory, setProjectEnvState } = require('./nanju-project') as typeof import('./nanju-project')

  test('非 web 品类 + envReady=false → 拦截（消息含缺失组件清单）', () => {
    const ws = setupFixture({
      stage: 'architecture',
      mode: 'iterative',
      html: validArchDoc('desktop-app', 'projectEnv: missing:rustc,cargo', '| rustc | 缺失 | Rust 编译器 | 缺失 | curl 安装 |\n| cargo | 缺失 | 包管理 | 缺失 | rustup |'),
    })
    setProjectCategory(ws, PROJECT_ID, 'desktop-app', 'architecture')
    setProjectEnvState(ws, PROJECT_ID, false, [
      { component: 'rustc', ok: false, attemptedAt: new Date().toISOString() },
      { component: 'cargo', ok: false, attemptedAt: new Date().toISOString() },
    ])
    const error = verifyPhaseOutput(ws, PROJECT_ID, 'architecture')
    expect(error).toContain('环境未就绪')
    expect(error).toContain('rustc')
    expect(error).toContain('cargo')
  })

  test('非 web 品类 + envReady 缺失（存量豁免，R8 禁裸 !==true）→ 放行', () => {
    const ws = setupFixture({
      stage: 'architecture',
      mode: 'iterative',
      html: validArchDoc('desktop-app', '（无标记行场景——存量项目无 envReady 字段）', ''),
    })
    setProjectCategory(ws, PROJECT_ID, 'desktop-app', 'architecture')
    // 不 setProjectEnvState：envReady 字段缺失 → 免检放行（S4 后续可改补探测）
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })

  test('非 web 品类 + envReady=true + 清单合法 → 放行', () => {
    const ws = setupFixture({
      stage: 'architecture',
      mode: 'iterative',
      html: validArchDoc('desktop-app', 'projectEnv: ready', '| rustc | 1.75 | 编译 | 就绪 | - |\n| cargo | 1.75 | 包管理 | 就绪 | - |\n| node | 20 | 前端 | 就绪 | - |'),
    })
    setProjectCategory(ws, PROJECT_ID, 'desktop-app', 'architecture')
    setProjectEnvState(ws, PROJECT_ID, true, [{ component: 'rustc', ok: true, attemptedAt: '' }])
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })

  test('非 web 品类 + envReady=true + 清单 typo 组件 → 拦截（R2 第 4 层兜底）', () => {
    const ws = setupFixture({
      stage: 'architecture',
      mode: 'iterative',
      html: validArchDoc('desktop-app', 'projectEnv: ready', '| rustcc | 1.75 | 编译 | 就绪 | - |\n| nodee | 20 | 前端 | 就绪 | - |'),
    })
    setProjectCategory(ws, PROJECT_ID, 'desktop-app', 'architecture')
    setProjectEnvState(ws, PROJECT_ID, true, [{ component: 'rustcc', ok: true, attemptedAt: '' }])
    const error = verifyPhaseOutput(ws, PROJECT_ID, 'architecture')
    expect(error).toContain('环境配置清单校验未通过')
    expect(error).toContain('rustcc')
    expect(error).toContain('nodee')
  })

  test('web-default 品类（无标记/无写入）→ 免环境门禁（envReady=false 也不拦）', () => {
    const ws = setupFixture({
      stage: 'architecture',
      mode: 'quick',
      html: '# 架构文档（web-default 免检用例，补足最低 100 字节）\n\n## 技术选型\n\n纯前端应用，无后端依赖，浏览器直接打开即可运行。\n\n本节内容用于撑过产出文件最低大小检查，不代表真实架构文档。\n\nprojectEnv: ready\n',
    })
    // 不写 projectCategory：resolved = web-default → 免 envReady 校验
    // （即便此前置位 false 也不拦——web 品类按 W7 v3 §6.1 免环境门禁）
    setProjectEnvState(ws, PROJECT_ID, false, [{ component: 'node', ok: false, attemptedAt: '' }])
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })

  test('品类标记非法值（R2 品类幻觉）→ 拦截（合法值六枚举提示）', () => {
    const ws = setupFixture({
      stage: 'architecture',
      mode: 'quick',
      html: '# 架构文档（品类幻觉拦截用例，补足最低 100 字节）\n\nprojectCategory: desktop\n\n## 技术选型\n\n本节内容用于撑过产出文件最低大小检查，不代表真实架构文档内容。\n\n桌面应用技术选型待定。\n',
    })
    const error = verifyPhaseOutput(ws, PROJECT_ID, 'architecture')
    expect(error).toContain('品类标记非法')
    expect(error).toContain('projectCategory: desktop')
    expect(error).toContain('desktop-app')
  })

  test('合法品类标记 + quick 模式 → 品类幻觉检查不误拦（desktop-app 在六枚举内）', () => {
    const ws = setupFixture({
      stage: 'architecture',
      mode: 'quick',
      html: validArchDoc('desktop-app', 'projectEnv: ready', '| rustc | 1.75 | 编译 | 就绪 | - |\n| node | 20 | 前端 | 就绪 | - |'),
    })
    setProjectCategory(ws, PROJECT_ID, 'desktop-app', 'architecture')
    setProjectEnvState(ws, PROJECT_ID, true, [{ component: 'rustc', ok: true, attemptedAt: '' }])
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })
})

// ===== W11（v0.17.73）：PHASE_ADVANCE 推进目标校验 validateAdvanceTarget =====
// 矩阵：六活跃阶段 × 合法/跳级/回退 + testing 特判豁免 + 异常兜底放行。
// 背景：终测 E2E 实锤——L1 在 prototype 阶段输出 `PHASE_ADVANCE: coding` 跳过
// architecture（jsonl 行 81）；接线见 agent-orchestrator.ts 通用推进分支
//（isTestingSelfAdvance / isDeliverFromTesting 两特殊分支在校验前分流）。

describe('validateAdvanceTarget（W11 推进目标校验）', () => {
  test('iterative 六阶段合法推进全放行（route.next 同源）', () => {
    expect(validateAdvanceTarget('iterative', 'requirements', 'prototype')).toEqual({ ok: true })
    expect(validateAdvanceTarget('iterative', 'prototype', 'architecture')).toEqual({ ok: true })
    expect(validateAdvanceTarget('iterative', 'architecture', 'planning')).toEqual({ ok: true })
    expect(validateAdvanceTarget('iterative', 'planning', 'coding')).toEqual({ ok: true })
    expect(validateAdvanceTarget('iterative', 'coding', 'testing')).toEqual({ ok: true })
  })

  test('iterative 跳级拒绝（expected 给出唯一合法目标）', () => {
    // 终测 E2E 实锤场景：prototype 输出 PHASE_ADVANCE: coding 跳过 architecture
    expect(validateAdvanceTarget('iterative', 'prototype', 'coding')).toEqual({ ok: false, expected: 'architecture' })
    expect(validateAdvanceTarget('iterative', 'requirements', 'architecture')).toEqual({ ok: false, expected: 'prototype' })
    expect(validateAdvanceTarget('iterative', 'requirements', 'delivered')).toEqual({ ok: false, expected: 'prototype' })
    expect(validateAdvanceTarget('iterative', 'architecture', 'coding')).toEqual({ ok: false, expected: 'planning' })
    expect(validateAdvanceTarget('iterative', 'coding', 'delivered')).toEqual({ ok: false, expected: 'testing' })
  })

  test('iterative 回退拒绝（含原地自推——推进必须有位移）', () => {
    expect(validateAdvanceTarget('iterative', 'prototype', 'requirements')).toEqual({ ok: false, expected: 'architecture' })
    expect(validateAdvanceTarget('iterative', 'planning', 'prototype')).toEqual({ ok: false, expected: 'coding' })
    expect(validateAdvanceTarget('iterative', 'coding', 'architecture')).toEqual({ ok: false, expected: 'testing' })
    expect(validateAdvanceTarget('iterative', 'requirements', 'requirements')).toEqual({ ok: false, expected: 'prototype' })
  })

  test('testing 特判豁免：GWT 重入（testing→testing）与交付（testing→delivered）放行', () => {
    expect(validateAdvanceTarget('iterative', 'testing', 'testing')).toEqual({ ok: true })
    expect(validateAdvanceTarget('quick', 'testing', 'delivered')).toEqual({ ok: true })
  })

  test('testing 非豁免目标仍拒绝（回炉 coding 走 GWT fail 路径，不是标记推进）', () => {
    expect(validateAdvanceTarget('iterative', 'testing', 'coding')).toEqual({ ok: false, expected: 'delivered' })
  })

  test('quick 链（无 planning）合法推进全放行', () => {
    expect(validateAdvanceTarget('quick', 'requirements', 'prototype')).toEqual({ ok: true })
    expect(validateAdvanceTarget('quick', 'prototype', 'architecture')).toEqual({ ok: true })
    expect(validateAdvanceTarget('quick', 'architecture', 'coding')).toEqual({ ok: true })
    expect(validateAdvanceTarget('quick', 'coding', 'testing')).toEqual({ ok: true })
  })

  test('quick 跳级/回退拒绝（quick 链 architecture.next=coding，无 planning 边）', () => {
    expect(validateAdvanceTarget('quick', 'prototype', 'coding')).toEqual({ ok: false, expected: 'architecture' })
    expect(validateAdvanceTarget('quick', 'architecture', 'planning')).toEqual({ ok: false, expected: 'coding' })
    expect(validateAdvanceTarget('quick', 'coding', 'prototype')).toEqual({ ok: false, expected: 'testing' })
  })

  test('防御性放行：异常 mode / route 缺失节点维持现状（工单 §1 不新增拦截）', () => {
    // mode 数据损坏（非 quick/iterative）
    expect(validateAdvanceTarget('broken', 'requirements', 'delivered')).toEqual({ ok: true })
    // mode-select（模式未定，不在路由中）
    expect(validateAdvanceTarget('iterative', 'mode-select', 'requirements')).toEqual({ ok: true })
    // planning 不在 quick 路由（数据不一致防御场景）
    expect(validateAdvanceTarget('quick', 'planning', 'coding')).toEqual({ ok: true })
  })

  test('垃圾标记目标拒绝（拼写错误不放行，expected 引导正确标记）', () => {
    expect(validateAdvanceTarget('iterative', 'prototype', 'codin')).toEqual({ ok: false, expected: 'architecture' })
    expect(validateAdvanceTarget('quick', 'requirements', 'proto')).toEqual({ ok: false, expected: 'prototype' })
  })

  test('终态 delivered：无合法下一阶段，任何目标拒绝（expected=null）', () => {
    expect(validateAdvanceTarget('iterative', 'delivered', 'requirements')).toEqual({ ok: false, expected: null })
    expect(validateAdvanceTarget('quick', 'delivered', 'delivered')).toEqual({ ok: false, expected: null })
  })
})
