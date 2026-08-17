import { Tray, Menu, app, nativeImage, BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'path'
import { existsSync } from 'fs'
import { listAgentSessions } from './lib/agent-session-manager'
import { listAgentWorkspaces } from './lib/agent-workspace-manager'
import { isAgentSessionActive } from './lib/agent-service'
import { createTrayMenuModel, type TrayRecentSessionItem } from './lib/tray-menu-model'

let tray: Tray | null = null
// Linux 下托盘图标是否真正注册成功（DBus 上存在本进程的 StatusNotifierItem name）。
// Electron 构造 Tray 不会报错，但在远程桌面（xrdp）/无托盘面板环境下 SNI 注册
// 静默失败，图标无处显示、菜单无从访问——此时 close-to-tray 会让用户无法退出应用。
let trayRegistered = process.platform !== 'linux'

/** 托盘图标是否真实可用（非 Linux 平台恒 true，Linux 以 SNI 注册实测为准） */
export function isTrayRegistered(): boolean {
  return trayRegistered
}

/**
 * Linux: 延迟检测 SNI 注册结果。Electron 注册的 well-known name 形如
 * org.kde.StatusNotifierItem-<pid>-1；若 ListNames 中查不到，说明托盘
 * 不可用（watcher 不存在或未接受注册）。
 */
function checkTrayRegistration(): void {
  if (process.platform !== 'linux' || !tray) return
  execFile(
    'dbus-send',
    [
      '--session',
      '--print-reply',
      '--dest=org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus.ListNames',
    ],
    { timeout: 3000 },
    (error, stdout) => {
      if (error) {
        console.warn('[托盘] 无法查询 DBus（' + error.message + '），按托盘不可用处理')
        trayRegistered = false
        return
      }
      const marker = `StatusNotifierItem-${process.pid}-`
      trayRegistered = stdout.includes(marker)
      if (trayRegistered) {
        console.log('[托盘] SNI 注册确认，关闭按钮将隐藏到托盘')
      } else {
        console.warn('[托盘] SNI 未注册成功（无托盘面板/远程桌面环境），关闭按钮将直接退出')
      }
    },
  )
}

export interface TrayActions {
  showMainWindow: () => void
  showPlanningWindow: () => void
  openAgentSession: (sessionId: string, title: string) => void
  createChatSession: () => void
  createAgentSession: () => void
  onTrayMouseEnter?: (bounds: Electron.Rectangle) => void
  onTrayMouseMove?: (bounds: Electron.Rectangle) => void
  onTrayMouseLeave?: () => void
}

let flashTimer: ReturnType<typeof setInterval> | null = null

function clearTrayFlashTimer(): void {
  if (flashTimer) {
    clearInterval(flashTimer)
    flashTimer = null
  }
}

/**
 * 获取托盘图标路径
 * 所有平台统一使用 Template 图标（PNG）
 */
function getTrayIconPath(): string {
  // macOS 使用 Template 图标；Linux/Windows 使用主应用图标
  if (process.platform === 'darwin') {
    const resourcesDir = app.isPackaged
      ? join(process.resourcesPath, 'proma-logos')
      : join(__dirname, 'resources/proma-logos')
    return join(resourcesDir, 'iconTemplate.png')
  }
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, 'resources')
  return join(resourcesDir, 'icon.png')
}

/** 显示主窗口 */
function showMainWindow(): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) return
  const mainWindow = windows[0]!
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

function getDefaultTrayActions(): TrayActions {
  return {
    showMainWindow,
    showPlanningWindow: showMainWindow,
    openAgentSession: () => showMainWindow(),
    createChatSession: () => showMainWindow(),
    createAgentSession: () => showMainWindow(),
  }
}

function createRecentSessionMenuItem(
  item: TrayRecentSessionItem,
  actions: TrayActions,
): Electron.MenuItemConstructorOptions {
  return {
    label: item.title,
    sublabel: item.subtitle,
    click: () => actions.openAgentSession(item.id, item.title),
  }
}

function buildTrayMenu(actions: TrayActions): Menu {
  const sessions = listAgentSessions()
  const runningSessionIds = new Set(
    sessions
      .filter((session) => isAgentSessionActive(session.id))
      .map((session) => session.id)
  )
  const model = createTrayMenuModel(sessions, listAgentWorkspaces(), runningSessionIds)
  const runningItems = model.runningSessions.map((item) => createRecentSessionMenuItem(item, actions))
  const recentItems = model.recentSessions.map((item) => createRecentSessionMenuItem(item, actions))
  const moreItems = model.moreSessions.map((item) => createRecentSessionMenuItem(item, actions))

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '任务/日程',
      click: () => actions.showPlanningWindow(),
    },
    { type: 'separator' },
    ...(runningItems.length > 0
      ? [
          { label: '运行中', enabled: false },
          ...runningItems,
          { type: 'separator' as const },
        ]
      : []),
    { label: '最近', enabled: false },
    ...(recentItems.length > 0
      ? recentItems
      : [{ label: '暂无最近会话', enabled: false }]),
    ...(moreItems.length > 0
      ? [{
          label: '更多',
          submenu: moreItems,
        }]
      : []),
    { type: 'separator' },
    {
      label: '新建对话',
      click: () => actions.createChatSession(),
    },
    {
      label: '新建 Agent 会话',
      click: () => actions.createAgentSession(),
    },
    { type: 'separator' },
    {
      label: '打开 Proma',
      click: () => actions.showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '退出 Proma',
      click: () => {
        app.quit()
      },
    },
  ]

  return Menu.buildFromTemplate(template)
}

function updateTrayMenu(actions: TrayActions): Menu | null {
  if (!tray) return null
  const contextMenu = buildTrayMenu(actions)
  tray.setContextMenu(contextMenu)
  return contextMenu
}

/**
 * 创建系统托盘图标和菜单
 */
export function createTray(actionsInput?: Partial<TrayActions>): Tray | null {
  const iconPath = getTrayIconPath()
  const actions = { ...getDefaultTrayActions(), ...actionsInput }
  const hasIcon = existsSync(iconPath)

  if (!hasIcon && process.platform !== 'win32') {
    console.warn('Tray icon not found at:', iconPath)
    return null
  }

  try {
    const image = hasIcon ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()

    // macOS: 标记为 Template 图像；Linux / Windows: 缩放到适合托盘的尺寸
    if (process.platform === 'darwin') {
      image.setTemplateImage(true)
    } else {
      const resized = image.resize({ width: 22, height: 22 })
      tray = new Tray(resized)
    }

    if (!tray) tray = new Tray(image)

    tray.setToolTip(process.platform === 'win32' ? '' : 'Proma')

    updateTrayMenu(actions)

    tray.on('click', () => {
      if (process.platform === 'win32') {
        actions.showMainWindow()
        return
      }
      const contextMenu = updateTrayMenu(actions)
      if (contextMenu) {
        tray?.popUpContextMenu(contextMenu)
      }
    })

    tray.on('right-click', () => {
      updateTrayMenu(actions)
    })

    if (process.platform === 'win32') {
      tray.on('mouse-enter', () => {
        if (!tray) return
        actions.onTrayMouseEnter?.(tray.getBounds())
      })
      tray.on('mouse-move', () => {
        if (!tray) return
        actions.onTrayMouseMove?.(tray.getBounds())
      })
      tray.on('mouse-leave', () => {
        actions.onTrayMouseLeave?.()
      })
    }

    // SNI 注册是异步的，延迟检测注册结果（决定 Linux close 按钮语义）
    setTimeout(checkTrayRegistration, 1500)

    console.log('System tray created')
    return tray
  } catch (error) {
    console.error('Failed to create system tray:', error)
    return null
  }
}

/**
 * 销毁系统托盘
 */
export function destroyTray(): void {
  clearTrayFlashTimer()
  if (tray) {
    tray.destroy()
    tray = null
    trayRegistered = process.platform !== 'linux'
  }
}

/**
 * 获取当前托盘实例
 */
export function getTray(): Tray | null {
  return tray
}

/**
 * 切换托盘图标闪烁（仅 Windows）
 */
export function setTrayFlash(on: boolean): void {
  if (process.platform !== 'win32') return
  clearTrayFlashTimer()
  const baseIcon = nativeImage.createFromPath(getTrayIconPath())
  if (!on) {
    tray?.setImage(baseIcon)
    return
  }
  if (!tray) return
  let showIdle = true
  flashTimer = setInterval(() => {
    showIdle = !showIdle
    tray?.setImage(showIdle ? baseIcon : nativeImage.createEmpty())
  }, 500)
}
