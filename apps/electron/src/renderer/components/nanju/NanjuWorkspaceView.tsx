/**
 * NanjuWorkspaceView — 南大项目工作区
 *
 * 左右平铺布局：左侧 Agent 对话 + 右侧 HTML 原型/文档预览。
 * 复用 Proma 的 AgentView 和 PreviewPanel，中间有可拖拽分隔条。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { AgentView } from '@/components/agent/AgentView'
import { PreviewPanel } from '@/components/diff/PreviewPanel'
import { GwtProgressCard } from '@/components/nanju/GwtProgressCard'
import { GuardAlertCard } from '@/components/nanju/GuardAlertCard'
import { NanjuToastHost } from '@/components/nanju/NanjuToast'
import { useNanjuDelegationToast } from '@/components/nanju/useNanjuDelegationToast'
import { useAtom, useAtomValue } from 'jotai'
import { previewPanelOpenMapAtom, previewSplitRatioAtom, previewFileMapAtom } from '@/atoms/preview-atoms'
import type { PreviewFile } from '@/atoms/preview-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'

interface NanjuWorkspaceViewProps {
  sessionId: string
}

export function NanjuWorkspaceView({ sessionId }: NanjuWorkspaceViewProps): React.ReactElement {
  const previewOpenMap = useAtomValue(previewPanelOpenMapAtom)
  const [splitRatio, setSplitRatio] = useAtom(previewSplitRatioAtom)
  const draggingRef = React.useRef(false)
  const openPreview = useOpenPreview()
  // R1（W1）：委派等待 Toast（5s/30s 阈值，spec 交互2）
  useNanjuDelegationToast(sessionId)

  // 监听 nanju HTML 预览事件，自动打开右侧分屏
  React.useEffect(() => {
    const handler = (_event: unknown, data: { filePath: string; fileName: string }) => {
      const previewFile: PreviewFile = {
        filePath: data.filePath,
        previewOnly: true,
      }
      openPreview(sessionId, previewFile)
    }
    window.electronAPI.onNanjuHtmlPreview?.(handler)
    return () => {
      window.electronAPI.offNanjuHtmlPreview?.(handler)
    }
  }, [sessionId, openPreview])

  const previewOpen = previewOpenMap.get(sessionId) ?? false

  const handleDragStart = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const startX = e.clientX
    const startRatio = splitRatio
    const container = (e.currentTarget as HTMLElement).parentElement
    const containerWidth = container?.clientWidth ?? 1
    let rafId = 0

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = 'none' })

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const delta = ev.clientX - startX
        const newRatio = Math.max(0.3, Math.min(0.7, startRatio + delta / containerWidth))
        setSplitRatio(newRatio)
      })
    }
    const onUp = () => {
      draggingRef.current = false
      if (rafId) cancelAnimationFrame(rafId)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.querySelectorAll('iframe').forEach((f) => { (f as HTMLElement).style.pointerEvents = '' })
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [splitRatio, setSplitRatio])

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* 左侧：Agent 对话（顶部叠加熔断卡片（R3）与 GWT 验收测试进度卡片，Sprint B）；底部固定 Toast（R1，spec 交互2） */}
      <div
        className="relative flex flex-col min-w-0 h-full"
        style={previewOpen ? { flex: `0 0 calc(${splitRatio * 100}% - 4px)` } : { flex: '1 1 auto' }}
      >
        <GuardAlertCard sessionId={sessionId} />
        <GwtProgressCard sessionId={sessionId} />
        <div className="flex-1 min-h-0">
          <AgentView sessionId={sessionId} />
        </div>
        {/* 底部固定 Toast 宿主（非对话流气泡；置底居中，pointer-events 仅 Toast 自身可交互） */}
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center px-4">
          <NanjuToastHost />
        </div>
      </div>

      {/* 可拖拽分隔条 */}
      {previewOpen && (
        <div
          className="w-1 cursor-col-resize bg-border/40 hover:bg-primary/30 active:bg-primary/50 transition-colors flex-shrink-0 self-stretch"
          onMouseDown={handleDragStart}
        />
      )}

      {/* 右侧：原型/文档预览 */}
      {previewOpen && (
        <div className="flex-1 min-w-0 h-full overflow-hidden">
          <PreviewPanel sessionId={sessionId} />
        </div>
      )}
    </div>
  )
}
