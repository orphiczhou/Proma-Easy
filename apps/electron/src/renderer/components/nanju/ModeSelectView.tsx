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

/**
 * v2.4（D7 §0 硬边界）：「自动补完需求」复选框仅快消型可选。
 * quick → available（复选框可选）；iterative → hidden（长期迭代型隐藏——升级即失效）。
 */
export function resolveAutoClarifyAvailability(mode: ProjectMode): 'available' | 'hidden' {
  return mode === 'quick' ? 'available' : 'hidden'
}

interface ModeSelectViewProps {
  onSelectMode: (mode: ProjectMode, projectName: string, options?: { autoClarify?: { enabled: boolean } }) => void
}

export function ModeSelectView({ onSelectMode }: ModeSelectViewProps): React.ReactElement {
  const [selectedMode, setSelectedMode] = React.useState<ProjectMode | null>(null)
  const [projectName, setProjectName] = React.useState('')
  /** v2.4：自动补完需求勾选态（仅快消型可选；切模式时重置，防跨模式残留） */
  const [autoClarify, setAutoClarify] = React.useState(false)
  const autoClarifyAvailability = selectedMode ? resolveAutoClarifyAvailability(selectedMode) : 'hidden'

  const handleSelectMode = (mode: ProjectMode) => {
    setSelectedMode(mode)
    if (mode !== 'quick') setAutoClarify(false)
  }

  const handleConfirm = () => {
    if (!selectedMode) return
    const name = projectName.trim() || (selectedMode === 'quick' ? '我的快速工具' : '我的长期项目')
    // v2.4：勾选态存入项目创建参数 autoClarify.enabled（仅快消型可达 true）
    onSelectMode(selectedMode, name, {
      autoClarify: { enabled: autoClarify && autoClarifyAvailability === 'available' },
    })
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
          onClick={() => handleSelectMode('quick')}
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
          onClick={() => handleSelectMode('iterative')}
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
          {/* v2.4：自动补完需求复选框（仅快消型；长期型隐藏——升级即失效硬边界） */}
          {autoClarifyAvailability === 'available' && (
            <label className="flex items-center justify-center gap-2 text-xs text-muted-foreground cursor-pointer select-none max-w-[420px]">
              <input
                type="checkbox"
                checked={autoClarify}
                onChange={(e) => setAutoClarify(e.target.checked)}
                className="size-3.5 accent-primary"
              />
              <span>
                自动补完需求
                <span className="text-muted-foreground/70">（需求补充类问题由 AI 代理自动作答，可联网检索；关键确认与设计偏好仍由你决定）</span>
              </span>
            </label>
          )}
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
