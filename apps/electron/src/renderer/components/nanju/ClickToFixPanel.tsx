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
import { clickToFixPanelAtom, pendingCtfChangesMapAtom, uxElementRefPoolMapAtom, previewFileMapAtom, type CtfChangeItem, type UxElementRef } from '@/atoms/preview-atoms'
import { currentAgentSessionIdAtom, agentWorkspacesAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { tabsAtom, activeTabIdAtom } from '@/atoms/tab-atoms'
import { VOICE_DICTATION_INSERT_EVENT, VOICE_DICTATION_PREVIEW_EVENT } from '@/lib/voice-input-focus'

/** 语音意见收集器的 sourceInputId 前缀（点选元素旁的语音 bar 用） */
const CTF_VOICE_INPUT_PREFIX = 'ctf-voice-'

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
  const setChangesMap = useSetAtom(pendingCtfChangesMapAtom)

  // 语音意见收集：听写结果（targetInputId 匹配点选语音收集器）自动附在发起语音时的元素上
  React.useEffect(() => {
    const onInsert = (event: Event): void => {
      const customEvent = event as CustomEvent<{ sessionId?: string; text?: string; targetInputId?: string | null }>
      const detail = customEvent.detail ?? {}
      const text = detail.text?.trim()
      if (!text || !detail.sessionId) return
      // R2：targetInputId 含元素 id（ctf-voice-<sessionId>-<elementId>），按发起时元素归属
      const prefix = `${CTF_VOICE_INPUT_PREFIX}${detail.sessionId}-`
      if (!detail.targetInputId?.startsWith(prefix)) return
      const elementId = detail.targetInputId.slice(prefix.length)
      // R1：命中即确认送达（preventDefault → 主进程不再走剪贴板兜底）
      customEvent.preventDefault()
      // 从元素池找完整 ref（type/text）；找不到则退化用 elementId
      const pool = store.get(uxElementRefPoolMapAtom).get(detail.sessionId) ?? []
      const pooled = pool.find((r) => r.id === elementId)
      const ref: UxElementRef = pooled ?? {
        id: elementId, type: '元素', text: '',
        filePath: store.get(previewFileMapAtom).get(detail.sessionId)?.filePath ?? '',
        capturedAt: Date.now(),
      }
      // 入清单：voice 项（同元素多条语音意见累积，不覆盖）
      const item: CtfChangeItem = { ref, action: 'voice', value: text, appliedAt: Date.now() }
      store.set(pendingCtfChangesMapAtom, (prev) => {
        const list = prev.get(detail.sessionId!) ?? []
        const next = new Map(prev)
        next.set(detail.sessionId!, [...list, item].slice(-24))
        return next
      })
      // 元素角标+窄条：iframe 内 annotate（计数+1，点击看意见）
      const frame = document.querySelector('iframe[src*="prototype"]') as HTMLIFrameElement | null
      frame?.contentWindow?.postMessage({ __promaCtfApply: true, action: 'annotate', id: elementId, text }, '*')
    }
    window.addEventListener(VOICE_DICTATION_INSERT_EVENT, onInsert)
    return () => window.removeEventListener(VOICE_DICTATION_INSERT_EVENT, onInsert)
  }, [store])

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

  /** 语音：面板保持打开，语音 bar 状态靠近元素；结果自动附在当前元素上（角标+意见） */
  const startVoiceForElement = (): void => {
    // R2：元素 id 编入 sourceInputId，语音结果按发起时元素归属（听写中切元素/关面板不串）
    void window.electronAPI.toggleVoiceDictation({ sourceInputId: `${CTF_VOICE_INPUT_PREFIX}${sessionId ?? ''}-${ref.id}` }).catch(() => {})
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
    { icon: <Mic className="size-3.5" />, label: '语音', onClick: startVoiceForElement },
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
          <div className="flex items-center gap-1.5">
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
            {/* 自定义调色板（用户反馈：四种预设色后加调色板入口） */}
            <label
              className="size-6 rounded-md border border-dashed border-border flex items-center justify-center cursor-pointer hover:bg-muted/70 overflow-hidden"
              title="自定义调色板"
            >
              <input
                type="color"
                className="absolute opacity-0 size-0"
                onChange={(e) => { applyColor(e.target.value); setColorPickerOpen(false) }}
              />
              <span className="text-[10px] leading-none">🎨</span>
            </label>
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
  const [iframeRect, setIframeRect] = React.useState<{ x: number; y: number } | null>(null)

  // 预览 iframe 存在性与位置轮询（轻量，1.5s）：浮动条/接受按钮/麦克风都定位在预览窗口内
  React.useEffect(() => {
    let boundFrame: HTMLIFrameElement | null = null
    const onLoad = (): void => {
      // Y2：iframe 重载后注入脚本的 inline 效果与角标全丢失，清空清单防脱节
      const s = store.get(currentAgentSessionIdAtom)
      if (!s) return
      const list = store.get(pendingCtfChangesMapAtom).get(s)
      if (!list || list.length === 0) return
      setChangesMap((prev) => {
        const next = new Map(prev)
        next.delete(s)
        return next
      })
    }
    const check = (): void => {
      const f = document.querySelector('iframe[src*="prototype"]') as HTMLIFrameElement | null
      const visible = !!f && f.offsetWidth > 0
      setPreviewVisible(visible)
      if (visible && f) {
        const r = f.getBoundingClientRect()
        setIframeRect((prev) => (prev && Math.abs(prev.x - r.x) < 1 && Math.abs(prev.y - r.y) < 1 ? prev : { x: r.x, y: r.y }))
        // iframe 引用变化（首现/切换）时（重新）绑定 load
        if (boundFrame !== f) {
          if (boundFrame) boundFrame.removeEventListener('load', onLoad)
          f.addEventListener('load', onLoad)
          boundFrame = f
        }
      } else {
        setIframeRect(null)
        if (boundFrame) {
          boundFrame.removeEventListener('load', onLoad)
          boundFrame = null
        }
      }
    }
    check()
    const timer = window.setInterval(check, 1500)
    return () => {
      window.clearInterval(timer)
      if (boundFrame) boundFrame.removeEventListener('load', onLoad)
    }
  }, [setChangesMap, store])

  // （原 Y7 的 load 清理 effect 已并入上方轮询，删除独立 effect）

  if (changes.length === 0 && !previewVisible) return null

  const removeChange = (index: number): void => {
    const item = changes[index]
    if (!item) return
    // 撤销 iframe 内即时效果：voice 项清角标计数；其余恢复原始样式
    const frame = document.querySelector('iframe[src*="prototype"]') as HTMLIFrameElement | null
    if (frame?.contentWindow) {
      if (item.action === 'voice') {
        frame.contentWindow.postMessage({ __promaCtfApply: true, action: 'remove-annotation', id: item.ref.id }, '*')
      } else {
        frame.contentWindow.postMessage({ __promaCtfApply: true, action: 'undo', id: item.ref.id }, '*')
      }
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

  /** 接受调整：一次性把修改清单发给调度员会话执行（含 PRD 同步）；
   *  Y8：仅当注入成功（ok）才清清单，失败保留清单并提示 */
  const acceptAll = async (): Promise<void> => {
    const workspace = store.get(agentWorkspacesAtom).find(
      (w) => w.id === store.get(agentSessionsAtom).find((s) => s.id === sessionId)?.workspaceId,
    )
    if (!sessionId || !workspace) return
    try {
      const result = await window.electronAPI.reportClickToFix({
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
      }) as { ok?: boolean } | undefined
      if (result && result.ok === false) throw new Error('注入失败')
    } catch {
      // 失败：保留清单与 iframe 内即时效果，用户可重试或放弃
      return
    }
    // Y1：接受成功后清理 iframe 内 inline 效果与角标/窄条（不依赖重载）
    const frame = document.querySelector('iframe[src*="prototype"]') as HTMLIFrameElement | null
    frame?.contentWindow?.postMessage({ __promaCtfApply: true, action: 'undo-all' }, '*')
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
    if (c.action === 'voice') {
      const t = String(c.value ?? '').slice(0, 24)
      return `${what} → 💬「${t}」`
    }
    const v = c.value as { dx?: number; dy?: number } | undefined
    return `${what} → 移动(${v?.dx ?? 0},${v?.dy ?? 0})`
  }

  // 浮动条定位在预览窗口内左上角（用户要求：属于 UX 界面范围，不挂在整个窗口左上角）
  const barStyle: React.CSSProperties | undefined = iframeRect
    ? { top: iframeRect.y + 8, left: iframeRect.x + 8, position: 'fixed' }
    : { top: 16, left: 4 }

  return (
    <div className="fixed z-[299] w-auto" style={barStyle}>
      {changes.length > 0 ? (
        <div className="flex flex-col items-start gap-1.5 rounded-xl border border-border bg-popover/95 shadow-lg px-3 py-2 text-xs backdrop-blur">
          <span className="shrink-0 font-medium text-primary">本轮已调整 {changes.length} 处</span>
          <div className="flex flex-col items-start gap-1 max-h-48 overflow-y-auto">
            {changes.map((c, i) => (
              <button
                key={`${c.ref.id}-${c.action}-${i}`}
                type="button"
                onClick={() => removeChange(i)}
                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 hover:bg-muted/70 max-w-[240px]"
                title={`${changeLabel(c)}（点击撤销）`}
              >
                <span className="truncate">{changeLabel(c)}</span>
                <X className="size-3 text-muted-foreground" />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 w-full">
            <button
              type="button"
              onClick={discardAll}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-muted/70"
            >
              <RotateCcw className="size-3" /> 放弃
            </button>
            <button
              type="button"
              onClick={acceptAll}
              className="inline-flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-2.5 py-1 hover:opacity-90"
            >
              <Check className="size-3" /> 接受本轮改动
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={startVoice}
          className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
          aria-label="语音输入"
          title="语音输入：直接说修改意见"
        >
          <Mic className="size-4" />
        </button>
      )}
    </div>
  )
}
