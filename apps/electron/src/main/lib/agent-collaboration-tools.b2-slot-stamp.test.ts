/**
 * W-I B-a：主进程盖章的委派 slot 链路（登记端点 → 公开工具入口 → record/meta）。
 *
 * 为什么单独一个文件：`agent-collaboration-tools.b2.test.ts` 与本文件都用 mock.module 替换
 * `./agent-session-manager` 等模块；两者必须**单文件独立进程**运行，不能与其他文件同目录批量跑，
 * 否则 mock 泄漏（B.md §7.8 已记录该风险）。
 *
 * 验收（对应 B.md §8.4 的 I-1..I-4）：
 * - I-1 端点匹配的视觉委派被盖章 → 子会话 meta.delegationSlot 与 list_delegations.slot 均有值
 * - I-2 非视觉委派不被盖章（无副作用）
 * - I-3 未登记（等价于 visualReviewer 未配置）→ 零写入
 * - I-4 模型自报 slot 无法伪造：先被剥离，且只有主进程登记端点全等时才补
 */
import { describe, expect, mock, test } from 'bun:test'

const sessionMetaUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []
let createdChildId = 'child-stamp-1'

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/proma-b2-stamp-test', getName: () => 'proma', getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  dialog: {}, clipboard: {}, nativeImage: { createFromPath: () => ({}) }, nativeTheme: {},
  powerMonitor: {}, powerSaveBlocker: {}, screen: {}, shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString('utf-8'),
  },
  ipcMain: { handle() {}, removeHandler() {} },
  webContents: { send() {} },
}))

mock.module('./agent-session-manager', () => ({
  createAgentSession: (title: string, channelId: string, workspaceId: string | undefined, modelId: string | undefined) => ({
    id: createdChildId, title, channelId, workspaceId, modelId, createdAt: 0, updatedAt: 0,
  }),
  getAgentSessionMeta: (id: string) => (
    id === 'L1'
      ? { id: 'L1', channelId: 'deepseek', workspaceId: 'ws', createdAt: 0, updatedAt: 0 }
      : { id, delegationStatus: 'running', createdAt: 0, updatedAt: 0 }
  ),
  getAgentSessionSDKMessages: () => [],
  listAgentSessions: () => [],
  updateAgentSessionMeta: (id: string, patch: Record<string, unknown>) => {
    sessionMetaUpdates.push({ id, patch })
  },
}))

mock.module('./agent-headless-runner-registry', () => ({
  runRegisteredHeadlessAgent: () => new Promise<void>(() => {}),
  stopRegisteredAgent: () => {},
}))

const actualModelSelection = await import('./agent-model-selection')
mock.module('./agent-model-selection', () => ({
  ...actualModelSelection,
  assertEnabledModelForChannel: (args: { modelId?: string }) => args.modelId ?? 'deepseek-flash',
  pickDefaultModelForChannel: () => 'deepseek-flash',
  listEnabledAgentModelsForChannel: () => ({ channelId: 'deepseek', channelName: 'deepseek', provider: 'deepseek', models: [] }),
}))

const actualFallback = await import('./nanju-model-fallback')
mock.module('./nanju-model-fallback', () => ({
  ...actualFallback,
  findNanjuFallbackProject: () => undefined,
}))

const mod = await import('./agent-collaboration-tools')

const ctx = { sessionId: 'L1', channelId: 'deepseek', workspaceId: 'ws' }
const buildTools = () => mod.buildPiCollaborationTools(
  { defineTool: (def: unknown) => def } as never,
  ctx,
) as Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }>

/** 与 orchestrator 盖章登记同型：只有 resolved 的独立视觉端点才会被登记 */
const registerVisualEndpoint = (channelId: string, modelId: string) =>
  mod.registerAuthorizedVisualDelegationEndpoint('L1', { channelId, modelId })

describe('W-I B-a：登记端点 → 公开工具入口盖章', () => {
  test('I-1 端点全等的委派被盖章（record.slot + meta.delegationSlot 同步落值）', async () => {
    createdChildId = 'child-stamp-1'
    registerVisualEndpoint('kimi', 'k3-vision')
    const delegate = buildTools().find((t) => t.name === 'mcp__collaboration__delegate_agent')!
    const res = await delegate.execute('call-stamp-1', {
      task: '对原型做独立视觉裁决',
      title: '独立视觉裁决',
      channelId: 'kimi',
      modelId: 'k3-vision',
    })
    expect(res).toBeTruthy()
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.childSessionId === 'child-stamp-1')
    expect(view).toBeTruthy()
    expect(view!.slot).toBe('visual-validator')
    expect(sessionMetaUpdates.some((u) => u.id === 'child-stamp-1' && u.patch.delegationSlot === 'visual-validator')).toBe(true)
  })

  test('I-1b inline 视觉委派同样落 meta（视觉验证者实际走 inline:true）', async () => {
    createdChildId = 'child-stamp-inline'
    registerVisualEndpoint('kimi', 'k3-vision')
    const delegate = buildTools().find((t) => t.name === 'mcp__collaboration__delegate_agent')!
    await delegate.execute('call-stamp-inline', {
      task: '对照 PRD 输出 red/yellow/green',
      title: '独立视觉裁决',
      inline: true,
      channelId: 'kimi',
      modelId: 'k3-vision',
    })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.childSessionId === 'child-stamp-inline')
    expect(view!.slot).toBe('visual-validator')
    expect(sessionMetaUpdates.some((u) => u.id === 'child-stamp-inline' && u.patch.delegationSlot === 'visual-validator')).toBe(true)
  })

  test('I-2 端点不一致（同阶段委派他人）→ 不盖章且无 meta 副作用', async () => {
    createdChildId = 'child-stamp-2'
    registerVisualEndpoint('kimi', 'k3-vision')
    const delegate = buildTools().find((t) => t.name === 'mcp__collaboration__delegate_agent')!
    await delegate.execute('call-stamp-2', { task: '普通实现委派', title: '实现', channelId: 'deepseek', modelId: 'deepseek-v3' })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.childSessionId === 'child-stamp-2')
    expect(view!.slot).toBeUndefined()
    expect(sessionMetaUpdates.some((u) => u.id === 'child-stamp-2' && 'delegationSlot' in u.patch)).toBe(false)
  })

  test('I-2b 只给 channel 不给 model（或反之）不构成端点全等 → 不盖章', async () => {
    createdChildId = 'child-stamp-2b'
    registerVisualEndpoint('kimi', 'k3-vision')
    const delegate = buildTools().find((t) => t.name === 'mcp__collaboration__delegate_agent')!
    await delegate.execute('call-stamp-2b', { task: '缺 model 的委派', title: '半匹配', channelId: 'kimi' })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.childSessionId === 'child-stamp-2b')
    expect(view!.slot).toBeUndefined()
  })

  test('I-3 未登记（visualReviewer 未配置）→ 零写入', async () => {
    createdChildId = 'child-stamp-3'
    mod.registerAuthorizedVisualDelegationEndpoint('L1', null)
    const delegate = buildTools().find((t) => t.name === 'mcp__collaboration__delegate_agent')!
    await delegate.execute('call-stamp-3', { task: '未配置视觉端点时的委派', title: '普通委派', channelId: 'kimi', modelId: 'k3-vision' })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.childSessionId === 'child-stamp-3')
    expect(view!.slot).toBeUndefined()
    expect(sessionMetaUpdates.some((u) => u.id === 'child-stamp-3' && 'delegationSlot' in u.patch)).toBe(false)
  })

  test('I-4 模型自报 slot 无法伪造：命中登记端点但 slot 参数被剥离后由主进程补权威值', async () => {
    createdChildId = 'child-stamp-4'
    registerVisualEndpoint('kimi', 'k3-vision')
    const delegate = buildTools().find((t) => t.name === 'mcp__collaboration__delegate_agent')!
    // 伪造 author 槽位 + 命中视觉端点：结果必须是主进程判定值 visual-validator，而非模型自报值
    await delegate.execute('call-stamp-4', {
      task: '尝试自报槽位',
      title: '伪造尝试',
      slot: 'author',
      channelId: 'kimi',
      modelId: 'k3-vision',
    })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.childSessionId === 'child-stamp-4')
    expect(view!.slot).toBe('visual-validator')
  })

  test('I-4b 撤销登记后即使模型自报 slot 也不盖章（登记是唯一可信来源）', async () => {
    createdChildId = 'child-stamp-4b'
    mod.registerAuthorizedVisualDelegationEndpoint('L1', null)
    const delegate = buildTools().find((t) => t.name === 'mcp__collaboration__delegate_agent')!
    await delegate.execute('call-stamp-4b', {
      task: '撤销后自报',
      title: '伪造尝试 2',
      slot: 'visual-validator',
      channelId: 'kimi',
      modelId: 'k3-vision',
    })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.childSessionId === 'child-stamp-4b')
    expect(view!.slot).toBeUndefined()
    expect(sessionMetaUpdates.some((u) => u.id === 'child-stamp-4b' && 'delegationSlot' in u.patch)).toBe(false)
  })

  test('批量入口：仅端点全等的项被盖章，其余项不受影响', async () => {
    createdChildId = 'child-stamp-batch'
    registerVisualEndpoint('kimi', 'k3-vision')
    const batch = buildTools().find((t) => t.name === 'mcp__collaboration__delegate_agents')!
    const raw = await batch.execute('call-stamp-batch', {
      sharedContext: '共同背景',
      items: [
        { task: '视觉裁决', title: '视觉', channelId: 'kimi', modelId: 'k3-vision' },
        { task: '普通实现', title: '实现', channelId: 'deepseek', modelId: 'deepseek-v3' },
      ],
    })
    const res = raw as { details: { delegations: Array<{ slot?: string; title?: string }> } }
    const slots = res.details.delegations.map((d) => d.slot)
    expect(slots).toContain('visual-validator')
    expect(slots.filter((s) => s === 'visual-validator').length).toBe(1)
  })
})

describe('W-I B-a：登记表自身语义', () => {
  test('登记可读可撤销（不进工具面，仅主进程/测试可见）', () => {
    mod.registerAuthorizedVisualDelegationEndpoint('L1', { channelId: 'kimi', modelId: 'k3-vision' })
    expect(mod.getAuthorizedVisualDelegationEndpoint('L1')).toEqual({ channelId: 'kimi', modelId: 'k3-vision' })
    mod.registerAuthorizedVisualDelegationEndpoint('L1', null)
    expect(mod.getAuthorizedVisualDelegationEndpoint('L1')).toBeUndefined()
  })

  test('登记按父会话隔离（L2 会话不会被 L1 的登记影响）', () => {
    mod.registerAuthorizedVisualDelegationEndpoint('L1', { channelId: 'kimi', modelId: 'k3-vision' })
    expect(mod.getAuthorizedVisualDelegationEndpoint('L2')).toBeUndefined()
    mod.registerAuthorizedVisualDelegationEndpoint('L1', null)
  })
})
