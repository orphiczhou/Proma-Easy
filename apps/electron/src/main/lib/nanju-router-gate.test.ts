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
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

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

// W19 缺陷A：mock 委派子会话标记（sourceDelegationId 是 L2 专属，走真实 agent-session-manager
// 会拉起 electron 依赖；本测试文件导入链中仅 nanju-router-gate 惰性 require 该模块）
// v2.4：同步 mock nanjuProxy 会话标记（代理子会话工具面白名单测试用）
const delegationChildSessions = new Set<string>()
const nanjuProxySessions = new Set<string>()
mock.module('./agent-session-manager', () => ({
  getAgentSessionMeta: (id: string) => {
    if (delegationChildSessions.has(id)) return { id, sourceDelegationId: 'delegation-x' }
    if (nanjuProxySessions.has(id)) return { id, nanjuProxy: true }
    return undefined
  },
}))

const { verifyPhaseOutput, validateAdvanceTarget, checkNanjuRouterGate, resolveVisualValidatorSlotForProject } = await import('./nanju-router-gate')
const { reloadNanjuModelConfig } = await import('./nanju-model-config')

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

const testArchitectureDoc = `
## 交付与运行
目标平台：按项目约定平台
交付产物：08_APP 下架构约定产物
构建方式：执行项目构建配置
启动方式：启动实际产物
## 测试架构
| 层级 | 框架 | 执行方式 | 证据 | 覆盖 |
| --- | --- | --- | --- | --- |
| 行为验收 | 平台测试驱动 | 执行真实产品 | 实际输出 | US-01 |
### 真实与模拟边界
模拟仅用于隔离单元，实际用户故事需真实行为证据。
### 失败回流
失败回开发或测试设计，环境缺失阻塞。
`

describe('verifyPhaseOutput 环境门禁（W7 B4：envReady 拦截 + 降级规则 + R2 规则校验）', () => {
  /** 合法架构文档（desktop-app 品类 + 环境清单 + ready 标记行） */
  const validArchDoc = (category: string, envLine: string, components: string): string =>
    `# 架构文档\n\n## 技术选型\n\nTauri v2 桌面程序。\n\nprojectCategory: ${category}\n\n## 环境配置\n\n| 组件 | 版本 | 用途 | 探测结果 | 备注 |\n| --- | --- | --- | --- | --- |\n${components}\n\n${envLine}\n${testArchitectureDoc}`

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
      html: '# 架构文档（web-default 免检用例，补足最低 100 字节）\n\n## 技术选型\n\n纯前端应用，无后端依赖，浏览器直接打开即可运行。\n\n本节内容用于撑过产出文件最低大小检查，不代表真实架构文档。\n\nprojectEnv: ready\n' + testArchitectureDoc,
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

// ═══════════════ W19 缺陷A（v0.17.87）：未绑定会话写保护 ═══════════════

/**
 * E2E 实测事故 Replay（6039a6af）：首发被拒 →「在新会话中重试」→ 普通续接会话
 * 不在项目注册表 → 原 `!project → return null` 全放行 → Write 直写 01_PRD/02_UX_DESIGN 成功。
 * fixture：双项目（dlv=delivered / act=requirements），被测 session-unbound 均不绑定。
 */
const UNBOUND_SESSION = 'session-unbound'

function setupUnboundFixture(): void {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-unbound-guard-'))
  fixtureRoot = dir
  mkdirSync(join(dir, '_telemetry'), { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([
    { projectId: 'dlv', name: '已交付项目', mode: 'quick', status: 'active', currentStage: 'delivered', createdAt: now, updatedAt: now, sessionId: 'session-dlv-bound', workspaceSlug: WORKSPACE_SLUG },
    { projectId: 'act', name: '进行中项目', mode: 'quick', status: 'active', currentStage: 'requirements', createdAt: now, updatedAt: now, sessionId: 'session-act-bound', workspaceSlug: WORKSPACE_SLUG },
  ]))
}

function setupEmptyWorkspace(): void {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-unbound-empty-'))
  fixtureRoot = dir
  mkdirSync(join(dir, '_telemetry'), { recursive: true })
  // 不写 _nanju-projects.json（非 nanju 工作区）
}

function readTelemetryEvents(): Array<{ eventType: string; payload: Record<string, unknown> }> {
  const telemetryDir = join(fixtureRoot, '_telemetry')
  if (!existsSync(telemetryDir)) return []
  const files = require('node:fs').readdirSync(telemetryDir) as string[]
  const events: Array<{ eventType: string; payload: Record<string, unknown> }> = []
  for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(telemetryDir, file), 'utf-8').trim().split('\n').filter(Boolean)) {
      events.push(JSON.parse(line))
    }
  }
  return events
}

describe('W19 缺陷A：未绑定会话写保护（红测试，工单口径）', () => {
  test('未绑定会话 Write 裸相对 01_PRD/x.md → deny + telemetry 留痕', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      path: '01_PRD/x.md', file_path: '01_PRD/x.md', content: '# x',
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('南大向导写保护')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'router.gate.unbound-write-deny')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.sessionId).toBe(UNBOUND_SESSION)
    expect(events[0]?.payload.reason).toBe('stage-dir-prefix')
    expect(events[0]?.payload.stageDir).toBe('01_PRD')
  })

  test('未绑定会话 Write delivered 项目 08_APP/index.html → 放行（指挥官裁决豁免）', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: join(fixtureRoot, 'project-dlv', '08_APP', 'index.html'),
    })
    expect(result).toBeNull()
    expect(readTelemetryEvents()).toHaveLength(0)
  })

  test('未绑定会话 Write active 项目 08_APP/x.html → deny（非 delivered 不豁免）', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: join(fixtureRoot, 'project-act', '08_APP', 'x.html'),
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'router.gate.unbound-write-deny')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.projectId).toBe('act')
    expect(events[0]?.payload.reason).toBe('project-dir')
  })

  test('未绑定会话 Read 01_PRD/prd.md → 放行（读类不拦，零 telemetry）', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Read', {
      file_path: join(fixtureRoot, 'project-act', '01_PRD', 'prd.md'),
    })
    expect(result).toBeNull()
    expect(readTelemetryEvents()).toHaveLength(0)
  })

  test('非 nanju 工作区（无 _nanju-projects.json）未绑定会话 Write 任意 → 零行为变化', () => {
    setupEmptyWorkspace()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: join(fixtureRoot, '01_PRD', 'x.md'),
    })
    expect(result).toBeNull()
    expect(readTelemetryEvents()).toHaveLength(0)
  })

  test('Bash 命令含裸阶段目录写操作（echo x > 01_PRD/y）→ deny + telemetry', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Bash', {
      command: 'echo x > 01_PRD/y',
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('保守拦截')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'router.gate.unbound-write-deny')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.reason).toBe('bash-stage-dir')
    expect(events[0]?.payload.stageDir).toBe('01_PRD')
  })
})

describe('W19 缺陷A：边界与豁免矩阵', () => {
  test('Bash 命令提及 delivered 项目 08_APP 尾随路径 → 放行', () => {
    setupUnboundFixture()
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Bash', {
      command: 'echo x > project-dlv/08_APP/app.js',
    })).toBeNull()
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Bash', {
      command: `cat ${join(fixtureRoot, 'project-dlv', '08_APP', 'index.html')}`,
    })).toBeNull()
    expect(readTelemetryEvents()).toHaveLength(0)
  })

  test('Bash 命令含 active 项目绝对路径（读命令也拦，保守口径）→ deny', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Bash', {
      command: `cat ${join(fixtureRoot, 'project-act', '01_PRD', 'prd.md')}`,
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'router.gate.unbound-write-deny')
    expect(events[0]?.payload.reason).toBe('bash-project-path')
    expect(events[0]?.payload.projectId).toBe('act')
  })

  test('project-<id> 提及带 id 边界检查：project-act2 不误配 project-act', () => {
    setupUnboundFixture()
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Bash', {
      command: 'cat project-act2/notes.txt',
    })).toBeNull()
  })

  test('L2 委派子会话（sourceDelegationId）写项目目录 → 放行（南大管线保护）', () => {
    setupUnboundFixture()
    delegationChildSessions.add('session-l2')
    try {
      const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-l2', 'Write', {
        file_path: join(fixtureRoot, 'project-act', '01_PRD', 'prd.md'),
      })
      expect(result).toBeNull()
      expect(readTelemetryEvents()).toHaveLength(0)
    } finally {
      delegationChildSessions.delete('session-l2')
    }
  })

  test('未绑定会话写工作区根散文件（项目外）→ 放行（零变化范围外）', () => {
    setupUnboundFixture()
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: join(fixtureRoot, 'notes.md'),
    })).toBeNull()
  })

  test('未绑定会话写项目根散文件（project-act/readme.md）→ deny（工单：项目根散文件一律 deny）', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: join(fixtureRoot, 'project-act', 'readme.md'),
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('根目录')
  })

  test('Edit 工具同样拦截（写类工具集）；显式 project-<id>/ 前缀相对路径归因', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Edit', {
      file_path: 'project-act/03_ARCHITECTURE/a.md',
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'router.gate.unbound-write-deny')
    expect(events[0]?.payload.stageDir).toBe('03_ARCHITECTURE')
  })

  test('裸相对 08_APP 前缀：工作区存在未交付项目 → 保守 deny（无法归因）', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: '08_APP/index.html',
    })
    expect(result?.behavior).toBe('deny')
  })

  test('绑定会话回归：项目自身会话不受未绑定写保护影响（走既有阶段门禁）', () => {
    setupUnboundFixture()
    // act 项目绑定会话处于 requirements：委派工具在白名单内，走 W8 委派守卫（非未绑定分支）
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-act-bound', 'delegate_agent', {
      title: '需求分析师', task: '梳理核心需求产出 PRD',
    })
    expect(result).toBeNull()
  })
})

describe('W19 F1（审查必修）：路径归一化——三个实证绕过形态全部封堵', () => {
  test('探针①：Write ./project-act/01_PRD/x.md（前导 ./ 前缀绕过归因）→ deny + 归因到项目', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: './project-act/01_PRD/x.md',
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'router.gate.unbound-write-deny')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.projectId).toBe('act')
    expect(events[0]?.payload.reason).toBe('project-dir')
  })

  test('探针②：delivered 豁免穿越 project-dlv/08_APP/../01_PRD/evil.html → deny（消解 .. 后不再豁免）', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: 'project-dlv/08_APP/../01_PRD/evil.html',
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'router.gate.unbound-write-deny')
    expect(events[0]?.payload.projectId).toBe('dlv')
    expect(events[0]?.payload.stageDir).toBe('01_PRD')
    // 绝对路径形态同样封堵
    const abs = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: join(fixtureRoot, 'project-dlv', '08_APP', '..', '01_PRD', 'evil.html'),
    })
    expect(abs?.behavior).toBe('deny')
  })

  test('探针②-Bash：cat project-dlv/08_APP/../01_PRD/x（豁免穿越，命令形态）→ deny', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Bash', {
      command: 'cat project-dlv/08_APP/../01_PRD/x',
    })
    expect(result?.behavior).toBe('deny')
  })

  test('探针③：Write ~/… 形态（~ 展开后归因）→ deny；~ 指向项目外 → 放行', () => {
    setupUnboundFixture()
    // 用 ~ + relative(homedir → fixture) 构造同时锻炼 ~ 展开与 .. 消解的路径
    const homeRelative = relative(homedir(), join(fixtureRoot, 'project-act', '01_PRD', 'x.md'))
    const viaHome = `~/${homeRelative}`
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: viaHome,
    })
    expect(result?.behavior).toBe('deny')
    const events = readTelemetryEvents().filter((e) => e.eventType === 'router.gate.unbound-write-deny')
    expect(events[0]?.payload.projectId).toBe('act')
    // 指向 home 下的普通路径（项目外）→ 仍放行（零变化范围外）
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: '~/notes-outside.md',
    })).toBeNull()
  })

  test('归一化回归：相对路径重复斜杠与中段 ./ 仍归因（project-act//01_PRD/./x.md）→ deny', () => {
    setupUnboundFixture()
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, UNBOUND_SESSION, 'Write', {
      file_path: 'project-act//01_PRD/./x.md',
    })
    expect(result?.behavior).toBe('deny')
  })
})

// ═══════════════ v2.4（D7 §3/§4）：nanjuProxy 工具面白名单 + L1 AskUser 路由 ═══════════════

import { getActiveConfirmAsk, setProjectDeliveryChallenge, __resetNanjuAdvanceAuthStoresForTests } from './nanju-project'

describe('v2.4 §4：nanjuProxy 代理会话工具面白名单（首分支，先于 workspaceSlug 早退）', () => {
  beforeEach(() => {
    nanjuProxySessions.add('session-proxy')
  })
  afterEach(() => {
    nanjuProxySessions.delete('session-proxy')
    __resetNanjuAdvanceAuthStoresForTests()
  })

  test('检索与只读工具放行（WebSearch/WebFetch/Read/LS/Glob/Grep）', () => {
    for (const tool of ['WebSearch', 'WebFetch', 'Read', 'LS', 'Glob', 'Grep']) {
      expect(checkNanjuRouterGate(WORKSPACE_SLUG, 'session-proxy', tool, {})).toBeNull()
    }
  })

  test('红测（Defender #12）：AskUserQuestion / mcp__session__send_message / Write / Edit / Bash / NotebookEdit / delegate_agent 一律 deny', () => {
    for (const tool of [
      'AskUserQuestion', 'mcp__session__send_message', 'mcp__session__list_sessions',
      'Write', 'Edit', 'Bash', 'NotebookEdit', 'delegate_agent', 'mcp__collaboration__delegate_agent',
    ]) {
      const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-proxy', tool, { file_path: '/tmp/x' })
      expect(result?.behavior).toBe('deny')
      expect(result?.message).toContain('nanju_clarify_proxy')
    }
  })

  test('红测（Defender #13）：workspaceSlug=undefined（未绑定工作区）时代理会话仍走白名单分支而非早退放行', () => {
    // 早退放行 = fail-open：白名单外工具必须在任何 workspaceSlug 下都被拦
    expect(checkNanjuRouterGate(undefined, 'session-proxy', 'AskUserQuestion', {})).not.toBeNull()
    expect(checkNanjuRouterGate(undefined, 'session-proxy', 'Write', { file_path: '/tmp/x' })).not.toBeNull()
    // 白名单内工具仍放行（代理正常工作不受影响）
    expect(checkNanjuRouterGate(undefined, 'session-proxy', 'WebSearch', {})).toBeNull()
  })

  test('非代理会话现状回归：L1（session-1，requirements）AskUserQuestion 放行（非 auto 项目无路由约束）', () => {
    // setupFixture 建的 session-1 是 requirements 阶段项目会话（autoClarify 未开启）
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'AskUserQuestion', {
      questions: [{ question: '这个布局可以吗？', header: '原型交互验证', options: [] }],
    })).toBeNull()
  })
})

describe('D8 A3′：auto on AskUser 路由 install-only（R7-03）', () => {
  /** AskUser 路由 fixture：requirements 阶段 + autoClarify 可控 + 达标 PRD */
  function setupAskFixture(autoClarify?: { enabled: boolean; proxyBudget?: number; pendingQuestionIds?: string[] }): void {
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    const projectsPath = join(fixtureRoot, '_nanju-projects.json')
    const projects = JSON.parse(readFileSync(projectsPath, 'utf-8')) as Array<Record<string, unknown>>
    const p = projects[0]!
    p.currentStage = 'requirements'
    p.autoClarify = autoClarify
    writeFileSync(projectsPath, JSON.stringify(projects))
  }

  const AUTO_ON = { enabled: true, proxyBudget: 20, pendingQuestionIds: [] }

  afterEach(() => {
    __resetNanjuAdvanceAuthStoresForTests()
  })

  test('红测（A3′）：auto on + 六确认收口 header（通用/原型交互验证/预览确认/架构与环境配置/满意交付）→ 一律 deny + 教育指向直接推进/调代理', () => {
    setupAskFixture(AUTO_ON)
    for (const header of ['确认·需求分析师', '确认·原型交互验证', '确认·预览确认', '确认·架构与环境配置', '确认·满意交付']) {
      const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'AskUserQuestion', {
        questions: [{ question: '收口确认', header, options: [] }],
      })
      expect(result?.behavior).toBe('deny')
      expect(result?.message).toContain('自动审核')
      expect(result?.message).toContain('直接输出推进标记')
      expect(result?.message).toContain('nanju_clarify_proxy')
    }
  })

  test('红测（A3′）：auto on + 设计/转述 header → deny（D7 三前缀放行面整体收窄）', () => {
    setupAskFixture(AUTO_ON)
    for (const header of ['设计·导航布局偏好', '转述·环境依赖确认', '需求澄清']) {
      expect(checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'AskUserQuestion', {
        questions: [{ question: 'q', header, options: [] }],
      })?.behavior).toBe('deny')
    }
  })

  test('A3′ 唯一放行：精确「确认·安装缺失组件」→ 放行且不登记 activeConfirmAsk（环境安装=唯一人工点）', () => {
    setupAskFixture(AUTO_ON)
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'AskUserQuestion', {
      questions: [{ question: '环境缺失 Rust 工具链，确认安装？', header: '确认·安装缺失组件', options: [{ label: '确认安装' }] }],
    })
    expect(result).toBeNull()
    expect(getActiveConfirmAsk(WORKSPACE_SLUG, PROJECT_ID)).toBeNull() // 登记整体跳过
  })

  test('红测（A3′）：安装 + 其他混合 question → 整体 deny（fail-closed）', () => {
    setupAskFixture(AUTO_ON)
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'AskUserQuestion', {
      questions: [
        { question: '确认安装？', header: '确认·安装缺失组件', options: [] },
        { question: '顺便确认收口？', header: '确认·需求分析师', options: [] },
      ],
    })
    expect(result?.behavior).toBe('deny')
  })

  test('红测（A3′/§九）：auto on 交付挑战机器豁免禁用（challenge 在场 + 无前缀 → deny；交付走 A2′ main 实跑 provenance）', () => {
    setupAskFixture(AUTO_ON)
    setProjectDeliveryChallenge(WORKSPACE_SLUG, PROJECT_ID, 'run-1', 'session-1')
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'AskUserQuestion', {
      questions: [{ question: '验收全部通过，是否满意交付？', header: '交付验收', options: [] }],
    })?.behavior).toBe('deny')
  })

  test('auto off（缺失 / enabled:false）→ 全放行 + D7 登记逻辑恢复（收口 header 登记 activeConfirmAsk）', () => {
    setupAskFixture(undefined)
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'AskUserQuestion', {
      questions: [{ question: 'PRD 已产出，是否确认进入下一阶段？', header: '确认·需求分析师', options: [] }],
    })).toBeNull()
    const ask = getActiveConfirmAsk(WORKSPACE_SLUG, PROJECT_ID)
    expect(ask).toBeTruthy()
    expect(ask!.expectedTarget).toBe('prototype')
    __resetNanjuAdvanceAuthStoresForTests()
    setupAskFixture({ enabled: false, proxyBudget: 20, pendingQuestionIds: [] })
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'AskUserQuestion', {
      questions: [{ question: 'q', header: '需求澄清', options: [] }],
    })).toBeNull() // auto off 全放行（无前缀也不拦——D7 现状）
  })

  test('auto off 中间确认不登记（F2-3① 回归保持）：「确认·安装缺失组件」放行且不登记', () => {
    setupAskFixture(undefined)
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'AskUserQuestion', {
      questions: [{ question: '环境缺失，确认安装？', header: '确认·安装缺失组件', options: [] }],
    })).toBeNull()
    expect(getActiveConfirmAsk(WORKSPACE_SLUG, PROJECT_ID)).toBeNull()
  })
})

// ===== W22 O1/O2 指挥官收口（2026-09-12）：接线存在性锁定 =====
describe('W22 O1/O2：minimax 修复守卫接线与 AC 覆写阶段感知（源码断言）', () => {
  test('O1：resolveACOverride 生产调用点带第三参 guardStage（per-phase 覆盖位不失效）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./nanju-router-gate.ts', import.meta.url), 'utf-8')
    expect(src).toContain('resolveACOverride(acRole, project.mode, guardStage)')
    expect(src).not.toContain('resolveACOverride(acRole, project.mode)(') // 旧两参形态不残留
  })

  test('O2：minimax-repair-misuse 分流消费 MINIMAX_REPAIR_GUIDANCE 专属文案', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./nanju-router-gate.ts', import.meta.url), 'utf-8')
    expect(src).toContain("v.result.denialKind === 'minimax-repair-misuse'")
    expect(src).toContain('MINIMAX_REPAIR_GUIDANCE}')
    expect(src).toContain('MINIMAX_REPAIR_GUIDANCE,')
  })
})


describe('Given 架构完成 When 推进阶段 Then 必须具备测试设计', () => {
  test('历史架构缺少测试设计时明确要求补全，不静默放行', () => {
    const ws = setupFixture({ stage: 'architecture', html: '# 架构文档\n\n' + '已有技术选型与环境说明。'.repeat(15) })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toContain('架构交付与测试设计不完整')
  })
  test('两模式完整文档通过结构门，未宣称执行验收通过', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const ws = setupFixture({ stage: 'architecture', mode, html: '# 架构文档\n' + testArchitectureDoc })
      expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
      rmSync(fixtureRoot, { recursive: true, force: true })
      fixtureRoot = ''
    }
  })
})


describe('Given 架构声明真实工程，When 检查coding产出，Then 不用HTML替代原生产物', () => {
  function setupNativeContract(): string {
    const ws = setupFixture({ stage: 'coding', html: htmlDoc('旧演示页不能作为原生交付') })
    const root = join(fixtureRoot, 'project-p1')
    mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
    mkdirSync(join(root, '01_PRD'), { recursive: true })
    writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 终端输出结果')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
      schemaVersion: 1, target: { platform: 'Linux', kind: 'cli', entry: 'main.ts' },
      artifacts: ['main.ts'], build: 'Bun原生运行，无需编译', run: 'bun main.ts',
      tests: [{ id: 'cli-output', layer: 'acceptance', adapter: 'cli-driver', target: 'main.ts', command: '调用实际程序检查输出', covers: ['US-01'], requiresReal: true }],
    }))
    writeFileSync(join(root, '08_APP/main.ts'), 'console.log("测试程序")')
    writeFileSync(join(root, '08_APP/DELIVERY.md'), '# 交付说明\n\n## 构建与运行\nBun原生运行无需编译，启动main.ts。\n\n## 测试状态\n尚未通过真实行为验收；源文件存在不等于可交付。\n')
    return ws
  }
  test('Then 真实产物及说明存在时无需网页入口', () => {
    const ws = setupNativeContract()
    rmSync(join(fixtureRoot, 'project-p1/08_APP/index.html'))
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toBeNull()
  })
  test('Then 缺真实程序时明确报告路径，网页演示不能替代', () => {
    const ws = setupNativeContract()
    rmSync(join(fixtureRoot, 'project-p1/08_APP/main.ts'))
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toContain('main.ts')
  })
  test('Then 损坏工程契约不能静默改成网页模式', () => {
    const ws = setupNativeContract()
    writeFileSync(join(fixtureRoot, 'project-p1/03_ARCHITECTURE/engineering.json'), '{}')
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'coding')).toContain('工程契约')
  })
})

test('Given 非浏览器工程的场景与实际驱动 When 确认testing产出 Then 不强迫伪造DOM steps.json', () => {
  const ws = setupFixture({ stage: 'testing', html: 'Feature: US-01 终端输出\nScenario: US-01 输出结果\nGiven 已构建实际程序\nWhen 使用项目驱动运行程序\nThen 返回预期结果\n' + '真实行为由宿主执行驱动，文档本身不代表通过。'.repeat(3) })
  const root = join(fixtureRoot, 'project-p1')
  mkdirSync(join(root, '03_ARCHITECTURE'), { recursive: true })
  mkdirSync(join(root, '08_APP'), { recursive: true })
  mkdirSync(join(root, '01_PRD'), { recursive: true })
  writeFileSync(join(root, '08_APP/app'), 'fixture')
  writeFileSync(join(root, '08_APP/test.cjs'), '// fixture driver')
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 终端输出')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 1, target: { kind: 'cli', platform: 'Linux', entry: 'app' }, artifacts: ['app', 'test.cjs'], build: 'fixture', run: 'fixture', tests: [{ id: 'cli', layer: 'acceptance', adapter: 'cli-driver', target: 'app', command: '驱动读取实际输出', covers: ['US-01'], requiresReal: true, driver: { runtime: 'node', path: 'test.cjs', args: [], timeoutMs: 1000 } }] }))
  expect(verifyPhaseOutput(ws, PROJECT_ID, 'testing')).toBeNull()
  rmSync(join(root, '08_APP/test.cjs'))
  expect(verifyPhaseOutput(ws, PROJECT_ID, 'testing')).toContain('test.cjs')
})

// ═══════════════ W-B B2：视觉验证者委派门禁（内部 producer → gate）═══════════════

describe('W-B B2：视觉验证者委派门禁（producer→gate；未配独立端点 = 清晰 blocked）', () => {
  test('红测：prototype 阶段视觉验证者委派（文本命中）但未配独立端点 → deny（不静默放行）', () => {
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'delegate_agent', {
      title: 'UX 顾问：独立视觉裁决',
      task: '对照最新截图逐条输出 red/yellow/green 结论与逐条对照结果。',
      channelId: 'glm-zhipu',
      modelId: 'glm-5.3-vision',
    })
    // 未显式配置 phases.prototype.visualReviewer → producer 返回 blocked → gate 拒绝
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('独立视觉裁决')
    expect(result?.message).toContain('未显式配置')
  })

  test('内部 slot 权威：即使标题不含视觉标记，target.slot=visual-validator 也触发门禁', () => {
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'delegate_agent', {
      title: 'UX 顾问：原型界面',
      task: '生成原型界面稿。',
      slot: 'visual-validator',
      channelId: 'glm-zhipu',
      modelId: 'glm-5.3-vision',
    })
    expect(result?.behavior).toBe('deny')
  })

  test('对照：prototype 阶段普通作者委派（无视觉标记/slot）不被视觉门禁拦截', () => {
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'delegate_agent', {
      title: 'UX 顾问：原型设计',
      task: '生成原型界面稿。',
    })
    expect(result).toBeNull()
  })
})

// ═══════════════ W-B B2 R1：视觉委派的可靠触发（prompt 稳定标题 + 端点检测）═══════════════

describe('W-B B2 R1：视觉委派可靠触发（配置端点检测，title 仅兜底）', () => {
  let visualCfgDir = ''

  /** 写入用户层配置并 reload（ROUTES 按代次重建）；visual 省略 = 保持未配置 */
  function setupVisualReviewer(visual?: { channel: string; model: string }): void {
    visualCfgDir = mkdtempSync(join(tmpdir(), 'nanju-gate-visual-'))
    const cfgPath = join(visualCfgDir, 'nanju-model-config.json')
    writeFileSync(cfgPath, JSON.stringify({ phases: { prototype: visual ? { visualReviewer: visual } : {} } }))
    reloadNanjuModelConfig({ userConfigPath: cfgPath, overrideConfigPath: null })
  }

  afterEach(() => {
    if (visualCfgDir) rmSync(visualCfgDir, { recursive: true, force: true })
    visualCfgDir = ''
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null })
  })

  const VISUAL = { channel: 'kimi', model: 'k3-vision' }

  test('机制一（title 兜底）：marker 标题 + 命中配置端点 → 放行（合法独立端点）', () => {
    setupVisualReviewer(VISUAL)
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'delegate_agent', {
      title: '独立视觉裁决',
      task: '对照最新截图逐条输出 red/yellow/green 结论。',
      channelId: 'kimi',
      modelId: 'k3-vision',
    })
    expect(result).toBeNull()
  })

  test('机制二（端点检测）：marker-less 标题但命中配置端点 → 同样纳入视觉门禁管辖', async () => {
    setupVisualReviewer(VISUAL)
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    // 先证检测本身为真（无 slot、无标题标记也认得出来）
    const { isVisualValidatorEndpointTarget, resolveVisualValidatorSlot } = await import('./nanju-router-prompt')
    const { getPhaseNode } = await import('./nanju-router')
    const phase = getPhaseNode('quick', 'prototype')!
    const slot = resolveVisualValidatorSlot(phase, { authorResolved: { channelId: 'minimax', modelId: 'MiniMax-M3' } })
    expect(slot).toEqual({ status: 'resolved', channelId: 'kimi', modelId: 'k3-vision' })
    expect(isVisualValidatorEndpointTarget({ slot, targetChannelId: 'kimi', targetModelId: 'k3-vision' })).toBe(true)
    expect(isVisualValidatorEndpointTarget({ slot, targetChannelId: 'deepseek', targetModelId: 'deepseek-v4-pro' })).toBe(false)
    // I 交接锚点：同一权威槽位可从 gate 侧解析（供 orchestrator 盖章内部 slot）
    const { findNanjuProjectBySession } = await import('./nanju-router-gate')
    const project = findNanjuProjectBySession(WORKSPACE_SLUG, 'session-1')
    expect(resolveVisualValidatorSlotForProject(project!)).toEqual(slot)
    // 再证端到端：标题无视觉标记，但因端点命中而受门禁管辖（端点合法 → 放行）
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'delegate_agent', {
      title: 'UX 顾问：原型界面复核',
      task: '生成原型界面稿。',
      channelId: 'kimi',
      modelId: 'k3-vision',
    })
    expect(result).toBeNull()
  })

  test('marker 标题 + 端点错（非配置的独立端点）→ 拒', () => {
    setupVisualReviewer(VISUAL)
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'delegate_agent', {
      title: '独立视觉裁决',
      task: '对照最新截图逐条输出 red/yellow/green 结论。',
      channelId: 'deepseek',
      modelId: 'deepseek-v4-pro',
    })
    expect(result?.behavior).toBe('deny')
    expect(result?.message).toContain('独立视觉裁决')
    expect(result?.message).toContain('端点与配置的独立视觉端点不一致')
  })

  test('marker 标题 + 端点=作者端点（同端点自证）→ 拒（不得削弱）', () => {
    setupVisualReviewer(VISUAL)
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'delegate_agent', {
      title: '独立视觉裁决',
      task: '对照最新截图逐条输出 red/yellow/green 结论。',
      channelId: 'minimax',
      modelId: 'MiniMax-M3',
    })
    expect(result?.behavior).toBe('deny')
  })

  test('未配置 visualReviewer：端点检测不误拦普通委派（marker-less → 放行）', () => {
    setupVisualReviewer(undefined)
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    const result = checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'delegate_agent', {
      title: 'UX 顾问：原型设计',
      task: '生成原型界面稿。',
      channelId: 'kimi',
      modelId: 'k3-vision',
    })
    expect(result).toBeNull()
  })

  test('未配置 visualReviewer：阶段推进不被视觉槽位硬阻断（L1 正常委派 + 阶段序放行）', () => {
    setupVisualReviewer(undefined)
    setupFixture({ stage: 'prototype', html: htmlDoc('<div>x</div>') })
    // 视觉槽位 blocked 只影响「视觉裁决」这一个动作，不阻断阶段推进：
    // L1 仍可委派作者（产出 prototype.html），阶段序校验也不受其影响。
    expect(checkNanjuRouterGate(WORKSPACE_SLUG, 'session-1', 'delegate_agent', {
      title: 'UX 顾问：原型设计',
      task: '生成原型界面稿。',
    })).toBeNull()
    expect(validateAdvanceTarget('quick', 'prototype', 'architecture')).toEqual({ ok: true })
  })
})

// ===== L2-4（2026-09-18，ATK-G-002/G-007/U-006）：网络检索凭证门禁（产物检查 + 存量兼容） =====

describe('L2-4：架构文档证据记录门禁（archEvidenceGate 标记项目：缺节拦截 / 条目无 URL 拦截 / 申报放行 / 存量豁免）', () => {
  const { validateEvidenceRecordSection } = require('./nanju-router-gate') as typeof import('./nanju-router-gate')
  const { writeFileSync: wfs } = require('node:fs') as typeof import('node:fs')

  /** 合法架构文档（品类合法 + 环境清单 + ready 标记 + 测试架构节 + 可选证据记录节） */
  const archDocWithEvidence = (evidenceSection: string): string =>
    `# 架构文档\n\n## 技术选型\n\nWeb 全栈。\n\nprojectCategory: web-fullstack\n\n## 环境配置\n\n| 组件 | 版本 | 用途 | 探测结果 | 备注 |\n| --- | --- | --- | --- | --- |\n| node | 20 | 运行时 | 就绪 | - |\n\nprojectEnv: ready\n${testArchitectureDoc}\n${evidenceSection}`

  /** 写 _project-info.json（archEvidenceGate 开关——新项目 true / 存量项目无字段） */
  function setEvidenceGate(slug: string, enabled: boolean | undefined): void {
    const info: Record<string, unknown> = {
      projectId: PROJECT_ID, name: '凭证门禁项目', mode: 'iterative',
      createdAt: '2026-09-18T00:00:00.000Z', workspaceSlug: slug,
      projectDir: `project-${PROJECT_ID}`, docDirs: [],
    }
    if (enabled !== undefined) info.archEvidenceGate = enabled
    wfs(join(fixtureRoot, `project-${PROJECT_ID}`, '_project-info.json'), JSON.stringify(info))
  }

  test('Given 新项目（archEvidenceGate=true）文档缺「## 证据升级与检索记录」节 When 推进 Then 拦截（无凭证视为未执行）', () => {
    const ws = setupFixture({ stage: 'architecture', mode: 'iterative', html: archDocWithEvidence('') })
    setEvidenceGate(ws, true)
    const error = verifyPhaseOutput(ws, PROJECT_ID, 'architecture')
    expect(error).toContain('缺少「## 证据升级与检索记录」节')
    expect(error).toContain('URL+检索日期')
    expect(error).toContain('本轮无证据升级；未触发检索条件')
  })

  test('Given 新项目 + 节内 [实证] 条目带 URL When 推进 Then 放行（形态①②凭证在场）', () => {
    const ws = setupFixture({
      stage: 'architecture', mode: 'iterative',
      html: archDocWithEvidence('## 证据升级与检索记录\n| 结论点 | 证据等级变化 | 来源 URL | 检索日期 |\n| --- | --- | --- | --- |\n| Node 20 LTS 支持策略 | [推断]→[实证] | https://nodejs.org/en/about/previous-releases | 2026-09-18 |\n'),
    })
    setEvidenceGate(ws, true)
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })

  test('Given 新项目 + 节内 [实证]/[文证] 条目无 URL When 推进 Then 拦截并指明条目', () => {
    const ws = setupFixture({
      stage: 'architecture', mode: 'iterative',
      html: archDocWithEvidence('## 证据升级与检索记录\n- Tauri v2 Linux 依赖清单：新增 [实证]（凭训练记忆，未检索）\n- DashScope ASR 端点：[推断]→[文证] 来源缺失\n'),
    })
    setEvidenceGate(ws, true)
    const error = verifyPhaseOutput(ws, PROJECT_ID, 'architecture')
    expect(error).toContain('证据记录凭证缺失')
    expect(error).toContain('http(s)://')
    expect(error).toContain('Tauri v2 Linux 依赖清单')
    expect(error).toContain('DashScope ASR 端点')
  })

  test('Given 新项目 + 实证条目引用已存在的 file:// 证据 When 推进 Then 放行（快消型本机实证无需伪造网络引用）', () => {
    const evidencePath = resolve(fixtureRoot, 'local-evidence.md')
    writeFileSync(evidencePath, 'local evidence')
    const ws = setupFixture({
      stage: 'architecture', mode: 'iterative',
      html: archDocWithEvidence(`## 证据升级与检索记录\n- xclip 往返验证：[实证] file://${evidencePath}\n`),
    })
    setEvidenceGate(ws, true)
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })
  test('Given 新项目 + 纯申报（未触发检索条件/已检索无结论）When 推进 Then 放行（形态③自我申报不做事前拦截）', () => {
    const ws = setupFixture({
      stage: 'architecture', mode: 'iterative',
      html: archDocWithEvidence('## 证据升级与检索记录\n本轮无证据升级；未触发检索条件。\n- X11 注入边界：已检索无结论（关键词：XkbSetMap CJK，2026-09-18），保持 [推断]。\n'),
    })
    setEvidenceGate(ws, true)
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })

  test('Given 存量项目（无 archEvidenceGate 字段）文档缺节 When 推进 Then 豁免放行（v0.17.127 前创建豁免）', () => {
    const ws = setupFixture({ stage: 'architecture', mode: 'iterative', html: archDocWithEvidence('') })
    setEvidenceGate(ws, undefined) // 旧版本创建：无标记字段
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })

  test('Given 正文含 [实证] 引用（模版坑库既有条目）但节内无条目 When 推进 Then 不误拦（只查证据记录节内条目）', () => {
    // 正文引用放在证据节【之前】（另一节的正文）——门禁只扫「## 证据升级与检索记录」节体
    const doc = '# 架构文档\n\n## 技术选型\n\n> 引用坑库既有条目：通知守护进程静默失败 [实证]（见模版 §7，非本轮新增）\n\nprojectCategory: web-fullstack\n\n## 环境配置\n\n| 组件 | 版本 | 用途 | 探测结果 | 备注 |\n| --- | --- | --- | --- | --- |\n| node | 20 | 运行时 | 就绪 | - |\n\nprojectEnv: ready\n' + testArchitectureDoc + '\n## 证据升级与检索记录\n本轮无证据升级；未触发检索条件。\n'
    const ws = setupFixture({ stage: 'architecture', mode: 'iterative', html: doc })
    setEvidenceGate(ws, true)
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })

  // validateEvidenceRecordSection 纯函数边界
  test('纯函数：### 级节头与后缀括号注释容忍；节体到下一节头截断（下一节的实证条目不计入）', () => {
    const doc = [
      '# 架构',
      '### 证据升级与检索记录（本轮）',
      '- 无升级条目',
      '## 交付与运行',
      '- 附录引用 [实证] 无 URL（属其他节，不计入本节检查）',
    ].join('\n')
    expect(validateEvidenceRecordSection(doc)).toBeNull()
  })

  test('纯函数：节头匹配为「证据升级与检索记录」前缀形态，不误配相近词', () => {
    expect(validateEvidenceRecordSection('# 架构\n\n## 环境配置\n普通内容')).toContain('缺少「## 证据升级与检索记录」节')
    expect(validateEvidenceRecordSection('# 架构\n\n## 证据升级与检索记录汇总\n普通内容')).toBeNull() // 前缀扩展节头容忍
  })
})

// ═══════════════ L3-7d（2026-09-18）：Spike 埋点接线（verifyPhaseOutput architecture 挂点）════════════════

describe('L3-7d：architecture 门禁挂点派生 Spike 埋点（纯观察不阻断）', () => {
  const { resetSpikeTelemetryState } = require('./nanju-spike-telemetry') as typeof import('./nanju-spike-telemetry')

  /** 合法 v2 契约（含 spikes 登记与 envProbe）；architecture 分支只 parse 不做产物存在性检查 */
  const spikeContract = {
    schemaVersion: 2,
    target: { platform: 'Linux', kind: 'desktop', entry: 'bin/tool' },
    artifacts: ['bin/tool'],
    build: '无需构建，脚手架产物', run: '终端运行 bin/tool',
    tests: [{ id: 'acc-1', layer: 'acceptance', adapter: 'cli-driver', target: 'bin/tool', command: '驱动验收', covers: ['US-01'], requiresReal: true }],
    spikes: [{ slug: 'SPIKE-001-ime-injection', verdict: 'confirmed', decided_by: 'architect-a', ts: '2026-09-18' }],
    envProbe: { generatedAt: '2026-09-18' },
  }
  const archDocWithPending = (decision: string): string =>
    `# 架构文档（L3-7d Spike 埋点接线用例）\n\n## 技术选型\n\n- 输入注入方案：${decision}\n\n本节内容用于撑过产出文件最低大小检查，不代表真实架构文档内容。\n\n${testArchitectureDoc}`

  beforeEach(() => { resetSpikeTelemetryState() })
  afterEach(() => { resetSpikeTelemetryState() })

  test('文档含 PENDING 标记 + 契约含 spikes 登记 → 门禁放行且双事件落盘（created=文档侧 / verdict=登记值）', () => {
    const ws = setupFixture({
      stage: 'architecture', mode: 'quick',
      html: archDocWithPending('PENDING(SPIKE-001-ime-injection)'),
      files: { 'engineering.json': JSON.stringify(spikeContract) },
    })
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
    const spikeEvents = readTelemetryEvents().filter((e) => e.eventType.startsWith('spike.'))
    expect(spikeEvents.map((e) => e.eventType).sort()).toEqual(['spike.created', 'spike.verdict'])
    const created = spikeEvents.find((e) => e.eventType === 'spike.created')
    const verdict = spikeEvents.find((e) => e.eventType === 'spike.verdict')
    expect(created?.payload).toMatchObject({ slug: 'SPIKE-001-ime-injection', source: 'pending-mark' })
    expect(verdict?.payload).toMatchObject({ slug: 'SPIKE-001-ime-injection', verdict: 'confirmed', source: 'contract-registration' })
  })

  test('同一文档重复推进不重复埋；PENDING 替换为结论后埋 verdict（resolved + pending-removed）', () => {
    const ws = setupFixture({
      stage: 'architecture', mode: 'quick',
      html: archDocWithPending('PENDING(SPIKE-001-ime-injection)'),
      files: { 'engineering.json': JSON.stringify(spikeContract) },
    })
    verifyPhaseOutput(ws, PROJECT_ID, 'architecture')
    verifyPhaseOutput(ws, PROJECT_ID, 'architecture') // 快照无变化：不重复埋
    expect(readTelemetryEvents().filter((e) => e.eventType.startsWith('spike.'))).toHaveLength(2)
    // 文档更新：PENDING 替换为结论引用（契约不变）
    writeFileSync(join(fixtureRoot, `project-${PROJECT_ID}`, '03_ARCHITECTURE', 'architecture.md'), archDocWithPending('SPIKE-001 结论——注入生效（结论引用）'))
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
    const resolved = readTelemetryEvents().filter((e) => e.eventType === 'spike.verdict')
    expect(resolved).toHaveLength(2) // contract-registration + pending-removed
    expect(resolved[1]?.payload).toMatchObject({ slug: 'SPIKE-001-ime-injection', verdict: 'resolved', source: 'pending-removed' })
  })

  test('埋点写盘失败不阻断门禁（_telemetry 被同名文件占据 → 门禁仍放行）', () => {
    const ws = setupFixture({
      stage: 'architecture', mode: 'quick',
      html: archDocWithPending('PENDING(SPIKE-001-ime-injection)'),
      files: { 'engineering.json': JSON.stringify(spikeContract) },
    })
    // 占位文件使 mkdirSync/appendFileSync 失败：recordTelemetry 内部 try-catch 只告警，门禁不受影响
    writeFileSync(join(fixtureRoot, '_telemetry'), 'not-a-directory')
    expect(verifyPhaseOutput(ws, PROJECT_ID, 'architecture')).toBeNull()
  })
})
