/**
 * P0-B Phase2 施工 B：会话删除 → pending capability 确定性 abort。
 *
 * 缺口（调研确认）：DELETE_SESSION 原先只 clearSessionPending（deny-resolve），
 * 无 stopAgent、无 capability abort；且 adapter.abort() 依赖 QUERY_ABORT 往返
 * 驱动 query finally 清理，utility 挂死（E2E 622s 挂起形态）时 finally 不执行。
 * 本文件锁定三层接线：shared 接口可选方法、adapter 按 sessionId 清空、
 * ipc.ts DELETE_SESSION 调用 stop + abort。
 *
 * 证据分级：shared 接口 = S（直接 import 断言）；adapter/ipc = M（源码接线断言，
 * pi-utility-adapter 经 agent-runtime-client 依赖 electron，无法单测实例化；
 * 按 queryId 中止的纯函数行为已由 pi-utility-capability-abort.test.ts 覆盖）。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AgentProviderAdapter } from '@proma/shared'

const adapterSource = readFileSync(
  new URL('./adapters/pi-utility-adapter.ts', import.meta.url),
  'utf-8',
)
const ipcSource = readFileSync(new URL('../ipc.ts', import.meta.url), 'utf-8')
const orchestratorSource = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')

describe('会话删除触发 pending capability abort（P0-B Phase2）', () => {
  test('shared 接口提供可选 abortPendingCapabilities 方法（S 级：类型存在）', () => {
    const adapter: AgentProviderAdapter = {
      query: async function* query() { /* stub for type check */ },
      abort: () => {},
      dispose: () => {},
    }
    // 可选方法未实现时调用侧安全跳过
    expect(adapter.abortPendingCapabilities).toBeUndefined()
    const withAbort: AgentProviderAdapter = {
      ...adapter,
      abortPendingCapabilities: () => {},
    }
    expect(typeof withAbort.abortPendingCapabilities).toBe('function')
  })

  test('PiUtilityAdapter.abortPendingCapabilities 按 sessionId 清空该会话全部 capability', () => {
    const fn = adapterSource.slice(
      adapterSource.indexOf('abortPendingCapabilities(sessionId: string): number'),
      adapterSource.indexOf('async sendQueuedMessage('),
    )
    expect(fn).toContain('pending.sessionId === sessionId')
    expect(fn).toContain('abortCapabilityControllersForQuery(this.capabilityAbortControllers, queryId)')
  })

  test('orchestrator 暴露 abortPendingCapabilities 并委托 adapter 可选方法', () => {
    const fn = orchestratorSource.slice(
      orchestratorSource.indexOf('abortPendingCapabilities(sessionId: string): void'),
      orchestratorSource.indexOf('/** 检查指定会话是否正在处理中 */'),
    )
    expect(fn).toContain('this.adapter.abortPendingCapabilities?.(sessionId)')
  })

  test('DELETE_SESSION：运行中先 stopAgent，再确定性 abort capability（不依赖 clearSessionPending）', () => {
    const handler = ipcSource.slice(
      ipcSource.indexOf('AGENT_IPC_CHANNELS.DELETE_SESSION'),
      ipcSource.indexOf('AGENT_IPC_CHANNELS.MIGRATE_CHAT_TO_AGENT'),
    )
    expect(handler).toContain('if (isAgentSessionActive(id)) stopAgent(id)')
    expect(handler).toContain('abortAgentPendingCapabilities(id)')
    // abort 必须先于 clearSessionPending 执行（确定性中止优先于 deny-resolve 兜底）
    expect(handler.indexOf('abortAgentPendingCapabilities(id)')).toBeLessThan(
      handler.indexOf('askUserService.clearSessionPending(id)'),
    )
    // 审查 F1：stop/abort 各自 try/catch 兜底，抛错不跳过后续清理链
    expect(handler).toContain('} catch (e) {')
    expect((handler.match(/} catch \(e\) \{/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(handler).toContain('deleteAgentSession(id)')
  })
})
