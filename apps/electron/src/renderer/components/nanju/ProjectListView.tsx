/**
 * ProjectListView — 我的项目列表页（Y5a 补全，W1，spec 交互5）
 *
 * 筛选栏：搜索框（按名称/摘要实时过滤——NanjuProject 现无摘要字段，当前按名称匹配，
 * 过滤函数已支持 summary）+ 三段 Tab（全部/快速工具/长期项目，mode 维度口径）。
 * 删除流程：卡片 ⋯ 菜单（打开继续/删除危险色）→ ProjectDeleteConfirm 二次确认
 * → nanjuDeleteProject IPC（nanju-ipc.ts 已有 handler）→ success Toast + 列表刷新。
 * 空态/无结果态按 spec 文案；Escape 关弹窗/菜单（弹窗侧由 ProjectDeleteConfirm 处理）。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Rocket, Building2, Folder, Clock, CheckCircle2, Archive, MoreHorizontal, Search } from 'lucide-react'
import { ProjectDeleteConfirm } from '@/components/nanju/ProjectDeleteConfirm'
import { showNanjuToast } from '@/components/nanju/NanjuToast'
import {
  filterProjects,
  nextDeleteDialogState,
  buildDeleteSuccessToastText,
  PROJECT_LIST_TAB_LABELS,
  PROJECT_EMPTY_GUIDE,
  PROJECT_NO_RESULTS,
  type ProjectListTab,
} from '@/components/nanju/project-list-logic'

interface NanjuProject {
  projectId: string
  name: string
  mode: 'quick' | 'iterative'
  status: 'active' | 'completed' | 'abandoned'
  currentStage: string
  createdAt: string
  updatedAt: string
  sessionId?: string
  /** 删除 IPC 需要（主进程 NanjuProject 本就含此字段） */
  workspaceSlug?: string
}

interface ProjectListViewProps {
  projects: NanjuProject[]
  onSelectProject: (project: NanjuProject) => void
  /** 删除成功后通知父层刷新列表（Y5a；缺省时仅本地隐藏） */
  onProjectsChanged?: () => void
  /** 空态「创建第一个项目」按钮回调（可选——未提供时不渲染按钮） */
  onCreateProject?: () => void
}

const STAGE_LABELS: Record<string, string> = {
  'mode-select': '选择模式',
  'requirements': '需求分析',
  'prototype': '原型设计',
  'architecture': '架构设计',
  'planning': '工程规划',
  'coding': '开发中',
  'testing': '测试中',
  'delivered': '已交付',
}

const STATUS_ICON: Record<string, React.ReactElement> = {
  active: <Clock className="w-3.5 h-3.5 text-blue-500" />,
  completed: <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />,
  abandoned: <Archive className="w-3.5 h-3.5 text-gray-400" />,
}

function formatDate(ts: string): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export function ProjectListView({ projects, onSelectProject, onProjectsChanged, onCreateProject }: ProjectListViewProps): React.ReactElement {
  const [tab, setTab] = React.useState<ProjectListTab>('all')
  const [query, setQuery] = React.useState('')
  /** 本地已删除的 projectId（立即隐藏；父层经 onProjectsChanged 兑底刷新） */
  const [deletedIds, setDeletedIds] = React.useState<Set<string>>(() => new Set())
  /** ⋯ 菜单打开的卡片（一次一卡） */
  const [menuForId, setMenuForId] = React.useState<string | null>(null)
  /** 删除流程：目标项目 + 弹窗状态机 */
  const [deleteTarget, setDeleteTarget] = React.useState<NanjuProject | null>(null)
  const [dialogState, setDialogState] = React.useState<'closed' | 'confirming' | 'deleting'>('closed')
  const [deleteError, setDeleteError] = React.useState<string | null>(null)

  const visibleProjects = React.useMemo(
    () => filterProjects(projects.filter((p) => !deletedIds.has(p.projectId)), { tab, query }),
    [projects, deletedIds, tab, query],
  )

  // ⋯ 菜单：点击外部自动关闭（spec 交互5「上下文菜单行为」）；Escape 同
  React.useEffect(() => {
    if (!menuForId) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest?.('[data-project-menu]')) setMenuForId(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuForId(null)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuForId])

  const openDeleteConfirm = (project: NanjuProject): void => {
    setMenuForId(null)
    setDeleteError(null)
    setDeleteTarget(project)
    setDialogState(nextDeleteDialogState('closed', { type: 'open' }))
  }

  const handleConfirmDelete = React.useCallback(async () => {
    if (!deleteTarget) return
    setDialogState((s) => nextDeleteDialogState(s, { type: 'confirm' }))
    try {
      const workspaceSlug = deleteTarget.workspaceSlug
      if (!workspaceSlug) throw new Error('项目缺少 workspaceSlug，无法删除')
      const ok = await window.electronAPI.nanjuDeleteProject({ workspaceSlug, projectId: deleteTarget.projectId })
      if (!ok) throw new Error('删除失败：项目不存在或已被删除')
      setDialogState((s) => nextDeleteDialogState(s, { type: 'deleted' }))
      setDeletedIds((prev) => { const next = new Set(prev); next.add(deleteTarget.projectId); return next })
      // spec 交互5：Toast(--color-success)「已删除「{项目名}」及其所有数据」
      showNanjuToast('success', { text: buildDeleteSuccessToastText(deleteTarget.name) })
      setDeleteTarget(null)
      onProjectsChanged?.()
    } catch (e) {
      setDialogState((s) => nextDeleteDialogState(s, { type: 'failed' }))
      setDeleteError(e instanceof Error ? e.message : String(e))
    }
  }, [deleteTarget, onProjectsChanged])

  const hasAnyProject = projects.length > 0

  return (
    <div className="relative flex flex-col h-full">
      {/* 筛选栏：搜索框 + 三段 Tab（spec 交互5：全部/快速工具/长期项目） */}
      <div className="flex items-center gap-2 px-4 py-3 border-b flex-shrink-0">
        <span className="text-sm font-medium text-foreground">我的项目</span>
        <span className="text-xs text-muted-foreground">({visibleProjects.length})</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索项目"
              aria-label="搜索项目"
              className="w-40 rounded-md border border-border bg-background py-1 pl-7 pr-2 text-[11px] focus:outline-none focus:border-primary/50"
            />
          </div>
          <div className="flex gap-1">
            {(Object.keys(PROJECT_LIST_TAB_LABELS) as ProjectListTab[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setTab(f)}
                className={cn(
                  'px-2 py-0.5 text-[11px] rounded transition-colors',
                  tab === f ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/50',
                )}
              >
                {PROJECT_LIST_TAB_LABELS[f]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 项目列表 */}
      <div className="flex-1 overflow-y-auto p-3">
        {!hasAnyProject ? (
          /* 空态（spec 交互5：图标 + 引导文案 + 创建按钮） */
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Folder className="w-8 h-8 opacity-40" />
            <span className="text-sm">还没有项目</span>
            <span className="max-w-[280px] text-center text-xs leading-relaxed">{PROJECT_EMPTY_GUIDE}</span>
            {onCreateProject && (
              <button
                type="button"
                onClick={onCreateProject}
                className="mt-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
              >
                创建第一个项目
              </button>
            )}
          </div>
        ) : visibleProjects.length === 0 ? (
          /* 无结果态（spec 交互5：不隐藏卡片网格区域文案） */
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Folder className="w-8 h-8 opacity-40" />
            <span className="text-sm">{PROJECT_NO_RESULTS}</span>
          </div>
        ) : (
          <div className="grid gap-2">
            {visibleProjects.map((project) => (
              <div
                key={project.projectId}
                className="group relative flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/40 hover:bg-muted/30 transition-all"
              >
                <button
                  type="button"
                  onClick={() => onSelectProject(project)}
                  className="flex flex-1 items-center gap-3 text-left min-w-0"
                >
                  <div className={cn(
                    'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
                    project.mode === 'quick' ? 'bg-blue-500/10' : 'bg-purple-500/10',
                  )}>
                    {project.mode === 'quick'
                      ? <Rocket className="w-4 h-4 text-blue-500" />
                      : <Building2 className="w-4 h-4 text-purple-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{project.name}</span>
                      {STATUS_ICON[project.status]}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {STAGE_LABELS[project.currentStage] ?? project.currentStage}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{formatDate(project.updatedAt)}</span>
                    </div>
                  </div>
                </button>
                {/* ⋯ 菜单按钮（spec 交互5 删除入口；菜单点击外部自动关闭） */}
                <div className="relative shrink-0" data-project-menu>
                  <button
                    type="button"
                    aria-label="项目操作菜单"
                    onClick={() => setMenuForId((prev) => (prev === project.projectId ? null : project.projectId))}
                    className="inline-flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted/70 focus:opacity-100"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                  {menuForId === project.projectId && (
                    <div className="absolute right-0 top-7 z-50 w-32 overflow-hidden rounded-md border border-border bg-content-area shadow-lg animate-in fade-in slide-in-from-top-1">
                      <button
                        type="button"
                        onClick={() => { setMenuForId(null); onSelectProject(project) }}
                        className="block w-full px-3 py-1.5 text-left text-xs hover:bg-muted/70"
                      >
                        打开继续
                      </button>
                      <button
                        type="button"
                        onClick={() => openDeleteConfirm(project)}
                        className="block w-full px-3 py-1.5 text-left text-xs text-red-600 dark:text-red-400 hover:bg-red-500/10"
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {deleteError && (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {deleteError}
          </div>
        )}
      </div>

      {/* 删除确认弹窗（Y5a 二次确认；Escape 关闭由弹窗内处理） */}
      {deleteTarget && dialogState !== 'closed' && (
        <ProjectDeleteConfirm
          projectName={deleteTarget.name}
          busy={dialogState === 'deleting'}
          onCancel={() => { setDialogState('closed'); setDeleteTarget(null); setDeleteError(null) }}
          onConfirm={() => void handleConfirmDelete()}
        />
      )}
    </div>
  )
}
