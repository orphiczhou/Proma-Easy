/**
 * Mermaid 图表渲染组件模块
 *
 * 提供使用 beautiful-mermaid 渲染 Mermaid 图表的 MermaidBlock 组件，
 * 以及底层渲染函数 renderMermaidSvg（DSL → SVG，供 GuideFlow 等复用）。
 */

export { MermaidBlock } from './MermaidBlock.tsx'
export { renderMermaidSvg } from './MermaidBlock.tsx'
