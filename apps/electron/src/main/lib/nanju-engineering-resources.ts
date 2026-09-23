/**
 * 南大向导 — 工程模板资源分发权威层（Task 4，基线 v0.17.131+task4，待父集成 bump）
 *
 * 设计目标：把"模板发布来源 + 资源完整性"从「existsSync 谁先到谁赢」的隐式约定
 * 升级为「manifest.json + SHA256 + 依赖图 + 路径安全」的显式契约。
 *
 * 关键决策（Phase1 plan §5 Task 4 + Task 4 修订口径）：
 * - **Electron 主进程运行时**：以 process.resourcesPath（electron-builder extraResources
 *   落点）为唯一权威源。不再使用 asar 候选；不与开发目录 fallback；manifest 错误即
 *   阻塞，不静默使用旧源。
 * - **开发 / 测试 / CLI**：explicitBase 注入或 cwd 候选解析，便于仓库根测试与开发部署入口。
 * - 资源目录引入 manifest.json：每个文件含 sha256/size/required/owner；依赖图显式
 *   声明「哪篇模板引用哪个共享文件」（驱动骨架 / Spike 协议 / check_env.sh）。
 * - 严格 schema 校验：拒绝 absolute path / path traversal / symlink escape / 重复路径；
 *   required 条目数最低门槛 11（防"空清单让 bundleSha256 重算巧合通过"）。
 * - 校验失败给结构化诊断（缺文件 / 哈希错 / 必需依赖缺失），不靠 asar 存在臆断；
 *   验证脚本可在 pack 产物与部署目标独立运行，失败即阻止宣布部署成功。
 * - 父集成阶段会刷新「owner=parent-refresh」的共享文件哈希（driver-skeleton.* /
 *   check_env.sh）：本模块允许该刷新，verify 与 load 共享同一段哈希逻辑，调用方
 *   只需重写 manifest.json 后再 load 即可。
 *
 * 与既有 nanju-engineering-template.ts 的关系：
 * - 路径解析逻辑（resolveEngineeringTemplatesDirInternal）从 template.ts 抽出到本模块，
 *   由 template.ts re-export 保持既有 import 不破坏（W3 既有 64 用例不受影响）。
 * - 模板正文落位（materializeEngineeringTemplate）仍由 template.ts 实现，但本批修订后
 *   内部必须走 manifest verify 链（load → verify → 拒绝/通过），不再允许 silently
 *   fallback 到旧源；项目侧同时落 Spike 协议 + 写项目 template-manifest.json（记录
 *   实际采用的 templateVersion / templateHash / bundleHash）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import {
  isProjectCategory,
  type ProjectCategory,
} from './nanju-project'

// ===== Manifest schema 类型 =====

/** 单条资源条目（在 templates 或 sharedFiles 数组中复用） */
export interface EngineeringResourceEntry {
  /** 相对资源目录路径（统一用 POSIX 分隔符，便于跨平台比较） */
  path: string
  /** 文件种类（影响 verify 阶段分组与诊断） */
  kind: 'category' | 'shared-protocol' | 'shared-readme' | 'shared-changelog' | 'shared-script' | 'shared-driver' | 'manifest'
  /** 模板品类（仅 kind=category 时存在） */
  category?: ProjectCategory
  /** 内容版本（取自正文章节头解析；共享脚本取自父阶段 owner 标注） */
  version?: string
  /** 是否必需：必需资源缺失 → verify.ok=false（可选资源仅记日志不阻塞） */
  required: boolean
  /** 文件所有者：manifest 自描述为 self；模板正文为 templates；共享文件标记 parent-refresh 时由父集成阶段统一刷新哈希 */
  owner: 'self' | 'templates' | 'parent-refresh'
  /** SHA256（hex，小写） */
  sha256: string
  /** 字节数（用于交叉验证 sha256 之外的多维校验） */
  size: number
}

/** 资源间依赖关系（驱动骨架 / Spike 协议 / check_env.sh 的引用闭环） */
export interface EngineeringResourceDependency {
  /** 引用方模板路径 */
  from: string
  /** 被引用方路径 */
  to: string
  /** 引用类型：正文引用 / 共享脚本 / 骨架文件 */
  kind: 'section-reference' | 'file-reference' | 'script-reference'
  /** 可选：引用定位（如章节号） */
  anchor?: string
  /** 是否必需：必需依赖缺失 → verify.ok=false */
  required: boolean
}

/** 完整 manifest（写入 manifest.json 的形态） */
export interface EngineeringTemplatesManifest {
  $schema: string
  /** Manifest schema 版本（与 bundleVersion 正交——schema 升不必然升 bundle） */
  manifestVersion: string
  /** 整包语义版本（绑定文件清单 + 内容 hash；任一文件变化即 bump） */
  bundleVersion: string
  /** 资源 ID（人类可读定位串） */
  bundleId: string
  /** Manifest 生成时间（ISO-8601） */
  generatedAt: string
  /** 生成器标识（owner=tools 时写入；owner=self 时填本模块名） */
  generator: string
  /** 关联的平台版本（首次绑定后随平台 bump 而 bump，单独跟踪；本批标注 task4-pending） */
  platformVersion?: string
  /** 6 个品类模板条目 */
  templates: EngineeringResourceEntry[]
  /** 共享文件条目（协议 / README / 脚本 / 骨架） */
  sharedFiles: EngineeringResourceEntry[]
  /** 依赖关系图（用于驱动缺失依赖检测） */
  dependencies: EngineeringResourceDependency[]
  /** 整包指纹：所有 required 条目按 path 排序后 sha256(concat(sha256)) */
  bundleSha256: string
}

// ===== 加载与诊断类型 =====

/** 单一校验问题（结构化诊断） */
export interface EngineeringResourceIssue {
  /** 问题分类 */
  kind:
    | 'manifest-missing'
    | 'manifest-unparseable'
    | 'file-missing'
    | 'hash-mismatch'
    | 'size-mismatch'
    | 'dependency-missing'
    | 'unparseable-version'
    | 'category-mismatch'
    | 'path-traversal'
    | 'symlink-escape'
    | 'absolute-path'
    | 'empty-path'
  /** 人类可读诊断 */
  message: string
  /** 涉及路径（缺失/不匹配的目标） */
  path?: string
  /** 期望值（哈希/版本等） */
  expected?: string
  /** 实际值 */
  actual?: string
  /** 严重等级：阻塞（必需资源失败）/ 警告（可选资源/非必需依赖） */
  severity: 'blocking' | 'warning'
}

/** 校验结果（verify 函数返回值；ok=true 表示必需资源全合规） */
export interface EngineeringResourceVerifyResult {
  /** 是否通过校验：所有 required 资源存在且哈希匹配、所有 required 依赖闭环 */
  ok: boolean
  /** 资源目录绝对路径（resolve 后的最终路径，可能不存在） */
  baseDir: string
  /** 资源目录是否存在 */
  baseDirExists: boolean
  /** Manifest 是否加载成功 */
  manifestFound: boolean
  /** Manifest bundleVersion（未加载时为 null） */
  bundleVersion: string | null
  /** Manifest bundleSha256（未加载时为 null；与重新计算结果对照可发现 manifest 自描述与实际不符） */
  bundleSha256: string | null
  /** Manifest 声明的 required 条目数 */
  requiredCount: number
  /** 重新计算的 bundleSha256（与 manifest 自描述对照） */
  computedBundleSha256: string
  /** 问题清单（按严重级倒序） */
  issues: EngineeringResourceIssue[]
  /** 人类可读诊断串（按问题生成；多行） */
  diagnostics: string[]
}

/** 资源加载结果（load = resolve + read manifest + verify 一站式） */
export interface EngineeringResourceLoadResult {
  baseDir: string
  manifest: EngineeringTemplatesManifest | null
  verify: EngineeringResourceVerifyResult
  /** 已索引的条目（manifest.templates + manifest.sharedFiles 合并；按 path 主键去重） */
  entries: EngineeringResourceEntry[]
  /** 必需资源清单（路径集合，便于外部快速校验） */
  requiredPaths: string[]
  /** 按品类索引的模板条目（category → entry）；仅 kind=category 的条目 */
  byCategory: Partial<Record<ProjectCategory, EngineeringResourceEntry>>
}

// ===== 路径解析（Task 4 修订：extraResources 权威，无 fallback） =====

/**
 * 解析权威资源目录（结构化返回）。
 *
 * Task 4 修订语义（基线 v0.17.131+task4，待父集成 bump）：
 * - **Electron 主进程运行时**：以 `process.resourcesPath`（electron-builder
 *   extraResources 落点）为唯一权威源。不再使用 asar 候选；不与开发目录 fallback。
 *   若资源目录在 resourcesPath 下不存在，仍返回该路径（调用方 verify 报 manifest-missing），
 *   不静默切到其他源——避免 manifest 错误被旧源遮蔽。
 * - **开发 / 测试 / CLI**：使用 `explicitBase` 注入；未提供时按 cwd 候选解析
 *   （apps/electron/resources > resources），便于仓库根测试与开发部署入口。
 *   资源验证失败也不静默 fallback 到另一个候选——返回首个候选路径作为权威，
 *   verify 失败由调用方决策。
 *
 * 返回值结构化以便调用方区分环境语义：
 * - mode=`electron-extraResources`：Electron 打包后
 * - mode=`dev-explicit`：explicitBase 注入（测试 / 开发）
 * - mode=`dev-cwd`：cwd 候选（仓库根调试脚本）
 */
export interface ResourcesPathResolution {
  baseDir: string
  mode: 'electron-extraResources' | 'dev-explicit' | 'dev-cwd'
  resourceDirExists: boolean
}

export function resolveAuthoritativeResourcesPath(opts?: { explicitBase?: string }): ResourcesPathResolution {
  if (opts?.explicitBase) {
    const baseDir = join(opts.explicitBase, 'nanju-engineering-templates')
    return { baseDir, mode: 'dev-explicit', resourceDirExists: existsSync(baseDir) }
  }
  const isElectron = typeof process.versions.electron === 'string' && (process as { type?: string }).type === 'browser'
  if (isElectron) {
    const baseDir = join(process.resourcesPath as string, 'nanju-engineering-templates')
    return { baseDir, mode: 'electron-extraResources', resourceDirExists: existsSync(baseDir) }
  }
  // 开发 / 测试 / CLI：cwd 候选首个存在的即为权威；都不存在则返回 cwd apps/electron/resources（由 verify 诊断）
  const cwdCandidates = [
    join(process.cwd(), 'apps', 'electron', 'resources', 'nanju-engineering-templates'),
    join(process.cwd(), 'resources', 'nanju-engineering-templates'),
  ]
  for (const c of cwdCandidates) {
    if (existsSync(c)) return { baseDir: c, mode: 'dev-cwd', resourceDirExists: true }
  }
  return { baseDir: cwdCandidates[0]!, mode: 'dev-cwd', resourceDirExists: false }
}

/**
 * 字符串版 resolver（与 nanju-engineering-template.ts 既有 import 兼容）。
 * 内部调用 resolveAuthoritativeResourcesPath 取 baseDir 字段。
 */
export function resolveEngineeringTemplatesDirInternal(explicitBase?: string): string {
  return resolveAuthoritativeResourcesPath({ explicitBase }).baseDir
}

// ===== SHA256 / 文件工具 =====

/** 计算单文件 SHA256（hex 小写）；文件不存在或读失败返回 null */
export function computeFileSha256(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null
    const buf = readFileSync(filePath)
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

/** 整包指纹：所有 required 条目按 path 升序，concat(sha256) 后再 sha256 */
function computeBundleSha256(entries: EngineeringResourceEntry[]): string {
  const required = entries
    .filter((e) => e.required)
    .map((e) => ({ path: e.path, sha256: e.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const concat = required.map((e) => `${e.path}\0${e.sha256}`).join('\n')
  return createHash('sha256').update(concat).digest('hex')
}

// ===== Manifest schema 常量（strict 校验用） =====

/** Manifest 文件名（资源目录根下唯一） */
export const MANIFEST_FILENAME = 'manifest.json'

/** 六品类（manifest 完整性约束：必须同时存在） */
export const REQUIRED_CATEGORIES: ReadonlyArray<ProjectCategory> = [
  'web-fullstack', 'api-backend', 'mobile-app', 'desktop-app', 'cli-tool', 'ai-application',
]

/** 必需共享文件（manifest 完整性约束：必须同时存在） */
export const REQUIRED_SHARED_FILES: ReadonlyArray<string> = [
  '02-Spike实验协议.md',
  'README.md',
  'CHANGELOG.md',
  'check_env.sh',
  'driver-skeleton.py',
  'driver-skeleton.cjs',
]

/** Manifest 最低 required 条目数（防"空清单让 bundleSha256 重算巧合通过"） */
export const MIN_REQUIRED_ENTRIES = REQUIRED_CATEGORIES.length + REQUIRED_SHARED_FILES.length

/** 路径安全验证问题结构（带 kind 路由供诊断分诊） */
export interface PathSafetyIssue {
  message: string
  kind: 'path-traversal' | 'symlink-escape' | 'absolute-path' | 'empty-path'
}

/**
 * 路径安全验证（S-9 修订：返回 kind）：
 * - 拒绝绝对路径（POSIX 起点 / 或 Windows 盘符 C:） → kind='absolute-path'
 * - 拒绝路径遍历（含 .. 段） → kind='path-traversal'
 * - 拒绝符号链接逃逸（实际绝对路径必须在 baseDir 下） → kind='symlink-escape'
 * - 空字符串 / 非字符串 → kind='empty-path'
 *
 * 返回 null 表示路径安全。
 */
export function validatePathSafety(relPath: string, baseDir: string): PathSafetyIssue | null {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return { message: '路径必须为非空字符串', kind: 'empty-path' }
  }
  // 绝对路径：POSIX 起点 或 Windows 盘符
  if (relPath.startsWith('/') || relPath.startsWith('\\')) {
    return { message: `绝对路径不允许：${relPath}`, kind: 'absolute-path' }
  }
  if (/^[a-zA-Z]:[\\/]/.test(relPath)) {
    return { message: `Windows 绝对路径不允许：${relPath}`, kind: 'absolute-path' }
  }
  // 路径遍历：含有 .. 段
  const segments = relPath.split(/[\\/]/)
  if (segments.includes('..')) {
    return { message: `路径遍历不允许（.. 段）：${relPath}`, kind: 'path-traversal' }
  }
  // 符号链接逃逸：实际绝对路径必须在 baseDir 下
  try {
    const absBase = realpathSync(baseDir)
    const absTarget = realpathSync(join(baseDir, relPath))
    const rel = relative(absBase, absTarget)
    if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
      return {
        message: `符号链接逃逸（实际路径越出 baseDir）：${relPath} → ${absTarget}`,
        kind: 'symlink-escape',
      }
    }
  } catch {
    // realpathSync 失败（文件不存在）不算逃逸，由后续 existsSync 检查
  }
  return null
}

/**
 * Manifest 严格 schema 校验。
 *
 * 验证内容：
 * 1. bundleVersion 非空
 * 2. templates/sharedFiles/dependencies 是数组
 * 3. 必需品类 6 项全部在 templates 中出现（kind=category + category 字段有效）
 * 4. 必需共享文件 5 项全部在 sharedFiles 中出现
 * 5. 路径安全（无 absolute / traversal / symlink escape）
 * 6. 重复路径拒绝（同一路径不能同时出现在 templates 与 sharedFiles 中，也不能在同列表重复）
 * 7. kind=category 条目的 path 必须以 `${category}.md` 结尾
 * 8. required 条目总数 >= MIN_REQUIRED_ENTRIES（防空清单让 bundleSha256 重算巧合通过）
 */
export function validateManifestSchema(
  manifest: EngineeringTemplatesManifest,
  baseDir: string,
): EngineeringResourceIssue[] {
  const issues: EngineeringResourceIssue[] = []

  // 基础结构
  if (typeof manifest.bundleVersion !== 'string' || manifest.bundleVersion.length === 0) {
    issues.push({
      kind: 'manifest-unparseable',
      severity: 'blocking',
      message: 'bundleVersion 字段缺失或为空',
      path: MANIFEST_FILENAME,
    })
  }
  if (!Array.isArray(manifest.templates)) {
    issues.push({
      kind: 'manifest-unparseable',
      severity: 'blocking',
      message: 'templates 不是数组',
      path: MANIFEST_FILENAME,
    })
  }
  if (!Array.isArray(manifest.sharedFiles)) {
    issues.push({
      kind: 'manifest-unparseable',
      severity: 'blocking',
      message: 'sharedFiles 不是数组',
      path: MANIFEST_FILENAME,
    })
  }
  if (!Array.isArray(manifest.dependencies)) {
    issues.push({
      kind: 'manifest-unparseable',
      severity: 'blocking',
      message: 'dependencies 不是数组',
      path: MANIFEST_FILENAME,
    })
  }

  const templates = Array.isArray(manifest.templates) ? manifest.templates : []
  const shared = Array.isArray(manifest.sharedFiles) ? manifest.sharedFiles : []

  // 必需品类
  const presentCategories = new Set<ProjectCategory>()
  for (const t of templates) {
    if (t.kind === 'category' && t.category) presentCategories.add(t.category)
  }
  for (const c of REQUIRED_CATEGORIES) {
    if (!presentCategories.has(c)) {
      issues.push({
        kind: 'manifest-unparseable',
        severity: 'blocking',
        message: `必需品类缺失：${c}（六品类必须同时出现在 manifest.templates）`,
        path: MANIFEST_FILENAME,
      })
    }
  }

  // 必需共享文件
  const presentShared = new Set(shared.map((s) => s.path))
  for (const s of REQUIRED_SHARED_FILES) {
    if (!presentShared.has(s)) {
      issues.push({
        kind: 'manifest-unparseable',
        severity: 'blocking',
        message: `必需共享文件缺失：${s}`,
        path: s,
      })
    }
  }

  // 重复路径 + 路径安全 + kind=category 文件名一致性
  const seenPaths = new Set<string>()
  for (const e of [...templates, ...shared]) {
    if (seenPaths.has(e.path)) {
      issues.push({
        kind: 'manifest-unparseable',
        severity: 'blocking',
        message: `重复路径：${e.path}（同一路径不能同时出现在 templates 与 sharedFiles 中，也不能在同列表重复）`,
        path: e.path,
      })
    }
    seenPaths.add(e.path)

    const pathIssue = validatePathSafety(e.path, baseDir)
    if (pathIssue) {
      issues.push({
        kind: pathIssue.kind,
        severity: 'blocking',
        message: pathIssue.message,
        path: e.path,
      })
    }

    if (e.kind === 'category') {
      if (!e.category || !isProjectCategory(e.category)) {
        issues.push({
          kind: 'category-mismatch',
          severity: 'blocking',
          message: `kind=category 但 category 字段非枚举：${String(e.category)}`,
          path: e.path,
          expected: REQUIRED_CATEGORIES.join('|'),
          actual: String(e.category),
        })
      } else {
        const expectedName = `${e.category}.md`
        if (basename(e.path) !== expectedName) {
          issues.push({
            kind: 'category-mismatch',
            severity: 'blocking',
            message: `kind=category 路径必须为 ${expectedName}（实际：${e.path}）`,
            path: e.path,
            expected: expectedName,
            actual: e.path,
          })
        }
      }
    }
  }

  // 依赖图 path safety
  for (const d of manifest.dependencies ?? []) {
    if (typeof d.to !== 'string') continue
    const pathIssue = validatePathSafety(d.to, baseDir)
    if (pathIssue) {
      issues.push({
        kind: pathIssue.kind,
        severity: 'blocking',
        message: `依赖目标路径不安全：${pathIssue.message}`,
        path: d.to,
      })
    }
  }

  // required 条目数最低门槛（防空清单让 bundleSha256 重算巧合通过）
  const requiredCount = [...templates, ...shared].filter((e) => e.required).length
  if (requiredCount < MIN_REQUIRED_ENTRIES) {
    issues.push({
      kind: 'manifest-unparseable',
      severity: 'blocking',
      message: `required 条目数 ${requiredCount} 低于最低门槛 ${MIN_REQUIRED_ENTRIES}（六品类 + 五共享都需 required=true）`,
      path: MANIFEST_FILENAME,
      expected: String(MIN_REQUIRED_ENTRIES),
      actual: String(requiredCount),
    })
  }

  return issues
}

// ===== Manifest 加载 =====

/**
 * 从资源目录加载 manifest.json。失败返回 null（与 verify 不混：load 只 IO 不判断合规性）。
 *
 * 注意：strict schema 校验（validateManifestSchema）在 verify 阶段执行，load 阶段只
 * 做基本字段检查（防 JSON.parse 崩溃）。这样测试可以构造"故意违规"的 manifest 测试
 * verify 行为而不会在 load 阶段被拦截。
 */
export function loadManifest(baseDir: string): EngineeringTemplatesManifest | null {
  const manifestPath = join(baseDir, MANIFEST_FILENAME)
  if (!existsSync(manifestPath)) return null
  try {
    const raw = readFileSync(manifestPath, 'utf-8')
    const parsed = JSON.parse(raw) as EngineeringTemplatesManifest
    // 最小结构校验：必备字段缺一即视为不可解析（上层 issue 区分）
    if (
      typeof parsed.bundleVersion !== 'string' ||
      !Array.isArray(parsed.templates) ||
      !Array.isArray(parsed.sharedFiles)
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

// ===== 校验：核心 =====

/**
 * 校验 manifest 与磁盘文件的一致性；返回结构化诊断。
 *
 * 校验内容：
 * 0. strict schema（必需品类/共享/路径安全/重复/最低 required 数）
 * 1. manifest 自描述的 bundleSha256 与按 required 条目重算结果是否一致（防止 manifest 改写但文件未同步）
 * 2. 每个 entry.path 物理存在（required 缺失 = blocking；非 required 缺失 = warning）
 * 3. 每个 entry.path 实际 sha256 与 manifest 声明一致（required 不一致 = blocking）
 * 4. 每个 entry.size 与 statSync 结果一致（额外多维校验，避免哈希碰撞型篡改）
 * 5. 每个 entry.category 在 6 品类枚举内（防止 manifest 错填品类）
 * 6. 每个 dependency.to 在磁盘存在（required 缺失 = blocking；非 required 缺失 = warning）
 * 7. kind=category 的条目 path 必须以 `${category}.md` 命名（防止 manifest 与文件不一一对应）
 */
export function verifyEngineeringResources(
  baseDir: string,
  manifest: EngineeringTemplatesManifest | null,
): EngineeringResourceVerifyResult {
  const issues: EngineeringResourceIssue[] = []
  const baseDirExists = existsSync(baseDir)

  // —— 阶段 1：manifest 缺失/不可解析 → 单独 issue，verify 不阻塞到「全无」但 baseDir 不存在即视为 blocking
  if (!manifest) {
    if (!baseDirExists) {
      issues.push({
        kind: 'manifest-missing',
        severity: 'blocking',
        message: `资源目录不存在：${baseDir}（manifest.json 与品类模板均无法验证）`,
        path: baseDir,
      })
    } else {
      issues.push({
        kind: 'manifest-missing',
        severity: 'blocking',
        message: `manifest.json 缺失：${join(baseDir, MANIFEST_FILENAME)}（v0.17.131+task4 起资源完整性依赖 manifest；缺失则视为未分发资源，禁止宣称部署成功）`,
        path: MANIFEST_FILENAME,
      })
    }
    return {
      ok: false,
      baseDir,
      baseDirExists,
      manifestFound: false,
      bundleVersion: null,
      bundleSha256: null,
      requiredCount: 0,
      computedBundleSha256: '',
      issues,
      diagnostics: issues.map((i) => i.message),
    }
  }

  // —— 阶段 2：baseDir 物理存在校验
  if (!baseDirExists) {
    issues.push({
      kind: 'file-missing',
      severity: 'blocking',
      message: `资源目录不存在：${baseDir}（manifest 已声明但目录不可访问）`,
      path: baseDir,
    })
  }

  // —— 阶段 3：strict schema 校验（先于文件存在性，避免 schema 错时静默放过）
  issues.push(...validateManifestSchema(manifest, baseDir))

  // —— 阶段 4：合并模板与共享文件为统一条目表
  const allEntries: EngineeringResourceEntry[] = [...manifest.templates, ...manifest.sharedFiles]
  const requiredCount = allEntries.filter((e) => e.required).length

  // —— 阶段 5：每条目逐项校验
  for (const entry of allEntries) {
    const abs = join(baseDir, entry.path)
    if (!existsSync(abs)) {
      issues.push({
        kind: 'file-missing',
        severity: entry.required ? 'blocking' : 'warning',
        message: `${entry.required ? '必需' : '可选'}资源缺失：${entry.path}${entry.required ? '（manifest 声明 required=true）' : '（manifest 声明 required=false，仅警告）'}`,
        path: entry.path,
      })
      continue
    }
    const stat = statSync(abs)
    if (stat.size !== entry.size) {
      issues.push({
        kind: 'size-mismatch',
        severity: entry.required ? 'blocking' : 'warning',
        message: `文件大小不一致：${entry.path}（manifest=${entry.size}B，实际=${stat.size}B）`,
        path: entry.path,
        expected: String(entry.size),
        actual: String(stat.size),
      })
    }
    const actualSha = computeFileSha256(abs)
    if (actualSha !== entry.sha256) {
      issues.push({
        kind: 'hash-mismatch',
        severity: entry.required ? 'blocking' : 'warning',
        message: `SHA256 不一致：${entry.path}（manifest=${entry.sha256.slice(0, 16)}…，实际=${actualSha ? actualSha.slice(0, 16) + '…' : '<unreadable>'}）`,
        path: entry.path,
        expected: entry.sha256,
        actual: actualSha ?? '<unreadable>',
      })
    }
  }

  // —— 阶段 6：依赖图校验
  for (const dep of manifest.dependencies) {
    const targetAbs = join(baseDir, dep.to)
    if (!existsSync(targetAbs)) {
      issues.push({
        kind: 'dependency-missing',
        severity: dep.required ? 'blocking' : 'warning',
        message: `${dep.required ? '必需' : '可选'}依赖缺失：${dep.from} → ${dep.to}（${dep.kind}${dep.anchor ? ` @ ${dep.anchor}` : ''}）`,
        path: dep.to,
        expected: dep.from,
      })
    }
  }

  // —— 阶段 7：bundleSha256 重算对照（包含最低门槛：空清单不能巧合通过）
  const computedBundle = computeBundleSha256(allEntries)
  if (requiredCount < MIN_REQUIRED_ENTRIES) {
    // required 数不足时即便 bundleSha256 匹配也视为 blocking（防"空清单巧合通过"）
    issues.push({
      kind: 'manifest-unparseable',
      severity: 'blocking',
      message: `required 条目数 ${requiredCount} 低于最低门槛 ${MIN_REQUIRED_ENTRIES}，禁止以空清单让 bundleSha256 巧合通过`,
      path: MANIFEST_FILENAME,
      expected: String(MIN_REQUIRED_ENTRIES),
      actual: String(requiredCount),
    })
  } else if (computedBundle !== manifest.bundleSha256) {
    issues.push({
      kind: 'hash-mismatch',
      severity: 'blocking',
      message: `bundleSha256 与重算结果不一致（manifest 自描述 ${manifest.bundleSha256.slice(0, 16)}… vs 重算 ${computedBundle.slice(0, 16)}…；manifest 可能未随文件同步刷新）`,
      path: MANIFEST_FILENAME,
      expected: manifest.bundleSha256,
      actual: computedBundle,
    })
  }

  const blockingIssues = issues.filter((i) => i.severity === 'blocking')
  return {
    ok: blockingIssues.length === 0 && baseDirExists,
    baseDir,
    baseDirExists,
    manifestFound: true,
    bundleVersion: manifest.bundleVersion,
    bundleSha256: manifest.bundleSha256,
    requiredCount,
    computedBundleSha256: computedBundle,
    issues,
    diagnostics: issues.map((i) => `[${i.severity}] ${i.message}`),
  }
}

// ===== 一站式加载 =====

/**
 * 一站式加载：resolve 资源目录 → 读 manifest → 校验 → 返回结果。
 *
 * 失败时 manifest=null，但 verify.issues 仍给出结构化诊断（不静默）。
 * 调用方不得仅依据 load().verify.ok 判定部署成功——必须把 verify.issues 一并上报。
 */
export function loadEngineeringResources(explicitBase?: string): EngineeringResourceLoadResult {
  const { baseDir } = resolveAuthoritativeResourcesPath({ explicitBase })
  const manifest = loadManifest(baseDir)
  const verify = verifyEngineeringResources(baseDir, manifest)
  const entries = manifest ? [...manifest.templates, ...manifest.sharedFiles] : []
  const requiredPaths = entries.filter((e) => e.required).map((e) => e.path)
  const byCategory: Partial<Record<ProjectCategory, EngineeringResourceEntry>> = {}
  for (const e of entries) {
    if (e.kind === 'category' && e.category && isProjectCategory(e.category)) {
      byCategory[e.category] = e
    }
  }
  return { baseDir, manifest, verify, entries, requiredPaths, byCategory }
}

/**
 * 仅校验入口（不解构 manifest 全部字段，给 verify 脚本和 pack 后验证复用）。
 */
export function verifyEngineeringResourcesAt(explicitBase?: string): EngineeringResourceVerifyResult {
  const { baseDir } = resolveAuthoritativeResourcesPath({ explicitBase })
  const manifest = loadManifest(baseDir)
  return verifyEngineeringResources(baseDir, manifest)
}

// ===== Manifest 构造工具（供父集成刷新哈希 / 工具脚本生成使用） =====

/**
 * 从已校验过的工程模板目录构造 EngineeringTemplatesManifest。
 *
 * 设计意图：
 * - 不修改既有模板正文，仅扫描文件并提取元数据；
 * - 复用 extractTemplateVersion 从章节头解析版本号；
 * - 整包指纹（bundleSha256）按 required 条目自动重算；
 * - 父集成阶段对 owner=parent-refresh 的条目允许覆盖 sha256（共享脚本更新后
 *   在父集成脚本里一次性刷新 manifest）。
 *
 * 参数：
 * - baseDir：资源目录绝对路径
 * - opts.bundleVersion：必填，整包语义版本
 * - opts.platformVersion：可选，关联的平台版本（Task 4 修订：建议标注 "task4-pending"，待父集成 bump）
 * - opts.dependencies：可选，由调用方声明依赖图（默认提供 6 品类 → 骨架双文件 + Spike 协议 + desktop → check_env.sh 的标准映射）
 * - opts.overrideSha256：可选，按 path 覆盖 sha256（父集成刷新共享文件用）
 */
export interface BuildManifestOptions {
  bundleVersion: string
  platformVersion?: string
  dependencies?: EngineeringResourceDependency[]
  /** 按 path 覆盖 sha256（父集成刷新 owner=parent-refresh 条目用） */
  overrideSha256?: Record<string, string>
  /** 生成器标识（默认本模块名） */
  generator?: string
}

const PROJECT_CATEGORIES_LIST: ProjectCategory[] = [
  'web-fullstack', 'api-backend', 'mobile-app', 'desktop-app', 'cli-tool', 'ai-application',
]

/** 默认依赖图：6 品类 → 骨架双文件 + Spike 协议 + desktop 唯一额外引用 check_env.sh */
export function buildDefaultDependencies(): EngineeringResourceDependency[] {
  const deps: EngineeringResourceDependency[] = []
  for (const c of PROJECT_CATEGORIES_LIST) {
    deps.push({ from: `${c}.md`, to: 'driver-skeleton.py', kind: 'file-reference', required: true })
    deps.push({ from: `${c}.md`, to: 'driver-skeleton.cjs', kind: 'file-reference', required: true })
    deps.push({ from: `${c}.md`, to: '02-Spike实验协议.md', kind: 'section-reference', anchor: '§6', required: true })
  }
  // desktop-app 额外显式引用 check_env.sh（实测 §2.3/§5/§7 三处）
  deps.push({ from: 'desktop-app.md', to: 'check_env.sh', kind: 'script-reference', anchor: '§2.3', required: true })
  return deps
}

/**
 * 从章节头解析版本号。
 *
 * 优先解析元信息行 `> 版本：vX.Y | 代号：...`（各品类模板统一约定）；
 * 缺该行时回退 H1 中的 `vX.Y` 标记（适用于 Spike 协议等非品类模板）。
 *
 * 返回形态：'v2.4' / 'v2.0' / 'v2.3' / 'v1.0' 等。无版本标记返回 null。
 */
export function extractTemplateVersion(content: string): string | null {
  // 1. 元信息行 `> 版本：v2.4` （权威）
  const meta = /^>\s*版本[：:]\s*(v\d+(?:\.\d+){0,2})\b/m.exec(content)
  if (meta?.[1]) return meta[1]
  // 2. H1 中的 `v2.4`（兼容 Spike 协议）
  const title = /#[^\n]*?\b(v\d+(?:\.\d+){0,2})\b/.exec(content)
  return title?.[1] ?? null
}

/**
 * 构造 manifest（在资源目录运行时一次性生成；父集成阶段用其结果写回 manifest.json）。
 *
 * 行为：
 * 1. 扫描 baseDir 下固定文件名清单（6 品类 + 5 共享文件 + manifest 自描述）
 * 2. 对每个文件计算 sha256/size，从品类正文提取 version
 * 3. 应用 opts.overrideSha256（仅覆盖 sha256 字段；size 不变）
 * 4. 生成整包 bundleSha256
 * 5. 返回完整 manifest 对象（调用方负责写盘）
 */
export function buildManifest(baseDir: string, opts: BuildManifestOptions): EngineeringTemplatesManifest {
  const templates: EngineeringResourceEntry[] = []
  const sharedFiles: EngineeringResourceEntry[] = []

  // 6 个品类模板
  for (const c of PROJECT_CATEGORIES_LIST) {
    const rel = `${c}.md`
    const abs = join(baseDir, rel)
    if (!existsSync(abs)) continue
    const buf = readFileSync(abs)
    const sha256 = opts.overrideSha256?.[rel] ?? createHash('sha256').update(buf).digest('hex')
    const version = extractTemplateVersion(buf.toString('utf-8')) ?? undefined
    templates.push({
      path: rel,
      kind: 'category',
      category: c,
      version,
      required: true,
      owner: 'templates',
      sha256,
      size: buf.length,
    })
  }

  // 6 个共享文件：协议 / README / CHANGELOG / check_env.sh / driver-skeleton.{py,cjs}
  const shared: Array<{ path: string; kind: EngineeringResourceEntry['kind']; owner: EngineeringResourceEntry['owner'] }> = [
    { path: '02-Spike实验协议.md', kind: 'shared-protocol', owner: 'templates' },
    { path: 'README.md', kind: 'shared-readme', owner: 'templates' },
    { path: 'CHANGELOG.md', kind: 'shared-changelog', owner: 'templates' },
    { path: 'check_env.sh', kind: 'shared-script', owner: 'parent-refresh' },
    { path: 'driver-skeleton.py', kind: 'shared-driver', owner: 'parent-refresh' },
    { path: 'driver-skeleton.cjs', kind: 'shared-driver', owner: 'parent-refresh' },
  ]
  for (const s of shared) {
    const abs = join(baseDir, s.path)
    if (!existsSync(abs)) continue
    const buf = readFileSync(abs)
    const sha256 = opts.overrideSha256?.[s.path] ?? createHash('sha256').update(buf).digest('hex')
    // 仅 markdown 共享文件提取 version；脚本/骨架不是 markdown，无版本头
    const isMarkdown = s.path.endsWith('.md')
    const version = isMarkdown ? extractTemplateVersion(buf.toString('utf-8')) ?? undefined : undefined
    sharedFiles.push({
      path: s.path,
      kind: s.kind,
      required: true,
      owner: s.owner,
      sha256,
      size: buf.length,
      version,
    })
  }

  // manifest 自描述（bundleSha256 在所有条目构造完成后计算）
  const dependencies = opts.dependencies ?? buildDefaultDependencies()
  const tempManifest: EngineeringTemplatesManifest = {
    $schema: 'https://proma.cool/schemas/engineering-templates-manifest-v1.json',
    manifestVersion: '1.0.0',
    bundleVersion: opts.bundleVersion,
    bundleId: 'nanju-engineering-templates',
    generatedAt: new Date().toISOString(),
    generator: opts.generator ?? 'nanju-engineering-resources.buildManifest',
    platformVersion: opts.platformVersion,
    templates,
    sharedFiles,
    dependencies,
    bundleSha256: '', // 占位，下面重算
  }
  tempManifest.bundleSha256 = computeBundleSha256([...templates, ...sharedFiles])
  return tempManifest
}

// ===== 便捷：解构按品类取条目 =====

/**
 * 取品类模板的绝对路径（仅当 verify 通过时安全返回；verify 失败返回 null）。
 * 用于既有 nanju-engineering-template.ts 的 materialize 链路（保留兼容：返回路径
 * 字符串而非条目，使旧调用方不变）。
 */
export function resolveCategoryTemplatePath(category: ProjectCategory, explicitBase?: string): string | null {
  const { manifest, verify } = loadEngineeringResources(explicitBase)
  if (!manifest || !verify.ok) return null
  const entry = manifest.templates.find((e) => e.kind === 'category' && e.category === category)
  if (!entry) return null
  return join(verify.baseDir, entry.path)
}
