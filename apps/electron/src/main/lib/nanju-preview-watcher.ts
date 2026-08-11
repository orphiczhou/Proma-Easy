/**
 * 南大项目 HTML 原型自动预览
 *
 * 监听工作区文件变化，当检测到新的 .html 文件时，
 * 通知渲染进程自动打开预览面板。
 */

import type { BrowserWindow } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { join, basename } from 'node:path'
import { getWorkspaceFilesDir } from './config-paths'

const NANJU_PREVIEW_CHANNEL = 'nanju:html-preview-detected'

let htmlWatcher: FSWatcher | null = null

/**
 * 启动 HTML 文件监听。
 * 当工作区中出现新的 .html 文件时，通知渲染进程。
 */
export function startNanjuHtmlWatcher(mainWindow: BrowserWindow, workspaceSlug: string): void {
  stopNanjuHtmlWatcher()

  const watchDir = getWorkspaceFilesDir(workspaceSlug)
  try {
    htmlWatcher = watch(watchDir, { recursive: false }, (_eventType, filename) => {
      if (!filename) return
      if (!filename.endsWith('.html') && !filename.endsWith('.htm')) return

      // 通知渲染进程检测到 HTML 文件
      const fullPath = join(watchDir, filename)
      console.log(`[南大预览] 检测到 HTML 文件: ${filename}`)
      mainWindow.webContents.send(NANJU_PREVIEW_CHANNEL, {
        filePath: fullPath,
        fileName: basename(filename),
      })
    })
    console.log(`[南大预览] HTML 文件监听已启动: ${watchDir}`)
  } catch (e) {
    console.warn('[南大预览] 启动 HTML 监听失败:', e)
  }
}

export function stopNanjuHtmlWatcher(): void {
  if (htmlWatcher) {
    htmlWatcher.close()
    htmlWatcher = null
  }
}

export { NANJU_PREVIEW_CHANNEL }
