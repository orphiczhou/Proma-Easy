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
import { getWorkspaceFilesDir } from './config-paths'

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
}

// ===== 路径 =====

function getMetaPath(workspaceSlug: string): string {
  return join(getWorkspaceFilesDir(workspaceSlug), '_nanju-projects.json')
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
  const project: NanjuProject = {
    projectId: randomUUID().slice(0, 8),
    name: input.name,
    mode: input.mode,
    status: 'active',
    currentStage: 'requirements',
    createdAt: now,
    updatedAt: now,
    sessionId: input.sessionId,
    workspaceSlug: input.workspaceSlug,
  }

  const projects = listNanjuProjects(input.workspaceSlug)
  projects.push(project)
  writeJsonFileAtomic(getMetaPath(input.workspaceSlug), projects)

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
