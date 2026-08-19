import * as React from 'react'
import { renderMermaidSvg } from '@proma/ui'
import { resolveGuideNodeTarget, type GuideNodeTarget } from './guide-dsl'

interface GuideFlowProps {
  dsl: string
  onNodeClick: (target: GuideNodeTarget) => void
}

const ZOOM_MIN = 0.3
const ZOOM_MAX = 3
const ZOOM_STEP = 0.2
/** 初始缩放：100%（svg 本体已 fit 容器宽，scale 是用户附加缩放） */
const INITIAL_SCALE = 1
const DEBOUNCE_MS = 350

/** 缩放适配：svg 以原始像素尺寸渲染（不缩水），外层 transform: scale 控制视觉缩放 */
const PULSE_CSS = `
.guide-node-current { animation: guide-pulse 1.6s ease-in-out infinite; }
@keyframes guide-pulse { 0%,100% { filter: drop-shadow(0 0 2px rgba(79,70,229,.9)); } 50% { filter: drop-shadow(0 0 7px rgba(79,70,229,.55)); } }
.guide-flow-svg svg [data-id], .guide-flow-svg svg [id^="flowchart-"] { cursor: pointer; }
`

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 双锚点提取节点 id（PRD §6.3：beautiful-mermaid data-id 主路径 / 官方 flowchart- 兜底） */
function extractNodeId(el: Element): string | null {
  const dataId = el.getAttribute('data-id')
  if (dataId) return dataId
  const id = el.getAttribute('id')
  if (id) return id
  return null
}

export function GuideFlow({ dsl, onNodeClick }: GuideFlowProps): React.ReactElement {
  const [renderedSvg, setRenderedSvg] = React.useState<string | null>(null)
  const [renderFailed, setRenderFailed] = React.useState(false)

  /** 视口变换：scale + translate（拖拽平移） */
  const [scale, setScale] = React.useState<number>(INITIAL_SCALE)
  const [pan, setPan] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragStateRef = React.useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null)

  const viewportRef = React.useRef<HTMLDivElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const dslRef = React.useRef(dsl)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = React.useRef(0)
  const anchorWarnedRef = React.useRef(false)

  dslRef.current = dsl

  const renderCurrentDsl = React.useCallback(async (generation: number) => {
    try {
      const svg = await renderMermaidSvg(dslRef.current)
      if (generationRef.current !== generation) return
      setRenderedSvg(svg)
      setRenderFailed(false)
    } catch {
      if (generationRef.current === generation) {
        setRenderedSvg(null)
        setRenderFailed(true)
      }
    }
  }, [])

  React.useEffect(() => {
    generationRef.current++
    const currentGen = generationRef.current
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setRenderedSvg(null)
    setRenderFailed(false)
    setScale(INITIAL_SCALE)
    setPan({ x: 0, y: 0 })
    debounceRef.current = setTimeout(() => {
      void renderCurrentDsl(currentGen)
    }, DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [dsl, renderCurrentDsl])

  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      generationRef.current++
      void renderCurrentDsl(generationRef.current)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [renderCurrentDsl])

  // SVG 后处理：恢复原始尺寸（覆盖任何 width=100% 残留）+ 锚点绑定 + 拖拽/滚轮缩放
  React.useEffect(() => {
    const container = containerRef.current
    if (!container || !renderedSvg) return

    // svg 保持 mermaid 输出的原始像素尺寸（清晰渲染），缩放交给外层 transform
    const svgEl = container.querySelector('svg')
    if (svgEl) {
      svgEl.style.maxWidth = 'none'
      svgEl.style.width = ''
      svgEl.style.height = ''
      svgEl.removeAttribute('width')
      svgEl.removeAttribute('height')
      // viewBox 缺失时用原始尺寸补（transform 依赖）
      if (!svgEl.getAttribute('viewBox')) {
        const vb = svgEl.getAttribute('viewBox')
        if (!vb) {
          // beautiful-mermaid 输出带 viewBox；官方兜底路径有 width/height 属性，转 viewBox
          const w = svgEl.getAttribute('data-orig-width')
          const h = svgEl.getAttribute('data-orig-height')
          if (w && h) svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`)
        }
      }
    }

    let nodes = Array.from(container.querySelectorAll('[data-id]'))
    if (nodes.length === 0) {
      nodes = Array.from(container.querySelectorAll('[id^="flowchart-"]'))
    }
    if (nodes.length === 0) {
      if (!anchorWarnedRef.current) {
        console.warn('[向导图] SVG 中未找到可交互节点锚点，本次渲染降级为纯展示')
        anchorWarnedRef.current = true
      }
      return
    }
    anchorWarnedRef.current = false

    const disposers: Array<() => void> = []
    for (const node of nodes) {
      const nodeId = extractNodeId(node)
      if (!nodeId) continue
      const target = resolveGuideNodeTarget(nodeId)
      if (!target) continue
      const handler = (event: Event) => {
        // 拖拽结束的 click 不触发节点详情（拖拽位移 > 5px 时抑制）
        if (dragStateRef.current?.moved) return
        event.stopPropagation()
        onNodeClick(target)
      }
      node.addEventListener('click', handler)
      disposers.push(() => node.removeEventListener('click', handler))
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [renderedSvg, onNodeClick])

  // 拖拽平移：mousedown 在视口空白/图形上拖动
  const handlePointerDown = React.useCallback((e: React.PointerEvent) => {
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y, moved: false }
  }, [pan])

  const handlePointerMove = React.useCallback((e: React.PointerEvent) => {
    const st = dragStateRef.current
    if (!st) return
    const dx = e.clientX - st.startX
    const dy = e.clientY - st.startY
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) st.moved = true
    setPan({ x: st.baseX + dx, y: st.baseY + dy })
  }, [])

  const handlePointerUp = React.useCallback(() => {
    // moved 标志保留到 click 事件后再清（click 在 pointerup 后同步触发）
    setTimeout(() => { dragStateRef.current = null }, 0)
  }, [])

  // 滚轮缩放（Ctrl+滚轮 或直接滚轮？设计：Ctrl+滚轮缩放，普通滚轮滚动——遵循 MermaidBlock 不劫持滚轮原则）
  const handleWheel = React.useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setScale((prev) => clamp(prev * (e.deltaY < 0 ? 1.1 : 0.9), ZOOM_MIN, ZOOM_MAX))
  }, [])

  const zoomIn = React.useCallback(() => setScale((prev) => clamp(prev + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)), [])
  const zoomOut = React.useCallback(() => setScale((prev) => clamp(prev - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)), [])
  const zoomReset = React.useCallback(() => { setScale(INITIAL_SCALE); setPan({ x: 0, y: 0 }) }, [])
  const zoomFit = React.useCallback(() => {
    // 适配视口：按视口宽/图原始宽计算缩放（近似，图渲染后按 100% 原始尺寸放置）
    const viewport = viewportRef.current
    const svgEl = containerRef.current?.querySelector('svg')
    if (!viewport || !svgEl) { zoomReset(); return }
    const viewBox = svgEl.getAttribute('viewBox')
    if (!viewBox) { zoomReset(); return }
    const [, , vbW] = viewBox.split(/\s+/).map(Number)
    if (!vbW) { zoomReset(); return }
    const fit = clamp((viewport.clientWidth - 24) / vbW, ZOOM_MIN, ZOOM_MAX)
    setScale(fit)
    setPan({ x: 0, y: 0 })
  }, [zoomReset])

  return (
    <div className="flex flex-col min-h-0 h-full">
      <style>{PULSE_CSS}</style>
      <div className="flex items-center justify-end gap-0.5 px-2 py-1 text-xs text-muted-foreground shrink-0">
        <button type="button" onClick={zoomOut} className="size-6 rounded hover:bg-muted/70 hover:text-foreground" title="缩小">−</button>
        <button type="button" onClick={zoomReset} className="px-1.5 h-6 rounded hover:bg-muted/70 hover:text-foreground tabular-nums min-w-[38px]" title="重置缩放">{Math.round(scale * 100)}%</button>
        <button type="button" onClick={zoomIn} className="size-6 rounded hover:bg-muted/70 hover:text-foreground" title="放大">＋</button>
        <button type="button" onClick={zoomFit} className="px-1.5 h-6 rounded hover:bg-muted/70 hover:text-foreground" title="适配面板宽度">⤢</button>
      </div>
      <div
        ref={viewportRef}
        className="flex-1 min-h-0 overflow-hidden bg-background/40 border-t border-border/40 cursor-grab active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
      >
        {renderFailed ? (
          <div className="p-2 text-xs text-muted-foreground overflow-auto h-full">
            <div className="mb-1 text-destructive">图表渲染失败，已降级为源码显示</div>
            <pre className="whitespace-pre-wrap break-all text-[11px] leading-relaxed text-foreground/70">{dsl}</pre>
          </div>
        ) : !renderedSvg ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">流程图渲染中…</div>
        ) : (
          <div
            ref={containerRef}
            className="guide-flow-svg inline-block"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: '0 0',
            }}
            dangerouslySetInnerHTML={{ __html: renderedSvg }}
          />
        )}
      </div>
    </div>
  )
}
