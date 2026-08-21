/**
 * ProjectListView — 我的项目列表页
 *
 * 显示所有南大项目，支持按状态/模式过滤。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Rocket, Building2, Folder, Clock, CheckCircle2, Archive } from 'lucide-react'

interface NanjuProject {
  projectId: string
  name: string
  mode: 'quick' | 'iterative'
  status: 'active' | 'completed' | 'abandoned'
  currentStage: string
  createdAt: string
  updatedAt: string
  sessionId?: string
}

interface ProjectListViewProps {
  projects: NanjuProject[]
  onSelectProject: (project: NanjuProject) => void
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

export function ProjectListView({ projects, onSelectProject }: ProjectListViewProps): React.ReactElement {
  const [filter, setFilter] = React.useState<'all' | 'active' | 'completed'>('all')

  const filtered = projects.filter((p) => {
    if (filter === 'all') return true
    return p.status === filter
  })

  return (
    <div className="flex flex-col h-full">
      {/* 筛选栏 */}
      <div className="flex items-center gap-2 px-4 py-3 border-b flex-shrink-0">
        <span className="text-sm font-medium text-foreground">我的项目</span>
        <span className="text-xs text-muted-foreground">({filtered.length})</span>
        <div className="ml-auto flex gap-1">
          {(['all', 'active', 'completed'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'px-2 py-0.5 text-[11px] rounded transition-colors',
                filter === f ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/50',
              )}
            >
              {f === 'all' ? '全部' : f === 'active' ? '进行中' : '已完成'}
            </button>
          ))}
        </div>
      </div>

      {/* 项目列表 */}
      <div className="flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Folder className="w-8 h-8 opacity-40" />
            <span className="text-sm">暂无项目</span>
            <span className="text-xs">点击上方「新建」开始创建</span>
          </div>
        ) : (
          <div className="grid gap-2">
            {filtered.map((project) => (
              <button
                key={project.projectId}
                type="button"
                onClick={() => onSelectProject(project)}
                className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/40 hover:bg-muted/30 transition-all text-left"
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
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
