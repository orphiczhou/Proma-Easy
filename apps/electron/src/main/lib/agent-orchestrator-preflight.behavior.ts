/**
 * W19 缺陷B：resolveWorkspaceMismatchSelfHeal 行为级测试（fixture）。
 *
 * ⚠️ 本文件故意不带 .test/.spec 后缀：agent-orchestrator 的静态依赖图（electron +
 * agent-service 环状初始化）必须 mock.module('electron') 并预载 agent-service 才能导入，
 * 而这些 mock 会进程级污染同批运行的其他测试文件（agent-session-manager 被早先文件
 * 部分替换后，本文件导入即 SyntaxError；反向同理，见 nanju-confirm-advance.test.ts
 * 顶部同类警告）。因此由 agent-orchestrator-preflight.test.ts 以 Bun.spawn 子进程
 * 隔离执行本文件（bun test <显式路径> 可运行任意命名文件，且不会被目录级发现）。
 */
import { describe, expect, mock, test } from 'bun:test'

process.env.PROMA_AGENT_RUNTIME = 'off'
const electronMock: Record<string, unknown> = {
  app: { isPackaged: false, getPath: () => '/tmp', getName: () => 'proma-test', on: () => {}, whenReady: async () => {}, commandLine: { appendSwitch: () => {} } },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
  BrowserWindow: class { static getAllWindows() { return [] } },
  WebContentsView: class {},
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  ipcRenderer: { invoke: async () => {}, on: () => {}, send: () => {} },
  contextBridge: { exposeInMainWorld: () => {} },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  net: { request: () => ({ on: () => {}, end: () => {} }) },
  globalShortcut: { register: () => {}, unregisterAll: () => {} },
  nativeImage: { createFromPath: () => ({}) },
  powerMonitor: { on: () => {} },
  powerSaveBlocker: { start: () => 0, stop: () => {} },
  Notification: class { constructor() {} static isSupported() { return false } show() {} },
  nativeTheme: { shouldUseDarkColors: false },
  systemPreferences: { getUserDefault: () => '' },
  clipboard: { readText: () => '', writeText: () => {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  session: { defaultSession: {} },
  protocol: { registerFileProtocol: () => {}, handle: () => {} },
  Menu: class { static buildFromTemplate() { return {} } },
  Tray: class {},
  utilityProcess: { fork: () => ({ on: () => {}, kill: () => {} }) },
  MessageChannelMain: class {},
  webUtils: { getPathForFile: () => '' },
}
mock.module('electron', () => electronMock)
// 先导入 agent-service 完成模块级装配（new AgentOrchestrator），否则环状初始化触发
// TDZ：Cannot access 'AgentOrchestrator' before initialization。
await import('./agent-service')
const { resolveWorkspaceMismatchSelfHeal } = await import('./agent-orchestrator')

describe('resolveWorkspaceMismatchSelfHeal 判定矩阵（S 级：真实函数执行，子进程隔离）', () => {
  test('E2E 实测方向：空会话已绑定南大项目 + 过期请求工作区 → 保持会话工作区（不改绑，保护项目绑定）', () => {
    expect(resolveWorkspaceMismatchSelfHeal({
      sessionWorkspaceId: 'ws-nanju',
      requestedWorkspaceId: 'ws-default',
      sessionHasRunHistory: false,
      sessionWorkspaceIsNanjuProjectBound: true,
      requestedWorkspaceExists: true,
    })).toBe('keep-session')
    // 过期请求指向幽灵工作区时同样以会话为准（请求侧是垃圾导航状态）
    expect(resolveWorkspaceMismatchSelfHeal({
      sessionWorkspaceId: 'ws-nanju',
      requestedWorkspaceId: 'ws-ghost',
      sessionHasRunHistory: false,
      sessionWorkspaceIsNanjuProjectBound: true,
      requestedWorkspaceExists: false,
    })).toBe('keep-session')
  })

  test('工单红测试1：空会话（默认工作区）+ 请求南大工作区存在 + 未绑定 → 改绑继续（不再硬拒）', () => {
    expect(resolveWorkspaceMismatchSelfHeal({
      sessionWorkspaceId: 'ws-default',
      requestedWorkspaceId: 'ws-nanju',
      sessionHasRunHistory: false,
      sessionWorkspaceIsNanjuProjectBound: false,
      requestedWorkspaceExists: true,
    })).toBe('rebind')
  })

  test('工单红测试2：会话已有运行历史（sdkSessionId 非空）→ 仍硬拒（保护既有归属，两种绑定形态都拒）', () => {
    expect(resolveWorkspaceMismatchSelfHeal({
      sessionWorkspaceId: 'ws-nanju',
      requestedWorkspaceId: 'ws-default',
      sessionHasRunHistory: true,
      sessionWorkspaceIsNanjuProjectBound: true,
      requestedWorkspaceExists: true,
    })).toBe('reject')
    expect(resolveWorkspaceMismatchSelfHeal({
      sessionWorkspaceId: 'ws-default',
      requestedWorkspaceId: 'ws-nanju',
      sessionHasRunHistory: true,
      sessionWorkspaceIsNanjuProjectBound: false,
      requestedWorkspaceExists: true,
    })).toBe('reject')
  })

  test('工单红测试3：请求工作区不存在（幽灵）+ 空会话未绑定 → 仍硬拒（不改绑到幽灵工作区）', () => {
    expect(resolveWorkspaceMismatchSelfHeal({
      sessionWorkspaceId: 'ws-default',
      requestedWorkspaceId: 'ws-ghost',
      sessionHasRunHistory: false,
      sessionWorkspaceIsNanjuProjectBound: false,
      requestedWorkspaceExists: false,
    })).toBe('reject')
  })

  test('无不匹配（会话无工作区 / 请求未携带 / 两边一致）→ 直通 keep-session（零行为变化）', () => {
    expect(resolveWorkspaceMismatchSelfHeal({
      sessionWorkspaceId: null,
      requestedWorkspaceId: 'ws-default',
      sessionHasRunHistory: false,
      sessionWorkspaceIsNanjuProjectBound: false,
      requestedWorkspaceExists: true,
    })).toBe('keep-session')
    expect(resolveWorkspaceMismatchSelfHeal({
      sessionWorkspaceId: 'ws-nanju',
      requestedWorkspaceId: undefined,
      sessionHasRunHistory: false,
      sessionWorkspaceIsNanjuProjectBound: false,
      requestedWorkspaceExists: true,
    })).toBe('keep-session')
    expect(resolveWorkspaceMismatchSelfHeal({
      sessionWorkspaceId: 'ws-nanju',
      requestedWorkspaceId: 'ws-nanju',
      sessionHasRunHistory: true,
      sessionWorkspaceIsNanjuProjectBound: false,
      requestedWorkspaceExists: true,
    })).toBe('keep-session')
  })
})
