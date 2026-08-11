/**
 * ModeSelectView — 模式选择页
 *
 * 南大项目入口。用户选择「快消型」或「长期迭代型」后创建项目并进入工作区。
 */

import * as React from 'react'
import { Rocket, Building2, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type ProjectMode = 'quick' | 'iterative'

interface ModeSelectViewProps {
  onSelectMode: (mode: ProjectMode, projectName: string) => void
}

export function ModeSelectView({ onSelectMode }: ModeSelectViewProps): React.ReactElement {
  const [selectedMode, setSelectedMode] = React.useState<ProjectMode | null>(null)
  const [projectName, setProjectName] = React.useState('')

  const handleConfirm = () => {
    if (!selectedMode) return
    const name = projectName.trim() || (selectedMode === 'quick' ? '我的快速工具' : '我的长期项目')
    onSelectMode(selectedMode, name)
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-6 py-12">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">你想做什么？</h1>
        <p className="text-sm text-muted-foreground">选择一种模式，开始你的项目</p>
      </div>

      <div className="flex gap-6 max-w-3xl w-full">
        {/* 快消型 */}
        <button
          type="button"
          onClick={() => setSelectedMode('quick')}
          className={cn(
            'flex-1 flex flex-col items-center gap-4 p-8 rounded-2xl border-2 transition-all duration-200 text-left',
            selectedMode === 'quick'
              ? 'border-primary bg-primary/5 shadow-md'
              : 'border-border hover:border-primary/40 hover:bg-muted/30',
          )}
        >
          <div className="w-14 h-14 rounded-full bg-blue-500/10 flex items-center justify-center">
            <Rocket className="w-7 h-7 text-blue-500" />
          </div>
          <div className="space-y-1 text-center">
            <h2 className="text-lg font-medium text-foreground">快速做一个工具</h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              一次性小应用、验证想法。快速实现，测试收口。
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 justify-center">
            {['小工具', '验证想法', '快速交付'].map((tag) => (
              <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
        </button>

        {/* 长期迭代型 */}
        <button
          type="button"
          onClick={() => setSelectedMode('iterative')}
          className={cn(
            'flex-1 flex flex-col items-center gap-4 p-8 rounded-2xl border-2 transition-all duration-200 text-left',
            selectedMode === 'iterative'
              ? 'border-primary bg-primary/5 shadow-md'
              : 'border-border hover:border-primary/40 hover:bg-muted/30',
          )}
        >
          <div className="w-14 h-14 rounded-full bg-purple-500/10 flex items-center justify-center">
            <Building2 className="w-7 h-7 text-purple-500" />
          </div>
          <div className="space-y-1 text-center">
            <h2 className="text-lg font-medium text-foreground">长期迭代项目</h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              需要持续更新的项目。完整工程流程，版本管理。
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 justify-center">
            {['完整文档', '架构设计', '版本管理'].map((tag) => (
              <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
        </button>
      </div>

      {/* 项目名输入 */}
      {selectedMode && (
        <div className="flex flex-col items-center gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
            placeholder={selectedMode === 'quick' ? '给你的工具起个名字（可选）' : '给你的项目起个名字（可选）'}
            className="w-80 px-4 py-2 text-sm rounded-lg border border-border bg-background text-center focus:outline-none focus:border-primary/50 transition-colors"
            maxLength={50}
            autoFocus
          />
          <Button
            type="button"
            onClick={handleConfirm}
            className="gap-2"
            size="default"
          >
            开始创建
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  )
}
