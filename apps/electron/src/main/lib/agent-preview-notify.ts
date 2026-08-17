/**
 * Agent 会话工具 open_preview — 主动在 UI 右侧分屏打开文档/图片预览
 *
 * 与南大向导的文件监听预览（nanju-preview-watcher）共享后半段链路：
 * 主进程 webContents.send → 渲染进程 useGlobalAgentListeners 全局监听
 * → jotai preview atoms → PreviewPanel 分屏渲染。
 * 区别仅在触发源：本模块由 Agent 会话工具显式调用（会话可调用），
 * 南大链路由文件系统变更自动触发。
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { getMainWindow } from './main-window-store'

/** 渲染进程监听的 IPC 通道（preload 同名桥接） */
export const AGENT_OPEN_PREVIEW_CHANNEL = 'agent:open-preview-request'

/** 允许预览的文件扩展名白名单（与 PreviewPanel 支持的类型对齐） */
const PREVIEWABLE_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdx',
  '.html', '.htm',
  '.txt', '.json', '.yaml', '.yml', '.csv', '.log',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
])

export interface PreviewRequestResult {
  ok: boolean
  filePath?: string
  error?: string
}

/**
 * 校验待预览文件（纯函数，便于单测）。
 *
 * - 必须能解析为存在的普通文件（相对路径相对 baseDir 解析）
 * - 扩展名必须在白名单内
 */
export function validatePreviewFile(inputFilePath: string, baseDir?: string): PreviewRequestResult {
  const filePath = isAbsolute(inputFilePath)
    ? inputFilePath
    : resolve(baseDir ?? process.cwd(), inputFilePath)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return { ok: false, error: `文件不存在: ${filePath}` }
  }
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot) : ''
  if (!PREVIEWABLE_EXTENSIONS.has(ext)) {
    return { ok: false, error: `不支持的预览类型 "${ext}"（支持: ${Array.from(PREVIEWABLE_EXTENSIONS).join(' ')}）` }
  }
  return { ok: true, filePath }
}

/**
 * 向主窗口渲染进程发送打开预览事件。
 *
 * sessionId 由调用方（工具上下文）注入而非 Agent 参数控制，
 * 防止跨会话注入预览状态。
 */
export function sendAgentOpenPreview(sessionId: string, filePath: string, baseDir?: string): PreviewRequestResult {
  const validated = validatePreviewFile(filePath, baseDir)
  if (!validated.ok) return validated

  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return { ok: false, error: '主窗口当前不可用，无法打开预览' }
  }
  win.webContents.send(AGENT_OPEN_PREVIEW_CHANNEL, {
    sessionId,
    filePath: validated.filePath,
    // 刷新版本号：同路径重复 open 时驱动渲染端重挂载预览组件，拉取最新文件内容
    version: Date.now(),
  })
  console.log(`[Agent 预览] open_preview 已发送: ${validated.filePath}（session ${sessionId}）`)
  return { ok: true, filePath: validated.filePath }
}
