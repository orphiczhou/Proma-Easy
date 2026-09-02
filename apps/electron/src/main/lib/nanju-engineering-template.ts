/**
 * 南大向导 — 工程样板模板（W3，v0.17.66：coding 阶段工程样板前置）
 *
 * 实证问题：全栈开发做「输入法」（本地桌面程序）时误套 UX 阶段的 HTML 原型框架——
 * coding 阶段不知道项目形态。本模块建立品类基础设施：
 *
 * 1. 品类判定：从 architecture.md（终判）> prd.md（初判）提取 `projectCategory: xxx`
 *    标记（值必须在 6 品类枚举内；多次出现取最后一次）；都无法判定 → 降级 web-fullstack。
 * 2. 模板落位：推进到 coding 时把对应品类模板全文从 resources 复制到项目目录
 *    00_ENGINEERING_TEMPLATE/template.md（L2 确定可读的路径）。
 * 3. 注入构建：coding 委派任务中注入「工程品类」节——品类声明 + 精简工程要点内联
 *    + 模板全文路径引用 + 与 GWT 验收锚点的对齐说明（08_APP/index.html 浏览器载体不变）。
 *
 * 设计取舍（token 预算）：
 * - 内联仅精简要点（每品类 ~40 行，约 1-1.5K tokens），指令密度不稀释；
 * - 模板全文（5-19KB）按需 Read（L2 自主取舍），与「前序产出文件请先 Read」同一模式。
 *
 * 资源路径：开发模式 process.cwd()/apps/electron/resources；打包后 process.resourcesPath
 * （electron-builder extraResources，与 nanju-roles 同模式）。测试可注入显式目录。
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isProjectCategory,
  getNanjuProjectDir,
  type ProjectCategory,
  type ProjectCategorySource,
} from './nanju-project'

// ===== 品类元数据（注入用精简要点；全文见 resources/nanju-engineering-templates/） =====

export interface CategoryMeta {
  /** 中文标签 */
  label: string
  /** 定位一句话（注入节开头，纠正项目形态认知——实证问题的直接对策） */
  oneLiner: string
  /** 技术栈基线（要点行） */
  stack: string[]
  /** 目录结构骨架（要点行） */
  structure: string[]
  /** 品类关键工程模式（要点行） */
  patterns: string[]
  /** 反模式警示（要点行） */
  antiPatterns: string[]
  /** 08_APP/index.html 验收载体的品类化角色定义（与 GWT/预览锚点对齐） */
  carrierRole: string[]
}

export const CATEGORY_META: Record<ProjectCategory, CategoryMeta> = {
  'web-fullstack': {
    label: 'Web 全栈应用',
    oneLiner: '浏览器访问的 Web 应用（前端 UI + 可选后端/数据），不是本地程序或命令行工具',
    stack: [
      '零构建载体：纯 HTML/CSS/原生 JS（管线约束），单页多面板组织',
      '长期演进锚点：Next.js App Router + TypeScript + Tailwind + Drizzle + tRPC（见模板全文）',
    ],
    structure: [
      '08_APP/：index.html 入口 + assets/ 资源 + js/ 模块（按 feature 分文件，不写单文件巨石）',
      '状态与数据：stores/（状态）+ services/（数据访问），localStorage 键名加项目前缀',
    ],
    patterns: [
      '组件与逻辑分离：UI 渲染层薄，业务逻辑集中在可独立测试的模块',
      '环境差异：file:// 打开时无服务端，一切持久化走本地存储',
    ],
    antiPatterns: [
      '把整个应用写进一个 script 标签（>1000 行巨石）',
      '假设有 Node/服务器环境（fetch 本地 json、require 等）',
    ],
    carrierRole: [
      '08_APP/index.html 就是应用本体：全部用户故事在此实现，预览/点选纠错/GWT 验收都指向它',
    ],
  },
  'api-backend': {
    label: 'API 后端服务',
    oneLiner: '为 Web/Mobile/第三方客户端提供接口的后端服务，核心资产是 API 与数据层，不是页面',
    stack: [
      '长期演进锚点：Hono（TS）或 FastAPI（Python）+ PostgreSQL + Drizzle/SQLAlchemy + Zod/Pydantic',
      '统一契约：OpenAPI 文档自动生成；统一响应格式（data/meta/error + 错误码前缀）',
    ],
    structure: [
      '08_APP/server/：modules/<feature>/{routes,service,schema} 三件套 + middleware/（认证/限流/错误）',
      '08_APP/index.html：API 演控台载体（见下）',
    ],
    patterns: [
      'feature-based 模块划分：每个业务域自带 routes/service/schema，禁止全局散落',
      '输入一律 schema 验证后进入 service；错误集中 error-handler 统一格式化',
    ],
    antiPatterns: [
      '把业务逻辑写在路由层（路由只做解析与转发）',
      '无错误码体系的裸 throw；无验证直接透传用户输入',
    ],
    carrierRole: [
      '08_APP/index.html = API 演控台（浏览器可打开）：端点清单 + 每个端点的参数/响应演示（用内置模拟数据）',
      '演控台承担用户故事的验收演示；真实服务代码在 08_APP/server/ 按上述结构组织（可运行性由演控台模拟层展示）',
    ],
  },
  'mobile-app': {
    label: '移动应用',
    oneLiner: 'iOS/Android 移动应用（原生能力：相机/GPS/推送），不是响应式网页',
    stack: [
      '长期演进锚点：React Native + Expo（Expo Router 文件路由）+ NativeWind + Zustand + TanStack Query',
      '存储：MMKV（KV）+ expo-sqlite（关系）；不是 localStorage',
    ],
    structure: [
      '08_APP/app/：Expo Router 文件路由（(tabs)/ 分组 + [id].tsx 动态路由）',
      '08_APP/src/：components/ + hooks/ + stores/ + services/ + types/；08_APP/index.html 为验收载体（见下）',
    ],
    patterns: [
      '移动交互范式：底部 Tab 导航、原生手势、安全区适配（safe-area）',
      '离线优先：本地存储先行，网络层可失败可重试',
    ],
    antiPatterns: [
      '桌面网页布局直接缩小（悬停依赖、小点击区、密集表格）',
      '移动特性（手势/键盘避让/深链）完全缺席',
    ],
    carrierRole: [
      '08_APP/index.html = 移动视口 UI 实现：以手机尺寸视口（如 390x844 框）呈现应用界面与交互',
      '原生能力（相机/推送等）以清晰标注的模拟层呈现；RN/Expo 工程骨架按上述结构生成并存',
    ],
  },
  'desktop-app': {
    label: '桌面应用',
    oneLiner: '本地桌面程序（Windows/macOS/Linux），不是网站——不存在「部署上线」，运行在用户本机，有系统层能力',
    stack: [
      '长期演进锚点：Tauri v2 + React + TypeScript（Vite + Tailwind + Zustand）；无 Rust 经验或重 Node 原生模块时备选 Electron',
      '两层架构：UI 层（Web 技术，可浏览器渲染）+ 系统层（Rust/Node：文件/窗口/托盘/快捷键/输入法 hook 等，经 IPC 命令暴露）',
    ],
    structure: [
      '08_APP/src/：UI 层（components/layouts/features + stores + hooks，与 Web 前端同构）',
      '08_APP/src-tauri/（或 electron/）：系统层骨架——commands/（IPC 命令清单与签名）、配置、权限声明（按模板组织）',
      '08_APP/index.html：主窗口 UI 验收载体（见下）',
    ],
    patterns: [
      'IPC 边界：系统调用全部收敛到 commands 层（明确清单），UI 不直接触系统 API——载体与真实壳共用同一命令接口（载体中 mock 实现）',
      '桌面惯例：自定义标题栏（macOS traffic lights 间距）、多窗口（主/设置/关于）、系统托盘、开机自启、自动更新',
      '安全：CSP 收紧、禁 eval、capabilities 按需授权（见模板 §4）',
    ],
    antiPatterns: [
      '把整个程序当网页做：无系统层概念、依赖浏览器能力、假设 http 部署',
      '系统调用散落在 UI 代码里（无法替换壳、无法测试）',
      '忽略离线/本地数据边界（桌面程序的数据在本机，不走云端）',
    ],
    carrierRole: [
      '08_APP/index.html = 主窗口/设置界面的同构实现（零构建，浏览器直接打开）：桌面 UI 全部用户故事在此实现',
      '系统层能力（托盘/全局快捷键/IME hook/文件访问等）在载体中以「模拟层」呈现（界面可见、标注为系统层 mock，经 commands 接口调用）',
      '真实桌面工程骨架（src-tauri/ 或 electron/）按模板结构生成并存于 08_APP/，commands 签名与载体 mock 一致——后续接入真实壳时 UI 层零改动',
    ],
  },
  'cli-tool': {
    label: 'CLI 工具',
    oneLiner: '命令行工具（终端运行、参数驱动），不是图形界面应用',
    stack: [
      '长期演进锚点：citty（unjs，声明式命令定义）+ unbuild + Vitest；或 Python/Go 按模板备选',
      '输出规范：chalk 颜色 + ora 进度 + 结构化退出码（0 成功/非 0 失败）',
    ],
    structure: [
      '08_APP/src/：index.ts 入口（命令树）+ commands/（子命令）+ lib/（可独立测试的核心逻辑）+ utils/',
      '08_APP/index.html：命令演控台载体（见下）',
    ],
    patterns: [
      '命令薄、逻辑厚：commands/ 只做参数解析与输出编排，核心逻辑在 lib/ 可单测',
      '交互提示用 @inquirer/prompts；错误信息给人看（下一步建议）也给机器看（退出码）',
    ],
    antiPatterns: [
      '把所有逻辑写进入口文件',
      '无 --help 的命令；吞错误不输出',
    ],
    carrierRole: [
      '08_APP/index.html = 命令演控台（浏览器可打开）：命令清单 + 参数说明 + 模拟执行演示（输入参数 → 展示输出）',
      '用户故事的验收演示在演控台完成；真实 CLI 代码在 08_APP/src/ 按上述结构组织',
    ],
  },
  'ai-application': {
    label: 'AI 应用',
    oneLiner: '以 LLM 调用为核心逻辑的应用（聊天/生成/RAG/Agent），LLM 是主功能而非点缀',
    stack: [
      '长期演进锚点：Vercel AI SDK（streamText/useChat）+ pgvector 或 LibSQL + Drizzle',
      'Prompt 管理：独立文件（.prompt/.md）+ {{placeholder}} 变量，Git 可追踪，不硬编码在代码里',
    ],
    structure: [
      '08_APP/：index.html 入口 + prompts/（prompt 模板文件）+ js/（对话状态/流式渲染/护栏逻辑）',
      '载体中 LLM 调用以本地模拟引擎呈现（见下），真实接入点集中在一个 provider 模块',
    ],
    patterns: [
      '流式输出：逐 token 渲染 + 思考中指示；会话历史持久化（本地存储）',
      '护栏双端：输入（长度/注入检测）+ 输出（格式校验/敏感信息）',
      '成本意识：每次调用记录 token 用量（模拟层也要展示用量概念）',
    ],
    antiPatterns: [
      '在客户端/UI 层硬编码 API key',
      'prompt 散落在代码字符串里；LLM 原始输出不经处理直接展示',
      '无长度/频率限制直接透传用户输入',
    ],
    carrierRole: [
      '08_APP/index.html = 应用本体（AI 应用天然是 Web 形态）：聊天/生成界面全部用户故事在此实现',
      'LLM 调用在载体中由「模拟引擎」承担（规则/模板生成，界面标注为演示模型），真实 provider 接入点预留为独立模块',
    ],
  },
}

/** 品类标记提取正则：`projectCategory: desktop-app`（反引号/引号包裹均可；值限枚举防误提取） */
const CATEGORY_MARKER_RE = /projectCategory\s*[:：]\s*[`"']?(web-fullstack|api-backend|mobile-app|desktop-app|cli-tool|ai-application)[`"']?/gi

/**
 * 从文档内容提取品类标记（纯函数）。
 * 多次出现取最后一次（文档修订/附录覆盖正文的语义）。无有效标记返回 null。
 */
export function extractProjectCategoryFromDoc(content: string): ProjectCategory | null {
  const matches = [...content.matchAll(CATEGORY_MARKER_RE)]
  const last = matches[matches.length - 1]?.[1]
  if (!last) return null
  // 正则带 i 修饰（大小写不敏感匹配），归一为小写后再入枚举校验（DESKTOP-APP → desktop-app）
  const normalized = last.toLowerCase()
  if (!isProjectCategory(normalized)) return null
  return normalized
}

/**
 * 解析 coding 推进时的品类判定（读项目目录文档，不写状态）。
 * 优先级：architecture.md（iterative 终判）> prd.md（quick 初判）。
 * 返回 null 表示两处均无有效标记（调用方降级 web-fullstack）。
 */
export function resolveProjectCategoryForCoding(
  workspaceSlug: string,
  projectId: string,
): { category: ProjectCategory; source: ProjectCategorySource } | null {
  const projectDir = getNanjuProjectDir(workspaceSlug, projectId)
  const candidates: Array<{ path: string; source: ProjectCategorySource }> = [
    { path: join(projectDir, '03_ARCHITECTURE', 'architecture.md'), source: 'architecture' },
    { path: join(projectDir, '01_PRD', 'prd.md'), source: 'prd' },
  ]
  for (const c of candidates) {
    try {
      if (!existsSync(c.path)) continue
      const category = extractProjectCategoryFromDoc(readFileSync(c.path, 'utf-8'))
      if (category) return { category, source: c.source }
    } catch {
      // 读取失败视为无标记，继续下一候选
    }
  }
  return null
}

// ===== 模板资源解析与落位 =====

/**
 * 解析模板资源目录。候选依次探测（首个存在者胜）：
 * 1. 打包后 process.resourcesPath（electron-builder extraResources 落点）
 * 2. process.cwd()/apps/electron/resources（仓库根跑测试/脚本）
 * 3. process.cwd()/resources（dev:electron，cwd=apps/electron）
 * 全部不存在时返回候选 2（调用方 materialize 会 existsSync 降级为 null）。
 * 测试注入 explicitBase 时直接使用。
 */
export function resolveEngineeringTemplatesDir(explicitBase?: string): string {
  if (explicitBase) return join(explicitBase, 'nanju-engineering-templates')
  const bases: string[] = []
  // Electron 主进程检测用 process.versions.electron（无副作用）：bun/node 测试环境下
  // require('electron') 会触发包 wrapper 的二进制下载副作用，禁止在模块加载路径引入
  if (typeof process.versions.electron === 'string' && (process as { type?: string }).type === 'browser') {
    bases.push(process.resourcesPath as string)
  }
  bases.push(join(process.cwd(), 'apps', 'electron', 'resources'))
  bases.push(join(process.cwd(), 'resources'))
  for (const base of bases) {
    if (existsSync(join(base, 'nanju-engineering-templates'))) {
      return join(base, 'nanju-engineering-templates')
    }
  }
  return join(bases[0]!, 'nanju-engineering-templates')
}

/** 项目内模板落位目录（00_ENGINEERING_TEMPLATE/，L2 可读） */
export function getProjectTemplateDir(workspaceSlug: string, projectId: string): string {
  return join(getNanjuProjectDir(workspaceSlug, projectId), '00_ENGINEERING_TEMPLATE')
}

/**
 * 把品类模板全文复制到项目目录 00_ENGINEERING_TEMPLATE/template.md。
 * 资源缺失/复制失败返回 null（降级：注入节退化为仅精简要点，不阻断 coding）。
 */
export function materializeEngineeringTemplate(
  workspaceSlug: string,
  projectId: string,
  category: ProjectCategory,
  explicitBase?: string,
): string | null {
  try {
    const src = join(resolveEngineeringTemplatesDir(explicitBase), `${category}.md`)
    if (!existsSync(src)) return null
    const destDir = getProjectTemplateDir(workspaceSlug, projectId)
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const dest = join(destDir, 'template.md')
    copyFileSync(src, dest)
    return dest
  } catch {
    return null
  }
}

// ===== coding 委派任务注入节 =====

export interface CategoryGuideInput {
  category: ProjectCategory
  source: ProjectCategorySource
  /** 项目目录绝对路径（用于模板全文路径引用） */
  projectDir: string
  /** 模板全文是否已落位（materialize 成功时传目标路径；null 则注入节省略全文引用） */
  templatePath: string | null
}

/**
 * 构建「工程品类」注入节（coding 委派任务专用）。
 *
 * 与下游验收链路的契约（不可破坏）：预览/点选纠错/GWT 的锚点始终是
 * 08_APP/index.html（零构建浏览器载体）；品类差异只改变载体的角色定义与
 * 工程骨架的组织方式，不改变验收锚点本身。
 */
export function buildCategoryGuideLines(input: CategoryGuideInput): string[] {
  const meta = CATEGORY_META[input.category]
  const isDefault = input.source === 'default'
  const isWeb = input.category === 'web-fullstack'

  const lines: string[] = [
    '## 工程品类判定：' + input.category + '（' + meta.label + '）',
    '项目形态：' + meta.oneLiner + '。',
    '品类判定来源：' + (isDefault ? '未在前序文档中标注，按默认 Web 全栈应用处理' : input.source === 'architecture' ? '架构文档（architecture.md）标记' : 'PRD（prd.md）标记') + '。',
    '',
  ]

  // 降级自检（实证问题第二道防线）：默认判定与文档描述明显不符时，以文档为准
  if (isDefault) {
    lines.push(
      '【品类自检（必须执行）】本次判定是降级默认值。先快速核对 PRD/架构文档对项目形态的描述：',
      '若明确是本地桌面程序、移动应用、CLI、纯后端服务等非 Web 形态，按文档实际形态执行，',
      '并在交付说明中注明「品类标记缺失，已按文档描述执行」；同时把正确品类以',
      '`projectCategory: <品类>` 形式补记入架构文档（无架构文档则记入 PRD 末尾）。',
      '',
    )
  }

  lines.push('### 品类工程要点（源自工程模板；结构与选型按此组织）')
  for (const s of meta.stack) lines.push('- 技术栈：' + s)
  for (const s of meta.structure) lines.push('- 目录：' + s)
  for (const s of meta.patterns) lines.push('- 模式：' + s)
  for (const s of meta.antiPatterns) lines.push('- 反模式（禁止）：' + s)
  lines.push('')

  if (input.templatePath) {
    lines.push(
      '### 模板全文（按需精读）',
      '完整工程模板已复制到：' + input.templatePath,
      '包含目录结构逐文件注释、关键配置内容、代码示例与参考项目。生成工程骨架前建议 Read 一遍',
      '（Web 品类模板较长时至少读目录结构与测试策略两节）；细节拿不准时以模板为准。',
      '',
    )
  }

  lines.push('### 验收载体对齐（重要——决定产出怎么被验收）')
  for (const s of meta.carrierRole) lines.push('- ' + s)
  if (!isWeb) {
    lines.push(
      '- 无论品类：08_APP/index.html 必须零构建可直接浏览器打开（约束节另有要求），',
      '  所有可交互 UI 元素标注 data-ai-id/data-ai-type——预览、点选纠错与 GWT 验收测试都锚定在该文件；',
      '- 品类工程骨架（服务端/系统层/CLI 代码等）与载体并存于 08_APP/ 下，骨架代码服务于真实工程演进，',
      '  用户故事的验收演示以载体为准；模板中的测试骨架（Vitest/cargo test 等）作为长期工程参考，',
      '  管线内验收以 06_TESTS 的 GWT 场景（浏览器载体执行）为准。',
    )
  } else {
    lines.push(
      '- 所有可交互 UI 元素标注 data-ai-id/data-ai-type（约束节已有要求）——预览、点选纠错与 GWT 验收都锚定在该文件。',
    )
  }
  lines.push('')
  return lines
}

/** 上游标注要求（requirements / architecture 阶段 constraints 复用的格式说明） */
export const CATEGORY_MARKER_GUIDE =
  '工程品类标注（后续 coding 按品类加载工程模板）：文档中包含一行 `projectCategory: <品类>`，'
  + '品类限 web-fullstack / api-backend / mobile-app / desktop-app / cli-tool / ai-application 六选一'
  + '（本地桌面程序=desktop-app，纯后端服务=api-backend，命令行工具=cli-tool，移动应用=mobile-app，'
  + '以 LLM 为核心=ai-application，浏览器访问的网站/Web 应用=web-fullstack）'
