/**
 * ClickToFixPanel — 点选纠错快速选项面板（interaction-spec 交互1）
 *
 * 交互（用户反馈修订 2026-08-20）：
 * - 换个颜色 / 删掉它 / 换个位置：**直接在原型上即时生效**（postMessage 指令进 iframe），
 *   可连续调整多处，每处进待接受清单；不逐次与模型会话交互
 * - 改文字 / 其他：关闭面板并聚焦输入框（点选引用已暂存，随消息携带）
 * - 浮动清单条：显示"已调整 N 处"，可逐条撤销 / 全部放弃 / 接受调整
 *   （接受 = 一次性把修改清单发给调度员会话执行，同步 PRD）
 */
import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { X, Palette, Type, Move, Trash2, MessageCircle, Mic, Check, RotateCcw } from 'lucide-react'
import { clickToFixPanelAtom, pendingCtfChangesMapAtom, type CtfChangeItem } from '@/atoms/preview-atoms'
import { currentAgentSessionIdAtom, agentWorkspacesAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { tabsAtom, activeTabIdAtom } from '@/atoms/tab-atoms'

/** 4 预设色（D1 修订：红/蓝/绿/靛蓝） */
const PRESET_COLORS = ['#DC2626', '#4F46E5', '#059669', '#6366F1']

/** 发送修改指令到预览 iframe（即时应用） */
function postToPreviewFrame(action: string, id: string, value?: unknown): void {
  const frame = document.querySelector('iframe[src*="prototype"]') as HTMLIFrameElement | null
  if (!frame?.contentWindow) return
  frame.contentWindow.postMessage(
    { __promaCtfApply: true, action, id, value },
    '*',
  )
}

export function ClickToFixPanel(): React.ReactElement | null {
  const panel = useAtomValue(clickToFixPanelAtom)
  const setPanel = useSetAtom(clickToFixPanelAtom)
  const store = useStore()
  const [colorPickerOpen, setColorPickerOpen] = React.useState(false)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const changes = useAtomValue(pendingCtfChangesMapAtom).get(sessionId ?? '') ?? []

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

  React.useEffect(() => {
    setColorPickerOpen(false)
  }, [panel?.ref.id])

  if (!panel) return null

  const { ref, rect, iframe } = panel
  const viewportH = window.innerHeight
  const below = iframe.y + rect.y + rect.h + 8
  const putBelow = viewportH - below >= 280
  const top = putBelow ? below : Math.max(8, iframe.y + rect.y - 8 - (colorPickerOpen ? 220 : 236))
  const left = Math.min(Math.max(8, iframe.x + rect.x), window.innerWidth - 224)

  /** 即时应用颜色（不与会话交互，进待接受清单） */
  const applyColor = (color: string): void => {
    postToPreviewFrame('color', ref.id, color)
    setPanel(null)
  }

  /** 即时删除（opacity 0.3 模拟，进待接受清单） */
  const applyDelete = (): void => {
    postToPreviewFrame('delete', ref.id)
    setPanel(null)
  }

  /** 进入拖拽模式：iframe 内元素可拖动，松手后偏移进清单 */
  const startDrag = (): void => {
    postToPreviewFrame('drag-start', ref.id)
    setPanel(null)
  }

  const closeAndFocusInput = (): void => {
    setPanel(null)
    const tabs = store.get(tabsAtom)
    const sessionTab = tabs.find((t) => t.sessionId === sessionId && t.type !== 'preview')
    if (sessionTab) store.set(activeTabIdAtom, sessionTab.id)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('proma:focus-agent-input'))
    }, 200)
  }

  /** 语音：聚焦输入框后启动全局语音听写（豆包 ASR 路由回输入框） */
  const startVoice = (): void => {
    setPanel(null)
    const tabs = store.get(tabsAtom)
    const sessionTab = tabs.find((t) => t.sessionId === sessionId && t.type !== 'preview')
    if (sessionTab) store.set(activeTabIdAtom, sessionTab.id)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('proma:focus-agent-input'))
      window.setTimeout(() => {
        void window.electronAPI.toggleVoiceDictation().catch(() => {})
      }, 250)
    }, 200)
  }

  const options = [
    { icon: <Palette className="size-3.5" />, label: '换个颜色', onClick: () => setColorPickerOpen((v) => !v) },
    { icon: <Type className="size-3.5" />, label: '改文字', onClick: closeAndFocusInput },
    { icon: <Move className="size-3.5" />, label: '换个位置', onClick: startDrag },
    { icon: <Trash2 className="size-3.5" />, label: '删掉它', onClick: applyDelete },
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
          <div className="text-[10px] text-muted-foreground mb-1.5">选择新颜色（即时生效）</div>
          <div className="flex gap-1.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="size-6 rounded-md border border-border hover:scale-110 transition-transform"
                style={{ backgroundColor: c }}
                aria-label={`颜色 ${c}`}
                onClick={() => applyColor(c)}
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

/** 修改清单浮动条 + 漂浮麦克风（用户要求：漂浮的麦克风图标模块，预览打开时常驻） */
export function CtfChangesBar(): React.ReactElement | null {
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const changes = useAtomValue(pendingCtfChangesMapAtom).get(sessionId ?? '') ?? []
  const store = useStore()
  const setChangesMap = useSetAtom(pendingCtfChangesMapAtom)
  const [previewVisible, setPreviewVisible] = React.useState(false)

  // 预览 iframe 存在性轮询（轻量，2s）
  React.useEffect(() => {
    const check = (): void => {
      const f = document.querySelector('iframe[src*="prototype"]') as HTMLIFrameElement | null
      setPreviewVisible(!!f && f.offsetWidth > 0)
    }
    check()
    const timer = window.setInterval(check, 2000)
    return () => window.clearInterval(timer)
  }, [])

  if (changes.length === 0 && !previewVisible) return null

  const removeChange = (index: number): void => {
    const item = changes[index]
    if (!item) return
    // 撤销 iframe 内即时效果（重新加载预览最稳）
    const frame = document.querySelector('iframe[src*="prototype"]') as HTMLIFrameElement | null
    if (frame?.contentWindow) {
      frame.contentWindow.postMessage({ __promaCtfApply: true, action: 'undo', id: item.ref.id }, '*')
    }
    setChangesMap((prev) => {
      const list = prev.get(sessionId ?? '') ?? []
      const next = new Map(prev)
      next.set(sessionId ?? '', list.filter((item, i) => i !== index))
      return next
    })
  }

  const discardAll = (): void => {
    const frame = document.querySelector('iframe[src*="prototype"]') as HTMLIFrameElement | null
    if (frame?.contentWindow) {
      frame.contentWindow.postMessage({ __promaCtfApply: true, action: 'undo-all' }, '*')
    }
    setChangesMap((prev) => {
      const next = new Map(prev)
      next.delete(sessionId ?? '')
      return next
    })
  }

  /** 接受调整：一次性把修改清单发给调度员会话执行（含 PRD 同步），随后清空清单 */
  const acceptAll = (): void => {
    const workspace = store.get(agentWorkspacesAtom).find(
      (w) => w.id === store.get(agentSessionsAtom).find((s) => s.id === sessionId)?.workspaceId,
    )
    if (!sessionId || !workspace) return
    void window.electronAPI.reportClickToFix({
      workspaceSlug: workspace.slug,
      sessionId,
      kind: 'commit-changes',
      id: 'batch',
      type: `${changes.length} 处`,
      text: '',
      action: JSON.stringify(changes.map((c) => ({
        id: c.ref.id,
        type: c.ref.type,
        label: c.ref.text,
        action: c.action,
        value: c.value,
      }))),
    }).catch(() => {})
    setChangesMap((prev) => {
      const next = new Map(prev)
      next.delete(sessionId ?? '')
      return next
    })
  }

  const startVoice = (): void => {
    const tabs = store.get(tabsAtom)
    const sessionTab = tabs.find((t) => t.sessionId === sessionId && t.type !== 'preview')
    if (sessionTab) store.set(activeTabIdAtom, sessionTab.id)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('proma:focus-agent-input'))
      window.setTimeout(() => {
        void window.electronAPI.toggleVoiceDictation().catch(() => {})
      }, 250)
    }, 200)
  }

  const changeLabel = (c: CtfChangeItem): string => {
    const what = c.ref.text || c.ref.id
    if (c.action === 'color') return `${what} → 换颜色`
    if (c.action === 'delete') return `${what} → 删除`
    const v = c.value as { dx?: number; dy?: number } | undefined
    return `${what} → 移动(${v?.dx ?? 0},${v?.dy ?? 0})`
  }

  return (
    <div className="fixed z-[299] bottom-24 left-1/2 -translate-x-1/2 max-w-[560px] w-auto">
      {changes.length > 0 ? (
        <div className="flex items-center gap-2 rounded-full border border-border bg-popover/95 shadow-lg px-3 py-1.5 text-xs backdrop-blur">
          <span className="shrink-0 font-medium text-primary">已调整 {changes.length} 处</span>
          <div className="flex items-center gap-1 overflow-x-auto max-w-[340px]">
            {changes.map((c, i) => (
              <button
                key={`${c.ref.id}-${i}`}
                type="button"
                onClick={() => removeChange(i)}
                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 hover:bg-muted/70"
                title={`${changeLabel(c)}（点击撤销）`}
              >
                <span className="truncate max-w-[120px]">{changeLabel(c)}</span>
                <X className="size-3 text-muted-foreground" />
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={discardAll}
            className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-muted/70"
          >
            <RotateCcw className="size-3" /> 放弃
          </button>
          <button
            type="button"
            onClick={acceptAll}
            className="shrink-0 inline-flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-2.5 py-0.5 hover:opacity-90"
          >
            <Check className="size-3" /> 接受调整
          </button>
          <button
            type="button"
            onClick={startVoice}
            className="shrink-0 size-6 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
            aria-label="语音输入"
            title="语音输入"
          >
            <Mic className="size-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={startVoice}
          className="ml-auto flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
          aria-label="语音输入"
          title="语音输入：直接说修改意见"
        >
          <Mic className="size-4" />
        </button>
      )}
    </div>
  )
}
