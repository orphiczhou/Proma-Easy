/**
 * 南大项目文件自动预览
 *
 * 监听工作区文件变化（递归），当检测到 .html 或 .md 文件写入/修改时，
 * 通知渲染进程自动打开预览面板。
 * .html → UX 原型预览
 * .md → PRD / 架构文档预览
 *
 * 注意：Node.js fs.watch 的 recursive 选项仅在 macOS/Windows 支持，
 * Linux 上会被忽略（只监听顶层目录）。因此需要手动递归遍历子目录
 * 并为每个目录分别创建 watcher。
 */

import type { BrowserWindow } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { join, basename } from 'node:path'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { getWorkspaceFilesDir } from './config-paths'

const NANJU_PREVIEW_CHANNEL = 'nanju:html-preview-detected'

/** 所有活跃的 watcher（支持多目录递归监听） */
const watchers: FSWatcher[] = []

/** 已通知过的文件去重（避免短时间内重复通知） */
const notifiedFiles = new Map<string, number>()
const DEDUP_INTERVAL_MS = 3000

/**
 * 递归收集目录及其子目录列表。
 */
function collectDirs(dir: string): string[] {
  const result: string[] = [dir]
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subDir = join(dir, entry.name)
        // 递归收集，跳过 node_modules 等无关目录
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        result.push(...collectDirs(subDir))
      }
    }
  } catch {
    // 目录读取失败，静默跳过
  }
  return result
}

/**
 * 判断文件是否应该触发预览通知。
 */
function shouldNotify(filename: string): boolean {
  if (!filename) return false
  const lower = filename.toLowerCase()
  if (!lower.endsWith('.html') && !lower.endsWith('.htm') && !lower.endsWith('.md')) return false
  // 忽略 _ 开头的元数据文件
  if (basename(filename).startsWith('_')) return false
  return true
}

/**
 * 启动文件监听（递归，跨平台兼容）。
 * 当工作区中出现新的 .html 或 .md 文件时，通知渲染进程。
 */
export function startNanjuHtmlWatcher(mainWindow: BrowserWindow, workspaceSlug: string): void {
  stopNanjuHtmlWatcher()

  const watchDir = getWorkspaceFilesDir(workspaceSlug)
  if (!existsSync(watchDir)) {
    console.warn(`[南大预览] 监听目录不存在: ${watchDir}`)
    return
  }

  try {
    // 递归收集所有子目录（Linux 上 fs.watch 不支持 recursive）
    const allDirs = collectDirs(watchDir)
    let watchedCount = 0

    for (const dir of allDirs) {
      try {
        const w = watch(dir, (_eventType, filenameRaw) => {
          const filename = filenameRaw ?? ''
          if (!shouldNotify(filename)) return

          const fullPath = join(dir, filename)
          // 去重：3 秒内同一文件不重复通知
          const now = Date.now()
          const lastNotify = notifiedFiles.get(fullPath)
          if (lastNotify && now - lastNotify < DEDUP_INTERVAL_MS) return
          notifiedFiles.set(fullPath, now)

          // 验证文件确实存在（可能收到删除事件）
          if (!existsSync(fullPath)) return

          const ext = filename.toLowerCase().endsWith('.md') ? '文档' : 'HTML'
          console.log(`[南大预览] 检测到${ext}文件变更: ${filename}（完整路径: ${fullPath}）`)
          mainWindow.webContents.send(NANJU_PREVIEW_CHANNEL, {
            filePath: fullPath,
            fileName: basename(filename),
          })
        })
        watchers.push(w)
        watchedCount++
      } catch (e) {
        console.warn(`[南大预览] 监听子目录失败: ${dir}`, e)
      }
    }

    console.log(`[南大预览] 文件监听已启动: ${watchedCount} 个目录（根: ${watchDir}）`)
  } catch (e) {
    console.warn('[南大预览] 启动文件监听失败:', e)
  }
}

export function stopNanjuHtmlWatcher(): void {
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      // watcher 关闭失败，静默处理
    }
  }
  watchers.length = 0
  notifiedFiles.clear()
}

export { NANJU_PREVIEW_CHANNEL }
