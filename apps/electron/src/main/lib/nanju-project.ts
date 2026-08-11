/**
 * 南大项目元数据管理
 *
 * 基于 Proma 的 safe-file.ts 原子写 + 文件系统存储，
 * 不引入数据库。项目元数据存储在工作区的 workspace-files/ 下。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { getWorkspaceFilesDir, getAgentWorkspacePath } from './config-paths'

// tree-engine 引擎接口（CJS require）
// eslint-disable-next-line @typescript-eslint/no-require-imports
const treeEngine = require('./tree-engine.cjs')

// ===== 类型 =====

export type ProjectMode = 'quick' | 'iterative'
export type ProjectStatus = 'active' | 'completed' | 'abandoned'
export type ProjectStage =
  | 'mode-select' | 'requirements' | 'prototype'
  | 'architecture' | 'planning' | 'coding' | 'testing' | 'delivered'

export interface NanjuProject {
  projectId: string
  name: string
  mode: ProjectMode
  status: ProjectStatus
  currentStage: ProjectStage
  createdAt: string
  updatedAt: string
  /** 关联的 Agent 会话 ID */
  sessionId?: string
  /** 工作区 slug */
  workspaceSlug: string
  /** 关联的 tree-engine tree_id */
  treeId?: string
}

// ===== 路径 =====

function getMetaPath(workspaceSlug: string): string {
  return join(getWorkspaceFilesDir(workspaceSlug), '_nanju-projects.json')
}

// ===== Tree Engine 初始化 =====

/**
 * 为南大项目初始化 tree-engine 树。
 * 创建 .context/trees/ 目录 + root 叶节点 + 各阶段里程碑。
 */
function initProjectTree(
  workspaceSlug: string,
  projectId: string,
  projectName: string,
  mode: ProjectMode,
  sessionId?: string,
): string {
  const treeId = `nanju-${projectId}`
  const wsRoot = getAgentWorkspacePath(workspaceSlug)
  const treesDir = join(wsRoot, 'workspace-files', '.context', 'trees')
  mkdirSync(treesDir, { recursive: true })

  try {
    // 初始化 root 叶节点
    treeEngine.run('init', [
      treeId,
      '--root-brief', JSON.stringify({
        project: projectName,
        mode,
        goal: '南大向导双脑协作平台 — 调度员按角色序列推进项目',
      }),
      '--root-dod', JSON.stringify({
        deliverables: [
          '01_PRD/prd.md',
          '02_UX_DESIGN/prototype.html',
          '03_ARCHITECTURE/architecture.md',
          '05_PROJECT_PLAN/plan.md',
        ],
      }),
      ...(sessionId ? ['--session-id', sessionId] : []),
    ], treesDir, sessionId)

    // 添加里程碑：每个阶段一个
    const milestones = mode === 'quick'
      ? [
          { id: 'm-requirements', desc: '需求分析完成', expect_outputs: ['01_PRD/prd.md'] },
          { id: 'm-prototype', desc: 'UX原型确认', expect_outputs: ['02_UX_DESIGN/prototype.html'] },
          { id: 'm-delivered', desc: '快消交付完成', expect_outputs: ['产品原型交付'] },
        ]
      : [
          { id: 'm-requirements', desc: '需求分析完成', expect_outputs: ['01_PRD/prd.md'] },
          { id: 'm-prototype', desc: 'UX原型确认', expect_outputs: ['02_UX_DESIGN/prototype.html'] },
          { id: 'm-architecture', desc: '架构设计确认', expect_outputs: ['03_ARCHITECTURE/architecture.md'] },
          { id: 'm-planning', desc: '工程计划确认', expect_outputs: ['05_PROJECT_PLAN/plan.md'] },
          { id: 'm-coding', desc: '编码实现完成', expect_outputs: ['项目代码交付'] },
        ]

    const rootLeafId = `${treeId}-root`
    for (const ms of milestones) {
      treeEngine.run('milestone', [
        'add', treeId, rootLeafId,
        '--json', JSON.stringify(ms),
      ], treesDir, sessionId)
    }

    console.log(`[南大向导] tree 已初始化: ${treeId} (${milestones.length} 个里程碑)`)
    return treeId
  } catch (err) {
    console.error(`[南大向导] tree 初始化失败:`, err)
    return treeId // 即使失败也返回 treeId，Agent 可手动 tree_init
  }
}

// ===== 公开接口 =====

/** 获取所有南大项目 */
export function listNanjuProjects(workspaceSlug: string): NanjuProject[] {
  const meta = (readJsonFileSafe<NanjuProject[]>(getMetaPath(workspaceSlug)) ?? [])
  return meta ?? []
}

/** 创建南大项目 */
export function createNanjuProject(input: {
  name: string
  mode: ProjectMode
  workspaceSlug: string
  sessionId?: string
}): NanjuProject {
  const now = new Date().toISOString()
  // 使用项目名生成 slug：project-{slugified-name}
  const slugBase = input.name
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'untitled'
  const projectId = slugBase

  // 避免重名
  const existing = listNanjuProjects(input.workspaceSlug)
  let uniqueId = projectId
  let counter = 2
  while (existing.some((p) => p.projectId === uniqueId)) {
    uniqueId = `${projectId}-${counter}`
    counter++
  }

  // 初始化 tree-engine 树（使用 uniqueId 确保 tree_id 唯一）
  const treeId = initProjectTree(input.workspaceSlug, uniqueId, input.name, input.mode, input.sessionId)

  const project: NanjuProject = {
    projectId: uniqueId,
    name: input.name,
    mode: input.mode,
    status: 'active',
    currentStage: 'requirements',
    createdAt: now,
    updatedAt: now,
    sessionId: input.sessionId,
    workspaceSlug: input.workspaceSlug,
    treeId,
  }

  existing.push(project)
  writeJsonFileAtomic(getMetaPath(input.workspaceSlug), existing)

  // 创建文档目录骨架，使用 project-{slugified-name} 格式
  const docDirs = [
    '01_PRD', '02_UX_DESIGN', '03_ARCHITECTURE',
    '04_API_SPEC', '05_PROJECT_PLAN', '06_TESTS', '07_VERSIONS',
  ]
  const wsFilesDir = getWorkspaceFilesDir(input.workspaceSlug)
  const projectDir = join(wsFilesDir, `project-${uniqueId}`)
  mkdirSync(projectDir, { recursive: true })
  for (const dir of docDirs) {
    mkdirSync(join(projectDir, dir), { recursive: true })
  }

  // 创建项目背景信息文件
  const projectInfo = {
    projectId: uniqueId,
    name: input.name,
    mode: input.mode,
    sessionId: input.sessionId,
    createdAt: now,
    workspaceSlug: input.workspaceSlug,
    projectDir: `project-${uniqueId}`,
    docDirs,
  }
  writeJsonFileAtomic(join(projectDir, '_project-info.json'), projectInfo)

  return project
}

/** 更新南大项目 */
export function updateNanjuProject(
  workspaceSlug: string,
  projectId: string,
  updates: Partial<NanjuProject>,
): NanjuProject | null {
  const projects = listNanjuProjects(workspaceSlug)
  const idx = projects.findIndex((p) => p.projectId === projectId)
  if (idx === -1) return null

  const existing = projects[idx]
  if (!existing) return null

  const updated: NanjuProject = {
    ...existing,
    ...updates,
    projectId: existing.projectId,
    createdAt: existing.createdAt,
    workspaceSlug: existing.workspaceSlug,
    updatedAt: new Date().toISOString(),
  }
  projects[idx] = updated

  writeJsonFileAtomic(getMetaPath(workspaceSlug), projects)
  return updated
}

/** 获取单个南大项目 */
export function getNanjuProject(
  workspaceSlug: string,
  projectId: string,
): NanjuProject | null {
  const projects = listNanjuProjects(workspaceSlug)
  const found = projects.find((p) => p.projectId === projectId)
  return found ?? null

}

/** 删除南大项目 */
export function deleteNanjuProject(
  workspaceSlug: string,
  projectId: string,
): boolean {
  const projects = listNanjuProjects(workspaceSlug)
  const filtered = projects.filter((p) => p.projectId !== projectId)
  if (filtered.length === projects.length) return false
  writeJsonFileAtomic(getMetaPath(workspaceSlug), filtered)
  return true
}
