/**
 * Tree View IPC handlers
 *
 * 供渲染进程的树形面板组件读取 tree-state.json 数据。
 * 移植自 proma-patches 的 registerTreePanelIpc。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IpcMain } from 'electron'
import { listAgentWorkspaces, getAgentWorkspace } from './agent-workspace-manager'
import { listAgentSessions } from './agent-session-manager'
import { getAgentWorkspacePath } from './config-paths'

interface TreeLeaf {
  leaf_id: string
  session_id: string
  parent: string | null
  path: string
  role: string
  model: string
  channel: string
  status: string
  created_at: string
  added_by: string | null
  last_event_ts: string | null
  last_event_type: string | null
  context_usage_pct: number
  milestones: Array<{ id: string; status: string; audit_pass: boolean }>
  events_count: number
  audit_gate: { verdict: string; audit_session_id: string | null } | null
  nudge_count: number
  segments: unknown[]
}

interface TreeState {
  tree_id: string
  workspace_slug: string
  workspace_name: string
  leaves: Record<string, TreeLeaf>
  created_at: string
  latest_activity_ts: number
  has_active_leaf: boolean
  error?: string
}

interface WorkspaceInfo {
  workspace_slug: string
  workspace_name: string
  is_current: boolean
  tree_count: number
}

interface TreeStateResult {
  ok: boolean
  workspaces: WorkspaceInfo[]
  trees: TreeState[]
  error?: string
}

function discoverWorkspacesWithTrees(): Array<{
  slug: string
  name: string
  treesDir: string | null
}> {
  const workspaces = listAgentWorkspaces()
  return workspaces.map((ws) => {
    const wsPath = getAgentWorkspacePath(ws.slug)
    const candidates = [
      path.join(wsPath, 'workspace-files', '.context', 'trees'),
      path.join(wsPath, '.context', 'trees'),
    ]
    let treesDir: string | null = null
    for (const dir of candidates) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          treesDir = dir
          break
        }
      } catch { /* continue */ }
    }
    return { slug: ws.slug, name: ws.name, treesDir }
  })
}

function findCurrentWorkspaceSlug(): string | null {
  try {
    const sessions = listAgentSessions()
    const sorted = sessions
      .filter((s) => s.workspaceId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    if (sorted.length === 0) return null
    const topSession = sorted[0]
    if (!topSession?.workspaceId) return null
    const ws = getAgentWorkspace(topSession.workspaceId)
    return ws?.slug ?? null
  } catch {
    return null
  }
}

function readTreesFromDir(treesDir: string, slug: string, name: string): TreeState[] {
  const trees: TreeState[] = []
  let entries: string[] = []
  try {
    entries = fs.readdirSync(treesDir)
  } catch { /* empty */ }

  for (const dirName of entries) {
    const statePath = path.join(treesDir, dirName, 'tree-state.json')
    if (!fs.existsSync(statePath)) continue
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>
      const leaves: Record<string, TreeLeaf> = {}
      let hasActiveLeaf = false
      let latestTs = 0

      for (const [lid, leafRaw] of Object.entries((raw.leaves ?? {}) as Record<string, Record<string, unknown>>)) {
        const leaf = leafRaw as unknown as TreeLeaf
        const status = leaf.status ?? 'active'
        if (['active', 'pending_brief', 'segment_pending'].includes(status)) hasActiveLeaf = true
        const ts = leaf.last_event_ts ? new Date(leaf.last_event_ts).getTime() : 0
        if (ts > latestTs) latestTs = ts
        leaves[lid] = {
          leaf_id: leaf.leaf_id,
          session_id: leaf.session_id,
          parent: leaf.parent,
          path: leaf.path,
          role: leaf.role,
          model: leaf.model,
          channel: leaf.channel,
          status,
          created_at: leaf.created_at,
          added_by: leaf.added_by,
          last_event_ts: leaf.last_event_ts,
          last_event_type: leaf.last_event_type,
          context_usage_pct: leaf.context_usage_pct ?? 0,
          milestones: Array.isArray(leaf.milestones)
            ? leaf.milestones.map((m) => ({ id: m.id, status: m.status, audit_pass: m.audit_pass }))
            : [],
          events_count: Array.isArray((leafRaw as Record<string, unknown>).events)
            ? ((leafRaw as Record<string, unknown>).events as unknown[]).length
            : 0,
          audit_gate: leaf.audit_gate ?? null,
          nudge_count: leaf.nudge_count ?? 0,
          segments: Array.isArray(leaf.segments) ? leaf.segments : [],
        }
      }

      trees.push({
        tree_id: raw.tree_id as string,
        workspace_slug: slug,
        workspace_name: name,
        leaves,
        created_at: raw.created_at as string,
        latest_activity_ts: latestTs,
        has_active_leaf: hasActiveLeaf,
      })
    } catch {
      trees.push({
        tree_id: dirName,
        workspace_slug: slug,
        workspace_name: name,
        leaves: {},
        created_at: '',
        latest_activity_ts: 0,
        has_active_leaf: false,
        error: 'parse error',
      })
    }
  }
  return trees
}

export function registerTreeViewIpc(ipcMain: IpcMain): void {
  ipcMain.handle('proma:get-tree-states', async (_event, arg: { workspace_slug?: string } | undefined) => {
    try {
      const requestedSlug = arg?.workspace_slug
      const allWs = discoverWorkspacesWithTrees()
      if (allWs.length === 0) {
        return { ok: false, error: 'no workspaces found', workspaces: [], trees: [] } satisfies TreeStateResult
      }

      const currentSlug = findCurrentWorkspaceSlug()
      const allTrees: TreeState[] = []
      const wsInfos: WorkspaceInfo[] = []

      for (const ws of allWs) {
        const isMatch = !requestedSlug || ws.slug === requestedSlug
        const trees = ws.treesDir && isMatch ? readTreesFromDir(ws.treesDir, ws.slug, ws.name) : []
        allTrees.push(...trees)
        wsInfos.push({
          workspace_slug: ws.slug,
          workspace_name: ws.name,
          is_current: ws.slug === currentSlug,
          tree_count: trees.length,
        })
      }

      return { ok: true, workspaces: wsInfos, trees: allTrees } satisfies TreeStateResult
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), workspaces: [], trees: [] } satisfies TreeStateResult
    }
  })
}
