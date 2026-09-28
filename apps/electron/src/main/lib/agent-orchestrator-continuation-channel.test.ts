/**
 * P0' 修复（2026-09-28）：护栏续接 channelId 缺失——回填 + 遥测可见化。
 *
 * 背景（E2E-Desktop 桌面便签 coding→testing 卡死 2 天，本会话调查定根因）：
 * 南大工程调度员会话创建链（TabContent ModeSelectView → createAgentSession(name,
 * undefined, ws.id)）不传 channelId；UI 消息发送路径每次显式带渠道但从不回填 meta；
 * 护栏续接（runNanjuGuardContinuation → runRegisteredHeadlessAgent）硬依赖
 * meta.channelId——缺失即走「续接跳过」分支立即 onGiveUp（实测拒因后 11 秒内放弃，
 * 连 60s 快速重试/600s 空闲巡检都没机会跑；dev 索引实测 25 个南大会话全部无 channelId）。
 *
 * 修复：
 * ① SEND_MESSAGE（真 UI 消息唯一入口，必带 channelId）首条消息回填 meta.channelId
 *   /modelId——治本：此后护栏续接、GWT 回炉等全部 headless 路径可用；
 * ② runNanjuGuardContinuation 的 !meta?.channelId 分支补 continuation.channel-missing
 *   遥测——治标可观测：存量无渠道会话可被监控发现。
 *
 * 说明：与 agent-orchestrator-continuation-idle-watch.test.ts 同源码断言模式
 * （大方法类无法轻量实例化单测）。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const ORCH = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')
const IPC = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf-8')
const TELEMETRY = readFileSync(new URL('./nanju-telemetry.ts', import.meta.url), 'utf-8')

function sendHandlerBlock(): string {
  const start = IPC.indexOf('AGENT_IPC_CHANNELS.SEND_MESSAGE,')
  expect(start).toBeGreaterThan(-1)
  const end = IPC.indexOf('await runAgent(input, event.sender)', start)
  expect(end).toBeGreaterThan(start)
  return IPC.slice(start, end)
}

function channelMissingBranch(): string {
  const start = ORCH.indexOf('if (!meta?.channelId)')
  expect(start).toBeGreaterThan(-1)
  const end = ORCH.indexOf('runRegisteredHeadlessAgent(', start)
  expect(end).toBeGreaterThan(start)
  return ORCH.slice(start, end)
}

describe("P0' 修复①：SEND_MESSAGE 首条消息回填 channelId/modelId", () => {
  const block = sendHandlerBlock()

  test('回填条件：meta 无 channelId 且消息必带渠道（input.channelId）', () => {
    expect(block).toContain('if (!session.channelId && input.channelId) {')
  })

  test('回填字段包含 channelId，modelId 仅在消息携带时回填', () => {
    const updateIdx = block.indexOf('updateAgentSessionMeta(input.sessionId, {')
    expect(updateIdx).toBeGreaterThan(-1)
    const tail = block.slice(updateIdx, updateIdx + 220)
    expect(tail).toContain('channelId: input.channelId')
    expect(tail).toContain("...(input.modelId ? { modelId: input.modelId } : {})")
  })

  test('回填失败不阻塞消息发送（吞错而非抛出）', () => {
    const updateIdx = block.indexOf('updateAgentSessionMeta(input.sessionId, {')
    const tryEnd = block.indexOf('}', block.indexOf('catch', updateIdx))
    const catchTail = block.slice(block.indexOf('catch', updateIdx), tryEnd + 60)
    expect(catchTail).toContain('/* 回填失败不阻塞发送 */')
  })

  test('回填先于飞书镜像与 runAgent（同一 handler 内，后续 run 可见新 meta）', () => {
    const backfillIdx = block.indexOf('updateAgentSessionMeta(input.sessionId, {')
    const mirrorIdx = block.indexOf('startSessionMirrorRun')
    expect(backfillIdx).toBeGreaterThan(-1)
    expect(mirrorIdx).toBeGreaterThan(backfillIdx)
  })
})

describe("P0' 修复②：续接缺 channelId 分支遥测可见化", () => {
  const block = channelMissingBranch()

  test('保留既有 console.warn（日志口径不变）', () => {
    expect(block).toContain('[南大护栏] 续接跳过（会话元数据缺失 channelId）')
  })

  test('发 continuation.channel-missing 遥测（工作区反查后按工程上报）', () => {
    expect(block).toContain("'continuation.channel-missing'")
    expect(block).toContain('getAgentWorkspace')
    expect(block).toContain('listNanjuProjects(workspace.slug).find((p) => p.sessionId === sessionId)')
  })

  test('遥测埋点失败不影响 onGiveUp 降级链（吞错）', () => {
    const telemetryIdx = block.indexOf("'continuation.channel-missing'")
    const catchIdx = block.indexOf('catch { /* 埋点失败不影响 */ }', telemetryIdx)
    const giveUpIdx = block.indexOf('onGiveUp?.(sessionId, message)', telemetryIdx)
    expect(catchIdx).toBeGreaterThan(-1)
    expect(giveUpIdx).toBeGreaterThan(catchIdx)
  })

  test('遥测事件类型已注册入 TelemetryEventType union', () => {
    expect(TELEMETRY).toContain("| 'continuation.channel-missing'")
  })
})

describe("P0' 根因链证据：创建链不传渠道是已知缺口（防回归注释锚）", () => {
  test('SEND_MESSAGE 回填注释指明 TabContent 创建链缺口', () => {
    const idx = IPC.indexOf("P0'（2026-09-28")
    expect(idx).toBeGreaterThan(-1)
    expect(IPC.slice(idx, idx + 300)).toContain('TabContent')
  })
})
