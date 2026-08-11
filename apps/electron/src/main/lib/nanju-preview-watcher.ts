/**
 * 南大项目文件自动预览
 *
 * 监听工作区文件变化（递归），当检测到新的 .html 或 .md 文件时，
 * 通知渲染进程自动打开预览面板。
 * .html → UX 原型预览
 * .md → PRD / 架构文档预览
 */

import type { BrowserWindow } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { getWorkspaceFilesDir } from './config-paths'

const NANJU_PREVIEW_CHANNEL = 'nanju:html-preview-detected'

let fileWatcher: FSWatcher | null = null

/**
 * 启动文件监听（递归）。
 * 当工作区中出现新的 .html 或 .md 文件时，通知渲染进程。
 */
export function startNanjuHtmlWatcher(mainWindow: BrowserWindow, workspaceSlug: string): void {
  stopNanjuHtmlWatcher()

  const watchDir = getWorkspaceFilesDir(workspaceSlug)
  try {
    fileWatcher = watch(watchDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      // 监听 .html 和 .md 文件
      if (!filename.endsWith('.html') && !filename.endsWith('.htm') && !filename.endsWith('.md')) return
      // 忽略 _ 开头的元数据文件
      if (basename(filename).startsWith('_')) return

      const fullPath = join(watchDir, filename)
      const ext = filename.endsWith('.md') ? '文档' : 'HTML'
      console.log(`[南大预览] 检测到${ext}文件: ${filename}`)
      mainWindow.webContents.send(NANJU_PREVIEW_CHANNEL, {
        filePath: fullPath,
        fileName: basename(filename),
      })
    })
    console.log(`[南大预览] 文件监听已启动（递归）: ${watchDir}`)
  } catch (e) {
    console.warn('[南大预览] 启动文件监听失败:', e)
  }
}

export function stopNanjuHtmlWatcher(): void {
  if (fileWatcher) {
    fileWatcher.close()
    fileWatcher = null
  }
}

export { NANJU_PREVIEW_CHANNEL }
