/**
 * ClickToFixPanel — 点选纠错快速选项面板（interaction-spec 交互1）
 *
 * 用户点击原型元素后，宿主在元素下方弹出快速选项面板：
 * 换个颜色（4 预设色）/ 改文字 / 换个位置 / 删掉它 / 其他。
 * - 颜色、删除：构造修改指令直接注入调度员会话（reportClickToFix panel-action）
 * - 改文字 / 换位置 / 其他：关闭面板并聚焦输入框（点选引用已暂存，随下一条消息携带）
 * - 面板外点击 / ✕：关闭面板（引用保持暂存，仍可继续打字发送）
 */
import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { X, Palette, Type, Move, Trash2, MessageCircle } from 'lucide-react'
import { clickToFixPanelAtom } from '@/atoms/preview-atoms'
import { currentAgentSessionIdAtom, agentWorkspacesAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { tabsAtom, activeTabIdAtom } from '@/atoms/tab-atoms'

/** 4 预设色（D1 修订：红/蓝/绿/靛蓝） */
const PRESET_COLORS = ['#DC2626', '#4F46E5', '#059669', '#6366F1']

export function ClickToFixPanel(): React.ReactElement | null {
  const panel = useAtomValue(clickToFixPanelAtom)
  const setPanel = useSetAtom(clickToFixPanelAtom)
  const store = useStore()
  const [colorPickerOpen, setColorPickerOpen] = React.useState(false)
  const panelRef = React.useRef<HTMLDivElement>(null)

  // 面板外点击关闭
  React.useEffect(() => {
    if (!panel) return
    const onDocClick = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return
      setPanel(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [panel, setPanel])

  // 面板开关时重置色板子菜单
  React.useEffect(() => {
    setColorPickerOpen(false)
  }, [panel?.ref.id])

  if (!panel) return null

  const { ref, rect, iframe } = panel
  // 定位：元素下方 8px；下方空间不足（视口高度 - 元素底部 < 280）时放元素上方
  const viewportH = window.innerHeight
  const below = iframe.y + rect.y + rect.h + 8
  const putBelow = viewportH - below >= 280
  const top = putBelow ? below : Math.max(8, iframe.y + rect.y - 8 - (colorPickerOpen ? 220 : 236))
  const left = Math.min(Math.max(8, iframe.x + rect.x), window.innerWidth - 224)

  const sendAction = (action: string, color?: string): void => {
    const sessionId = store.get(currentAgentSessionIdAtom)
    const sessions = store.get(agentSessionsAtom)
    const session = sessions.find((s) => s.id === sessionId)
    const workspace = store.get(agentWorkspacesAtom).find((w) => w.id === session?.workspaceId)
    if (!sessionId || !workspace) return
    void window.electronAPI.reportClickToFix({
      workspaceSlug: workspace.slug,
      sessionId,
      kind: 'panel-action',
      id: ref.id,
      type: ref.type,
      text: ref.text,
      action,
      color,
    }).catch(() => {})
    setPanel(null)
  }

  const closeAndFocusInput = (): void => {
    const sessionId = store.get(currentAgentSessionIdAtom)
    setPanel(null)
    // 当前可能在“预览”tab：切回该会话的主 tab（sessionId 匹配且非 preview），
    // 等 tab 渲染后再聚焦输入框（tiptap 编辑器挂载于会话视图）
    const tabs = store.get(tabsAtom)
    const sessionTab = tabs.find((t) => t.sessionId === sessionId && t.type !== 'preview')
    if (sessionTab) store.set(activeTabIdAtom, sessionTab.id)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('proma:focus-agent-input'))
    }, 200)
  }

  const options = [
    { icon: <Palette className="size-3.5" />, label: '换个颜色', onClick: () => setColorPickerOpen((v) => !v) },
    { icon: <Type className="size-3.5" />, label: '改文字', onClick: closeAndFocusInput },
    { icon: <Move className="size-3.5" />, label: '换个位置', onClick: closeAndFocusInput },
    { icon: <Trash2 className="size-3.5" />, label: '删掉它', onClick: () => sendAction('delete') },
    { icon: <MessageCircle className="size-3.5" />, label: '其他', onClick: closeAndFocusInput },
  ]

  return (
    <div
      ref={panelRef}
      className="fixed z-[300] w-52 rounded-lg border border-border bg-popover shadow-xl text-sm select-none"
      style={{ top, left }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <span className="truncate flex-1 text-xs text-muted-foreground">
          对此{ref.type}的操作
        </span>
        <button
          type="button"
          onClick={() => setPanel(null)}
          className="shrink-0 size-5 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted/70 hover:text-foreground"
          aria-label="关闭"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="truncate px-3 py-1.5 text-xs text-foreground/80 border-b border-border/60" title={ref.text}>
        {ref.text || ref.id}
      </div>
      {colorPickerOpen && (
        <div className="px-3 py-2 border-b border-border/60">
          <div className="text-[10px] text-muted-foreground mb-1.5">选择新颜色</div>
          <div className="flex gap-1.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="size-6 rounded-md border border-border hover:scale-110 transition-transform"
                style={{ backgroundColor: c }}
                aria-label={`颜色 ${c}`}
                onClick={() => sendAction('color', c)}
              />
            ))}
          </div>
        </div>
      )}
      <div className="p-1">
        {options.map((opt) => (
          <button
            key={opt.label}
            type="button"
            onClick={opt.onClick}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-muted/70"
          >
            <span className="text-muted-foreground">{opt.icon}</span>
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
