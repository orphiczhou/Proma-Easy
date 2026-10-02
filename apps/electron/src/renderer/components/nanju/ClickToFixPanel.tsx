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
import { getPreviewFrame } from '@/lib/ctf-preview-frame'
import { tearOffPreviewToSplit } from '@/components/diff/preview-opener'
import { previewPanelOpenMapAtom } from '@/atoms/preview-atoms'
import { CTF_VOICE_INPUT_PREFIX, parseCtfVoiceTarget } from '../../../main/lib/ctf-voice'

type JotaiStore = ReturnType<typeof useStore>

/** 点选纠错交互强制并列展示：聊天 + 原型分屏（用户反馈：交互确认 UX 界面时必须并列）
 *  - 若当前是 preview 独立 tab → tearOff 为分屏；
 *  - 若无 tab 但该会话有预览文件 → 直接开分屏。 */
export function ensurePreviewSplit(store: JotaiStore, sessionId: string): void {
  const tabs = store.get(tabsAtom)
  const previewTab = tabs.find((t) => t.type === 'preview' && t.sessionId === sessionId)
  if (previewTab) {
    tearOffPreviewToSplit(store, previewTab.id)
    return
  }
  if (store.get(previewFileMapAtom).get(sessionId)) {
    store.set(previewPanelOpenMapAtom, (prev) => new Map(prev).set(sessionId, true))
  }
}

/** 4 预设色（D1 修订：红/蓝/绿/靛蓝） */
const PRESET_COLORS = ['#DC2626', '#4F46E5', '#059669', '#6366F1']

/** 发送修改指令到预览 iframe（即时应用）。
 *  Y3：目标解析见 lib/ctf-preview-frame —— 点击来源 frame 优先，多预览并存时不再取错目标 */
function postToPreviewFrame(action: string, id: string, value?: unknown): void {
  const frame = getPreviewFrame()
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
      if (!text) return
      // P3（v0.17.58）：targetInputId 是唯一事实源。detail.sessionId 是 ASR 听写会话 id
      // （主进程 commit 传 dictationSessionId），不是 agent 会话 id——用它拼 prefix 永远
      // startsWith false → 链路断裂（无清单/无角标/文本丢 fallback）。禁止回退到 sessionId 拼法。
      const tid = typeof detail.targetInputId === 'string' ? detail.targetInputId : ''
      if (!tid.startsWith(CTF_VOICE_INPUT_PREFIX)) return
      // 元素 id 与会话 id 都可能含 '-'：uuid 结构精确切分优先（见 parseCtfVoiceTarget）
      const parsed = parseCtfVoiceTarget(tid)
      if (!parsed) return
      const agentSid = parsed.agentSid
      const elementId = parsed.elementId
      if (!elementId) return
      // 命中即确认送达（preventDefault → 主进程不走剪贴板/fallback 兜底）
      customEvent.preventDefault()
      // 从元素池找完整 ref（type/text）；找不到则退化用 elementId 合成
      const pool = store.get(uxElementRefPoolMapAtom).get(agentSid) ?? []
      const pooled = pool.find((r) => r.id === elementId)
      const ref: UxElementRef = pooled ?? {
        id: elementId, type: '元素', text: '',
        filePath: store.get(previewFileMapAtom).get(agentSid)?.filePath ?? '',
        capturedAt: Date.now(),
      }
      // 入清单：voice 项（同元素多条语音意见累积，不覆盖）；
      // 归 agentSid 键（听写期间可能切会话，不能用 currentAgentSessionId）
      const item: CtfChangeItem = { ref, action: 'voice', value: text, appliedAt: Date.now() }
      store.set(pendingCtfChangesMapAtom, (prev) => {
        const list = prev.get(agentSid) ?? []
        const next = new Map(prev)
        next.set(agentSid, [...list, item].slice(-24))
        return next
      })
      // 元素角标+窄条：iframe 内 annotate（计数+1，点击看意见）
      getPreviewFrame()?.contentWindow?.postMessage({ __promaCtfApply: true, action: 'annotate', id: elementId, text }, '*')
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

  /** P1（v0.17.58）：改文字 → iframe 原地编辑（contentEditable/原生输入控件，Enter 确认）；
   *  替换元素/无可编辑文本时注入脚本回 text-edit-degraded，宿主退化为切输入框走「其他」路径 */
  const startTextEdit = (): void => {
    postToPreviewFrame('text-edit', ref.id)
    setPanel(null)
  }

  /** 进入拖拽模式（P2a：会话级持续，iframe 内可反复拖动直到退出条件）；退出后偏移进清单 */
  const startDrag = (): void => {
    postToPreviewFrame('drag-start', ref.id)
    setPanel(null)
  }

  /** 语音：面板保持打开，语音 bar 状态靠近元素；结果自动附在当前元素上（角标+意见） */
  const startVoiceForElement = (): void => {
    // 并列展示：语音时用户看着原型说话
    if (sessionId) ensurePreviewSplit(store, sessionId)
    // R2：元素 id 编入 sourceInputId，语音结果按发起时元素归属（听写中切元素/关面板不串）
    void window.electronAPI.toggleVoiceDictation({ sourceInputId: `${CTF_VOICE_INPUT_PREFIX}${sessionId ?? ''}-${ref.id}` }).catch(() => {})
  }

  const closeAndFocusInput = (): void => {
    setPanel(null)
    // 交互确认需要并列展示：强制聊天+原型分屏（不再用独立预览 tab）
    if (sessionId) ensurePreviewSplit(store, sessionId)
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
    { icon: <Type className="size-3.5" />, label: '改文字', onClick: startTextEdit },
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
    // P3b（v0.17.58）：iframe 重挂载/切换间隙可能单次探不到（闪隐），连续 2 次 null 才认定隐藏
    let missCount = 0
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
      const f = getPreviewFrame()
      const visible = !!f && f.offsetWidth > 0
      if (visible) {
        missCount = 0
        setPreviewVisible(true)
        if (f) {
          const r = f.getBoundingClientRect()
          setIframeRect((prev) => (prev && Math.abs(prev.x - r.x) < 1 && Math.abs(prev.y - r.y) < 1 ? prev : { x: r.x, y: r.y }))
          // iframe 引用变化（首现/切换）时（重新）绑定 load
          if (boundFrame !== f) {
            if (boundFrame) boundFrame.removeEventListener('load', onLoad)
            f.addEventListener('load', onLoad)
            boundFrame = f
          }
        }
      } else {
        missCount += 1
        if (missCount >= 2) {
          setPreviewVisible(false)
          setIframeRect(null)
          if (boundFrame) {
            boundFrame.removeEventListener('load', onLoad)
            boundFrame = null
          }
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

  /** #6 user.undo（PRD §12.4，I-P8）：撤销是渲染端事实，经 nanju:record-event 上报
   *  （主进程按 sessionId 解析归属项目）。只记发生与来源，不记被撤销的内容。 */
  const recordUndo = (source: 'single' | 'all'): void => {
    if (!sessionId) return
    const workspace = store.get(agentWorkspacesAtom).find(
      (w) => w.id === store.get(agentSessionsAtom).find((s) => s.id === sessionId)?.workspaceId,
    )
    if (!workspace) return
    void window.electronAPI.nanjuRecordEvent?.({
      workspaceSlug: workspace.slug,
      eventType: 'user.undo',
      payload: { source },
      sessionId,
    }).catch(() => {})
  }

  const removeChange = (index: number): void => {
    const item = changes[index]
    if (!item) return
    recordUndo('single')
    // 撤销 iframe 内即时效果：voice 项清角标计数；其余恢复原始样式
    // v0.17.59（WO3②）：undo 报文携带 value.action——iframe 按动作选择性还原，
    // 同元素其它动作的即时效果不受单条撤销影响（撤销粒度）
    const frame = getPreviewFrame()
    if (frame?.contentWindow) {
      if (item.action === 'voice') {
        frame.contentWindow.postMessage({ __promaCtfApply: true, action: 'remove-annotation', id: item.ref.id }, '*')
      } else {
        frame.contentWindow.postMessage({ __promaCtfApply: true, action: 'undo', id: item.ref.id, value: { action: item.action } }, '*')
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
    recordUndo('all')
    const frame = getPreviewFrame()
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
    // 并列展示：接受后用户看会话执行 + 原型刷新，聊天与原型需并排
    ensurePreviewSplit(store, sessionId)
    try {
      // v0.17.59（WO3①）：move 三级回退——iframe 上报 finalTransform 存在则原样透传；
      // 否则 absX/absY 拼 translate；再否则无字段（宿主不再拼装任何矩阵，
      // 矩阵序列化只发生在注入脚本内，消除双源分叉）
      const reportItems = changes.map((c) => {
        const base = {
          id: c.ref.id,
          type: c.ref.type,
          label: c.ref.text,
          action: c.action,
          value: c.value,
        }
        if (c.action === 'move') {
          const v = c.value as { absX?: number; absY?: number; finalTransform?: string } | undefined
          if (typeof v?.finalTransform === 'string' && v.finalTransform) {
            return { ...base, finalTransform: v.finalTransform }
          }
          if (typeof v?.absX === 'number' && typeof v?.absY === 'number') {
            return { ...base, finalTransform: `translate(${Math.round(v.absX)}px, ${Math.round(v.absY)}px)` }
          }
        }
        return base
      })
      const result = await window.electronAPI.reportClickToFix({
        workspaceSlug: workspace.slug,
        sessionId,
        kind: 'commit-changes',
        id: 'batch',
        type: `${changes.length} 处`,
        text: '',
        action: JSON.stringify(reportItems),
      }) as { ok?: boolean } | undefined
      if (result && result.ok === false) throw new Error('注入失败')
    } catch {
      // 失败：保留清单与 iframe 内即时效果，用户可重试或放弃
      return
    }
    // Y1：接受成功后清理 iframe 内 inline 效果与角标/窄条（不依赖重载）
    const frame = getPreviewFrame()
    frame?.contentWindow?.postMessage({ __promaCtfApply: true, action: 'undo-all' }, '*')
    setChangesMap((prev) => {
      const next = new Map(prev)
      next.delete(sessionId ?? '')
      return next
    })
  }

  const startVoice = (): void => {
    // 并列展示：语音时用户看着原型说话
    if (sessionId) ensurePreviewSplit(store, sessionId)
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
    if (c.action === 'text') {
      // P1（v0.17.58）：同元素改文字入清单（合并保留最新）
      const t = String(c.value ?? '').slice(0, 24)
      return `${what} → 改文字「${t}」`
    }
    if (c.action === 'voice') {
      const t = String(c.value ?? '').slice(0, 24)
      return `${what} → 💬「${t}」`
    }
    // P2b（v0.17.58）：优先显示绝对偏移（最终位置），与 commit 报文最终 transform 一致
    const v = c.value as { dx?: number; dy?: number; absX?: number; absY?: number } | undefined
    if (typeof v?.absX === 'number' && typeof v?.absY === 'number') {
      return `${what} → 移动(→${Math.round(v.absX)},${Math.round(v.absY)})`
    }
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
