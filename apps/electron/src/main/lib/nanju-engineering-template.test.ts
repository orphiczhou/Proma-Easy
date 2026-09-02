import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const {
  extractProjectCategoryFromDoc,
  resolveProjectCategoryForCoding,
  resolveEngineeringTemplatesDir,
  materializeEngineeringTemplate,
  getProjectTemplateDir,
  buildCategoryGuideLines,
  CATEGORY_META,
} = await import('./nanju-engineering-template')
const { setProjectCategory, getProjectCategory, PROJECT_CATEGORIES, isProjectCategory } = await import('./nanju-project')

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
