import * as React from 'react'
import { renderMermaidSvg } from '@proma/ui'
import { resolveGuideNodeTarget, type GuideNodeTarget } from './guide-dsl'
import { buildDivergenceWarningText } from './useNanjuGuideData'

interface GuideFlowProps {
  dsl: string
  onNodeClick: (target: GuideNodeTarget) => void
  /**
   * W18 Wave3：阶段偏差观测（弱断言）：未来阶段产出文件已存在且 >100B 的记录；
   * 非空时顶部渲染 st-warning 警示条（非阻断，用户裁决 D4：仅展示不拦截）。
   * 结构与主进程 StageDivergence 同构（此处保持展示组件自包含的最小字段面）。
   */
  divergences?: Array<{ stage: string; artifact: string; observedAt?: string }>
  /**
   * active 回归边（W2c，v0.17.69）：主进程 regressionEvents 投影中 active=true 的边
   *（阶段 id 对）。SVG 后处理按 mermaid 边 path 的 data-id 前缀匹配（v11.15.0 实测：
   * getEdgeId 生成 `L_{from}_{to}_{counter}`，insertEdge 写入 path[data-id]；flowchart
   * 边 class 仅 edge-thickness/pattern/flowchart-link 三段式，**无端点前缀 class**——
   * AC 审计 A2 勘误：原 LS/ES 选择器在本仓锁定版本永不命中，已废弃）。
   */
  activeRegressionEdges?: Array<{ from: string; to: string }>
}

/**
 * 回归边端点映射：阶段 id → 边的卖际节点 id（mermaid 边 data-id 的端点段）。
 * 一般阶段主节点与阶段 id 同名（REQ/PROTO/…）；testing 两条分流边从 TEST_GWT
 * 出发而非 TEST 主节点（忠实于 v0.17.63 失败分流的卖际源点）。
 */
const REGRESSION_EDGE_NODE_ID: Record<string, string> = {
  testing: 'TEST_GWT',
}

/** 回归边（阶段 id 对）→ mermaid 边 data-id 前缀选择器 */
function regressionEdgeSelector(edge: { from: string; to: string }): string {
  const fromNode = REGRESSION_EDGE_NODE_ID[edge.from] ?? edge.from
  const toNode = REGRESSION_EDGE_NODE_ID[edge.to] ?? edge.to
  return `path[data-id^="L_${fromNode}_${toNode}_"]`
}

const ZOOM_MIN = 0.3
const ZOOM_MAX = 3
const ZOOM_STEP = 0.2
/** 初始缩放：68%（用户反馈 2026-08-20 二轮：70→68，与面板宽度配合完全显示内容） */
const INITIAL_SCALE = 0.68
const DEBOUNCE_MS = 350

/** 缩放适配：svg 以原始像素尺寸渲染（不缩水），外层 transform: scale 控制视觉缩放 */
const PULSE_CSS = `
.guide-node-current { animation: guide-pulse 1.6s ease-in-out infinite; }
@keyframes guide-pulse { 0%,100% { filter: drop-shadow(0 0 2px rgba(79,70,229,.9)); } 50% { filter: drop-shadow(0 0 7px rgba(79,70,229,.55)); } }
.guide-edge-active { animation: guide-edge-pulse 1.6s ease-in-out infinite; }
@keyframes guide-edge-pulse { 0%,100% { stroke-opacity: .45; } 50% { stroke-opacity: 1; } }
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

export function GuideFlow({ dsl, onNodeClick, activeRegressionEdges, divergences }: GuideFlowProps): React.ReactElement {
  const [renderedSvg, setRenderedSvg] = React.useState<string | null>(null)
  const [renderFailed, setRenderFailed] = React.useState(false)

  /** W18 Wave3：偏差警示条文案（弱断言纯函数；空列表/undefined → null 不渲染） */
  const divergenceWarning = divergences !== undefined ? buildDivergenceWarningText(divergences) : null

  /** 视口变换：scale + translate（拖拽平移） */
  const [scale, setScale] = React.useState<number>(INITIAL_SCALE)
  const [pan, setPan] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragStateRef = React.useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null)

  const viewportRef = React.useRef<HTMLDivElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

  /** Y5：pan 边界约束（可拖出最多半个视口，防止图完全拖丢；缩放/重置/适配可找回） */
  const clampPan = React.useCallback((value: number, axis: 'x' | 'y'): number => {
    const viewport = viewportRef.current
    const svgEl = containerRef.current?.querySelector('svg')
    if (!viewport || !svgEl) return value
    const viewBox = svgEl.getAttribute('viewBox')
    const [, , vbW = 0, vbH = 0] = (viewBox ?? '').split(/\s+/).map(Number)
    const w = (vbW > 0 ? vbW : svgEl.clientWidth) * scale
    const h = (vbH > 0 ? vbH : svgEl.clientHeight) * scale
    if (axis === 'x') {
      const min = Math.min(0, viewport.clientWidth - w) - viewport.clientWidth / 2
      const max = Math.max(0, viewport.clientWidth - w) + viewport.clientWidth / 2
      return clamp(value, min, max)
    }
    const min = Math.min(0, viewport.clientHeight - h) - viewport.clientHeight / 2
    const max = Math.max(0, viewport.clientHeight - h) + viewport.clientHeight / 2
    return clamp(value, min, max)
  }, [scale])

  /** 初始布局：68% 缩放 + 左右居中 + 顶部对齐（顶部留 8px 防边框遮节点）；
   *  内容完全显示优先：面板过窄时自动降到 fit 缩放（68% 与适配取小者），
   *  保证整图不横向溢出被遮。 */
  const applyInitialLayout = React.useCallback((): void => {
    const viewport = viewportRef.current
    const svgEl = containerRef.current?.querySelector('svg')
    if (!viewport || !svgEl) {
      setScale(INITIAL_SCALE)
      setPan({ x: 0, y: 8 })
      return
    }
    const viewBox = svgEl.getAttribute('viewBox')
    const [, , vbW = 0] = (viewBox ?? '').split(/\s+/).map(Number)
    const renderedW = vbW > 0 ? vbW : svgEl.clientWidth
    // 内容完全显示：图宽超过视口时用 fit（68% 与适配取小）
    const fitScale = (viewport.clientWidth - 24) / renderedW
    const effective = Math.min(INITIAL_SCALE, clamp(fitScale, ZOOM_MIN, ZOOM_MAX))
    const scaledW = renderedW * effective
    setScale(effective)
    setPan({ x: (viewport.clientWidth - scaledW) / 2, y: 8 })
  }, [])
  const dslRef = React.useRef(dsl)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = React.useRef(0)
  const anchorWarnedRef = React.useRef(false)
  /** 初始布局（70% 居中）是否已应用：首次渲染/DSL 变化后应用一次 */
  const initialLayoutAppliedRef = React.useRef(false)
  /** 用户是否已手动操作过视图（拖拽/缩放/滚动）；未操作时面板 resize 可自动重居中 */
  const userInteractedRef = React.useRef(false)

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
    // DSL 变化后重新居中（下次 SVG 渲染完成时应用初始布局）；用户操作痕迹一并重置
    initialLayoutAppliedRef.current = false
    userInteractedRef.current = false
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
      // 必须显式按 viewBox 设置宽高：只清空 width/height 会让 SVG 布局尺寸塌陷为 0，
      // 图形视觉完全不可见（v0.17.41 实测）。原始像素尺寸 + 外层 transform 缩放。
      let viewBox = svgEl.getAttribute('viewBox')
      if (!viewBox) {
        // beautiful-mermaid 输出带 viewBox；官方兜底路径有 width/height 属性，转 viewBox
        const w = svgEl.getAttribute('data-orig-width') || svgEl.getAttribute('width')
        const h = svgEl.getAttribute('data-orig-height') || svgEl.getAttribute('height')
        if (w && h && !/%/.test(w)) {
          viewBox = `0 0 ${w} ${h}`
          svgEl.setAttribute('viewBox', viewBox)
        }
      }
      if (viewBox) {
        const [, , vbW = 0, vbH = 0] = viewBox.split(/\s+/).map(Number)
        if (vbW > 0 && vbH > 0) {
          svgEl.style.width = `${vbW}px`
          svgEl.style.height = `${vbH}px`
        }
      }
    }

    // 首次渲染/DSL 变化后应用初始布局：70% 缩放 + 左右居中（顶部对齐）
    if (!initialLayoutAppliedRef.current) {
      initialLayoutAppliedRef.current = true
      // 尺寸已设置，稍等一帧让布局生效再居中
      requestAnimationFrame(() => { applyInitialLayout() })
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

    // W2c（v0.17.69）：active 回归边脉冲动画——按 mermaid 边 path 的 data-id 前缀匹配
    //（`L_{from}_{to}_{counter}`，v11.15.0 实测锚点；端点用 REGRESSION_EDGE_NODE_ID
    // 映射，testing 分流边从 TEST_GWT 出发），命中加 guide-edge-active。
    // 部署批次以 querySelector 命中数 > 0 验证（AC 审计 A2 收口条件）。
    if (activeRegressionEdges && activeRegressionEdges.length > 0) {
      for (const edge of activeRegressionEdges) {
        const paths = container.querySelectorAll(regressionEdgeSelector(edge))
        paths.forEach((p) => p.classList.add('guide-edge-active'))
      }
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [renderedSvg, onNodeClick, applyInitialLayout, activeRegressionEdges])

  // 拖拽平移：仅 Ctrl+拖动（用户反馈：拖动需按住 Ctrl，避免与常规操作冲突）；
  // pointer capture 确保 SVG 子元素不吞事件、指针移出仍持续跟踪
  const handlePointerDown = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // 仅主键拖拽；必须按住 Ctrl（Ctrl 组合键兼容：仅 Ctrl+左键进入拖拽）
    if (e.button !== 0 || !e.ctrlKey) return
    e.preventDefault()
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, baseX: pan.x, baseY: pan.y, moved: false }
    // 捕获指针：即使移到 svg 子元素/视口外，move/up 仍派发给本元素
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 合成事件无指针时忽略 */ }
  }, [pan])

  const handlePointerMove = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current
    if (!st) return
    const dx = e.clientX - st.startX
    const dy = e.clientY - st.startY
    if (!st.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) st.moved = true
    if (!st.moved) return
    userInteractedRef.current = true
    setPan({ x: clampPan(st.baseX + dx, 'x'), y: clampPan(st.baseY + dy, 'y') })
  }, [clampPan])

  const handlePointerUp = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 未捕获时忽略 */ }
    // moved 标志保留到 click 事件后再清（click 在 pointerup 后同步触发）
    setTimeout(() => { dragStateRef.current = null }, 0)
  }, [])

  // Y3：拖拽中松开 Ctrl 即结束拖拽（与“按住 Ctrl 拖拽”契约一致）
  React.useEffect(() => {
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Control') dragStateRef.current = null
    }
    window.addEventListener('keyup', onKeyUp)
    return () => window.removeEventListener('keyup', onKeyUp)
  }, [])

  /** 视口中心锚定缩放（地图式）：缩放时眼前内容原地放大/缩小，而不是左上角锚定导致内容跑出视野
   *  数学：视口中心点 C 在内容坐标系的位置保持不变 → pan' = C - (C - pan) * (newScale/oldScale) */
  const zoomAtCenter = React.useCallback((factor: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const cx = viewport.clientWidth / 2
    const cy = viewport.clientHeight / 2
    setScale((prevScale) => {
      const next = clamp(prevScale * factor, ZOOM_MIN, ZOOM_MAX)
      if (next === prevScale) return prevScale
      setPan((prevPan) => ({
        x: cx - (cx - prevPan.x) * (next / prevScale),
        y: cy - (cy - prevPan.y) * (next / prevScale),
      }))
      return next
    })
  }, [])

  /** 鼠标位置锚定缩放（滚轮用）：光标处的内容点保持在光标下 */
  const zoomAtPoint = React.useCallback((factor: number, px: number, py: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const cx = px - rect.left
    const cy = py - rect.top
    setScale((prevScale) => {
      const next = clamp(prevScale * factor, ZOOM_MIN, ZOOM_MAX)
      if (next === prevScale) return prevScale
      setPan((prevPan) => ({
        x: cx - (cx - prevPan.x) * (next / prevScale),
        y: cy - (cy - prevPan.y) * (next / prevScale),
      }))
      return next
    })
  }, [])

  // Y4：面板宽度变化时（用户未手动操作过视图）自动重新居中，避免侧栏 resize 后图停在旧位置
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    let lastW = viewport.clientWidth
    const observer = new ResizeObserver(() => {
      const w = viewport.clientWidth
      if (w === lastW) return
      lastW = w
      if (!userInteractedRef.current && initialLayoutAppliedRef.current) {
        applyInitialLayout()
      }
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [applyInitialLayout])

  // 滚轮（用户反馈 2026-08-20；AC-R2 必修 2026-08-21）：
  // - Ctrl+滚轮 = 缩放（光标锚定，地图式）；默认 = 上下滚动；Shift = 横向滚动
  // - 原生非被动监听（范式同 TabBar/CalendarWorkspace/DiffTabContent）：React onWheel 走根委托且 passive，
  //   preventDefault 无效 → Ctrl+滚轮时 Electron 默认整应用缩放与图缩放同时发生（macOS 捏合同源）
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      userInteractedRef.current = true
      if (e.ctrlKey) {
        zoomAtPoint(e.deltaY < 0 ? 1.12 : 0.89, e.clientX, e.clientY)
        return
      }
      // Y6：deltaMode 归一化（line=16px，page=视口高）
      const vpH = viewport.clientHeight
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vpH : 1
      const dy = e.deltaY * unit
      if (e.shiftKey) {
        setPan((p) => ({ ...p, x: clampPan(p.x - dy, 'x') }))
        return
      }
      setPan((p) => ({ ...p, y: clampPan(p.y - dy, 'y') }))
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [zoomAtPoint, clampPan])

  /** 初始布局：70% 缩放 + 左右居中（顶部对齐） */
  const zoomIn = React.useCallback(() => { userInteractedRef.current = true; zoomAtCenter(1 + ZOOM_STEP) }, [zoomAtCenter])
  const zoomOut = React.useCallback(() => { userInteractedRef.current = true; zoomAtCenter(1 - ZOOM_STEP) }, [zoomAtCenter])
  const zoomReset = React.useCallback(() => { userInteractedRef.current = false; applyInitialLayout() }, [applyInitialLayout])
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
    userInteractedRef.current = true
    setScale(fit)
    // Y5：与 reset/初始一致，水平居中（图中线对齐视口中线）
    setPan({ x: (viewport.clientWidth - vbW * fit) / 2, y: 0 })
  }, [zoomReset])

  return (
    <div className="flex flex-col min-h-0 h-full">
      <style>{PULSE_CSS}</style>
      {/* W18 Wave3：阶段偏差警示条（st-warning，非阻断）——只说「可能存在越阶段施工」
          （弱断言 SHOULD-6：观测≠施工事实），不拦截任何推进/交互 */}
      {divergenceWarning !== null && (
        <div
          className="st-warning flex items-start gap-1 mx-2 mt-1 px-2 py-1 rounded text-[11px] leading-relaxed shrink-0 bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30"
          role="status"
        >
          <span className="break-all">{divergenceWarning}</span>
        </div>
      )}
      <div className="flex items-center justify-end gap-0.5 px-2 py-1 text-xs text-muted-foreground shrink-0">
        <button type="button" onClick={zoomOut} className="size-6 rounded hover:bg-muted/70 hover:text-foreground" title="缩小">−</button>
        <button type="button" onClick={zoomReset} className="px-1.5 h-6 rounded hover:bg-muted/70 hover:text-foreground tabular-nums min-w-[38px]" title="重置缩放">{Math.round(scale * 100)}%</button>
        <button type="button" onClick={zoomIn} className="size-6 rounded hover:bg-muted/70 hover:text-foreground" title="放大">＋</button>
        <button type="button" onClick={zoomFit} className="px-1.5 h-6 rounded hover:bg-muted/70 hover:text-foreground" title="适配面板宽度">⤢</button>
      </div>
      <div
        ref={viewportRef}
        className="flex-1 min-h-0 overflow-hidden bg-content-area border-t border-border/40 cursor-grab active:cursor-grabbing select-none [touch-action:none]"
        title="Ctrl+拖动平移 · Ctrl+滚轮缩放 · 滚轮上下滚动 · Shift+滚轮横向滚动"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
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
