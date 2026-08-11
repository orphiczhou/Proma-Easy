/**
 * 南大项目角色编排
 *
 * 读取 nanju-roles 配置，使用 session fork + send_message 做角色切换。
 * 不新建实体类——直接复用 agent-session-manager 的底层函数。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createAgentSession } from './agent-session-manager'
import { runRegisteredHeadlessAgent } from './agent-headless-runner-registry'
import { recordTelemetry } from './nanju-telemetry'
import type { PromaPermissionMode } from '@proma/shared'

// ===== 类型 =====

export interface RoleConfig {
  role: string
  name: string
  model: string
  channel: string
  description: string
  system_prompt: string
  activation_stage: string
  next_role: string | null
}

export interface RoleSequenceConfig {
  version: string
  roles: string[]
  quick_mode_sequence: string[]
  iterative_mode_sequence: string[]
}

// ===== 配置加载 =====

let rolesCache: Record<string, RoleConfig> | null = null
let sequenceCache: RoleSequenceConfig | null = null

function getRolesDir(): string {
  // 打包后: process.resourcesPath/nanju-roles/
  // 开发时: resources/nanju-roles/
  const { app } = require('electron')
  const base = app?.isPackaged
    ? process.resourcesPath
    : join(process.cwd(), 'apps', 'electron', 'resources')
  return join(base, 'nanju-roles')
}

export function loadRoleConfig(roleId: string): RoleConfig | null {
  if (!rolesCache) {
    rolesCache = {}
  }
  if (rolesCache[roleId]) return rolesCache[roleId]

  const filePath = join(getRolesDir(), `${roleId}.json`)
  if (!existsSync(filePath)) return null

  try {
    const config = JSON.parse(readFileSync(filePath, 'utf-8')) as RoleConfig
    rolesCache[roleId] = config
    return config
  } catch {
    return null
  }
}

export function loadRoleSequence(): RoleSequenceConfig | null {
  if (sequenceCache) return sequenceCache

  const filePath = join(getRolesDir(), 'roles.json')
  if (!existsSync(filePath)) return null

  try {
    sequenceCache = JSON.parse(readFileSync(filePath, 'utf-8')) as RoleSequenceConfig
    return sequenceCache
  } catch {
    return null
  }
}

// ===== 角色编排 =====

/**
 * 为指定角色创建 Agent 会话。
 * 返回新会话的 sessionId。
 */
export function createRoleSession(
  roleId: string,
  workspaceId: string,
  projectContext?: string,
): { sessionId: string; config: RoleConfig } | null {
  const config = loadRoleConfig(roleId)
  if (!config) return null

  const title = `[${config.name}] ${projectContext ?? ''}`.trim()
  const session = createAgentSession(
    title,
    config.channel,
    workspaceId,
    config.model,
  )

  return { sessionId: session.id, config }
}

/**
 * 向角色会话发送首条消息（注入 system prompt + 上下文摘要）。
 */
export async function sendRoleInitialMessage(
  sessionId: string,
  roleId: string,
  contextSummary: string,
  workspaceSlug: string,
  projectId?: string,
): Promise<string> {
  const config = loadRoleConfig(roleId)
  if (!config) throw new Error(`Role config not found: ${roleId}`)

  const message = `${config.system_prompt}

---

## 上下文交接

${contextSummary}

---

请开始你的工作。`;

  // 记录角色切换事件
  recordTelemetry(workspaceSlug, 'role.switched', {
    role: roleId,
    session_id: sessionId,
  }, projectId)

  // 通过 headless runner 发送消息
  await runRegisteredHeadlessAgent(
    {
      sessionId,
      userMessage: message,
      channelId: config.channel,
      modelId: config.model,
      permissionModeOverride: 'bypassPermissions' as PromaPermissionMode,
      startedAt: Date.now(),
    },
    {
      source: 'delegation',
      onError: () => {},
      onComplete: () => {},
      onTitleUpdated: () => {},
    },
  )

  return sessionId
}

/**
 * 获取角色切换序列。
 */
export function getRoleSequence(mode: 'quick' | 'iterative'): string[] {
  const seq = loadRoleSequence()
  if (!seq) return mode === 'quick' ? ['requirement-analyst', 'ux-advisor'] : ['requirement-analyst', 'ux-advisor', 'architect', 'engineering-manager']
  return mode === 'quick' ? seq.quick_mode_sequence : seq.iterative_mode_sequence
}
