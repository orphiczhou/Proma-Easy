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
      {/* 左侧：Agent 对话 */}
      <div
        className="flex flex-col min-w-0 h-full"
        style={previewOpen ? { flex: `0 0 calc(${splitRatio * 100}% - 4px)` } : { flex: '1 1 auto' }}
      >
        <AgentView sessionId={sessionId} />
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
