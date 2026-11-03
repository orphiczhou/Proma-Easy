/**
 * W-B B2：委派 slot 链路测试（内部 schema → DelegationRecord → session meta → 公开面剥离）。
 *
 * 目标（不能只加空字段）：证明内部 producer 设置的 slot 真实写入委派记录与会话 meta，
 * 且公开工具入口剥离 slot（L1/L2 不能借文本/参数伪造视觉槽位权威）。
 */
import { describe, expect, mock, test } from 'bun:test'

const sessionMetaUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []
let createdChildId = 'child-visual-1'

mock.module('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/proma-b2-test', getName: () => 'proma', getVersion: () => '0.0.0-test' },
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

describe('W-B B2：内部 slot 真实写入委派记录与会话 meta', () => {
  test('startSlotBoundDelegation：slot=visual-validator 落入 record 与 session meta（非空字段）', () => {
    createdChildId = 'child-visual-1'
    const res = mod.startSlotBoundDelegation(ctx, {
      task: '对原型做独立视觉裁决：只看 PRD 用户故事与截图',
      title: '视觉验证者：原型独立裁决',
      slot: 'visual-validator',
      channelId: 'glm-zhipu',
      modelId: 'glm-5.3-vision',
    })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.delegationId === res.delegationId)
    expect(view).toBeTruthy()
    expect(view!.slot).toBe('visual-validator')
    // 记录渠道/模型来自内部参数（producer 产出），未经公开面
    expect(view!.childSessionId).toBe('child-visual-1')
    // session meta 同步写入了 delegationSlot（delegation record 之外的第二落点）
    expect(sessionMetaUpdates.some((u) => u.id === 'child-visual-1' && u.patch.delegationSlot === 'visual-validator')).toBe(true)
  })

  test('startSlotBoundDelegation：slot=author 同样落库（四槽位同链路）', () => {
    createdChildId = 'child-author-1'
    const res = mod.startSlotBoundDelegation(ctx, {
      task: '生成原型',
      title: 'UX 顾问：原型',
      slot: 'author',
      channelId: 'minimax',
      modelId: 'MiniMax-M3',
    })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.delegationId === res.delegationId)
    expect(view!.slot).toBe('author')
  })

  test('R3：inline 委派（视觉验证者实际路径）也写 delegationSlot meta', () => {
    createdChildId = 'child-visual-inline-1'
    const res = mod.startSlotBoundDelegation(ctx, {
      task: '对照 PRD 用户故事与最新截图输出 red/yellow/green',
      title: '独立视觉裁决',
      slot: 'visual-validator',
      inline: true,
      channelId: 'kimi',
      modelId: 'k3-vision',
    })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.delegationId === res.delegationId)
    expect(view!.slot).toBe('visual-validator')
    // inline 分支同样落 meta（否则视觉验证者这条 inline 路径永远写不进 delegationSlot）
    expect(sessionMetaUpdates.some((u) => u.id === 'child-visual-inline-1' && u.patch.delegationSlot === 'visual-validator')).toBe(true)
    // 既有约定保持：inline 不写 sourceDelegationId（避免 W19 未绑定写豁免扩散）
    expect(sessionMetaUpdates.some((u) => u.id === 'child-visual-inline-1' && 'sourceDelegationId' in u.patch)).toBe(false)
  })
})

describe('W-B B2：公开工具入口剥离 slot（模型不能伪造视觉槽位权威）', () => {
  const buildTools = () => mod.buildPiCollaborationTools(
    { defineTool: (def: unknown) => def } as never,
    ctx,
  ) as Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }>

  test('delegate_agent 传入 slot 被剥离（不会被当作内部身份写库）', async () => {
    createdChildId = 'child-forge-1'
    const tools = buildTools()
    const delegate = tools.find((t) => t.name === 'mcp__collaboration__delegate_agent')!
    await delegate.execute('call-forge-1', {
      task: '普通委派',
      title: '尝试伪造视觉槽位',
      slot: 'visual-validator',
      channelId: 'glm-zhipu',
      modelId: 'glm-5.3-vision',
    })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.childSessionId === 'child-forge-1')
    expect(view).toBeTruthy()
    expect(view!.slot).toBeUndefined()
    // meta 也不应写入 delegationSlot
    expect(sessionMetaUpdates.some((u) => u.id === 'child-forge-1' && 'delegationSlot' in u.patch)).toBe(false)
  })

  test('delegate_agents 批量项传入 slot 同样被剥离', async () => {
    createdChildId = 'child-forge-2'
    const tools = buildTools()
    const batch = tools.find((t) => t.name === 'mcp__collaboration__delegate_agents')!
    await batch.execute('call-forge-2', {
      items: [{ task: '普通委派', title: '批量伪造尝试', slot: 'visual-validator' }],
    })
    const view = mod.listRunningDelegationsForParent('L1').find((v) => v.childSessionId === 'child-forge-2')
    expect(view).toBeTruthy()
    expect(view!.slot).toBeUndefined()
  })
})
