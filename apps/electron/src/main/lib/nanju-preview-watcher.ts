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

import { resolveCodingOutputPath } from './nanju-engineering-contract'
import { watch, type FSWatcher } from 'node:fs'
import { join, basename, sep } from 'node:path'
import { readdirSync, existsSync } from 'node:fs'
import { getWorkspaceFilesDir } from './config-paths'
import { getMainWindow as getStoredMainWindow } from './main-window-store'

/**
 * D8 S4′（R7-04）：产出文件写入 → 向导图「AC 审计中」（{主节点}_ATK）事实写入。
 *
 * 判据链（全部满足才写）：文件归因到 project-<id> → 路径精确等于当前阶段
 * PhaseNode.outputPath（S4′-2 stage/outputPath 匹配，防旧文件/他文件误触发）→
 * verifyPhaseOutput === null（S4′-4「首次达标」判据，复用同一函数勿自造）→
 * 阶段 requiresAC === true（R7-16：quick 全阶段 requiresAC=false 不写 ATK——ATK
 * 节点着色由序列推导兜底；iterative architecture 等写）→ tryAdvanceGuideSubStage
 * （内含 S4′-1 单调守卫 + write-then-emit）。lazy require 防模块初始化环。
 */
function maybeAdvanceAtkSubStage(workspaceSlug: string, fullPath: string): void {
  try {
    const { listNanjuProjects, tryAdvanceGuideSubStage } = require('./nanju-project') as typeof import('./nanju-project')
    const { getPhaseNode } = require('./nanju-router') as typeof import('./nanju-router')
    const { verifyPhaseOutput } = require('./nanju-router-gate') as typeof import('./nanju-router-gate')
    const { getGuideStageMainNodeId } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
    const filesRoot = getWorkspaceFilesDir(workspaceSlug)
    if (!fullPath.startsWith(filesRoot + sep)) return
    for (const project of listNanjuProjects(workspaceSlug)) {
      const projectDir = join(filesRoot, `project-${project.projectId}`)
      const node = getPhaseNode(project.mode, project.currentStage as import('./nanju-router').PhaseId)
      if (!node?.outputPath) continue
      const outputPath = node.id === 'coding' ? resolveCodingOutputPath(projectDir) : node.outputPath
      if (join(projectDir, outputPath) !== fullPath) continue
      if (node.requiresAC !== true) continue
      if (verifyPhaseOutput(workspaceSlug, project.projectId, project.currentStage as import('./nanju-router').PhaseId) !== null) continue
      const main = getGuideStageMainNodeId(project.currentStage)
      if (!main) continue
      tryAdvanceGuideSubStage(workspaceSlug, project.projectId, `${main}_ATK`)
      return
    }
  } catch { /* 向导图写入失败不影响预览通知 */ }
}

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
 *
 * 注意：不接收 BrowserWindow 引用，而是在事件到达时动态获取主窗——
 * 1) 主窗可能被销毁重建（托盘恢复 / second-instance 唤起等），启动时捕获的引用会失效；
 * 2) 必须使用 main-window-store 维护的主窗引用，禁止 BrowserWindow.getAllWindows()[0]——
 *    quick-task 等辅助窗口一旦排到窗口列表首位（主窗重建后即如此），
 *    预览事件会全部发给用户看不见的隐藏窗口，导致预览面板永远不弹出。
 */
export function startNanjuHtmlWatcher(workspaceSlug: string): void {
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

          // D8 S4′：产出写入 → 归因+达标+requiresAC → ATK（失败不影响下方预览通知）
          maybeAdvanceAtkSubStage(workspaceSlug, fullPath)

          const ext = filename.toLowerCase().endsWith('.md') ? '文档' : 'HTML'
          console.log(`[南大预览] 检测到${ext}文件变更: ${filename}（完整路径: ${fullPath}）`)
          // 事件到达时动态取主窗引用：避免窗口销毁重建后闭包内旧引用失效，
          // 以及 getAllWindows()[0] 在辅助窗口（quick-task）排首时发错目标的问题
          const win = getStoredMainWindow()
          if (!win) {
            console.warn('[南大预览] 主窗口当前不可用，跳过本次预览通知')
            return
          }
          win.webContents.send(NANJU_PREVIEW_CHANNEL, {
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
