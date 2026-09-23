/**
 * 工程模板资源分发权威层（nanju-engineering-resources）测试。
 *
 * 测试策略：
 * - 所有 IO 用 tmpdir 临时目录（autonomy 约束：系统盘 94MB 禁写大量数据）；
 * - 通过显式 explicitBase 注入模板目录，不依赖 process.cwd / electron；
 * - 校验路径覆盖：manifest 缺失 / 不可解析 / 文件缺失 / 哈希错 / 大小错 / 必需依赖缺失 /
 *   类别不匹配 / bundleSha256 不一致 / 路径遍历 / 绝对路径 / 符号链接逃逸 / 重复路径 /
 *   必需品类缺失 / 必需共享文件缺失 / required 最低门槛；
 * - 不依赖网络、不打 pack、不修改 package.json。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import {
  resolveEngineeringTemplatesDirInternal,
  resolveAuthoritativeResourcesPath,
  loadManifest,
  verifyEngineeringResources,
  loadEngineeringResources,
  verifyEngineeringResourcesAt,
  buildManifest,
  buildDefaultDependencies,
  computeFileSha256,
  extractTemplateVersion,
  validatePathSafety,
  validateManifestSchema,
  REQUIRED_CATEGORIES,
  REQUIRED_SHARED_FILES,
  MIN_REQUIRED_ENTRIES,
  MANIFEST_FILENAME,
  type EngineeringTemplatesManifest,
  type EngineeringResourceEntry,
} from './nanju-engineering-resources'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** 真实资源目录绝对路径（用于仓库默认 fixture 的"可用资源"类用例） */
const REAL_TEMPLATES_DIR = join(REPO_ROOT, 'apps', 'electron', 'resources', 'nanju-engineering-templates')

let fixtureRoot = ''
let templatesBase = ''

function setupFixture(): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-eng-res-'))
  templatesBase = join(fixtureRoot, 'resources')
  mkdirSync(join(templatesBase, 'nanju-engineering-templates'), { recursive: true })
}

afterEach(() => {
  if (fixtureRoot) {
    try { rmSync(fixtureRoot, { recursive: true, force: true }) } catch { /* 残留容忍 */ }
    fixtureRoot = ''
    templatesBase = ''
  }
})

/** 工具：把一个文件名+内容写入 fixture 模板目录 */
function writeTemplateFile(name: string, content: string): void {
  writeFileSync(join(templatesBase, 'nanju-engineering-templates', name), content)
}

/** 工具：在 fixture 写入完整 11 个占位文件（六品类 + 五共享），让 strict schema + 文件存在都过 */
function writeFullFixtureContents(): void {
  writeTemplateFile('web-fullstack.md', '# Web 全栈应用 · 工程模板 v2\n\n> 版本：v2.0\n')
  writeTemplateFile('api-backend.md', '# API 后端服务 · 工程模板 v2\n\n> 版本：v2.0\n')
  writeTemplateFile('mobile-app.md', '# 移动应用 · 工程模板 v2\n\n> 版本：v2.3\n')
  writeTemplateFile('desktop-app.md', '# 桌面应用 · 工程模板 v2\n\n> 版本：v2.4\n')
  writeTemplateFile('cli-tool.md', '# CLI 工具 · 工程模板 v2\n\n> 版本：v2.0\n')
  writeTemplateFile('ai-application.md', '# AI 应用 · 工程模板 v2\n\n> 版本：v2.0\n')
  writeTemplateFile('02-Spike实验协议.md', '# Spike 实验协议\n\n> 版本：v1.0\n')
  writeTemplateFile('README.md', '# README\n\n> 版本：v2.0\n')
  writeTemplateFile('CHANGELOG.md', '# CHANGELOG\n\n> 版本：v2.5.0\n')
  writeTemplateFile('check_env.sh', '# check_env.sh\nprobe "node"\nprobe "python3"\n')
  writeTemplateFile('driver-skeleton.py', '# driver-skeleton.py\n')
  writeTemplateFile('driver-skeleton.cjs', '# driver-skeleton.cjs\n')
}

/** 工具：基于当前 fixture 文件计算 entry（仅对存在的文件） */
function entryFor(name: string, opts: Partial<EngineeringResourceEntry> = {}): EngineeringResourceEntry {
  const abs = join(templatesBase, 'nanju-engineering-templates', name)
  const buf = existsSync(abs) ? readFileSync(abs) : Buffer.from('')
  return {
    path: name,
    kind: opts.kind ?? 'shared-script',
    required: opts.required ?? true,
    owner: opts.owner ?? 'templates',
    sha256: opts.sha256 ?? createHash('sha256').update(buf).digest('hex'),
    size: opts.size ?? buf.length,
    category: opts.category,
    version: opts.version,
  }
}

/** 工具：构造 strict-compliant manifest（12 required 项全部声明，符合 MIN_REQUIRED_ENTRIES） */
function fullStrictManifest(opts: {
  bundleVersion?: string
  templateOverrides?: Partial<Record<string, { sha256?: string; size?: number; required?: boolean; version?: string }>>
  sharedOverrides?: Partial<Record<string, { sha256?: string; size?: number; required?: boolean }>>
  deps?: EngineeringTemplatesManifest['dependencies']
  omitCategory?: boolean
  omitShared?: boolean
} = {}): EngineeringTemplatesManifest {
  const templates: EngineeringResourceEntry[] = []
  for (const c of REQUIRED_CATEGORIES) {
    if (opts.omitCategory) continue
    const rel = `${c}.md`
    const override = opts.templateOverrides?.[rel]
    const abs = join(templatesBase, 'nanju-engineering-templates', rel)
    const exists = existsSync(abs)
    const buf = exists ? readFileSync(abs) : Buffer.from('')
    templates.push({
      path: rel,
      kind: 'category',
      category: c,
      version: override?.version ?? 'v2.0',
      required: override?.required ?? true,
      owner: 'templates',
      sha256: override?.sha256 ?? (exists ? createHash('sha256').update(buf).digest('hex') : 'a'.repeat(64)),
      size: override?.size ?? (exists ? buf.length : 0),
    })
  }
  const sharedFiles: EngineeringResourceEntry[] = []
  for (const s of REQUIRED_SHARED_FILES) {
    if (opts.omitShared) continue
    const override = opts.sharedOverrides?.[s]
    const abs = join(templatesBase, 'nanju-engineering-templates', s)
    const exists = existsSync(abs)
    const buf = exists ? readFileSync(abs) : Buffer.from('')
    const isMarkdown = s.endsWith('.md')
    const isSpike = s.includes('Spike')
    const isSh = s.endsWith('.sh')
    sharedFiles.push({
      path: s,
      kind: isMarkdown ? (isSpike ? 'shared-protocol' : 'shared-readme') : (isSh ? 'shared-script' : 'shared-driver'),
      required: override?.required ?? true,
      owner: (s === 'check_env.sh' || s.endsWith('driver-skeleton.py') || s.endsWith('driver-skeleton.cjs'))
        ? 'parent-refresh' : 'templates',
      sha256: override?.sha256 ?? (exists ? createHash('sha256').update(buf).digest('hex') : 'a'.repeat(64)),
      size: override?.size ?? (exists ? buf.length : 0),
      version: isMarkdown ? 'v1.0' : undefined,
    })
  }
  const deps = opts.deps ?? buildDefaultDependencies()
  const m: EngineeringTemplatesManifest = {
    $schema: 'https://proma.cool/schemas/engineering-templates-manifest-v1.json',
    manifestVersion: '1.0.0',
    bundleVersion: opts.bundleVersion ?? '2.5.0',
    bundleId: 'nanju-engineering-templates',
    generatedAt: new Date().toISOString(),
    generator: 'test-fixture',
    templates,
    sharedFiles,
    dependencies: deps,
    bundleSha256: '',
  }
  m.bundleSha256 = computeBundleSha256(m)
  return m
}

/** 工具：bundle sha256 重算（用于测试中构造合规 manifest） */
function computeBundleSha256(m: EngineeringTemplatesManifest): string {
  const all = [...m.templates, ...m.sharedFiles]
  const required = all
    .filter((e) => e.required)
    .map((e) => ({ path: e.path, sha256: e.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const concat = required.map((e) => `${e.path}\0${e.sha256}`).join('\n')
  return createHash('sha256').update(concat).digest('hex')
}

// ===== 路径解析 =====

describe('resolveAuthoritativeResourcesPath（Task 4 修订：extraResources 权威）', () => {
  test('显式 base → dev-explicit 模式', () => {
    const r = resolveAuthoritativeResourcesPath({ explicitBase: '/opt/base' })
    expect(r.baseDir).toBe('/opt/base/nanju-engineering-templates')
    expect(r.mode).toBe('dev-explicit')
  })

  test('非 Electron 环境 + cwd 在仓库根 → dev-cwd 模式 + 命中真实资源', () => {
    const cwdBefore = process.cwd()
    try {
      process.chdir(REPO_ROOT)
      const r = resolveAuthoritativeResourcesPath()
      expect(r.mode).toBe('dev-cwd')
      expect(r.baseDir).toBe(REAL_TEMPLATES_DIR)
      expect(r.resourceDirExists).toBe(true)
    } finally {
      try { process.chdir(cwdBefore) } catch { /* 恢复失败容忍 */ }
    }
  })

  test('非 Electron 环境 + cwd 无资源 → dev-cwd 模式 + resourceDirExists=false（verify 报 manifest-missing）', () => {
    const cwdBefore = process.cwd()
    try {
      process.chdir('/tmp')
      const r = resolveAuthoritativeResourcesPath()
      expect(r.mode).toBe('dev-cwd')
      expect(r.resourceDirExists).toBe(false)
    } finally {
      try { process.chdir(cwdBefore) } catch { /* 恢复失败容忍 */ }
    }
  })

  test('非 Electron 环境下也无 fallback 链：resolveAuthoritativeResourcesPath 不再探测 asar 候选', () => {
    // Task 4 修订口径：asar 不再承担模板分发渠道
    const r = resolveAuthoritativeResourcesPath({ explicitBase: '/x' })
    expect(r.baseDir).toBe('/x/nanju-engineering-templates')
  })
})

describe('resolveEngineeringTemplatesDirInternal（兼容既有 import）', () => {
  test('显式 base 输入 → 路径完全一致', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# x') // 让 existsSync 命中
    expect(resolveEngineeringTemplatesDirInternal(templatesBase))
      .toBe(join(templatesBase, 'nanju-engineering-templates'))
  })

  test('非 Electron 环境 + cwd 在仓库根时定位到真实资源目录', () => {
    const cwdBefore = process.cwd()
    try {
      process.chdir(REPO_ROOT)
      expect(resolveEngineeringTemplatesDirInternal()).toBe(REAL_TEMPLATES_DIR)
    } finally {
      try { process.chdir(cwdBefore) } catch { /* 恢复失败容忍 */ }
    }
  })
})

// ===== extractTemplateVersion 纯函数 =====

describe('extractTemplateVersion', () => {
  test('优先解析元信息行 `> 版本：vX.Y`', () => {
    expect(extractTemplateVersion('# 标题 v2\n\n> 版本：v2.4 | 代号：x\n')).toBe('v2.4')
    expect(extractTemplateVersion('# 标题\n\n> 版本：v1.0\n')).toBe('v1.0')
  })

  test('元信息行带全角冒号亦解析', () => {
    expect(extractTemplateVersion('# 标题\n\n> 版本：v3.0\n')).toBe('v3.0')
  })

  test('无元信息行时回退 H1 中的 vX.Y', () => {
    expect(extractTemplateVersion('# Spike 实验协议 v1.0 · 标题\n')).toBe('v1.0')
  })

  test('无版本标记返回 null', () => {
    expect(extractTemplateVersion('# README\n\n普通内容\n')).toBeNull()
  })

  test('空字符串 / 空白也返回 null', () => {
    expect(extractTemplateVersion('')).toBeNull()
    expect(extractTemplateVersion('\n\n')).toBeNull()
  })
})

// ===== computeFileSha256 =====

describe('computeFileSha256', () => {
  test('已知内容 → 已知 hash', () => {
    setupFixture()
    writeTemplateFile('hello.txt', 'hello')
    const sha = computeFileSha256(join(templatesBase, 'nanju-engineering-templates', 'hello.txt'))
    expect(sha).toBe(createHash('sha256').update('hello').digest('hex'))
  })

  test('文件不存在 → null', () => {
    expect(computeFileSha256('/dev/shm/nonexistent-file-xyz')).toBeNull()
  })
})

// ===== validatePathSafety =====

describe('validatePathSafety（路径安全，S-9 修订：返回 {message, kind}）', () => {
  test('合法相对路径 → null', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# x')
    expect(validatePathSafety('desktop-app.md', join(templatesBase, 'nanju-engineering-templates'))).toBeNull()
  })

  test('绝对路径（POSIX） → kind=absolute-path', () => {
    const r = validatePathSafety('/etc/passwd', '/tmp')
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('absolute-path')
    expect(r!.message).toContain('绝对路径')
  })

  test('绝对路径（Windows 盘符） → kind=absolute-path', () => {
    const r = validatePathSafety('C:\\Windows\\evil.md', '/tmp')
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('absolute-path')
  })

  test('路径遍历 `..` → kind=path-traversal', () => {
    const r1 = validatePathSafety('../escape.md', '/tmp')
    expect(r1!.kind).toBe('path-traversal')
    expect(r1!.message).toContain('路径遍历')
    const r2 = validatePathSafety('a/../../etc/passwd', '/tmp')
    expect(r2!.kind).toBe('path-traversal')
  })

  test('符号链接逃逸 → kind=symlink-escape', () => {
    setupFixture()
    const outside = join(fixtureRoot, 'outside.md')
    writeFileSync(outside, '# evil')
    const linkName = 'leaked.md'
    try {
      symlinkSync(outside, join(templatesBase, 'nanju-engineering-templates', linkName))
    } catch {
      return
    }
    const r = validatePathSafety(linkName, join(templatesBase, 'nanju-engineering-templates'))
    if (r) {
      expect(r.kind).toBe('symlink-escape')
      expect(r.message).toContain('符号链接逃逸')
    }
  })

  test('空字符串 / 非字符串 → kind=empty-path', () => {
    expect(validatePathSafety('', '/tmp')!.kind).toBe('empty-path')
    expect(validatePathSafety(undefined as never, '/tmp')!.kind).toBe('empty-path')
  })
})

// ===== loadManifest =====

describe('loadManifest', () => {
  test('fixture 中不存在 manifest.json → null', () => {
    setupFixture()
    expect(loadManifest(join(templatesBase, 'nanju-engineering-templates'))).toBeNull()
  })

  test('manifest.json 存在但字段缺失 → null（不可解析）', () => {
    setupFixture()
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify({ bundleVersion: '1.0.0' }))
    expect(loadManifest(join(templatesBase, 'nanju-engineering-templates'))).toBeNull()
  })

  test('manifest.json 不可解析（JSON 损坏） → null', () => {
    setupFixture()
    writeTemplateFile(MANIFEST_FILENAME, '{ bad json')
    expect(loadManifest(join(templatesBase, 'nanju-engineering-templates'))).toBeNull()
  })

  test('合法 manifest → 解析成功（strict schema 在 verify 阶段执行）', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    const loaded = loadManifest(join(templatesBase, 'nanju-engineering-templates'))
    expect(loaded).not.toBeNull()
    expect(loaded!.bundleVersion).toBe('2.5.0')
  })
})

// ===== validateManifestSchema（strict schema） =====

describe('validateManifestSchema（strict）', () => {
  test('完整合规 manifest → issues 为空', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    const issues = validateManifestSchema(m, join(templatesBase, 'nanju-engineering-templates'))
    expect(issues).toEqual([])
  })

  test('缺品类 → blocking manifest-unparseable', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest({ omitCategory: true })
    const issues = validateManifestSchema(m, join(templatesBase, 'nanju-engineering-templates'))
    expect(issues.some((i) => i.severity === 'blocking' && i.message.includes('必需品类缺失'))).toBe(true)
    // 应有 6 条（每个 REQUIRED_CATEGORIES 缺一条）
    const missing = issues.filter((i) => i.message.includes('必需品类缺失'))
    expect(missing).toHaveLength(REQUIRED_CATEGORIES.length)
  })

  test('缺共享文件 → blocking', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest({ omitShared: true })
    const issues = validateManifestSchema(m, join(templatesBase, 'nanju-engineering-templates'))
    expect(issues.some((i) => i.severity === 'blocking' && i.message.includes('必需共享文件缺失'))).toBe(true)
    const missing = issues.filter((i) => i.message.includes('必需共享文件缺失'))
    expect(missing).toHaveLength(REQUIRED_SHARED_FILES.length)
  })

  test('重复路径 → blocking', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    // 强行在 sharedFiles 加一个与 templates 同 path 的条目
    m.sharedFiles.push({
      path: 'desktop-app.md',
      kind: 'shared-readme',
      required: true,
      owner: 'templates',
      sha256: 'a'.repeat(64),
      size: 1,
    })
    const issues = validateManifestSchema(m, join(templatesBase, 'nanju-engineering-templates'))
    expect(issues.some((i) => i.severity === 'blocking' && i.message.includes('重复路径'))).toBe(true)
  })

  test('路径遍历 → blocking path-traversal', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    // 替换第一个 template 的 path 为 traversal
    m.templates[0]!.path = '../escape.md'
    const issues = validateManifestSchema(m, join(templatesBase, 'nanju-engineering-templates'))
    expect(issues.some((i) => i.severity === 'blocking' && i.kind === 'path-traversal')).toBe(true)
  })

  test('绝对路径 → blocking', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    m.templates[0]!.path = '/etc/passwd'
    const issues = validateManifestSchema(m, join(templatesBase, 'nanju-engineering-templates'))
    expect(issues.some((i) => i.severity === 'blocking' && i.message.includes('绝对路径'))).toBe(true)
  })

  test('required 数低于最低门槛 → blocking（防"空清单让 bundleSha256 重算巧合通过"）', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest({
      templateOverrides: { 'desktop-app.md': { required: false } },
      sharedOverrides: { 'README.md': { required: false }, '02-Spike实验协议.md': { required: false } },
    })
    const issues = validateManifestSchema(m, join(templatesBase, 'nanju-engineering-templates'))
    expect(issues.some((i) => i.severity === 'blocking' && i.message.includes('required 条目数'))).toBe(true)
  })
})

// ===== verifyEngineeringResources（集成校验） =====

describe('verifyEngineeringResources', () => {
  test('manifest 缺失：baseDir 不存在 → blocking manifest-missing', () => {
    const r = verifyEngineeringResources('/dev/shm/never-created-tpl', null)
    expect(r.ok).toBe(false)
    expect(r.manifestFound).toBe(false)
    expect(r.baseDirExists).toBe(false)
    expect(r.issues.some((i) => i.kind === 'manifest-missing' && i.severity === 'blocking')).toBe(true)
  })

  test('manifest 缺失但 baseDir 存在 → 明确诊断 manifest.json', () => {
    setupFixture()
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), null)
    expect(r.ok).toBe(false)
    expect(r.baseDirExists).toBe(true)
    expect(r.manifestFound).toBe(false)
    expect(r.issues.some((i) => i.kind === 'manifest-missing')).toBe(true)
  })

  test('strict schema 拦截缺品类', () => {
    setupFixture()
    // 只写 desktop-app.md（其他品类不存在）
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest({ omitCategory: true })
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.kind === 'manifest-unparseable' && i.message.includes('必需品类缺失'))).toBe(true)
  })

  test('文件缺失（required） → blocking file-missing', () => {
    setupFixture()
    writeFullFixtureContents()
    const m = fullStrictManifest()
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    // 删除 driver-skeleton.py 触发文件缺失
    rmSync(join(templatesBase, 'nanju-engineering-templates', 'driver-skeleton.py'))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.kind === 'file-missing' && i.severity === 'blocking' && i.path === 'driver-skeleton.py')).toBe(true)
  })

  test('哈希错配（required） → blocking hash-mismatch', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    // 篡改 manifest 中 desktop-app.md 的 sha256
    m.templates.find((e) => e.path === 'desktop-app.md')!.sha256 = 'deadbeef'.repeat(8)
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.kind === 'hash-mismatch' && i.path === 'desktop-app.md' && i.severity === 'blocking')).toBe(true)
  })

  test('大小错配（required） → blocking size-mismatch', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    m.templates.find((e) => e.path === 'desktop-app.md')!.size = 999
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.kind === 'size-mismatch' && i.path === 'desktop-app.md')).toBe(true)
  })

  test('必需依赖缺失 → blocking dependency-missing', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    writeTemplateFile('check_env.sh', '# check')
    const m = fullStrictManifest()
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    // 删除 check_env.sh 触发依赖缺失
    rmSync(join(templatesBase, 'nanju-engineering-templates', 'check_env.sh'))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.kind === 'dependency-missing' && i.severity === 'blocking')).toBe(true)
  })

  test('bundleSha256 与重算不一致 → blocking', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    m.bundleSha256 = 'aaaa'.repeat(16)
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.kind === 'hash-mismatch' && i.path === MANIFEST_FILENAME)).toBe(true)
  })

  test('kind=category 但 category 字段非枚举 → blocking category-mismatch', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    m.templates.find((e) => e.category === 'desktop-app')!.category = 'not-a-category' as never
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.kind === 'category-mismatch' && i.severity === 'blocking')).toBe(true)
  })

  test('kind=category 但文件名不匹配 category → blocking', () => {
    setupFixture()
    writeTemplateFile('desktop-app.md', '# desktop')
    const m = fullStrictManifest()
    m.templates.find((e) => e.category === 'web-fullstack')!.path = 'desktop-app.md'
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.kind === 'category-mismatch' && i.path === 'desktop-app.md')).toBe(true)
  })

  test('全合规 → ok=true 且 issues 为空', () => {
    setupFixture()
    writeFullFixtureContents()
    const m = fullStrictManifest()
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(true)
    expect(r.issues).toEqual([])
    expect(r.diagnostics).toEqual([])
  })

  test('required=false 资源缺失 → 仅 warning 不阻塞 ok（仍需 strict schema 通过）', () => {
    setupFixture()
    writeFullFixtureContents()
    writeTemplateFile('extra.md', '# extra')
    const m = fullStrictManifest()
    // 额外加一个 required=false 的非 category 条目
    m.sharedFiles.push({
      path: 'extra.md',
      kind: 'shared-readme',
      required: false,
      owner: 'templates',
      sha256: 'b'.repeat(64),
      size: 1,
      version: 'v1.0',
    })
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    rmSync(join(templatesBase, 'nanju-engineering-templates', 'extra.md'))
    const r = verifyEngineeringResources(join(templatesBase, 'nanju-engineering-templates'), m)
    expect(r.ok).toBe(true)
    expect(r.issues.some((i) => i.severity === 'warning' && i.path === 'extra.md')).toBe(true)
    expect(r.issues.some((i) => i.severity === 'blocking')).toBe(false)
  })
})

// ===== 一站式 load =====

describe('loadEngineeringResources（仓库真实 fixture）', () => {
  test('在仓库根运行 → 命中真实资源目录；ok=true', () => {
    const cwdBefore = process.cwd()
    try {
      process.chdir(REPO_ROOT)
      const r = loadEngineeringResources()
      expect(r.baseDir).toBe(REAL_TEMPLATES_DIR)
      expect(r.manifest).not.toBeNull()
      expect(r.verify.ok).toBe(true)
      expect(r.verify.bundleVersion).toBe('2.5.0')
      expect(r.verify.requiredCount).toBe(MIN_REQUIRED_ENTRIES)
      expect(r.requiredPaths).toHaveLength(MIN_REQUIRED_ENTRIES)
      expect(r.entries.find((e) => e.path === 'desktop-app.md')).toBeDefined()
      expect(r.byCategory['desktop-app']?.path).toBe('desktop-app.md')
      expect(r.byCategory['web-fullstack']?.path).toBe('web-fullstack.md')
    } finally {
      try { process.chdir(cwdBefore) } catch { /* 恢复失败容忍 */ }
    }
  })

  test('缺 manifest 的 fixture → manifest=null 但 verify.issues 明确诊断', () => {
    setupFixture()
    const r = loadEngineeringResources(templatesBase)
    expect(r.manifest).toBeNull()
    expect(r.entries).toEqual([])
    expect(r.requiredPaths).toEqual([])
    expect(r.verify.ok).toBe(false)
    expect(r.verify.issues.some((i) => i.kind === 'manifest-missing')).toBe(true)
  })
})

// ===== verifyEngineeringResourcesAt 便捷入口 =====

describe('verifyEngineeringResourcesAt', () => {
  test('默认入口 = 仓库真实资源；ok=true', () => {
    const cwdBefore = process.cwd()
    try {
      process.chdir(REPO_ROOT)
      const r = verifyEngineeringResourcesAt()
      expect(r.ok).toBe(true)
      expect(r.bundleVersion).toBe('2.5.0')
    } finally {
      try { process.chdir(cwdBefore) } catch { /* 恢复失败容忍 */ }
    }
  })

  test('显式 templatesBase 注入', () => {
    setupFixture()
    writeFullFixtureContents()
    const m = fullStrictManifest()
    writeTemplateFile(MANIFEST_FILENAME, JSON.stringify(m))
    const r = verifyEngineeringResourcesAt(templatesBase)
    expect(r.ok).toBe(true)
    expect(r.baseDir).toBe(join(templatesBase, 'nanju-engineering-templates'))
  })
})

// ===== buildManifest 构造器 =====

describe('buildManifest', () => {
  test('基于真实资源目录生成 manifest：自动计算 sha256/size/version/依赖图', () => {
    const m = buildManifest(REAL_TEMPLATES_DIR, {
      bundleVersion: '2.5.0',
      platformVersion: 'task4-pending',
    })
    expect(m.bundleVersion).toBe('2.5.0')
    expect(m.platformVersion).toBe('task4-pending')
    expect(m.generator).toContain('nanju-engineering-resources')
    expect(m.templates).toHaveLength(6)
    expect(m.sharedFiles).toHaveLength(6)
    expect(m.dependencies.length).toBeGreaterThanOrEqual(19)

    const desktop = m.templates.find((e) => e.path === 'desktop-app.md')
    expect(desktop?.category).toBe('desktop-app')
    expect(desktop?.version).toBe('v2.4')
    expect(desktop?.kind).toBe('category')

    const spike = m.sharedFiles.find((e) => e.path === '02-Spike实验协议.md')
    expect(spike?.kind).toBe('shared-protocol')
    expect(spike?.version).toBe('v1.0')

    // bundleSha256 应与重算一致（构造器自洽）
    const recomputed = computeBundleSha256(m)
    expect(m.bundleSha256).toBe(recomputed)
  })

  test('overrideSha256：覆盖后 bundleSha256 重算（父集成刷新场景）', () => {
    const m = buildManifest(REAL_TEMPLATES_DIR, {
      bundleVersion: '2.5.1',
      overrideSha256: { 'check_env.sh': 'a'.repeat(64) },
    })
    const entry = m.sharedFiles.find((e) => e.path === 'check_env.sh')
    expect(entry?.sha256).toBe('a'.repeat(64))
    expect(entry?.owner).toBe('parent-refresh')
    expect(m.bundleSha256).not.toBe('')
  })

  test('依赖图：默认提供 6 品类 → 骨架双文件 + Spike 协议 + desktop → check_env.sh', () => {
    const deps = buildDefaultDependencies()
    expect(deps.length).toBe(19)
    expect(deps.filter((d) => d.kind === 'file-reference' && d.to === 'driver-skeleton.py')).toHaveLength(6)
    expect(deps.filter((d) => d.kind === 'file-reference' && d.to === 'driver-skeleton.cjs')).toHaveLength(6)
    expect(deps.filter((d) => d.kind === 'section-reference' && d.to === '02-Spike实验协议.md')).toHaveLength(6)
    expect(deps.filter((d) => d.kind === 'script-reference' && d.to === 'check_env.sh')).toHaveLength(1)
    expect(deps.find((d) => d.from === 'desktop-app.md' && d.to === 'check_env.sh')?.required).toBe(true)
  })
})

// ===== MIN_REQUIRED_ENTRIES 常量 =====

describe('MIN_REQUIRED_ENTRIES 防"空清单让 bundleSha256 巧合通过"', () => {
  test('值 = REQUIRED_CATEGORIES + REQUIRED_SHARED_FILES = 11', () => {
    expect(MIN_REQUIRED_ENTRIES).toBe(12)
    expect(MIN_REQUIRED_ENTRIES).toBe(REQUIRED_CATEGORIES.length + REQUIRED_SHARED_FILES.length)
  })
})
