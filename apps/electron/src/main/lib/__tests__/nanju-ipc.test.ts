/**
 * WO5.2（v0.17.59）：buildCtfCommitDetail 四类用例
 * finalTransform / absX / dx-dy / text / 畸形 JSON 兜底
 *
 * nanju-ipc 的传递依赖（agent-session-manager → conversation-manager →
 * attachment-service）顶层 import electron——按本仓库既有测试模式（见
 * agent-session-manager.test.ts）先 mock.module 再动态导入。
 */
import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/tmp/proma-ctf-test',
    getName: () => 'proma',
    getVersion: () => '0.0.0-test',
  },
  BrowserWindow: class {},
  dialog: {},
  clipboard: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  ipcMain: { handle() {}, removeHandler() {} },
}))

const { buildCtfCommitDetail } = await import('../nanju-ipc')
type CtfCommitItem = import('../nanju-ipc').CtfCommitItem

describe('buildCtfCommitDetail（WO4）', () => {
  test('move 一级：finalTransform 原样写入「将 transform 设为 …（绝对终值…）」', () => {
    const detail = buildCtfCommitDetail([
      { id: 'btn-1', type: '按钮', label: '提交', action: 'move', finalTransform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 25, 10, 100, 1)' },
    ])
    expect(detail).toBe(
      '- 按钮「提交」（data-ai-id=btn-1）：将 transform 设为 matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 25, 10, 100, 1)（绝对终值，直接写死，勿与现有样式叠加）',
    )
  })

  test('move 二级：无 finalTransform 时 absX/absY 拼 translate（同绝对终值语义）', () => {
    const detail = buildCtfCommitDetail([
      { id: 'btn-2', type: '按钮', label: '取消', action: 'move', value: { dx: 20, dy: 4, absX: 51, absY: -5 } },
    ])
    expect(detail).toBe(
      '- 按钮「取消」（data-ai-id=btn-2）：将 transform 设为 translate(51px, -5px)（绝对终值，直接写死，勿与现有样式叠加）',
    )
  })

  test('move 三级：legacy dx/dy 增量（无 absX/absY 的旧报文）', () => {
    const detail = buildCtfCommitDetail([
      { id: 'btn-3', type: '按钮', label: '搜索', action: 'move', value: { dx: -8, dy: 3 } },
    ])
    expect(detail).toBe('- 按钮「搜索」（data-ai-id=btn-3）：平移 (-8px, 3px)')
  })

  test('text 分支：值透传（修复 v0.17.58 text 值丢弃缺口）', () => {
    const detail = buildCtfCommitDetail([
      { id: 'tab-1', type: '标签', label: 'US-1 概览', action: 'text', value: 'US-1 全单位对照' },
    ])
    expect(detail).toBe('- 标签「US-1 概览」（data-ai-id=tab-1）：文字改为「US-1 全单位对照」')
  })

  test('color/delete/voice 维持既有格式', () => {
    const detail = buildCtfCommitDetail([
      { id: 'c1', type: '按钮', label: '确定', action: 'color', value: '#DC2626' },
      { id: 'd1', type: '文本', label: '免责声明', action: 'delete' },
      { id: 'v1', type: '输入框', label: '搜索框', action: 'voice', value: '把这行加粗放大' },
    ])
    const lines = detail.split('\n')
    expect(lines[0]).toBe('- 按钮「确定」（data-ai-id=c1）：背景色改为 #DC2626')
    expect(lines[1]).toBe('- 文本「免责声明」（data-ai-id=d1）：删除')
    expect(lines[2]).toBe('- 输入框「搜索框」（data-ai-id=v1）：用户意见「把这行加粗放大」')
  })

  test('空串 finalTransform 不走一级（回退 absX/absY）', () => {
    const detail = buildCtfCommitDetail([
      { id: 'm1', type: '元素', label: 'x', action: 'move', value: { absX: 3, absY: 4 }, finalTransform: '' },
    ])
    expect(detail).toBe('- 元素「x」（data-ai-id=m1）：将 transform 设为 translate(3px, 4px)（绝对终值，直接写死，勿与现有样式叠加）')
  })

  test('多行 join 与未知动作兜底', () => {
    const detail = buildCtfCommitDetail([
      { id: 'a', type: '元素', label: 'A', action: 'color', value: '#fff' },
      { id: 'b', type: '元素', action: 'unknown-action' },
    ] satisfies CtfCommitItem[])
    expect(detail.split('\n')).toHaveLength(2)
    expect(detail).toContain('- 元素「b」（data-ai-id=b）：unknown-action')
  })
})
