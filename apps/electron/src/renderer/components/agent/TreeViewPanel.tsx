/**
 * TreeViewPanel — 树形会话可视化面板
 *
 * 作为右侧 SidePanel 的一个 tab，展示工作区中所有 tree 的层级结构。
 * 移植自 proma-patches 的 proma-tree-view.js，重写为 React 组件。
 *
 * 数据来源：IPC 通道 proma:get-tree-states → tree-view-ipc.ts
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { cn } from '@/lib/utils'
import { currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'

// ===== 类型 =====

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
}

interface TreeData {
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
  trees: TreeData[]
  error?: string
}

// ===== 常量 =====

const STATUS_COLOR: Record<string, string> = {
  active: 'bg-blue-500',
  pending_brief: 'bg-purple-500',
  done: 'bg-green-500',
  pruned: 'bg-red-500',
  archived: 'bg-gray-400',
  segment_pending: 'bg-amber-500',
}

const STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  pending_brief: '待brief',
  done: '完成',
  pruned: '已剪枝',
  archived: '已归档',
  segment_pending: '竹节交接',
}

const ROLE_ICON: Record<string, string> = {
  root: '📁',
  commander: '🔀',
  worker: '🍃',
}

const GATE_COLOR: Record<string, string> = {
  pass: 'text-green-500',
  required: 'text-amber-500',
  fail: 'text-red-500',
  skip: 'text-gray-400',
}

function formatRelative(iso: string | null): string {
  if (!iso) return '从未'
  const t = new Date(iso).getTime()
  if (isNaN(t)) return '?'
  const sec = Math.floor((Date.now() - t) / 1000)
  if (sec < 60) return `${sec}s 前`
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h 前`
  return `${Math.floor(sec / 86400)}d 前`
}

// ===== 主组件 =====

interface TreeViewPanelProps {
  sessionId: string
  onNavigateToSession?: (sessionId: string, title: string) => void
}

export function TreeViewPanel({ sessionId: _sessionId, onNavigateToSession }: TreeViewPanelProps): React.ReactElement {
  const [data, setData] = React.useState<TreeStateResult | null>(null)
  const [selectedTreeId, setSelectedTreeId] = React.useState<string | null>(null)
  const [selectedLeafId, setSelectedLeafId] = React.useState<string | null>(null)
  const [detailHeight, setDetailHeight] = React.useState(160)
  const [dragging, setDragging] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  // 拉取数据
  const fetchData = React.useCallback(async () => {
    try {
      const result = await window.electronAPI.getTreeStates() as TreeStateResult
      setData(result)
    } catch (e) {
      console.error('[TreeView] fetch failed:', e)
    }
  }, [])

  // 3 秒轮询
  React.useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, 3000)
    return () => clearInterval(timer)
  }, [fetchData])

  // 自动选中第一个 tree
  React.useEffect(() => {
    if (data?.ok && data.trees.length > 0 && !selectedTreeId) {
      const firstTree = data.trees[0]
      if (firstTree) setSelectedTreeId(firstTree.tree_id)
    }
  }, [data, selectedTreeId])

  const trees = data?.trees ?? []
  const workspaces = data?.workspaces ?? []

  // 当前选中的 tree
  const activeTree = trees.find((t) => t.tree_id === selectedTreeId) ?? null

  // 构建 children map
  const childrenMap = React.useMemo(() => {
    const map: Record<string, TreeLeaf[]> = {}
    if (!activeTree) return map
    for (const leaf of Object.values(activeTree.leaves ?? {})) {
      if (leaf.parent) {
        const parentKey = leaf.parent
        if (!map[parentKey]) map[parentKey] = []
        map[parentKey]!.push(leaf)
      }
    }
    // 排序：commander → worker → root，然后按 leaf_id
    for (const key of Object.keys(map)) {
      const arr = map[key]
      if (arr) arr.sort((a, b) => {
        if (a.role !== b.role) {
          const order: Record<string, number> = { commander: 0, worker: 1, root: 2 }
          return (order[a.role] ?? 9) - (order[b.role] ?? 9)
        }
        return a.leaf_id.localeCompare(b.leaf_id)
      })
    }
    return map
  }, [activeTree])

  const rootLeaf = activeTree
    ? Object.values(activeTree.leaves ?? {}).find((l) => l.parent === null || l.parent === undefined)
    : null

  // ===== 渲染 =====

  if (!data) {
    return <div className="flex items-center justify-center h-full text-xs text-muted-foreground">加载中...</div>
  }

  if (!data.ok || trees.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-xs text-muted-foreground p-4 text-center">
        <span className="text-2xl">🌳</span>
        <span>暂无树形任务</span>
        <span className="text-[10px]">Agent 使用 mcp__tree__tree_init 创建树后会在此显示</span>
      </div>
    )
  }

  function renderLeaf(leaf: TreeLeaf, depth: number): React.ReactElement {
    const isSelected = leaf.leaf_id === selectedLeafId
    const statusColor = STATUS_COLOR[leaf.status] ?? 'bg-gray-400'
    const kids = childrenMap[leaf.leaf_id] ?? []

    return (
      <React.Fragment key={leaf.leaf_id}>
        <div
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 text-[11px] cursor-pointer rounded-sm transition-colors',
            isSelected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/50 text-muted-foreground',
            leaf.status === 'pending_brief' && 'italic',
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          title={`session: ${leaf.session_id}`}
          onClick={() => setSelectedLeafId(leaf.leaf_id)}
          onDoubleClick={() => {
            if (onNavigateToSession && leaf.session_id && leaf.session_id !== 'PENDING_ROOT') {
              onNavigateToSession(leaf.session_id, leaf.leaf_id)
            }
          }}
        >
          <span className="shrink-0">{ROLE_ICON[leaf.role] ?? '?'}</span>
          <span className={cn('size-1.5 rounded-full shrink-0', statusColor)} />
          <span className="truncate flex-1">{leaf.leaf_id}</span>
          {/* chips */}
          <span className="shrink-0 flex items-center gap-1">
            <span className={cn('text-[9px]', statusColor.replace('bg-', 'text-'))}>
              {STATUS_LABEL[leaf.status] ?? leaf.status}
            </span>
            {leaf.audit_gate?.verdict && leaf.audit_gate.verdict !== 'skip' && (
              <span className={cn('text-[9px] font-medium', GATE_COLOR[leaf.audit_gate.verdict] ?? 'text-gray-400')}>
                {leaf.audit_gate.verdict}
              </span>
            )}
            {leaf.role === 'worker' && leaf.milestones.length > 0 && (
              <span className="text-[9px] text-muted-foreground">
                {leaf.milestones.filter((m) => m.status === 'done').length}/{leaf.milestones.length}
              </span>
            )}
            {leaf.nudge_count > 0 && (
              <span className="text-[9px] text-amber-500" title="偏差纠正次数">⚠{leaf.nudge_count}</span>
            )}
            {leaf.context_usage_pct > 0 && (
              <span className="text-[9px] text-muted-foreground">{leaf.context_usage_pct}%</span>
            )}
          </span>
        </div>
        {kids.map((kid) => renderLeaf(kid, depth + 1))}
      </React.Fragment>
    )
  }

  const selectedLeaf = activeTree && selectedLeafId ? activeTree.leaves[selectedLeafId] : null

  return (
    <div className="flex flex-col h-full">
      {/* Tree 选择 tabs */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b overflow-x-auto flex-shrink-0">
        {trees.map((tree) => (
          <button
            key={tree.tree_id}
            type="button"
            onClick={() => { setSelectedTreeId(tree.tree_id); setSelectedLeafId(null) }}
            className={cn(
              'px-2 py-0.5 text-[10px] rounded transition-colors whitespace-nowrap',
              tree.tree_id === selectedTreeId
                ? 'bg-primary/15 text-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            {tree.has_active_leaf && <span className="size-1.5 rounded-full bg-blue-500 inline-block mr-1" />}
            {tree.tree_id}
            <span className="text-muted-foreground/60 ml-1">({Object.keys(tree.leaves).length})</span>
          </button>
        ))}
      </div>

      {/* 上方树列表 + 下方详情 */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* 树列表（上方） */}
        <div className={cn('flex-1 min-h-0 overflow-y-auto py-1', selectedLeaf && 'border-b')}>
          {activeTree && activeTree.error ? (
            <div className="text-[11px] text-red-500 p-2">解析失败: {activeTree.error}</div>
          ) : activeTree && rootLeaf ? (
            renderLeaf(rootLeaf, 0)
          ) : activeTree ? (
            Object.values(activeTree.leaves ?? {}).map((leaf) => renderLeaf(leaf, 0))
          ) : (
            <div className="text-[11px] text-muted-foreground p-2">选择上方的 tree tab</div>
          )}
        </div>

        {/* 拖拽分隔条 */}
        {selectedLeaf && (
          <div
            className="flex-shrink-0 h-1.5 cursor-row-resize bg-border/60 hover:bg-primary/40 transition-colors"
            onMouseDown={(e) => {
              e.preventDefault()
              setDragging(true)
              const panel = e.currentTarget.parentElement
              if (!panel) return
              const panelHeight = panel.clientHeight
              const startY = e.clientY
              const startDetailH = detailHeight
              const onMove = (ev: MouseEvent) => {
                const delta = startY - ev.clientY
                const newH = Math.max(80, Math.min(panelHeight - 100, startDetailH + delta))
                setDetailHeight(newH)
              }
              const onUp = () => {
                setDragging(false)
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
              }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }}
          />
        )}

        {/* 详情面板（下方） */}
        {selectedLeaf && (
          <div
            className="flex-shrink-0 overflow-y-auto px-2 py-1.5 bg-muted/30"
            style={{ height: detailHeight }}
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <span>{ROLE_ICON[selectedLeaf.role] ?? '?'}</span>
              <span className="text-[11px] font-medium truncate">{selectedLeaf.leaf_id}</span>
              <span className={cn('size-1.5 rounded-full shrink-0', STATUS_COLOR[selectedLeaf.status] ?? 'bg-gray-400')} />
              <span className="text-[10px] text-muted-foreground truncate">{STATUS_LABEL[selectedLeaf.status] ?? selectedLeaf.status}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
              <DetailRow label="角色" value={selectedLeaf.role} />
              <DetailRow label="模型" value={selectedLeaf.model} />
              <DetailRow label="渠道" value={selectedLeaf.channel} />
              <DetailRow label="事件" value={selectedLeaf.last_event_type ?? '—'} />
              <DetailRow label="更新" value={formatRelative(selectedLeaf.last_event_ts)} />
              {selectedLeaf.audit_gate?.verdict && selectedLeaf.audit_gate.verdict !== 'skip' && (
                <DetailRow label="审计" value={selectedLeaf.audit_gate.verdict} />
              )}
              {selectedLeaf.milestones.length > 0 && (
                <DetailRow label="里程碑" value={`${selectedLeaf.milestones.filter((m) => m.status === 'done').length}/${selectedLeaf.milestones.length}`} />
              )}
              {selectedLeaf.context_usage_pct > 0 && (
                <DetailRow label="上下文" value={`${selectedLeaf.context_usage_pct}%`} />
              )}
            </div>
            {onNavigateToSession && selectedLeaf.session_id && selectedLeaf.session_id !== 'PENDING_ROOT' && (
              <button
                type="button"
                onClick={() => onNavigateToSession(selectedLeaf.session_id, selectedLeaf.leaf_id)}
                className="mt-1.5 w-full text-[10px] px-2 py-1 rounded border border-border hover:bg-muted/50 transition-colors"
              >
                跳转会话 →
              </button>
            )}
          </div>
        )}
      </div>

      {/* 底部状态 */}
      <div className="flex items-center justify-between px-2 py-1 border-t text-[9px] text-muted-foreground flex-shrink-0">
        <span>{workspaces.length} 工作区 · {trees.length} 棵树</span>
        <span>{Object.values(activeTree?.leaves ?? {}).length} 叶节点</span>
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground truncate text-right">{value}</span>
    </div>
  )
}
