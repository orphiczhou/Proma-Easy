import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 工程样板模块（W3，v0.17.66）单测。
 * 依赖 config-paths.getWorkspaceFilesDir——按仓库既有模式先 mock.module 指向 tmpdir，
 * 再动态导入被测模块（与 nanju-router-prompt.test.ts 同构）。
 */
let fixtureRoot = ''
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

// W17 验收补修（组合污染甄别后修复）：本文件 4 个用例（「仓库实际资源可用」的
// resolveEngineeringTemplatesDir 无参 cwd 回退解析，及 materialize 无 explicitBase
// 的 R3 前移标注 ×2 + B2 品类写入 ×1）隐含契约「bun test 在仓库根或 apps/electron
// 目录跑」；多文件合跑时调用方 cwd 任意（验收实证 `cd apps/electron/src && bun test …`
// 打破契约 → 本文件 4 用例稳定挂，与 w17 测试文件在场与否无关——同 cwd 下 13 文件
// 无 w17 同挂，见 plan/w17-report.md 组合污染修复节）。以 import.meta.url 定位仓库根
// 并临时 chdir（用例跑完恢复），cwd 无关化后任意调用目录全绿。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
let chdirOrigin = ''
beforeAll(() => {
  if (process.cwd() === REPO_ROOT) return
  if (!existsSync(join(REPO_ROOT, 'apps', 'electron', 'resources', 'nanju-engineering-templates'))) return
  chdirOrigin = process.cwd()
  process.chdir(REPO_ROOT)
})
afterAll(() => {
  if (chdirOrigin) {
    try { process.chdir(chdirOrigin) } catch { /* 恢复失败不影响后续文件（仅 cwd 偏移） */ }
    chdirOrigin = ''
  }
})

const {
  extractProjectCategoryFromDoc,
  resolveProjectCategoryForCoding,
  resolveEngineeringTemplatesDir,
  materializeEngineeringTemplate,
  getProjectTemplateDir,
  buildCategoryGuideLines,
  CATEGORY_META,
  validateEnvChecklist,
  parseEnvChecklistFromDoc,
  extractRawCategoryMarker,
  parseProjectEnvMarker,
  syncProjectEnvStateFromArchitectureDoc,
} = await import('./nanju-engineering-template')
const {
  setProjectCategory, getProjectCategory, PROJECT_CATEGORIES, isProjectCategory,
  setProjectEnvState, getProjectEnvState,
} = await import('./nanju-project')

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'nanju-eng-tpl-'))
  fixtureRoot = root
  return root
}

afterEach(() => {
  if (fixtureRoot) {
    try { rmSync(fixtureRoot, { recursive: true, force: true }) } catch { /* 并行残留容忍 */ }
    fixtureRoot = ''
  }
})

// ===== 品类标记提取（纯函数） =====

describe('extractProjectCategoryFromDoc', () => {
  test('提取标准标记（projectCategory: desktop-app）', () => {
    expect(extractProjectCategoryFromDoc('## 工程品类\n\n`projectCategory: desktop-app`\n')).toBe('desktop-app')
  })

  test('支持中文冒号与引号包裹', () => {
    expect(extractProjectCategoryFromDoc('projectCategory："cli-tool"')).toBe('cli-tool')
    expect(extractProjectCategoryFromDoc("projectCategory: 'mobile-app'")).toBe('mobile-app')
  })

  test('多次出现取最后一次（修订覆盖正文语义）', () => {
    const doc = '初判 `projectCategory: web-fullstack`\n...\n终判：projectCategory: desktop-app'
    expect(extractProjectCategoryFromDoc(doc)).toBe('desktop-app')
  })

  test('非枚举值视为无效（防误提取代码变量名等）', () => {
    expect(extractProjectCategoryFromDoc('projectCategory: quantum-simulator')).toBeNull()
    expect(extractProjectCategoryFromDoc('projectCategory:')).toBeNull()
  })

  test('无标记返回 null（降级路径入口）', () => {
    expect(extractProjectCategoryFromDoc('# 架构文档\n\n普通内容')).toBeNull()
    expect(extractProjectCategoryFromDoc('')).toBeNull()
  })

  test('大小写不敏感（ProjectCategory: DESKTOP-APP 归一）', () => {
    expect(extractProjectCategoryFromDoc('projectcategory: DESKTOP-APP')).toBe('desktop-app')
  })
})

// ===== 判定解析（architecture 优先级 > prd） =====

describe('resolveProjectCategoryForCoding', () => {
  test('architecture.md 标记优先于 prd.md（终判修正初判）', () => {
    const root = makeFixture()
    const projectDir = join(root, 'project-x')
    mkdirSync(join(projectDir, '03_ARCHITECTURE'), { recursive: true })
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), 'projectCategory: web-fullstack')
    writeFileSync(join(projectDir, '03_ARCHITECTURE', 'architecture.md'), 'projectCategory: desktop-app')
    expect(resolveProjectCategoryForCoding(fixtureRoot, 'x')).toEqual({ category: 'desktop-app', source: 'architecture' })
  })

  test('无 architecture 时回落 prd.md（quick 模式路径）', () => {
    const root = makeFixture()
    const projectDir = join(root, 'project-q')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '`projectCategory: cli-tool`')
    expect(resolveProjectCategoryForCoding(fixtureRoot, 'q')).toEqual({ category: 'cli-tool', source: 'prd' })
  })

  test('两处均无标记返回 null（调用方降级 web-fullstack）', () => {
    makeFixture()
    expect(resolveProjectCategoryForCoding(fixtureRoot, 'project-none')).toBeNull()
  })

  test('标记值非枚举等同无标记', () => {
    const root = makeFixture()
    const projectDir = join(root, 'project-bad')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), 'projectCategory: not-a-category')
    expect(resolveProjectCategoryForCoding(fixtureRoot, 'project-bad')).toBeNull()
  })
})

// ===== 资源目录解析与模板落位 =====

describe('resolveEngineeringTemplatesDir / materializeEngineeringTemplate', () => {
  test('显式 baseDir 注入（测试不依赖 electron app 对象）', () => {
    expect(resolveEngineeringTemplatesDir('/opt/base')).toBe(join('/opt/base', 'nanju-engineering-templates'))
  })

  test('materialize 复制模板全文到项目 00_ENGINEERING_TEMPLATE/template.md', () => {
    const root = makeFixture()
    // 构造资源目录（模拟 resources/nanju-engineering-templates/）
    const resBase = join(root, '_resources')
    mkdirSync(join(resBase, 'nanju-engineering-templates'), { recursive: true })
    writeFileSync(join(resBase, 'nanju-engineering-templates', 'desktop-app.md'), '# 桌面应用模板（测试）')
    const projectDir = join(root, 'project-m')
    mkdirSync(projectDir, { recursive: true })

    const dest = materializeEngineeringTemplate(fixtureRoot, 'm', 'desktop-app', resBase)
    expect(dest).toBe(join(projectDir, '00_ENGINEERING_TEMPLATE', 'template.md'))
    expect(existsSync(dest!)).toBe(true)
    expect(readFileSync(dest!, 'utf-8')).toBe('# 桌面应用模板（测试）')
  })

  test('资源缺失返回 null（不抛错，coding 侧降级仅注入要点）', () => {
    const root = makeFixture()
    const projectDir = join(root, 'project-n')
    mkdirSync(projectDir, { recursive: true })
    const emptyBase = join(root, '_empty_resources')
    mkdirSync(emptyBase, { recursive: true })
    expect(materializeEngineeringTemplate(fixtureRoot, 'project-n', 'desktop-app', emptyBase)).toBeNull()
  })

  test('仓库实际资源可用（6 品类模板齐全，回退 cwd 解析）', () => {
    // 从 lib 目录回退：process.cwd() 是仓库 apps/electron（bun test 在该目录跑）→ resources 存在
    const dir = resolveEngineeringTemplatesDir()
    for (const c of PROJECT_CATEGORIES) {
      expect(existsSync(join(dir, `${c}.md`))).toBe(true)
    }
  })

  test('getProjectTemplateDir 指向项目目录内', () => {
    makeFixture()
    expect(getProjectTemplateDir(fixtureRoot, 'p1')).toBe(join(fixtureRoot, 'project-p1', '00_ENGINEERING_TEMPLATE'))
  })
})

// ===== 注入节构建 =====

describe('buildCategoryGuideLines', () => {
  test('desktop-app：品类声明 + 要点 + 载体对齐 + 模板全文引用', () => {
    const lines = buildCategoryGuideLines({
      category: 'desktop-app',
      source: 'architecture',
      projectDir: '/tmp/project-x',
      templatePath: '/tmp/project-x/00_ENGINEERING_TEMPLATE/template.md',
    })
    const text = lines.join('\n')
    expect(text).toContain('工程品类判定：desktop-app（桌面应用）')
    expect(text).toContain('不是网站')
    expect(text).toContain('架构文档（architecture.md）标记')
    expect(text).toContain('src-tauri')
    expect(text).toContain('00_ENGINEERING_TEMPLATE/template.md')
    expect(text).toContain('data-ai-id')
    expect(text).toContain('GWT')
    expect(text).not.toContain('品类自检')
  })

  test('default 降级：注入品类自检（第二道防线）', () => {
    const lines = buildCategoryGuideLines({
      category: 'web-fullstack',
      source: 'default',
      projectDir: '/tmp/project-y',
      templatePath: null,
    })
    const text = lines.join('\n')
    expect(text).toContain('品类自检')
    expect(text).toContain('降级默认值')
    expect(text).not.toContain('00_ENGINEERING_TEMPLATE/template.md')
  })

  test('模板未落位时省略全文引用但不报错', () => {
    const lines = buildCategoryGuideLines({
      category: 'cli-tool',
      source: 'prd',
      projectDir: '/tmp/project-z',
      templatePath: null,
    })
    const text = lines.join('\n')
    expect(text).toContain('工程品类判定：cli-tool（CLI 工具）')
    expect(text).toContain('命令演控台')
    expect(text).not.toContain('模板全文')
  })

  test('六品类元数据完备（label/oneLiner/载体角色非空）', () => {
    for (const c of PROJECT_CATEGORIES) {
      const meta = CATEGORY_META[c]
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.oneLiner.length).toBeGreaterThan(4)
      expect(meta.carrierRole.length).toBeGreaterThan(0)
      expect(meta.stack.length + meta.structure.length + meta.patterns.length + meta.antiPatterns.length).toBeGreaterThan(6)
    }
  })
})

// ===== 元信息读写（nanju-project 扩展） =====

describe('setProjectCategory / getProjectCategory', () => {
  test('写入与读回（保留既有 phaseGuards 等字段）', () => {
    const root = makeFixture()
    const projectDir = join(root, 'project-c')
    mkdirSync(projectDir, { recursive: true })
    // 预置既有字段（模拟老项目升级路径）
    writeFileSync(join(projectDir, '_project-info.json'), JSON.stringify({
      projectId: 'project-c', name: '测试', mode: 'quick', createdAt: '2026-09-02T00:00:00Z',
      workspaceSlug: fixtureRoot, projectDir: 'project-c', docDirs: [],
      phaseGuards: { coding: { failCount: 1, errorCount: 0 } },
    }))

    setProjectCategory(fixtureRoot, 'c', 'desktop-app', 'architecture')
    expect(getProjectCategory(fixtureRoot, 'c')).toEqual({ category: 'desktop-app', source: 'architecture' })

    // 既有字段未被破坏
    const info = JSON.parse(readFileSync(join(projectDir, '_project-info.json'), 'utf-8'))
    expect(info.phaseGuards?.coding?.failCount).toBe(1)
  })

  test('无文件时返回 null；写入自动补骨架', () => {
    const root = makeFixture()
    const projectDir = join(root, 'project-d')
    mkdirSync(projectDir, { recursive: true })
    expect(getProjectCategory(fixtureRoot, 'd')).toBeNull()

    setProjectCategory(fixtureRoot, 'd', 'web-fullstack', 'default')
    expect(getProjectCategory(fixtureRoot, 'd')).toEqual({ category: 'web-fullstack', source: 'default' })
  })

  test('isProjectCategory 枚举校验', () => {
    expect(isProjectCategory('desktop-app')).toBe(true)
    expect(isProjectCategory('Web-Fullstack')).toBe(false)
    expect(isProjectCategory('')).toBe(false)
  })
})

// ===== R2 规则校验层（W7，v0.17.69）：品类枚举 + 环境清单组件校验 =====

describe('validateEnvChecklist（R2 第 4 层兜底）', () => {
  test('合法组件（品类白名单 + 共享集）通过', () => {
    expect(validateEnvChecklist('desktop-app', ['rustc', 'cargo', 'node', 'git'])).toEqual({ ok: true, problems: [] })
    expect(validateEnvChecklist('web-fullstack', ['node', 'npm', 'bun'])).toEqual({ ok: true, problems: [] })
    expect(validateEnvChecklist('cli-tool', ['python3', 'pip', 'node'])).toEqual({ ok: true, problems: [] })
  })

  test('typo 组件拦截（rustcc / nodee 不在白名单）', () => {
    const result = validateEnvChecklist('desktop-app', ['rustc', 'rustcc', 'nodee'])
    expect(result.ok).toBe(false)
    // 只有 rustcc / nodee 两条 problem（合法的 rustc 不产生拦截项）
    expect(result.problems).toHaveLength(2)
    expect(result.problems.some((p) => p.includes('rustcc'))).toBe(true)
    expect(result.problems.some((p) => p.includes('nodee'))).toBe(true)
  })

  test('跨品类组件拦截（desktop-app 清单含 xcodebuild → 不在 desktop 白名单）', () => {
    expect(validateEnvChecklist('desktop-app', ['xcodebuild']).ok).toBe(false)
    // mobile-app 白名单内合法
    expect(validateEnvChecklist('mobile-app', ['xcodebuild', 'node']).ok).toBe(true)
  })

  test('空清单拦截（环境节缺失/表格为空）', () => {
    const result = validateEnvChecklist('desktop-app', [])
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain('环境配置清单为空')
  })

  test('组件名大小写归一（Rustc/CARGO 视同 rustc/cargo；trailing 空格容忍）', () => {
    expect(validateEnvChecklist('desktop-app', [' Rustc ', 'CARGO'])).toEqual({ ok: true, problems: [] })
    // rust ≠ rustc（拼写不同的组件仍拦）
    expect(validateEnvChecklist('desktop-app', [' Rust ']).ok).toBe(false)
  })

  test('模板有「环境」节时以模板清单为准（覆盖白名单：模板含 deno 则 deno 合法）', () => {
    const tpl = '# 模板\n\n## 环境\n\n| deno | 1.4 |\n| node | 20 |\n\n## 其他\n'
    expect(validateEnvChecklist('web-fullstack', ['deno'], tpl)).toEqual({ ok: true, problems: [] })
    // 模板清单外组件仍拦
    expect(validateEnvChecklist('web-fullstack', ['rustc'], tpl).ok).toBe(false)
  })

  test('品类六枚举校验链（isProjectCategory 接入校验层，B5）', () => {
    for (const c of PROJECT_CATEGORIES) expect(isProjectCategory(c)).toBe(true)
    expect(isProjectCategory('desktop')).toBe(false)
    expect(isProjectCategory('web')).toBe(false)
    expect(isProjectCategory('')).toBe(false)
  })
})

describe('extractRawCategoryMarker（宽松品类标记提取，R2 品类幻觉拦截）', () => {
  test('提取最后一次出现的原始值（不限枚举——非法值也要能看见）', () => {
    expect(extractRawCategoryMarker('projectCategory: desktop\n后续 projectCategory: desktop-app')).toBe('desktop-app')
    expect(extractRawCategoryMarker('projectCategory: desktop')).toBe('desktop')
    expect(extractRawCategoryMarker('projectCategory: web')).toBe('web')
  })

  test('无标记返回 null；projectEnv 行不误匹配', () => {
    expect(extractRawCategoryMarker('# 无标记文档\n\nprojectEnv: ready\n')).toBeNull()
  })

  test('与 extractProjectCategoryFromDoc 互补：枚举限定提取只见合法值', () => {
    const doc = 'projectCategory: desktop\n'
    expect(extractProjectCategoryFromDoc(doc)).toBeNull()   // 枚举正则看不见非法值
    expect(extractRawCategoryMarker(doc)).toBe('desktop')   // 宽松提取看得见 → 门禁可拦
  })
})

describe('parseEnvChecklistFromDoc（architecture.md 环境节解析）', () => {
  test('提取表格第一列（跳过表头与分隔行）；节截止于下一标题', () => {
    const doc = '# 架构\n\n## 环境配置\n\n| 组件 | 版本 | 用途 |\n| --- | --- | --- |\n| rustc | 1.75 | 编译 |\n| node | 20 | 前端 |\n\n## 下节\n\n| notenv | 1 | x |\n'
    expect(parseEnvChecklistFromDoc(doc)).toEqual(['rustc', 'node'])
  })

  test('无环境节 → 空数组', () => {
    expect(parseEnvChecklistFromDoc('# 架构\n\n## 技术选型\n\n无环境节。\n')).toEqual([])
  })
})

// ===== W7 前移契约 + 环境状态（v0.17.69） =====

describe('materializeEngineeringTemplate 前移标注（R3 前移契约）', () => {
  test('annotateInitialGuess：模板头部注入「⏳ 初判参考」标注行', () => {
    const root = makeFixture()
    mkdirSync(join(root, 'project-e'), { recursive: true })
    const path = materializeEngineeringTemplate(fixtureRoot, 'e', 'desktop-app', undefined, { annotateInitialGuess: true })
    expect(path).toBeTruthy()
    const content = readFileSync(path!, 'utf-8')
    expect(content).toContain('⏳ 初判参考，以架构师终判为准')
    expect(content).toContain('# 桌面应用 · 工程模板')
  })

  test('默认（无 opts）：纯复制无标注（coding 权威落位不变）', () => {
    const root = makeFixture()
    mkdirSync(join(root, 'project-f'), { recursive: true })
    const path = materializeEngineeringTemplate(fixtureRoot, 'f', 'desktop-app')
    const content = readFileSync(path!, 'utf-8')
    expect(content).not.toContain('初判参考')
  })
})

describe('前移契约：architecture 推进仅 materialize 不写 projectCategory（B2）', () => {
  test('materialize 落位后 projectCategory 仍为 null（品类写入只在 coding 推进钩子）', () => {
    const root = makeFixture()
    mkdirSync(join(root, 'project-g'), { recursive: true })
    // 模拟 prototype→architecture 推进钩子：仅 materialize（前移落位）
    const initial = resolveProjectCategoryForCoding(fixtureRoot, 'g') ?? { category: 'web-fullstack' as const, source: 'default' as const }
    materializeEngineeringTemplate(fixtureRoot, 'g', initial.category, undefined, { annotateInitialGuess: true })
    // 前移契约：模板已落位但品类状态未写入
    expect(existsSync(join(root, 'project-g', '00_ENGINEERING_TEMPLATE', 'template.md'))).toBe(true)
    expect(getProjectCategory(fixtureRoot, 'g')).toBeNull()
    // coding 推进钩子才写品类（既有 setProjectCategory 语义）
    setProjectCategory(fixtureRoot, 'g', initial.category, initial.source)
    expect(getProjectCategory(fixtureRoot, 'g')).toEqual({ category: 'web-fullstack', source: 'default' })
  })
})

describe('setProjectEnvState / 品类变更重置（B3 + R8）', () => {
  test('置位与读回：envReady/envCheck/checkedAt', () => {
    const root = makeFixture()
    mkdirSync(join(root, 'project-h'), { recursive: true })
    setProjectEnvState(fixtureRoot, 'h', false, [{ component: 'rustc', ok: false, reason: '缺失', attemptedAt: '2026-09-03T00:00:00Z' }])
    const state = getProjectEnvState(fixtureRoot, 'h')
    expect(state.envReady).toBe(false)
    expect(state.missingComponents).toEqual(['rustc'])
    expect(state.envCheck).toHaveLength(1)
  })

  test('未置位（存量项目）：envReady undefined + 空缺失清单（门禁豁免口径）', () => {
    const root = makeFixture()
    mkdirSync(join(root, 'project-i'), { recursive: true })
    const state = getProjectEnvState(fixtureRoot, 'i')
    expect(state.envReady).toBeUndefined()
    expect(state.missingComponents).toEqual([])
  })

  test('品类变更重置 envReady（R8：desktop→cli 时清未检查态）；同品类不变', () => {
    const root = makeFixture()
    mkdirSync(join(root, 'project-j'), { recursive: true })
    setProjectCategory(fixtureRoot, 'j', 'desktop-app', 'architecture')
    setProjectEnvState(fixtureRoot, 'j', true, [{ component: 'rustc', ok: true, attemptedAt: '' }])
    expect(getProjectEnvState(fixtureRoot, 'j').envReady).toBe(true)
    // 品类变更（Rust CLI 重判）→ envReady 重置为 undefined
    setProjectCategory(fixtureRoot, 'j', 'cli-tool', 'architecture')
    const after = getProjectEnvState(fixtureRoot, 'j')
    expect(after.envReady).toBeUndefined()
    expect(after.envCheck).toEqual([])
    // 同品类重复写入不重置（幂等）
    setProjectEnvState(fixtureRoot, 'j', true, [{ component: 'bun', ok: true, attemptedAt: '' }])
    setProjectCategory(fixtureRoot, 'j', 'cli-tool', 'prd')
    expect(getProjectEnvState(fixtureRoot, 'j').envReady).toBe(true)
  })
})

// ===== M3（AC 审计 A4）：projectEnv 标记行解析放宽 + 置位共用函数 =====

describe('parseProjectEnvMarker（M3 正则放宽）', () => {
  test('标准形态：ready / missing 半角冒号逗号', () => {
    expect(parseProjectEnvMarker('# 架构\n\nprojectEnv: ready\n')).toEqual({ ready: true, missing: [] })
    expect(parseProjectEnvMarker('projectEnv: missing:rustc,cargo\n')).toEqual({ ready: false, missing: ['rustc', 'cargo'] })
  })

  test('放宽形态：行首缩进 / projectEnv 与冒号间空白 / 冒号后空白', () => {
    expect(parseProjectEnvMarker('  projectEnv : ready\n')).toEqual({ ready: true, missing: [] })
    expect(parseProjectEnvMarker('\tprojectEnv:  missing: rustc,cargo\n')).toEqual({ ready: false, missing: ['rustc', 'cargo'] })
  })

  test('全角容错：全角冒号（主体与 missing 后）+ 全角逗号/顿号分隔', () => {
    expect(parseProjectEnvMarker('projectEnv：ready')).toEqual({ ready: true, missing: [] })
    expect(parseProjectEnvMarker('projectEnv：missing：rustc，cargo、node\n')).toEqual({ ready: false, missing: ['rustc', 'cargo', 'node'] })
  })

  test('多行取最后一次（文档修订覆盖正文）；missing 无组件清单 → 空数组', () => {
    expect(parseProjectEnvMarker('projectEnv: ready\n中间修订\nprojectEnv: missing:node\n')).toEqual({ ready: false, missing: ['node'] })
    expect(parseProjectEnvMarker('projectEnv: missing:\n')).toEqual({ ready: false, missing: [] })
  })

  test('无标记行 → null（调用方 warn + 不置位）', () => {
    expect(parseProjectEnvMarker('# 架构文档\n\n## 环境配置\n\n| node | 20 |\n')).toBeNull()
  })
})

describe('syncProjectEnvStateFromArchitectureDoc（M4 共用函数：解析+置位+幂等）', () => {
  const ARCH_READY = '# 架构\n\n## 环境配置\n\n| 组件 | 版本 |\n| --- | --- |\n| node | 20 |\n| rustc | 1.75 |\n\nprojectEnv: ready\n'

  test('解析标记行并置位（ready→true；missing→false+缺失组件 ok=false）', () => {
    const root = makeFixture()
    const projectDir = join(root, 'project-m4a')
    mkdirSync(join(projectDir, '03_ARCHITECTURE'), { recursive: true })
    writeFileSync(join(projectDir, '03_ARCHITECTURE', 'architecture.md'), ARCH_READY)
    syncProjectEnvStateFromArchitectureDoc(fixtureRoot, 'm4a')
    let state = getProjectEnvState(fixtureRoot, 'm4a')
    expect(state.envReady).toBe(true)
    expect(state.missingComponents).toEqual([])

    // missing 形态（全角冒号 + 冒号后空白，M3 放宽）
    writeFileSync(join(projectDir, '03_ARCHITECTURE', 'architecture.md'),
      '# 架构\n\n## 环境配置\n\n| 组件 | 版本 |\n| --- | --- |\n| node | 20 |\n| rustc | 缺失 |\n\n  projectEnv: missing: rustc\n')
    syncProjectEnvStateFromArchitectureDoc(fixtureRoot, 'm4a')
    state = getProjectEnvState(fixtureRoot, 'm4a')
    expect(state.envReady).toBe(false)
    expect(state.missingComponents).toEqual(['rustc'])
  })

  test('幂等：状态未变不重写（第二次调用后 checkedAt 不变）', () => {
    const root = makeFixture()
    const projectDir = join(root, 'project-m4b')
    mkdirSync(join(projectDir, '03_ARCHITECTURE'), { recursive: true })
    writeFileSync(join(projectDir, '03_ARCHITECTURE', 'architecture.md'), ARCH_READY)
    syncProjectEnvStateFromArchitectureDoc(fixtureRoot, 'm4b')
    const first = JSON.parse(readFileSync(join(projectDir, '_project-info.json'), 'utf-8')) as { checkedAt?: string }
    syncProjectEnvStateFromArchitectureDoc(fixtureRoot, 'm4b')
    const second = JSON.parse(readFileSync(join(projectDir, '_project-info.json'), 'utf-8')) as { checkedAt?: string }
    expect(second.checkedAt).toBe(first.checkedAt)
  })

  test('无标记行：不置位（envReady 保持 undefined——门禁豁免口径）+ 架构文档缺失不抛', () => {
    const root = makeFixture()
    const projectDir = join(root, 'project-m4c')
    mkdirSync(join(projectDir, '03_ARCHITECTURE'), { recursive: true })
    writeFileSync(join(projectDir, '03_ARCHITECTURE', 'architecture.md'), '# 架构文档（无标记行）\n\n补齐最低字节数的架构内容，此处无 projectEnv 标记行。\n')
    syncProjectEnvStateFromArchitectureDoc(fixtureRoot, 'm4c')
    expect(getProjectEnvState(fixtureRoot, 'm4c').envReady).toBeUndefined()
    // 文档不存在：静默跳过
    syncProjectEnvStateFromArchitectureDoc(fixtureRoot, 'm4-nonexistent')
  })
})

// ===== W24-10：环境节头后缀容忍 =====
describe('W24-10 parseEnvChecklistFromDoc 节头后缀容忍', () => {
  test('节头带注释后缀（实测形态「## 环境配置（探测时间 …）」）→ 正常解析组件清单', () => {
    const doc = [
      '# 架构文档',
      '## 环境配置（探测时间 2026-09-13 23:15 GMT+8；命令幂等只读，未安装/升级/改任何配置）',
      '| 组件 | 版本 | 用途 | 探测结果 | 备注 |',
      '| --- | --- | --- | --- | --- |',
      '| rustc | 1.97.1 | Tauri 后端编译 | 就绪 | — |',
      '| node | v22 | 前端构建 | 就绪 | — |',
      '## 下一节',
    ].join('\n')
    const components = parseEnvChecklistFromDoc(doc)
    expect(components).toContain('rustc')
    expect(components).toContain('node')
  })

  test('原有严格形态（## 环境配置 无后缀）与「## 环境」短形态保持可解析', () => {
    expect(parseEnvChecklistFromDoc('## 环境配置\n| 组件 |\n| --- |\n| cargo |')).toContain('cargo')
    expect(parseEnvChecklistFromDoc('## 环境\n| 组件 |\n| --- |\n| bun |')).toContain('bun')
  })

  test('非环境节（## 环境变化分析）不误配', () => {
    expect(parseEnvChecklistFromDoc('## 环境变化分析\n| 项 |\n| --- |\n| x |')).toEqual([])
  })
})

describe('W24-10 环境组件白名单扩容与复合名拆分', () => {
  test('desktop-app：Tauri Linux 真实依赖（webkit2gtk-4.1/gtk+-3.0/libsoup/ayatana）过白名单', () => {
    const r = validateEnvChecklist('desktop-app', ['rustc', 'cargo', 'webkit2gtk-4.1', 'gtk+-3.0', 'libsoup-3.0', 'ayatana-appindicator3-0.1'])
    expect(r.ok).toBe(true)
  })

  test('复合名合写「pkg-config / cc (gcc)」拆 token 全过；DISPLAY 归一为 display 过共享集', () => {
    const r = validateEnvChecklist('desktop-app', ['pkg-config / cc (gcc)', 'DISPLAY'])
    expect(r.ok).toBe(true)
  })

  test('真幻觉包名仍拦（nodej 之类 typo）', () => {
    const r = validateEnvChecklist('desktop-app', ['nodej'])
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toContain('nodej')
  })
})
