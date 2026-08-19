/**
 * GuideFlow — 向导图 DSL → SVG 渲染 + 后处理交互
 *
 * 复用 @proma/ui 的 renderMermaidSvg 渲染管线（beautiful-mermaid 优先、官方 mermaid 兜底，
 * PRD §6.3 函数级复用），自带：350ms 防抖、generation 防竞态、暗色主题 MutationObserver 重渲染、
 * 渲染失败降级源码显示（MermaidBlock 同款模式）。
 *
 * SVG 后处理交互锚点双适配（修订 R3）：
 * - 主路径（beautiful-mermaid）：[data-id]（源码证实稳定存在）
 * - 官方兜底路径：[id^="flowchart-"]（mermaid v10 节点 id 约定）
 * 两条路径均绑定交互；均未命中时不绑定不抛错（console 记录一次）。
 */

import * as React from 'react'
import { renderMermaidSvg } from '@proma/ui'
import { resolveGuideNodeTarget, type GuideNodeTarget } from './guide-dsl'

/** 防抖间隔（ms），与 MermaidBlock 一致 */
const DEBOUNCE_MS = 350
/** 缩放范围与步进（MermaidBlock 同款控件模式） */
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2.5
const ZOOM_STEP = 0.15
/** 初始缩放 1.0：fit-to-width 由 CSS 承担（svg width=100% height=auto），不再双重缩小 */
const INITIAL_SCALE = 1.0

interface GuideFlowProps {
  /** mermaid DSL（GuidePanel useMemo 派生，引用相等即不重渲染——轮询零抖动） */
  dsl: string
  onNodeClick: (target: GuideNodeTarget) => void
}

/** 进行中节点的描边脉冲动画（AC-03：SVG 渲染完成后注入，2s 循环呼吸） */
const PULSE_CSS = `
@keyframes guide-pulse {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.35; }
}
.guide-flow-svg .node.st-current { animation: guide-pulse 2s ease-in-out infinite; }
.guide-flow-svg .node[data-id], .guide-flow-svg .node[id^="flowchart-"] { cursor: pointer; }
`

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 从 SVG 元素提取 mermaid 节点 id（data-id 优先；flowchart-XX-n 兜底正则提取） */
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
  const [scale, setScale] = React.useState<number>(INITIAL_SCALE)

  const containerRef = React.useRef<HTMLDivElement>(null)
  const dslRef = React.useRef(dsl)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** generation 计数器：防止异步竞态（MermaidBlock 同款） */
  const generationRef = React.useRef(0)
  /** 双锚点均未命中时只 console 记录一次（PRD §九 降级去重） */
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

  // 唯一的渲染 effect：防抖 + generation 防竞态
  React.useEffect(() => {
    generationRef.current++
    const currentGen = generationRef.current
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setRenderedSvg(null)
    setRenderFailed(false)
    setScale(INITIAL_SCALE)
    debounceRef.current = setTimeout(() => {
      void renderCurrentDsl(currentGen)
    }, DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [dsl, renderCurrentDsl])

  // 暗色主题切换：重渲染当前 DSL（MermaidBlock 同款 MutationObserver）
  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      generationRef.current++
      void renderCurrentDsl(generationRef.current)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [renderCurrentDsl])

  // SVG 后处理：双锚点绑定 click（修订 R3）+ 尺寸适配注入
  React.useEffect(() => {
    const container = containerRef.current
    if (!container || !renderedSvg) return

    // 尺寸适配：svg 改为 width=100% height=auto（覆盖 mermaid 固定像素宽）
    const svgEl = container.querySelector('svg')
    if (svgEl) {
      svgEl.setAttribute('width', '100%')
      svgEl.setAttribute('height', 'auto')
      svgEl.style.maxWidth = 'none'
      svgEl.removeAttribute('preserveAspectRatio')
    }

    // 主路径：beautiful-mermaid 的 [data-id]；兜底路径：官方 mermaid 的 [id^="flowchart-"]
    let nodes = Array.from(container.querySelectorAll('[data-id]'))
    if (nodes.length === 0) {
      nodes = Array.from(container.querySelectorAll('[id^="flowchart-"]'))
    }
    if (nodes.length === 0) {
      if (!anchorWarnedRef.current) {
        console.warn('[向导图] SVG 中未找到可交互节点锚点（[data-id] / [id^="flowchart-"]），本次渲染降级为纯展示')
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

  const zoomIn = React.useCallback(() => setScale((prev) => clamp(prev + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)), [])
  const zoomOut = React.useCallback(() => setScale((prev) => clamp(prev - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)), [])
  const zoomReset = React.useCallback(() => setScale(INITIAL_SCALE), [])

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* 脉冲动画 + 可点指针注入（AC-03/§5.3） */}
      <style>{PULSE_CSS}</style>
      {/* 缩放控件（MermaidBlock 同款：仅按钮不劫持滚轮） */}
      <div className="flex items-center justify-end gap-0.5 px-2 py-1 text-xs text-muted-foreground shrink-0">
        <button type="button" onClick={zoomOut} className="size-6 rounded hover:bg-muted/70 hover:text-foreground" title="缩小">−</button>
        <button type="button" onClick={zoomReset} className="px-1.5 h-6 rounded hover:bg-muted/70 hover:text-foreground tabular-nums min-w-[38px]" title="重置缩放">{Math.round(scale * 100)}%</button>
        <button type="button" onClick={zoomIn} className="size-6 rounded hover:bg-muted/70 hover:text-foreground" title="放大">＋</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto bg-background/40 border-t border-border/40">
        {renderFailed ? (
          // mermaid 解析失败降级：显示 DSL 源码 + 提示（信息不丢，PRD §九）
          <div className="p-2 text-xs text-muted-foreground">
            <div className="mb-1 text-destructive">图表渲染失败，已降级为源码显示</div>
            <pre className="whitespace-pre-wrap break-all text-[11px] leading-relaxed text-foreground/70">{dsl}</pre>
          </div>
        ) : !renderedSvg ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">流程图渲染中…</div>
        ) : (
          <div
            ref={containerRef}
            className="guide-flow-svg inline-block min-w-full p-3"
            style={{ zoom: scale }}
            dangerouslySetInnerHTML={{ __html: renderedSvg }}
          />
        )}
      </div>
    </div>
  )
}
